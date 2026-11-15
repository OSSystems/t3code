import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { T, useGT } from "gt-react";

import { projectEnvironment } from "../../state/projectEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULT_DEV_SHELL = "";

export function ProjectEnvironmentSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const project = targets.find((target) => target.projectId !== null);
  const devShellsQuery = useEnvironmentQuery(
    project?.projectId
      ? projectEnvironment.devShellsAtom({
          environmentId: project.environmentId,
          projectId: project.projectId,
        })
      : null,
  );
  const devShells = devShellsQuery.data?.shells ?? [];
  const devShell = settings.direnvDevShell;
  const devShellOptions =
    devShell !== null && !devShells.includes(devShell) ? [...devShells, devShell] : devShells;
  return (
    <SettingsSection id="project-environment" title={gt("direnv environment")}>
      <SettingsRow
        serverScoped
        settingKeys={["enableDirenvEnvironment"]}
        {...searchableSetting("project-direnv")}
        description={gt(
          "Load the project's .envrc for agents, worktree setup scripts, and Git hooks. T3 Code asks before loading each new .envrc.",
        )}
        resetAction={
          settings.enableDirenvEnvironment !== DEFAULT_UNIFIED_SETTINGS.enableDirenvEnvironment ? (
            <SettingResetButton
              ariaLabel={gt("Reset direnv environment to default")}
              onClick={() =>
                updateSettings({
                  enableDirenvEnvironment: DEFAULT_UNIFIED_SETTINGS.enableDirenvEnvironment,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["enableDirenvEnvironment"]}
            checked={settings.enableDirenvEnvironment}
            onCheckedChange={(checked) =>
              updateSettings({ enableDirenvEnvironment: Boolean(checked) })
            }
            aria-label={gt("Load direnv environment")}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["trustDirenvChanges"]}
        {...searchableSetting("project-direnv-trust")}
        description={gt(
          "Approve changes to an approved .envrc without asking. Only for repositories you fully control.",
        )}
        resetAction={
          settings.trustDirenvChanges !== DEFAULT_UNIFIED_SETTINGS.trustDirenvChanges ? (
            <SettingResetButton
              ariaLabel={gt("Reset trust .envrc changes to default")}
              onClick={() =>
                updateSettings({ trustDirenvChanges: DEFAULT_UNIFIED_SETTINGS.trustDirenvChanges })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["trustDirenvChanges"]}
            checked={settings.trustDirenvChanges}
            disabled={!settings.enableDirenvEnvironment}
            onCheckedChange={(checked) => updateSettings({ trustDirenvChanges: Boolean(checked) })}
            aria-label={gt("Trust .envrc changes")}
          />
        }
      />
      {project !== undefined && devShellOptions.length > 0 ? (
        <SettingsRow
          serverScoped
          settingKeys={["direnvDevShell"]}
          {...searchableSetting("project-direnv-dev-shell")}
          description={gt(
            "The flake dev shell use flake loads in T3 Code. Your own terminal keeps the shell the .envrc names.",
          )}
          resetAction={
            devShell !== null ? (
              <SettingResetButton
                ariaLabel={gt("Reset development shell to default")}
                onClick={() => updateSettings({ direnvDevShell: null })}
              />
            ) : null
          }
          control={
            <Select
              value={devShell ?? DEFAULT_DEV_SHELL}
              disabled={!settings.enableDirenvEnvironment}
              onValueChange={(value) =>
                updateSettings({
                  direnvDevShell: value === DEFAULT_DEV_SHELL || value === null ? null : value,
                })
              }
            >
              <SelectTrigger size="sm" aria-label={gt("Development shell")}>
                <SelectValue>
                  {(value: string | null) =>
                    value === null || value === DEFAULT_DEV_SHELL
                      ? gt("Default", { $context: "default flake dev shell" })
                      : value
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={DEFAULT_DEV_SHELL}>
                  <T>Default (from .envrc)</T>
                </SelectItem>
                {devShellOptions.map((shell) => (
                  <SelectItem key={shell} value={shell}>
                    {shell}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
