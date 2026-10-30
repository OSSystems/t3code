// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as DirenvEnvironment from "./DirenvEnvironment.ts";

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const TestLayer = DirenvEnvironment.layer.pipe(
  Layer.provide(
    Layer.succeed(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run: runMock })),
  ),
  Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
  Layer.provideMerge(NodeServices.layer),
);

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput>,
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

/** A project root holding an `.envrc`, and a nested directory a thread might run in. */
const makeProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-direnv-" });
  const nested = path.join(root, "packages", "app");
  yield* fileSystem.makeDirectory(nested, { recursive: true });
  yield* fileSystem.writeFileString(path.join(root, ".envrc"), "use flake\n");
  return { envrcPath: path.join(root, ".envrc"), nested };
});

afterEach(() => {
  runMock.mockReset();
});

describe("DirenvEnvironment.load", () => {
  it.effect("skips direnv when no .envrc governs the directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-direnv-" });
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      expect(yield* direnv.load(cwd)).toEqual({ _tag: "None" });
      expect(runMock).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("loads the exported variables from the nearest parent .envrc", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { nested } = yield* makeProject;
      // Reached through a symlink, as direnv does: the parent is the physical one.
      const elsewhere = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-direnv-link-" });
      const linked = path.join(elsewhere, "app");
      yield* fileSystem.symlink(nested, linked);
      runMock.mockReturnValueOnce(
        Effect.succeed(output({ stdout: '{"PATH":"/nix/store/x/bin:/usr/bin","OLD":null}' })),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      const result = yield* direnv.load(linked);

      expect(result).toEqual({
        _tag: "Loaded",
        diff: { PATH: "/nix/store/x/bin:/usr/bin", OLD: null },
        changed: true,
      });
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "direnv", args: ["export", "json"], cwd: linked }),
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reports a blocked .envrc instead of loading it", () =>
    Effect.gen(function* () {
      const { envrcPath, nested } = yield* makeProject;
      runMock.mockReturnValueOnce(
        Effect.succeed(
          output({
            // direnv still prints its own bookkeeping variables when blocked.
            stdout: '{"DIRENV_DIR":"-/project"}',
            stderr: `\u001b[31mdirenv: error ${envrcPath} is blocked. Run \`direnv allow\` to approve its content\u001b[0m\n`,
            code: ChildProcessSpawner.ExitCode(1),
          }),
        ),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      const result = yield* direnv.load(nested);

      expect(result).toEqual({
        _tag: "Failed",
        envrcPath,
        reason: "blocked",
        message: `${envrcPath} is blocked. Run \`direnv allow\` to approve its content`,
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("treats a missing direnv binary as no project environment", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      runMock.mockReturnValueOnce(
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "direnv",
            argumentCount: 2,
            cause: new Error("spawn direnv ENOENT"),
          }),
        ),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      expect(yield* direnv.load(nested)).toEqual({ _tag: "None" });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reports a timed-out load", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      runMock.mockReturnValueOnce(Effect.succeed(output({ code: null, timedOut: true })));
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      const result = yield* direnv.load(nested);

      expect(result).toMatchObject({ _tag: "Failed", reason: "timeout" });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("checks staleness against exactly the previously loaded environment", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      const previous = { PATH: "/nix/store/old/bin", STALE: null, DIRENV_DIFF: "v1" };
      runMock.mockReturnValueOnce(Effect.succeed(output({ stdout: "" })));
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      const result = yield* direnv.load(nested, previous);

      expect(result).toEqual({ _tag: "Loaded", diff: previous, changed: false });
      const input = runMock.mock.calls[0]?.[0];
      expect(input?.extendEnv).toBe(false);
      expect(input?.env?.PATH).toBe("/nix/store/old/bin");
      expect(input?.env && "STALE" in input.env).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps the diff relative to the server environment after a change", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      const previous = { PATH: "/nix/store/old/bin", FOO: "1", DIRENV_DIFF: "v1" };
      runMock.mockReturnValueOnce(
        Effect.succeed(output({ stdout: '{"PATH":"/nix/store/new/bin","DIRENV_DIFF":"v2"}' })),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      expect(yield* direnv.load(nested, previous)).toEqual({
        _tag: "Loaded",
        diff: { PATH: "/nix/store/new/bin", FOO: "1", DIRENV_DIFF: "v2" },
        changed: true,
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("shares one evaluation between concurrent loads of a directory", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      const release = yield* Deferred.make<void>();
      runMock.mockReturnValueOnce(
        Deferred.await(release).pipe(Effect.as(output({ stdout: '{"FOO":"bar"}' }))),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      const first = yield* Effect.forkChild(direnv.load(nested), { startImmediately: true });
      const second = yield* Effect.forkChild(direnv.load(nested), { startImmediately: true });
      yield* Deferred.succeed(release, undefined);

      expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(second));
      expect(runMock).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("DirenvEnvironment.allow", () => {
  it.effect("writes direnv's record for the given content and clears a deny", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { envrcPath } = yield* makeProject;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-direnv-data-" });
      const digest = (data: string) => NodeCrypto.createHash("sha256").update(data).digest("hex");
      const denyPath = path.join(dataDir, "deny", digest(`${envrcPath}\n`));
      yield* fileSystem.makeDirectory(path.dirname(denyPath), { recursive: true });
      yield* fileSystem.writeFileString(denyPath, `${envrcPath}\n`);
      runMock.mockReturnValueOnce(
        Effect.succeed(
          output({
            stdout: `Found RC path ${envrcPath}\nFound RC allowed 1\nFound RC allowPath ${path.join(dataDir, "allow", "current")}\n`,
          }),
        ),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      // The reviewed content, even though the file on disk now holds something else.
      expect(yield* direnv.allow(envrcPath, "use nix\n")).toEqual({ _tag: "Allowed" });
      expect(
        yield* fileSystem.readFileString(
          path.join(dataDir, "allow", digest(`${envrcPath}\nuse nix\n`)),
        ),
      ).toBe(`${envrcPath}\n`);
      expect(yield* fileSystem.exists(denyPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("DirenvEnvironment.inspect", () => {
  it.effect("trusts direnv's permission only for the content it judged", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { envrcPath, nested } = yield* makeProject;
      const digest = (data: string) => NodeCrypto.createHash("sha256").update(data).digest("hex");
      const status = (allowed: number, content: string) =>
        Effect.succeed(
          output({
            stdout: `Found RC path ${envrcPath}\nFound RC allowed ${allowed}\nFound RC allowPath /data/allow/${digest(`${envrcPath}\n${content}`)}\n`,
          }),
        );
      runMock
        .mockReturnValueOnce(status(0, "use flake\n"))
        .mockReturnValueOnce(status(2, "use flake\n"))
        // direnv saw approved content, but the file changed before T3 Code read it.
        .mockReturnValueOnce(status(0, "approved\n"));
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;
      const inspect = direnv.inspect(nested).pipe(Effect.map(Option.getOrNull));

      expect(yield* inspect).toEqual({
        path: envrcPath,
        content: "use flake\n",
        permission: "allowed",
      });
      expect((yield* inspect)?.permission).toBe("denied");
      expect((yield* inspect)?.permission).toBe("blocked");
      expect(yield* fileSystem.readFileString(envrcPath)).toBe("use flake\n");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("applyDirenvEnvironment", () => {
  const serverEnv = { PATH: "/usr/bin", HOME: "/home/user", STALE: "1" };

  it("sets and unsets variables over the server environment", () => {
    expect(
      DirenvEnvironment.applyDirenvEnvironment(
        serverEnv,
        { PATH: "/nix/store/x/bin:/usr/bin", STALE: null, IN_NIX_SHELL: "impure" },
        serverEnv,
      ),
    ).toEqual({ PATH: "/nix/store/x/bin:/usr/bin", HOME: "/home/user", IN_NIX_SHELL: "impure" });
  });

  it("keeps values the provider instance configured itself", () => {
    const instanceEnv = { ...serverEnv, CLAUDE_CONFIG_DIR: "/home/user/.claude-work" };

    expect(
      DirenvEnvironment.applyDirenvEnvironment(
        instanceEnv,
        { CLAUDE_CONFIG_DIR: "/project/.claude", FOO: "bar" },
        serverEnv,
      ),
    ).toEqual({ ...instanceEnv, FOO: "bar" });
  });
});
