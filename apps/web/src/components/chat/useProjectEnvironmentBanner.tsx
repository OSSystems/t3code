import { useAtomValue } from "@effect/atom-react";
import type { ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import {
  projectEnvironmentReview,
  type ProjectEnvironmentTarget,
} from "@t3tools/client-runtime/state/projectEnvironment";
import { TerminalSquareIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projectEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Asks once per `.envrc` content before T3 Code loads a project's direnv
 * environment, and again with a diff when it changes.
 */
export function useProjectEnvironmentBanner(
  projectRef: ScopedProjectRef | null,
  threadId: ThreadId | null,
): ComposerBannerStackItem | null {
  const target: ProjectEnvironmentTarget | null =
    projectRef === null ? null : { ...projectRef, threadId };
  const query = useEnvironmentQuery(target === null ? null : projectEnvironment.statusAtom(target));
  const approve = useAtomCommand(projectEnvironment.approve);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const [pending, setPending] = useState(false);
  const dismissed = useAtomValue(projectEnvironment.dismissedAtom).dismissed;
  const canApprove = useAtomValue(
    projectEnvironment.approve.permissionAtom(projectRef?.environmentId ?? null),
  );
  const canTurnOff = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(projectRef?.environmentId ?? null),
  );
  const review = projectEnvironmentReview(query.data);
  if (target === null || review === null) return null;
  if (projectEnvironment.isDismissed(dismissed, target, review.sha256)) return null;

  const onApprove = async () => {
    setPending(true);
    const result = await approve({
      environmentId: target.environmentId,
      input: {
        projectId: target.projectId,
        ...(threadId === null ? {} : { threadId }),
        sha256: review.sha256,
      },
    });
    setPending(false);
    if (result._tag === "Success" && !result.value.approved) {
      toastManager.add({
        type: "error",
        title: "Could not approve the .envrc",
        description: result.value.error,
      });
    }
    query.refresh();
  };
  const onTurnOff = async () => {
    const overrides = appAtomRegistry.get(serverEnvironment.configValueAtom(target.environmentId))
      ?.settings.projectSettingsOverrides[target.projectId];
    await updateSettings({
      environmentId: target.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [target.projectId]: { ...overrides, enableDirenvEnvironment: false },
          },
        },
      },
    });
    query.refresh();
  };

  const { changed } = review;
  return {
    id: `project-environment:${target.projectId}`,
    group: "environment",
    variant: changed ? "warning" : "info",
    icon: <TerminalSquareIcon />,
    title: changed
      ? "The project's .envrc changed since you approved it"
      : "This project has a direnv environment",
    description: review.tooLarge
      ? "This .envrc is too large to review here. Run direnv allow in the project to approve it."
      : changed
        ? "Agents keep the environment they started with until you approve the change."
        : "Load its .envrc for agents and setup scripts in this project and the worktrees T3 Code creates. It runs code on this machine.",
    children: review.tooLarge ? undefined : (
      <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed">
        {review.lines.map((line, index) => (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- lines repeat and never reorder
            key={index}
            className={cn(
              line.kind === "added" && "text-success",
              line.kind === "removed" && "text-destructive",
            )}
          >
            {changed ? (line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  ") : ""}
            {line.text}
          </div>
        ))}
      </pre>
    ),
    actions: canApprove ? (
      <>
        {canTurnOff ? (
          <Button size="xs" variant="ghost" disabled={pending} onClick={() => void onTurnOff()}>
            Turn off for project
          </Button>
        ) : null}
        {review.tooLarge ? null : (
          <Button size="xs" variant="default" disabled={pending} onClick={() => void onApprove()}>
            {changed ? "Approve change" : "Approve"}
          </Button>
        )}
      </>
    ) : undefined,
    dismissLabel: "Not now",
    onDismiss: () => projectEnvironment.dismiss(appAtomRegistry, target, review.sha256),
  };
}
