import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ArchivedShellStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/http";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentCatalogAtoms } from "./connections.ts";
import { createOrchestrationEnvironmentAtoms } from "./orchestration.ts";
import { v2Now, v2Project, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
} from "./archivedThreads.ts";

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    getConnectionStateAtom: () => Atom.make(AsyncResult.initial<SupervisorConnectionState>()),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
  });

  registry.dispose();
});

it.effect("keeps environment archives live and replaces stale data on reconnect", () =>
  Effect.gen(function* () {
    const connectedState: SupervisorConnectionState = {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    };
    const makeConnection = Effect.fnUntraced(function* (id: string, state = connectedState) {
      const events = yield* Queue.unbounded<OrchestrationV2ArchivedShellStreamItem>();
      const subscribed = yield* Deferred.make<void>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: () =>
          Stream.fromQueue(events).pipe(Stream.onStart(Deferred.succeed(subscribed, undefined))),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(id),
        label: id,
        httpBaseUrl: "https://environment.example.test",
        wsBaseUrl: "wss://environment.example.test",
      });
      const prepared: PreparedConnection = {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: target.wsBaseUrl,
        httpAuthorization: null,
        target,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(state),
        session: yield* SubscriptionRef.make(
          state.phase === "connected" ? Option.some(session) : Option.none<RpcSession>(),
        ),
        prepared: yield* SubscriptionRef.make(
          state.phase === "connected" ? Option.some(prepared) : Option.none<PreparedConnection>(),
        ),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      return { events, subscribed, session, prepared, supervisor };
    });
    const a = yield* makeConnection("env-a");
    const b = yield* makeConnection("env-b", {
      ...connectedState,
      network: "offline",
      phase: "offline",
      lastFailure: new ConnectionTransientError({
        reason: "network",
        detail: "credential=secret-value",
      }),
    });
    const envA = a.supervisor.target.environmentId;
    const envB = b.supervisor.target.environmentId;
    const environments = EnvironmentRegistry.EnvironmentRegistry.of({
      followStream: (environmentId, stream) =>
        Stream.provideService(
          stream,
          EnvironmentSupervisor.EnvironmentSupervisor,
          environmentId === envA ? a.supervisor : b.supervisor,
        ),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const runtime = Atom.runtime(
      Layer.merge(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
        FetchHttpClient.layer,
      ),
    );
    const atoms = createOrchestrationEnvironmentAtoms(runtime);
    const catalog = createEnvironmentCatalogAtoms(runtime);
    const snapshots = createArchivedThreadSnapshotsAtomFamily({
      getSnapshotAtom: (environmentId) => atoms.archivedShell({ environmentId, input: {} }),
      getConnectionStateAtom: catalog.stateAtom,
      labelPrefix: "test:archived-thread-snapshots",
    })(makeArchivedThreadsEnvironmentKey([envA, envB]));
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
      Effect.sync(() => registry.dispose()),
    );
    for (const [environmentId, phase] of [
      [envA, "connected"],
      [envB, "offline"],
    ] as const) {
      yield* AtomRegistry.toStream(registry, catalog.stateAtom(environmentId)).pipe(
        Stream.filter((result) =>
          Option.exists(AsyncResult.value(result), (state) => state.phase === phase),
        ),
        Stream.runHead,
      );
    }
    registry.mount(snapshots);
    expect(registry.get(snapshots).isLoading).toBe(true);

    const initial: OrchestrationV2ArchivedShellSnapshot = {
      schemaVersion: 1,
      snapshotSequence: 2,
      projects: [v2Project],
      threads: [],
    };
    const archived = { ...v2ThreadShell, archivedAt: v2Now };
    const onlineSnapshot = { ...initial, snapshotSequence: 1, threads: [archived] };
    const otherEnvironment = { ...initial, snapshotSequence: 1, threads: [archived] };
    const waitForSequence = (environmentId: EnvironmentId, sequence: number) =>
      AtomRegistry.toStream(registry, snapshots).pipe(
        Stream.filter((state) =>
          state.snapshots.some(
            (entry) =>
              entry.environmentId === environmentId && entry.snapshot.snapshotSequence === sequence,
          ),
        ),
        Stream.runHead,
      );
    yield* Queue.offer(a.events, { kind: "snapshot", snapshot: onlineSnapshot });
    yield* waitForSequence(envA, 1);
    expect(registry.get(snapshots).snapshots).toEqual([
      { environmentId: envA, snapshot: onlineSnapshot },
    ]);
    // Keep exercising recovery and live updates when the offline-state regression fails.
    expect.soft(registry.get(snapshots).isLoading).toBe(false);
    expect.soft(registry.get(snapshots).error).toBe("Failed to load archived threads.");

    yield* SubscriptionRef.set(b.supervisor.state, {
      ...connectedState,
      phase: "connecting",
      stage: "opening",
      attempt: 2,
      generation: 2,
    });
    yield* AtomRegistry.toStream(registry, snapshots).pipe(
      Stream.filter((state) => state.isLoading),
      Stream.runHead,
    );
    yield* SubscriptionRef.set(b.supervisor.prepared, Option.some(b.prepared));
    yield* SubscriptionRef.set(b.supervisor.session, Option.some(b.session));
    yield* SubscriptionRef.set(b.supervisor.state, {
      ...connectedState,
      attempt: 2,
      generation: 2,
    });
    yield* Deferred.await(b.subscribed);
    expect(registry.get(snapshots).isLoading).toBe(true);
    expect(registry.get(snapshots).snapshots).toEqual([
      { environmentId: envA, snapshot: onlineSnapshot },
    ]);
    yield* Queue.offer(b.events, { kind: "snapshot", snapshot: otherEnvironment });
    yield* waitForSequence(envB, 1);

    const check = (snapshot: OrchestrationV2ArchivedShellSnapshot) =>
      expect(registry.get(snapshots)).toEqual({
        snapshots: [
          { environmentId: envA, snapshot },
          { environmentId: envB, snapshot: otherEnvironment },
        ],
        error: null,
        isLoading: false,
      });
    check(onlineSnapshot);
    yield* Queue.offer(a.events, { kind: "snapshot", snapshot: initial });
    yield* waitForSequence(envA, 2);
    check(initial);
    yield* Queue.offer(a.events, { kind: "thread.updated", sequence: 3, thread: archived });
    yield* waitForSequence(envA, 3);
    check({ ...initial, snapshotSequence: 3, threads: [archived] });
    const renamed = { ...archived, title: "Renamed by another client" };
    yield* Queue.offer(a.events, { kind: "thread.updated", sequence: 4, thread: renamed });
    yield* waitForSequence(envA, 4);
    check({ ...initial, snapshotSequence: 4, threads: [renamed] });
    yield* Queue.offer(a.events, { kind: "thread.removed", sequence: 5, threadId: archived.id });
    yield* waitForSequence(envA, 5);
    check({ ...initial, snapshotSequence: 5 });

    yield* Queue.offer(a.events, { kind: "thread.updated", sequence: 6, thread: archived });
    yield* waitForSequence(envA, 6);
    const reconnected = yield* makeConnection("env-a");
    const replacement = { ...initial, snapshotSequence: 9, projects: [] };
    yield* SubscriptionRef.set(a.supervisor.session, Option.some(reconnected.session));
    yield* Queue.offer(reconnected.events, { kind: "snapshot", snapshot: replacement });
    yield* waitForSequence(envA, 9);
    check(replacement);
    const newThread = { ...archived, id: ThreadId.make("thread-after-reconnect") };
    const refreshed = { ...initial, snapshotSequence: 10, threads: [newThread] };
    yield* Queue.offer(reconnected.events, { kind: "snapshot", snapshot: refreshed });
    yield* waitForSequence(envA, 10);
    check(refreshed);
    yield* Queue.offer(reconnected.events, {
      kind: "thread.removed",
      sequence: 11,
      threadId: newThread.id,
    });
    yield* waitForSequence(envA, 11);
    check({ ...initial, snapshotSequence: 11 });
  }),
);
