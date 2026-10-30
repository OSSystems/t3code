import {
  type EnvironmentId,
  type ProjectEnvironmentStatus,
  type ProjectEnvironmentStatusInput,
  type ProjectId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export interface ProjectEnvironmentTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Without a thread, the project's own checkout. */
  readonly threadId: ThreadId | null;
}

const projectKey = (target: ProjectEnvironmentTarget) =>
  `${target.environmentId}:${target.projectId}:`;

/**
 * `refreshSignal` re-reads the status whenever its value changes, such as on each run or
 * settings change, so edits to the `.envrc` and approvals from other clients show up.
 */
export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly refreshSignal?: (target: ProjectEnvironmentTarget) => Atom.Atom<unknown>;
  } = {},
) {
  const { refreshSignal } = options;
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:project-environment:status",
    tag: WS_METHODS.projectEnvironmentStatus,
    ...(refreshSignal === undefined
      ? {}
      : {
          refreshTrigger: (target: {
            readonly environmentId: EnvironmentId;
            readonly input: ProjectEnvironmentStatusInput;
          }) =>
            refreshSignal({
              environmentId: target.environmentId,
              projectId: target.input.projectId,
              threadId: target.input.threadId ?? null,
            }),
        }),
  });
  // "Not now" lasts for the session, per reviewed content, until a thread asks for a review.
  const dismissedAtom = Atom.make<{ readonly dismissed: ReadonlySet<string> }>({
    dismissed: new Set<string>(),
  }).pipe(Atom.keepAlive);
  return {
    statusAtom: (target: ProjectEnvironmentTarget) =>
      status({
        environmentId: target.environmentId,
        input: {
          projectId: target.projectId,
          ...(target.threadId === null ? {} : { threadId: target.threadId }),
        },
      }),
    approve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-environment:approve",
      tag: WS_METHODS.projectEnvironmentApprove,
    }),
    dismissedAtom,
    isDismissed: (
      dismissed: ReadonlySet<string>,
      target: ProjectEnvironmentTarget,
      sha256: string,
    ) => dismissed.has(projectKey(target) + sha256),
    dismiss: (
      registry: AtomRegistry.AtomRegistry,
      target: ProjectEnvironmentTarget,
      sha256: string,
    ) =>
      registry.set(dismissedAtom, {
        dismissed: new Set([...registry.get(dismissedAtom).dismissed, projectKey(target) + sha256]),
      }),
    /** Brings back the review a "Not now" hid, for this project only. */
    reviewAgain: (registry: AtomRegistry.AtomRegistry, target: ProjectEnvironmentTarget) =>
      registry.set(dismissedAtom, {
        dismissed: new Set(
          [...registry.get(dismissedAtom).dismissed].filter(
            (key) => !key.startsWith(projectKey(target)),
          ),
        ),
      }),
  };
}

export interface ProjectEnvironmentReview {
  readonly changed: boolean;
  readonly sha256: string;
  readonly tooLarge: boolean;
  /** `same` lines with no diff marks for a first review. */
  readonly lines: ReadonlyArray<EnvrcDiffLine>;
}

/** What the user reviews before approving, or null when nothing waits for approval. */
export function projectEnvironmentReview(
  status: ProjectEnvironmentStatus | null,
): ProjectEnvironmentReview | null {
  if (status === null || status.pending === "none" || status.envrc === null) return null;
  const { envrc } = status;
  const changed = status.pending === "approve-change" && status.approvedContent !== null;
  return {
    changed,
    sha256: envrc.sha256,
    tooLarge: envrc.tooLarge,
    lines: envrc.tooLarge
      ? []
      : changed
        ? diffEnvrc(status.approvedContent!, envrc.content)
        : envrc.content.split("\n").map((text) => ({ kind: "same", text })),
  };
}

/** The thread details indicator; null hides it, when no `.envrc` or direnv is available. */
export function projectEnvironmentIndicator(
  status: ProjectEnvironmentStatus | null,
): "on" | "off" | "approval" | null {
  if (status === null || status.envrc === null) return null;
  return !status.enabled ? "off" : status.pending === "none" ? "on" : "approval";
}

export interface EnvrcDiffLine {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
}

// `.envrc` files are a few dozen lines; past this, show the new content as added.
const MAX_DIFF_LINES = 400;

/** A line diff of an `.envrc` change, for the user to review before approving it. */
export function diffEnvrc(previous: string, next: string): ReadonlyArray<EnvrcDiffLine> {
  const before = previous.split("\n");
  const after = next.split("\n");
  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) {
    return after.map((text) => ({ kind: "added", text }));
  }
  // Longest common subsequence lengths of each pair of suffixes.
  const lengths = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        before[i] === after[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const lines: EnvrcDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: "same", text: before[i]! });
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      lines.push({ kind: "removed", text: before[i++]! });
    } else {
      lines.push({ kind: "added", text: after[j++]! });
    }
  }
  while (i < before.length) lines.push({ kind: "removed", text: before[i++]! });
  while (j < after.length) lines.push({ kind: "added", text: after[j++]! });
  return lines;
}
