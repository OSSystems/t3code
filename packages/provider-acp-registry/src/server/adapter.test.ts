import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import { resolveAcpRegistrySpawn } from "./adapter.ts";
import type * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

// Like the real resolver, which puts its managed bin directory ahead of the given PATH.
const catalog = {
  resolve: (_settings: unknown, _cwd: string, environment?: NodeJS.ProcessEnv) =>
    Effect.succeed({
      spawn: {
        command: "agent",
        args: [],
        env: { PATH: `/managed/bin:${environment?.PATH ?? ""}` },
      },
    }),
} as unknown as AcpRegistrySupport.AcpRegistryCatalog["Service"];
const settings = Schema.decodeSync(AcpRegistrySettings)({});

describe("resolveAcpRegistrySpawn", () => {
  it.effect("launches with direnv's PATH behind the managed bin and without unset variables", () =>
    Effect.gen(function* () {
      const spawn = yield* resolveAcpRegistrySpawn({
        catalog,
        settings,
        cwd: "/project",
        environment: { ...process.env },
        direnvEnvironment: { PATH: "/nix/store/tools/bin:/usr/bin", HOME: null },
        processEnvironment: undefined,
      });
      expect(spawn.env?.PATH).toBe("/managed/bin:/nix/store/tools/bin:/usr/bin");
      expect(spawn.env).not.toHaveProperty("HOME");
      expect(spawn.extendEnv).toBe(false);
    }),
  );
});
