import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * A project's direnv environment, seen from the directory a thread works in.
 * Without a thread, the project's own checkout. The server resolves the
 * directory, so a client cannot name an arbitrary path.
 */
const ProjectEnvironmentTarget = {
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
};

export const ProjectEnvironmentStatusInput = Schema.Struct(ProjectEnvironmentTarget);
export type ProjectEnvironmentStatusInput = typeof ProjectEnvironmentStatusInput.Type;

export const ProjectEnvironmentEnvrc = Schema.Struct({
  path: Schema.String,
  /** Empty when `tooLarge`: such a file can only be approved with `direnv allow`. */
  content: Schema.String,
  sha256: Schema.String,
  tooLarge: Schema.Boolean,
});
export type ProjectEnvironmentEnvrc = typeof ProjectEnvironmentEnvrc.Type;

/**
 * `approve`: the project's first `.envrc`. `approve-change`: an `.envrc` that
 * differs from the one approved before, which `approvedContent` holds.
 */
export const ProjectEnvironmentPending = Schema.Literals(["none", "approve", "approve-change"]);
export type ProjectEnvironmentPending = typeof ProjectEnvironmentPending.Type;

export const ProjectEnvironmentStatus = Schema.Struct({
  envrc: Schema.NullOr(ProjectEnvironmentEnvrc),
  pending: ProjectEnvironmentPending,
  approvedContent: Schema.NullOr(Schema.String),
  /** False when Load direnv environment is off, or direnv is not installed. */
  enabled: Schema.Boolean,
});
export type ProjectEnvironmentStatus = typeof ProjectEnvironmentStatus.Type;

/** Approve the `.envrc` the user reviewed; `sha256` must still match the file. */
export const ProjectEnvironmentApproveInput = Schema.Struct({
  ...ProjectEnvironmentTarget,
  sha256: Schema.String,
});
export type ProjectEnvironmentApproveInput = typeof ProjectEnvironmentApproveInput.Type;

export const ProjectEnvironmentApproveResult = Schema.Struct({
  approved: Schema.Boolean,
  /** Why nothing was approved. */
  error: Schema.optional(Schema.String),
});
export type ProjectEnvironmentApproveResult = typeof ProjectEnvironmentApproveResult.Type;
