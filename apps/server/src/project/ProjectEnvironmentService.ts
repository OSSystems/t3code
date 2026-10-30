// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type {
  ProjectEnvironmentApproveInput,
  ProjectEnvironmentApproveResult,
  ProjectEnvironmentStatus,
  ProjectEnvironmentStatusInput,
  ProjectId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DirenvEnvironment from "../provider/DirenvEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";

/**
 * The user approves an `.envrc` content once per project; T3 Code then runs `direnv allow`
 * itself in every checkout with that content, worktrees included. direnv stays the source of
 * truth for what loads, so shells with the direnv hook see the same trust.
 */
export class ProjectEnvironmentService extends Context.Service<
  ProjectEnvironmentService,
  {
    readonly status: (
      input: ProjectEnvironmentStatusInput,
    ) => Effect.Effect<ProjectEnvironmentStatus>;
    readonly approve: (
      input: ProjectEnvironmentApproveInput,
    ) => Effect.Effect<ProjectEnvironmentApproveResult>;
    /**
     * Allow `cwd`'s approved `.envrc` before a provider or setup script starts there. False
     * when nothing may load. A changed `.envrc` stays blocked and loads as a failure, so a
     * running agent keeps its environment and the thread offers a review.
     */
    readonly prepare: (projectId: ProjectId, cwd: string) => Effect.Effect<boolean>;
    /** The project's Load direnv environment setting. */
    readonly enabled: (projectId: ProjectId) => Effect.Effect<boolean>;
  }
>()("t3/project/ProjectEnvironmentService") {}

const APPROVALS_FILE = "direnv-approvals.json";
// Older approvals only matter as the base of a change diff.
const MAX_APPROVALS_PER_PROJECT = 5;
const MAX_ENVRC_LENGTH = 64 * 1024;

const Approval = Schema.Struct({
  sha256: Schema.String,
  content: Schema.String,
  approvedAt: Schema.String,
});
type Approval = typeof Approval.Type;

const ApprovalsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Array(Approval)));
const decodeApprovals = Schema.decodeUnknownOption(ApprovalsJson);
const encodeApprovals = Schema.encodeSync(ApprovalsJson);

type Approvals = Readonly<Record<string, ReadonlyArray<Approval>>>;

const sha256 = (content: string) => NodeCrypto.createHash("sha256").update(content).digest("hex");

interface Evaluation {
  readonly envrc: DirenvEnvironment.DirenvEnvrc | null;
  readonly sha256: string | null;
  readonly approvals: ReadonlyArray<Approval>;
  /** Approved in T3 Code, in the user's shell, or by the trust-changes setting. */
  readonly approved: boolean;
  /** Approved but not recorded yet, so T3 Code has no diff base for its next change. */
  readonly unrecorded: boolean;
}

const make = Effect.fn("ProjectEnvironmentService.make")(function* () {
  const direnv = yield* DirenvEnvironment.DirenvEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const approvalsPath = path.join(stateDir, APPROVALS_FILE);
  const writeLock = yield* Semaphore.make(1);
  const writeFile = (contents: string) =>
    writeFileStringAtomically({ filePath: approvalsPath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const readApprovals = fileSystem.readFileString(approvalsPath).pipe(
    Effect.map((raw) => Option.getOrElse(decodeApprovals(raw), (): Approvals => ({}))),
    Effect.orElseSucceed((): Approvals => ({})),
  );

  const recordApproval = Effect.fn("ProjectEnvironmentService.recordApproval")(function* (
    projectId: ProjectId,
    content: string,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readApprovals;
        const hash = sha256(content);
        const previous = (current[projectId] ?? []).filter((entry) => entry.sha256 !== hash);
        const next: Approvals = {
          ...current,
          [projectId]: [...previous, { sha256: hash, content, approvedAt: now }].slice(
            -MAX_APPROVALS_PER_PROJECT,
          ),
        };
        yield* writeFile(encodeApprovals(next));
      }),
    );
  });

  const projectRoot = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
      Effect.orElseSucceed(() => undefined),
    );

  const settingsFor = (projectId: ProjectId) =>
    serverSettings.getSettings.pipe(
      Effect.orDie,
      Effect.map((settings) => resolveProjectSettings(settings, projectId).settings),
    );

  const evaluate = Effect.fn("ProjectEnvironmentService.evaluate")(function* (
    projectId: ProjectId,
    cwd: string,
  ) {
    const envrc = Option.getOrNull(yield* direnv.inspect(cwd));
    const approvals = (yield* readApprovals)[projectId] ?? [];
    if (envrc === null) {
      return { envrc, sha256: null, approvals, approved: false, unrecorded: false };
    }
    const hash = sha256(envrc.content);
    const recorded = approvals.some((entry) => entry.sha256 === hash);
    // An explicit `direnv deny` wins until the user approves again.
    if (envrc.permission === "denied") {
      return { envrc, sha256: hash, approvals, approved: false, unrecorded: false };
    }
    let approved = envrc.permission === "allowed" || recorded;
    if (!approved) {
      // A project allowed from the user's shell vouches for worktrees with the same content.
      const root = yield* projectRoot(projectId);
      if (root !== undefined && path.resolve(root) !== path.resolve(cwd)) {
        const rootEnvrc = Option.getOrNull(yield* direnv.inspect(root));
        approved =
          rootEnvrc !== null &&
          rootEnvrc.permission === "allowed" &&
          sha256(rootEnvrc.content) === hash;
      }
    }
    if (!approved && approvals.length > 0) {
      approved = (yield* settingsFor(projectId)).trustDirenvChanges;
    }
    return {
      envrc,
      sha256: hash,
      approvals,
      approved,
      unrecorded: approved && !recorded && envrc.content.length <= MAX_ENVRC_LENGTH,
    } satisfies Evaluation;
  });

  const recordQuietly = (projectId: ProjectId, content: string) =>
    recordApproval(projectId, content).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not save the .envrc approval.", { cause }),
      ),
    );

  /** The project and directory a request targets; a thread decides both when given. */
  const resolveTarget = Effect.fn("ProjectEnvironmentService.resolveTarget")(function* (
    input: ProjectEnvironmentStatusInput,
  ) {
    if (input.threadId !== undefined) {
      const thread = yield* projectionStore
        .getThread(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (thread === null) return undefined;
      const cwd = thread.worktreePath ?? (yield* projectRoot(thread.projectId));
      return cwd === undefined ? undefined : { projectId: thread.projectId, cwd };
    }
    const cwd = yield* projectRoot(input.projectId);
    return cwd === undefined ? undefined : { projectId: input.projectId, cwd };
  });

  const status: ProjectEnvironmentService["Service"]["status"] = Effect.fn(
    "ProjectEnvironmentService.status",
  )(function* (input) {
    const target = yield* resolveTarget(input);
    if (target === undefined) {
      return { envrc: null, pending: "none", approvedContent: null, enabled: false } as const;
    }
    const enabled = (yield* settingsFor(target.projectId)).enableDirenvEnvironment;
    const {
      envrc,
      sha256: hash,
      approvals,
      approved,
    } = yield* evaluate(target.projectId, target.cwd);
    if (envrc === null || hash === null) {
      return { envrc: null, pending: "none", approvedContent: null, enabled: false } as const;
    }
    const tooLarge = envrc.content.length > MAX_ENVRC_LENGTH;
    const latest = approvals.at(-1);
    return {
      envrc: { path: envrc.path, content: tooLarge ? "" : envrc.content, sha256: hash, tooLarge },
      pending: !enabled || approved ? "none" : latest === undefined ? "approve" : "approve-change",
      approvedContent: latest?.content ?? null,
      enabled,
    } satisfies ProjectEnvironmentStatus;
  });

  const approve: ProjectEnvironmentService["Service"]["approve"] = Effect.fn(
    "ProjectEnvironmentService.approve",
  )(function* (input) {
    const target = yield* resolveTarget(input);
    if (target === undefined) return { approved: false, error: "The project no longer exists." };
    const envrc = Option.getOrNull(yield* direnv.inspect(target.cwd));
    if (envrc === null) return { approved: false, error: "No .envrc governs this workspace." };
    if (envrc.content.length > MAX_ENVRC_LENGTH) {
      return {
        approved: false,
        error: "This .envrc is too large to review here. Run direnv allow.",
      };
    }
    if (sha256(envrc.content) !== input.sha256) {
      return { approved: false, error: "The .envrc changed while you were reviewing it." };
    }
    const allowed = yield* direnv.allow(envrc.path, envrc.content);
    if (allowed._tag === "Failed") return { approved: false, error: allowed.message };
    yield* recordQuietly(target.projectId, envrc.content);
    return { approved: true };
  });

  const prepare: ProjectEnvironmentService["Service"]["prepare"] = Effect.fn(
    "ProjectEnvironmentService.prepare",
  )(function* (projectId, cwd) {
    if (!(yield* settingsFor(projectId)).enableDirenvEnvironment) return false;
    const evaluation = yield* evaluate(projectId, cwd);
    const { envrc, sha256: hash } = evaluation;
    // Without an `.envrc`, loading only unloads what a previous one set.
    if (envrc === null || hash === null) return true;
    if (!evaluation.approved) return evaluation.approvals.length > 0;
    if (envrc.permission !== "allowed") {
      const allowed = yield* direnv.allow(envrc.path, envrc.content);
      if (allowed._tag === "Failed") {
        yield* Effect.logWarning("Could not allow an approved .envrc.", {
          cwd,
          message: allowed.message,
        });
      }
    }
    if (evaluation.unrecorded) yield* recordQuietly(projectId, envrc.content);
    return true;
  });

  const enabled: ProjectEnvironmentService["Service"]["enabled"] = (projectId) =>
    settingsFor(projectId).pipe(Effect.map((settings) => settings.enableDirenvEnvironment));

  return ProjectEnvironmentService.of({ status, approve, prepare, enabled });
});

export const layer = Layer.effect(ProjectEnvironmentService, make());
