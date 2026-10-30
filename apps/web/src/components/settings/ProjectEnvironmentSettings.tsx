import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ProjectEnvironmentSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection id="project-environment" title="direnv environment">
      <SettingsRow
        serverScoped
        settingKeys={["enableDirenvEnvironment"]}
        {...searchableSetting("project-direnv")}
        description="Load the project's .envrc for agents and worktree setup scripts. T3 Code asks before loading each new .envrc."
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
    </SettingsSection>
  );
}
