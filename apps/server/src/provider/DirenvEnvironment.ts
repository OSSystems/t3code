// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export {
  applyDirenvEnvironment,
  clearAllThreadDirenvEnvironments,
  type DirenvEnvironmentDiff,
  readThreadDirenvEnvironment,
  setThreadDirenvEnvironment,
  withThreadDirenvEnvironment,
} from "@t3tools/provider-core/server/direnvEnvironment";
import {
  applyDirenvEnvironment,
  type DirenvEnvironmentDiff,
} from "@t3tools/provider-core/server/direnvEnvironment";

export type DirenvFailureReason = "blocked" | "timeout" | "failed";

export interface DirenvLoadOptions {
  /** Load this flake dev shell where the `.envrc` runs `use flake`. */
  readonly devShell?: string | undefined;
}

/**
 * Set in a diff loaded with a dev shell, so a later staleness check knows which shell it holds.
 * The provider sees it too, which tells an agent which shell it runs in.
 */
export const DEV_SHELL_VARIABLE = "T3CODE_DIRENV_DEV_SHELL";
const USER_CONFIG_VARIABLE = "T3CODE_DIRENV_USER_CONFIG";

/** `use flake [ref]` in an `.envrc`, with its flake reference when given. */
const USES_FLAKE_REF = /^\s*use\s+flake(?:[ \t]+([^\s-][^\s]*))?/m;
const DEV_SHELLS_TIMEOUT = "1 minute";
const decodeDevShells = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

/**
 * direnv's config directory while a dev shell is chosen. It loads the user's own configuration
 * (nix-direnv included), then wraps `use_flake` to load the chosen shell. That shell caches its
 * profile in its own layout directory: nix-direnv deletes the other profiles in the directory it
 * writes, which would otherwise evict the shell the user's terminal loads, and back again.
 */
const DEV_SHELL_DIRENVRC = `# Written by T3 Code for the dev shell chosen in its project settings.
_t3code_config=\${${USER_CONFIG_VARIABLE}:-}
for _t3code_lib in "$_t3code_config/lib/"*.sh; do
  [[ -f $_t3code_lib ]] && source "$_t3code_lib"
done
if [[ -f $_t3code_config/direnvrc ]]; then
  source "$_t3code_config/direnvrc"
elif [[ -f $HOME/.direnvrc ]]; then
  source "$HOME/.direnvrc"
fi
unset _t3code_config _t3code_lib
if [[ -n \${${DEV_SHELL_VARIABLE}:-} ]] && declare -F use_flake >/dev/null; then
  _t3code_use_flake_definition=$(declare -f use_flake)
  eval "_t3code_use_flake\${_t3code_use_flake_definition#use_flake}"
  unset _t3code_use_flake_definition
  use_flake() {
    local flake_expr=\${1:-.}
    if [[ $flake_expr == -* ]]; then
      set -- . "$@"
      flake_expr=.
    fi
    local layout_dir
    layout_dir=$(direnv_layout_dir)
    local direnv_layout_dir="$layout_dir/t3code-dev-shell-\${${DEV_SHELL_VARIABLE}}"
    _t3code_use_flake "\${flake_expr%%#*}#\${${DEV_SHELL_VARIABLE}}" "\${@:2}"
  }
fi
`;

export type DirenvLoadResult =
  /** No `.envrc` governs the directory, or direnv is not installed. */
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Loaded";
      /** The full diff over the server's environment, bookkeeping variables included. */
      readonly diff: DirenvEnvironmentDiff;
      /** False when direnv reported `previous` as still current. */
      readonly changed: boolean;
    }
  | {
      readonly _tag: "Failed";
      readonly envrcPath: string;
      readonly reason: DirenvFailureReason;
      readonly message: string;
    };

export type DirenvLoadFailure = Extract<DirenvLoadResult, { readonly _tag: "Failed" }>;

export interface DirenvEnvrc {
  readonly path: string;
  readonly content: string;
  /** direnv's own record for this content at this path; `denied` came from `direnv deny`. */
  readonly permission: "allowed" | "blocked" | "denied";
}

interface DirenvStatus {
  readonly rcPath: string;
  readonly allowed: number;
  readonly allowPath: string;
}

export type DirenvAllowResult =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Failed"; readonly message: string };

/**
 * Loads the direnv environment a shell would get in a directory, so provider
 * sessions see the same project tools (Nix dev shells, devenv, mise, ...) a
 * terminal does. Trust stays with direnv: a blocked `.envrc` is reported and
 * only allowed when the user asks for it.
 */
export class DirenvEnvironment extends Context.Service<
  DirenvEnvironment,
  {
    /**
     * Load the environment for `cwd`. With `previous` (a diff this service
     * returned earlier), this is the shell hook's cheap staleness check: direnv
     * compares the files it watches, such as `.envrc`, its allow record and
     * `flake.lock`, and only re-evaluates when one changed.
     */
    readonly load: (
      cwd: string,
      previous?: DirenvEnvironmentDiff,
      options?: DirenvLoadOptions,
    ) => Effect.Effect<DirenvLoadResult>;
    /**
     * The flake dev shells for the current system, read from the flake `use flake` loads in
     * `cwd`'s `.envrc`; empty without one or when Nix cannot evaluate it.
     */
    readonly devShells: (cwd: string) => Effect.Effect<ReadonlyArray<string>>;
    /**
     * Allow `content` at `envrcPath`, as `direnv allow` would for that file. Writing direnv's
     * record for the given bytes, rather than running `direnv allow` on whatever the path
     * holds by then, means a file replaced after review stays blocked.
     */
    readonly allow: (envrcPath: string, content: string) => Effect.Effect<DirenvAllowResult>;
    /** The `.envrc` governing `cwd`; none without one, on Windows, or without direnv. */
    readonly inspect: (cwd: string) => Effect.Effect<Option.Option<DirenvEnvrc>>;
  }
>()("t3/provider/DirenvEnvironment") {}

const DIRENV_FAILURE_MESSAGES: Record<DirenvFailureReason, string> = {
  blocked: "The project's .envrc needs your approval, so its direnv environment was not loaded.",
  timeout: "Loading the project's direnv environment timed out.",
  failed: "The project's direnv environment failed to load.",
};

/** What a thread shows for a failed load; a blocked `.envrc` offers to review it. */
export function direnvFailureNotice(failure: DirenvLoadFailure): {
  readonly message: string;
  readonly detail: string;
  readonly action?: { readonly type: "direnv.allow" };
} {
  return {
    message: DIRENV_FAILURE_MESSAGES[failure.reason],
    detail: failure.message,
    ...(failure.reason === "blocked" ? { action: { type: "direnv.allow" } as const } : {}),
  };
}

// A first `nix develop` evaluation can legitimately take minutes.
const DIRENV_TIMEOUT = "5 minutes";

const decodeDirenvExport = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
);

const ANSI_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

/** The `direnv: error ...` lines, or the last stderr line when there are none. */
function direnvErrorMessage(stderr: string): string {
  const lines = stderr
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errors = lines.filter((line) => line.startsWith("direnv: error"));
  return (errors.length > 0 ? errors.join("\n") : (lines.at(-1) ?? "direnv failed")).replace(
    /^direnv: (error )?/,
    "",
  );
}

const make = Effect.fn("DirenvEnvironment.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const devShellConfigDir = path.join(stateDir, "direnv-dev-shell");
  const hostEnv = yield* HostProcess.Environment;
  const userConfigDir =
    hostEnv.DIRENV_CONFIG ??
    path.join(hostEnv.XDG_CONFIG_HOME ?? path.join(hostEnv.HOME ?? "", ".config"), "direnv");

  /** Writes the wrapper config each time, so a server update ships its new version. */
  const devShellConfig = Effect.fn("DirenvEnvironment.devShellConfig")(function* () {
    yield* fileSystem.makeDirectory(devShellConfigDir, { recursive: true });
    yield* fileSystem.writeFileString(path.join(devShellConfigDir, "direnvrc"), DEV_SHELL_DIRENVRC);
    // direnv reads its settings, such as `whitelist` and `load_dotenv`, from the config dir.
    for (const name of ["direnv.toml", "config.toml"]) {
      const link = path.join(devShellConfigDir, name);
      yield* fileSystem.remove(link, { force: true });
      const target = path.join(userConfigDir, name);
      if (yield* fileSystem.exists(target)) yield* fileSystem.symlink(target, link);
    }
  });

  const findEnvrc = Effect.fn("DirenvEnvironment.findEnvrc")(function* (cwd: string) {
    // direnv walks the physical directory's ancestors, not the symlinked ones.
    let directory = yield* fileSystem
      .realPath(cwd)
      .pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
    while (true) {
      const candidate = path.join(directory, ".envrc");
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(candidate);
      }
      const parent = path.dirname(directory);
      if (parent === directory) return Option.none<string>();
      directory = parent;
    }
  });

  const loadUncached = Effect.fn("DirenvEnvironment.load")(function* (
    cwd: string,
    previous: DirenvEnvironmentDiff | undefined,
    devShell: string | undefined,
  ) {
    if (platform === "win32") return { _tag: "None" } as const;
    const envrcPath = yield* findEnvrc(cwd);
    // Without a previous load there is nothing for direnv to unload either.
    if (Option.isNone(envrcPath) && previous === undefined) return { _tag: "None" } as const;

    const failed = (reason: DirenvFailureReason, message: string) =>
      ({
        _tag: "Failed",
        envrcPath: Option.getOrElse(envrcPath, () => path.join(cwd, ".envrc")),
        reason,
        message,
      }) as const;
    let devShellEnv: Record<string, string> = {};
    if (devShell !== undefined) {
      const written = yield* devShellConfig().pipe(Effect.result);
      if (written._tag === "Failure") return failed("failed", written.failure.message);
      devShellEnv = {
        DIRENV_CONFIG: devShellConfigDir,
        [USER_CONFIG_VARIABLE]: userConfigDir,
        [DEV_SHELL_VARIABLE]: devShell,
      };
    }
    const result = yield* runner
      .run({
        command: "direnv",
        args: ["export", "json"],
        cwd,
        // direnv diffs against the environment it is given, so a staleness
        // check must see exactly what the previous load produced.
        ...(previous
          ? {
              env: { ...applyDirenvEnvironment(process.env, previous), ...devShellEnv },
              extendEnv: false,
            }
          : devShell !== undefined
            ? { env: devShellEnv }
            : {}),
        timeout: DIRENV_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      // Having an `.envrc` without direnv installed is common in shared repos.
      return result.failure._tag === "ProcessSpawnError"
        ? ({ _tag: "None" } as const)
        : failed("failed", result.failure.message);
    }
    const output = result.success;
    if (output.timedOut)
      return failed("timeout", `direnv did not finish within ${DIRENV_TIMEOUT}.`);
    if (output.code !== 0) {
      const message = direnvErrorMessage(output.stderr);
      return failed(message.includes(" is blocked") ? "blocked" : "failed", message);
    }
    // Empty output means the environment is already current for this directory.
    if (output.stdout.trim().length === 0) {
      return { _tag: "Loaded", diff: previous ?? {}, changed: false } as const;
    }
    const delta = decodeDirenvExport(output.stdout);
    if (Option.isNone(delta)) {
      return failed("failed", "direnv printed an environment T3 Code could not read.");
    }
    // `delta` is relative to the previous environment; keep the diff relative
    // to the server's own environment.
    return {
      _tag: "Loaded",
      diff: {
        ...previous,
        ...delta.value,
        ...(devShell === undefined ? {} : { [DEV_SHELL_VARIABLE]: devShell }),
      },
      changed: true,
    } as const;
  });

  // Threads started together in one checkout share a single evaluation.
  const inFlight = new Map<string, Deferred.Deferred<DirenvLoadResult>>();
  const load = (cwd: string, previous?: DirenvEnvironmentDiff, options?: DirenvLoadOptions) =>
    Effect.suspend(() => {
      const devShell = options?.devShell;
      // A diff of another shell is no base for direnv's staleness check.
      if (previous !== undefined && (previous[DEV_SHELL_VARIABLE] ?? undefined) !== devShell) {
        previous = undefined;
      }
      // DIRENV_DIFF identifies the environment a staleness check starts from.
      const key = `${path.resolve(cwd)}\0${previous?.DIRENV_DIFF ?? ""}\0${devShell ?? ""}`;
      const existing = inFlight.get(key);
      if (existing) return Deferred.await(existing);
      const deferred = Deferred.makeUnsafe<DirenvLoadResult>();
      inFlight.set(key, deferred);
      return loadUncached(cwd, previous, devShell).pipe(
        Deferred.into(deferred),
        Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
        Effect.andThen(Deferred.await(deferred)),
      );
    });

  // Mirrors direnv's rc.go: sha256 of the path, a newline and the content names the allow
  // record, which holds the path; the deny record is named by the path alone.
  const digest = (data: string) => NodeCrypto.createHash("sha256").update(data).digest("hex");

  /** direnv's own view of the `.envrc` governing `cwd`: its physical path and records. */
  const readStatus = Effect.fn("DirenvEnvironment.readStatus")(function* (cwd: string) {
    const result = yield* runner
      .run({ command: "direnv", args: ["status"], cwd })
      .pipe(Effect.result);
    if (result._tag === "Failure") return Option.none<DirenvStatus>();
    const field = (name: string) =>
      new RegExp(`^Found RC ${name} (.+)$`, "m").exec(result.success.stdout)?.[1]?.trim();
    const rcPath = field("path");
    const allowPath = field("allowPath");
    if (rcPath === undefined || allowPath === undefined) return Option.none<DirenvStatus>();
    return Option.some({ rcPath, allowed: Number(field("allowed")), allowPath });
  });

  const allow = Effect.fn("DirenvEnvironment.allow")(function* (
    envrcPath: string,
    content: string,
  ) {
    const failed = (message: string) => ({ _tag: "Failed", message }) as const;
    const status = yield* readStatus(path.dirname(envrcPath));
    if (Option.isNone(status) || status.value.rcPath !== envrcPath) {
      return failed("direnv did not report the .envrc that was reviewed.");
    }
    const allowDir = path.dirname(status.value.allowPath);
    const written = yield* fileSystem
      .makeDirectory(allowDir, { recursive: true })
      .pipe(
        Effect.andThen(
          fileSystem.writeFileString(
            path.join(allowDir, digest(`${envrcPath}\n${content}`)),
            `${envrcPath}\n`,
          ),
        ),
        Effect.andThen(
          fileSystem
            .remove(path.join(path.dirname(allowDir), "deny", digest(`${envrcPath}\n`)))
            .pipe(Effect.catchTags({ PlatformError: () => Effect.void })),
        ),
        Effect.result,
      );
    return written._tag === "Failure"
      ? failed(written.failure.message)
      : ({ _tag: "Allowed" } as const);
  });

  const inspect = Effect.fn("DirenvEnvironment.inspect")(function* (cwd: string) {
    if (platform === "win32") return Option.none<DirenvEnvrc>();
    // Cheap check first, so projects without an `.envrc` never spawn direnv.
    if (Option.isNone(yield* findEnvrc(cwd))) return Option.none<DirenvEnvrc>();
    // Having an `.envrc` without direnv installed is common in shared repos.
    const status = yield* readStatus(cwd);
    if (Option.isNone(status)) return Option.none<DirenvEnvrc>();
    const { rcPath, allowed, allowPath } = status.value;
    const content = yield* fileSystem
      .readFileString(rcPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (content === undefined) return Option.none<DirenvEnvrc>();
    // direnv judged the file as it was when it ran; only trust that for the same bytes.
    const sameContent = path.basename(allowPath) === digest(`${rcPath}\n${content}`);
    return Option.some<DirenvEnvrc>({
      path: rcPath,
      content,
      // direnv reports 0 for allowed, 1 for not allowed and 2 for denied.
      permission: allowed === 2 ? "denied" : allowed === 0 && sameContent ? "allowed" : "blocked",
    });
  });

  const devShells = Effect.fn("DirenvEnvironment.devShells")(function* (cwd: string) {
    const envrcPath = yield* findEnvrc(cwd);
    if (Option.isNone(envrcPath)) return [];
    const content = yield* fileSystem
      .readFileString(envrcPath.value)
      .pipe(Effect.orElseSucceed(() => ""));
    const flake = USES_FLAKE_REF.exec(content);
    if (flake === null) return [];
    const flakeRef = (flake[1] ?? ".").split("#")[0] || ".";
    const result = yield* runner
      .run({
        command: "nix",
        args: [
          "--extra-experimental-features",
          "nix-command flakes",
          "eval",
          "--impure",
          "--json",
          `${flakeRef}#devShells`,
          "--apply",
          "shells: builtins.attrNames (shells.${builtins.currentSystem} or { })",
        ],
        cwd: path.dirname(envrcPath.value),
        timeout: DEV_SHELLS_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.result);
    if (result._tag === "Failure" || result.success.timedOut || result.success.code !== 0) {
      return [];
    }
    return Option.getOrElse(decodeDevShells(result.success.stdout), () => []);
  });

  return DirenvEnvironment.of({ load, allow, inspect, devShells });
});

export const layer = Layer.effect(DirenvEnvironment, make());
