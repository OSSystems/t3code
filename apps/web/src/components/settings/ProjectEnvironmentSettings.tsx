import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ProjectEnvironmentSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection id="project-environment" title={gt("direnv environment")}>
      <SettingsRow
        serverScoped
        settingKeys={["enableDirenvEnvironment"]}
        {...searchableSetting("project-direnv")}
        description={gt(
          "Load the project's .envrc for agents and worktree setup scripts. T3 Code asks before loading each new .envrc.",
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
    </SettingsSection>
  );
}
