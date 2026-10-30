import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { projectEnvironmentReview } from "@t3tools/client-runtime/state/projectEnvironment";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projectEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

// useId repeats across remounts at the same spot; each visit needs its own key.
let visits = 0;
const nextVisit = () => ++visits;

/**
 * Asks once per `.envrc` content before T3 Code loads a project's direnv
 * environment, and again with a diff when it changes. Without a details panel
 * to return to, "Not now" only lasts for this visit to the screen.
 */
export function ProjectEnvironmentBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  /** Spacing around the banner, applied only while it shows. */
  readonly className?: string;
}) {
  const target = {
    environmentId: props.environmentId,
    projectId: props.projectId,
    threadId: props.threadId,
  };
  const query = useEnvironmentQuery(projectEnvironment.statusAtom(target));
  const approve = useAtomCommand(projectEnvironment.approve, "approve .envrc");
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "turn off direnv");
  const canApprove = useAtomValue(projectEnvironment.approve.permissionAtom(props.environmentId));
  const canTurnOff = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const [visit] = useState(nextVisit);
  const dismissed = useAtomValue(projectEnvironment.dismissedAtom).dismissed;
  const [pending, setPending] = useState(false);
  const review = projectEnvironmentReview(query.data);
  if (review === null) return null;
  const dismissKey = `${review.sha256}:${visit}`;
  if (projectEnvironment.isDismissed(dismissed, target, dismissKey)) return null;

  const { changed } = review;
  const onApprove = async () => {
    setPending(true);
    const result = await approve({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        ...(props.threadId === null ? {} : { threadId: props.threadId }),
        sha256: review.sha256,
      },
    });
    setPending(false);
    if (result._tag === "Success" && !result.value.approved) {
      Alert.alert("Could not approve the .envrc", result.value.error);
    }
    query.refresh();
  };
  const onTurnOff = async () => {
    const overrides = appAtomRegistry.get(serverEnvironment.configValueAtom(props.environmentId))
      ?.settings.projectSettingsOverrides[props.projectId];
    await updateSettings({
      environmentId: props.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [props.projectId]: { ...overrides, enableDirenvEnvironment: false },
          },
        },
      },
    });
    query.refresh();
  };

  return (
    <View className={props.className}>
      <View
        className={cn(
          "rounded-2xl border px-3.5 py-3",
          changed ? "border-warning-border bg-warning" : "border-border bg-card",
        )}
      >
        <Text className="font-t3-medium text-sm">
          {changed ? "The project's .envrc changed" : "direnv environment found"}
        </Text>
        <Text className="mt-0.5 text-xs text-foreground-muted">
          {review.tooLarge
            ? "This .envrc is too large to review here. Run direnv allow in the project."
            : changed
              ? "Agents keep their environment until you approve the change."
              : "Load its .envrc for agents and worktree setup on this machine?"}
        </Text>
        {review.tooLarge ? null : (
          <ScrollView className="mt-2 max-h-32 rounded-lg bg-subtle px-2.5 py-2">
            {review.lines.map((line, index) => (
              <Text
                // oxlint-disable-next-line react/no-array-index-key -- lines repeat and never reorder
                key={index}
                className={cn(
                  "font-mono text-2xs",
                  line.kind === "added" && "text-adaptive-emerald-600-400",
                  line.kind === "removed" && "text-danger-foreground",
                )}
              >
                {changed
                  ? line.kind === "added"
                    ? "+ "
                    : line.kind === "removed"
                      ? "- "
                      : "  "
                  : ""}
                {line.text}
              </Text>
            ))}
          </ScrollView>
        )}
        <View className="mt-2 flex-row flex-wrap justify-end gap-2">
          <Button
            label="Not now"
            tone="secondary"
            onPress={() => projectEnvironment.dismiss(appAtomRegistry, target, dismissKey)}
          />
          {canApprove && canTurnOff ? (
            <Button
              label="Turn off"
              tone="secondary"
              disabled={pending}
              onPress={() => void onTurnOff()}
            />
          ) : null}
          {canApprove && !review.tooLarge ? (
            <Button
              label={changed ? "Approve change" : "Approve"}
              tone="primary"
              disabled={pending}
              onPress={() => void onApprove()}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}
