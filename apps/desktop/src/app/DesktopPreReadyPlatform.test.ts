import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  getSwitchValueMock,
  hasSwitchMock,
  registerSchemesMock,
  setDesktopNameMock,
  mkdirSyncMock,
  writeFileSyncMock,
  copyFileSyncMock,
  execFileSyncMock,
  readFileSyncMock,
  symlinkSyncMock,
  existsSyncMock,
  rmSyncMock,
  symlinkPaths,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  symlinkSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  symlinkPaths: new Set<string>(),
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: setDesktopNameMock,
    getVersion: () => "0.0.37",
    isPackaged: true,
    getAppPath: () => "/tmp/.mount_T3/resources/app.asar",
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
    },
  },
  protocol: {
    registerSchemesAsPrivileged: registerSchemesMock,
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  copyFileSync: copyFileSyncMock,
  symlinkSync: symlinkSyncMock,
  existsSync: existsSyncMock,
  rmSync: rmSyncMock,
  lstatSync: (path: string) =>
    existsSyncMock(path) ? { isFile: () => !symlinkPaths.has(path) } : undefined,
  realpathSync: (path: string) =>
    path === "/opt/share/applications/com.t3tools.T3Code.desktop"
      ? "/xdg/applications/com.t3tools.T3Code.desktop"
      : path.replace("/xdg-alias/", "/xdg/"),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    setDesktopNameMock.mockReset();
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    copyFileSyncMock.mockReset();
    execFileSyncMock.mockReset();
    readFileSyncMock.mockReset().mockReturnValue("{}");
    symlinkSyncMock.mockReset();
    existsSyncMock.mockReset().mockReturnValue(false);
    rmSyncMock.mockReset();
    symlinkPaths.clear();
  });

  it.effect("persists Linux scaling synchronously across relaunches and settings rewrites", () => {
    vi.stubEnv("T3CODE_HOME", "/isolated");
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    const settingsPath = "/isolated/userdata/desktop-settings.json";
    const files = new Map([[settingsPath, "{}"]]);
    const commandLine = new Map<string, string>();
    readFileSyncMock.mockImplementation((path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string) => {
      files.set(path, contents);
    });
    hasSwitchMock.mockImplementation((name: string) => commandLine.has(name));
    getSwitchValueMock.mockImplementation((name: string) => commandLine.get(name) ?? "");
    appendSwitchMock.mockImplementation((name: string, value: string) => {
      commandLine.set(name, value);
    });
    const launch = Effect.gen(function* () {
      const startup = Promise.resolve().then(() => commandLine.get("force-device-scale-factor"));
      yield* DesktopPreReadyPlatform.make;
      return yield* Effect.promise(() => startup);
    });

    return Effect.gen(function* () {
      for (const explicitScale of ["1.75", "1"]) {
        commandLine.clear();
        commandLine.set("force-device-scale-factor", explicitScale);
        appendSwitchMock.mockClear();
        assert.equal(yield* launch, explicitScale);
        assert.isFalse(
          appendSwitchMock.mock.calls.some(([name]) => name === "force-device-scale-factor"),
        );

        // The settings service discards fields it does not own when rewriting its document.
        files.set(settingsPath, JSON.stringify({ linuxPasswordStore: "basic" }));
        commandLine.clear();
        assert.equal(yield* launch, explicitScale);
      }
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect.each([
    { previousEntry: undefined, label: "missing" },
    { previousEntry: 'Exec="/Applications/deleted-previous.AppImage" %U', label: "stale" },
  ])("prepares a $label Linux desktop entry before startup yields", ({ previousEntry }) => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    getSwitchValueMock.mockReturnValue("");
    let desktopName = "t3code.desktop";
    let desktopEntry = previousEntry;
    let iconInstalled = false;
    const iconSource = "/tmp/.mount_T3/resources/app.asar/apps/desktop/prod-resources/icon.png";
    const iconPath = "/xdg/icons/com.t3tools.T3Code.desktop.png";
    const iconBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === iconSource) return iconBytes;
      return "{}";
    });
    setDesktopNameMock.mockImplementation((name: string) => {
      desktopName = name;
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string | Buffer) => {
      if (path === "/xdg/applications/com.t3tools.T3Code.desktop") desktopEntry = String(contents);
      if (path === iconPath) iconInstalled = Buffer.compare(Buffer.from(contents), iconBytes) === 0;
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const portalIdentity = Promise.resolve().then(() => ({
          desktopName,
          desktopEntry,
          iconInstalled,
        }));
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provide(
              DesktopConfig.layerTest({
                XDG_DATA_HOME: "/xdg",
                APPIMAGE: "/Applications/current.AppImage",
              }),
            ),
          ),
        );
        const identity = yield* Effect.promise(() => portalIdentity);
        assert.equal(identity.desktopName, "com.t3tools.T3Code.desktop");
        assert.include(identity.desktopEntry ?? "", "Exec=/Applications/current.AppImage %U");
        assert.include(identity.desktopEntry ?? "", "Name=T3 Code (Beta)");
        assert.notInclude(identity.desktopEntry ?? "", "MimeType=");
        assert.include(
          identity.desktopEntry ?? "",
          "Icon=/xdg/icons/com.t3tools.T3Code.desktop.png",
        );
        assert.equal(
          copyFileSyncMock.mock.calls.length,
          0,
          "icon must not be copied out of the app bundle",
        );
        assert.isTrue(identity.iconInstalled, "icon must be written from the bundled bytes");
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect.each([
    { relaunchedByUpdater: "true", restored: true },
    { relaunchedByUpdater: "", restored: false },
  ])(
    "restores the versioned AppImage path an update removed (updater relaunch: $relaunchedByUpdater)",
    ({ relaunchedByUpdater, restored }) => {
      vi.stubEnv("VITE_DEV_SERVER_URL", "");
      getSwitchValueMock.mockReturnValue("");
      const entryPath = "/xdg/applications/com.t3tools.T3Code.desktop";
      const files = new Map([[entryPath, "Exec=/Applications/T3-Code-0.1.8-x86_64.AppImage %U\n"]]);
      readFileSyncMock.mockImplementation((path: string) => files.get(path) ?? "{}");
      writeFileSyncMock.mockImplementation((path: string, contents: string | Buffer) => {
        files.set(path, String(contents));
      });

      return Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            DesktopPreReadyPlatform.layer.pipe(
              Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
              Layer.provide(
                DesktopConfig.layerTest({
                  XDG_DATA_HOME: "/xdg",
                  APPIMAGE: "/Applications/T3-Code-x86_64.AppImage",
                  APPIMAGE_SILENT_INSTALL: relaunchedByUpdater,
                }),
              ),
            ),
          );
          assert.deepEqual(
            symlinkSyncMock.mock.calls,
            restored
              ? [["T3-Code-x86_64.AppImage", "/Applications/T3-Code-0.1.8-x86_64.AppImage"]]
              : [],
          );
          assert.include(files.get(entryPath), "Exec=/Applications/T3-Code-x86_64.AppImage %U");
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
    },
  );

  it.effect("points the early portal entry at a configured distribution launcher", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    getSwitchValueMock.mockReturnValue("");

    return Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provide(
              DesktopConfig.layerTest({
                XDG_DATA_HOME: "/xdg",
                APPIMAGE: "/Applications/current.AppImage",
                T3CODE_DESKTOP_LAUNCHER_PATH: " /opt/T3 Code/t3code ",
              }),
            ),
          ),
        );
        const entry = writeFileSyncMock.mock.calls.find(
          ([path]) => path === "/xdg/applications/com.t3tools.T3Code.desktop",
        )?.[1];
        assert.include(entry, 'Exec="/opt/T3 Code/t3code" %U');
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect.each([
    {
      label: "removes a generated entry that hides an installed launcher",
      entry: "NoDisplay=true\nMimeType=x-scheme-handler/t3code;\n",
      dataDirs: "relative/share:/xdg:/nix/profile/share",
      kept: false,
    },
    {
      label: "keeps a visible entry next to an installed launcher",
      entry: "[Desktop Entry]\nExec=t3code --custom %U\n",
      dataDirs: "relative/share:/xdg:/nix/profile/share",
      kept: true,
    },
    {
      label: "keeps a hidden symlink next to an installed launcher",
      entry: "NoDisplay=true\n",
      dataDirs: "/nix/profile/share",
      kept: true,
      symlink: true,
    },
    {
      label: "keeps the entry when $XDG_DATA_DIRS reaches $XDG_DATA_HOME through a symlink",
      entry: "NoDisplay=true\n",
      dataDirs: "/xdg-alias",
      kept: true,
      rewritten: true,
    },
    {
      label: "keeps the entry when an installed path is a symlink to it",
      entry: "NoDisplay=true\n",
      dataDirs: "/opt/share",
      kept: true,
      rewritten: true,
    },
    {
      label: "keeps a visible launcher in $XDG_DATA_HOME",
      entry: "[Desktop Entry]\nExec=t3code --custom %U\n",
      dataDirs: "/xdg",
      kept: true,
    },
    {
      label: "writes nothing next to an installed launcher",
      entry: undefined,
      dataDirs: "/nix/profile/share",
      kept: false,
    },
  ])("$label", ({ entry, dataDirs, kept, rewritten = false, symlink = false }) => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    getSwitchValueMock.mockReturnValue("");
    const entryPath = "/xdg/applications/com.t3tools.T3Code.desktop";
    const files = new Map([
      ["/nix/profile/share/applications/com.t3tools.T3Code.desktop", "[Desktop Entry]\n"],
      ["/opt/share/applications/com.t3tools.T3Code.desktop", ""],
    ]);
    if (entry !== undefined) files.set(entryPath, entry);
    if (symlink) symlinkPaths.add(entryPath);
    existsSyncMock.mockImplementation((path: string) =>
      files.has(path.replace("/xdg-alias/", "/xdg/")),
    );
    readFileSyncMock.mockImplementation((path: string) => files.get(path) ?? "{}");
    rmSyncMock.mockImplementation((path: string) => files.delete(path));

    return Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provide(
              DesktopConfig.layerTest({
                XDG_DATA_HOME: "/xdg",
                XDG_DATA_DIRS: dataDirs,
                T3CODE_DESKTOP_LAUNCHER_PATH: "/nix/profile/bin/t3code-desktop",
              }),
            ),
          ),
        );
        assert.equal(files.get(entryPath), kept ? entry : undefined);
        assert.equal(
          writeFileSyncMock.mock.calls.some(([path]) => path === entryPath),
          rewritten,
        );
        assert.deepEqual(setDesktopNameMock.mock.calls, [["com.t3tools.T3Code.desktop"]]);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect("still writes the entry when $XDG_DATA_DIRS only lists $XDG_DATA_HOME", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    getSwitchValueMock.mockReturnValue("");
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockImplementation((path: string) =>
      path.endsWith(".desktop") ? "NoDisplay=true\n" : "{}",
    );

    return Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provide(
              DesktopConfig.layerTest({ XDG_DATA_HOME: "/xdg", XDG_DATA_DIRS: "/xdg" }),
            ),
          ),
        );
        assert.isTrue(
          writeFileSyncMock.mock.calls.some(
            ([path]) => path === "/xdg/applications/com.t3tools.T3Code.desktop",
          ),
        );
        assert.deepEqual(rmSyncMock.mock.calls, []);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect(
    "acquires a synchronous pre-ready layer before an asynchronous Clerk-shaped layer",
    () =>
      Effect.gen(function* () {
        class ClerkShaped extends Context.Service<ClerkShaped, { readonly ready: true }>()(
          "@t3tools/desktop/app/DesktopPreReadyPlatform.test/ClerkShaped",
        ) {}

        const events: Array<string> = [];
        registerSchemesMock.mockImplementation(() => {
          events.push("pre-ready");
        });

        const layerPreReady = DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
        );

        const layerClerkShaped = Layer.effect(
          ClerkShaped,
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.map(() => {
              events.push("clerk");
              return { ready: true as const };
            }),
          ),
        );

        const layerRuntime = layerClerkShaped.pipe(
          Layer.flatMap((clerkContext) => Layer.succeedContext(clerkContext)),
          Layer.provideMerge(layerPreReady),
        );

        const result = yield* Effect.all({
          clerk: ClerkShaped,
          preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        }).pipe(Effect.provide(layerRuntime));

        assert.deepEqual(result, {
          clerk: { ready: true },
          preReady: {
            linux: null,
            linuxPasswordStoreCommandLine: null,
          },
        });
        assert.deepEqual(events, ["pre-ready", "clerk"]);
        assert.equal(registerSchemesMock.mock.calls.length, 1);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
        assert.equal(setDesktopNameMock.mock.calls.length, 0);
      }),
  );
});
