import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { projectEnvironment } from "../../state/projectEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULT_DEV_SHELL = "";

export function ProjectEnvironmentSettings() {
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
    <SettingsSection id="project-environment" title="direnv environment">
      <SettingsRow
        serverScoped
        settingKeys={["enableDirenvEnvironment"]}
        {...searchableSetting("project-direnv")}
        description="Load the project's .envrc for agents, worktree setup scripts, and Git hooks. T3 Code asks before loading each new .envrc."
        resetAction={
          settings.enableDirenvEnvironment !== DEFAULT_UNIFIED_SETTINGS.enableDirenvEnvironment ? (
            <SettingResetButton
              label="direnv environment"
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
            aria-label="Load direnv environment"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["trustDirenvChanges"]}
        {...searchableSetting("project-direnv-trust")}
        description="Approve changes to an approved .envrc without asking. Only for repositories you fully control."
        resetAction={
          settings.trustDirenvChanges !== DEFAULT_UNIFIED_SETTINGS.trustDirenvChanges ? (
            <SettingResetButton
              label="trust .envrc changes"
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
            aria-label="Trust .envrc changes"
          />
        }
      />
      {project !== undefined && devShellOptions.length > 0 ? (
        <SettingsRow
          serverScoped
          settingKeys={["direnvDevShell"]}
          {...searchableSetting("project-direnv-dev-shell")}
          description="The flake dev shell use flake loads in T3 Code. Your own terminal keeps the shell the .envrc names."
          resetAction={
            devShell !== null ? (
              <SettingResetButton
                label="development shell"
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
              <SelectTrigger size="sm" aria-label="Development shell">
                <SelectValue>
                  {(value: string | null) =>
                    value === null || value === DEFAULT_DEV_SHELL ? "Default" : value
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={DEFAULT_DEV_SHELL}>Default (from .envrc)</SelectItem>
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
