import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { projectEnvironmentIndicator } from "@t3tools/client-runtime/state/projectEnvironment";
import { useNavigate } from "@tanstack/react-router";
import { TerminalSquareIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projectEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

export function useThreadDirenvStatus(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId | null,
) {
  const target = { environmentId, projectId, threadId };
  const query = useEnvironmentQuery(projectEnvironment.statusAtom(target));
  return { target, query, indicator: projectEnvironmentIndicator(query.data) };
}

/** Whether the thread's direnv environment loads; render only when `indicator` is set. */
export function ThreadDirenvControl(props: {
  readonly status: ReturnType<typeof useThreadDirenvStatus>;
}) {
  const navigate = useNavigate();
  const { target, query, indicator } = props.status;
  if (indicator === null) return null;
  return (
    <ThreadDetailsControl
      type="button"
      variant="ghost"
      size="sm"
      part="row"
      onClick={() => {
        if (indicator === "approval") {
          projectEnvironment.reviewAgain(appAtomRegistry, target);
          query.refresh();
          return;
        }
        void navigate({ to: "/settings/worktrees" });
      }}
    >
      <TerminalSquareIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
      <span className={cn("flex-1 text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>direnv</span>
      <span
        className={cn(
          "text-xs",
          indicator === "on" && "text-success",
          indicator === "approval" && "text-warning",
          indicator === "off" && "text-muted-foreground",
        )}
      >
        {indicator === "on" ? "On" : indicator === "approval" ? "Needs approval" : "Off"}
      </span>
    </ThreadDetailsControl>
  );
}
