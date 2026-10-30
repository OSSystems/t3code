import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projectEnvironment";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  // Each run and each settings change; a run's start is when a changed .envrc surfaces.
  refreshSignal: ({ environmentId, projectId, threadId }) =>
    Atom.make((get) => {
      const settings = get(serverEnvironment.configValueAtom(environmentId))?.settings;
      const run =
        threadId === null
          ? null
          : get(environmentThreadShells.quietThreadShellAtom({ environmentId, threadId }))
              ?.latestRun;
      return JSON.stringify([
        settings?.enableDirenvEnvironment,
        settings?.trustDirenvChanges,
        settings?.projectSettingsOverrides[projectId],
        run?.runId,
        run?.status,
      ]);
    }),
});
