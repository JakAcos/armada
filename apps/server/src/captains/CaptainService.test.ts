import { assert, it } from "@effect/vitest";
import {
  type Captain,
  CaptainNeedId,
  type CaptainError,
  type CommandId,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  isCaptainError,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CaptainService from "./CaptainService.ts";

const projectId = ProjectId.make("project:test");
const apiProjectId = ProjectId.make("project:api");
const bareProjectId = ProjectId.make("project:no-default-model");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const fromUser = { createdBy: "user", creationSource: "web" } as const;

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
  const value = error !== undefined && "error" in error ? error.error : undefined;
  assert.isTrue(isCaptainError(value), `expected a CaptainError, got ${String(value)}`);
  return value as CaptainError;
};

type LaunchOutcome = "starts" | "fails-before-thread" | "fails-after-thread" | "above-ceiling";

interface Harness {
  readonly launches: Ref.Ref<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>;
  readonly sends: Ref.Ref<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>;
  readonly interrupts: Ref.Ref<ReadonlyArray<ThreadId>>;
  /** Threads that exist, and whether each was deleted. */
  readonly threads: Ref.Ref<ReadonlyMap<ThreadId, { readonly deleted: boolean }>>;
  /** While true, a send fails as it does for an archived thread. */
  readonly threadArchived: Ref.Ref<boolean>;
  /** While true, a send is accepted by the thread and then fails on the read for its reply. */
  readonly sendFailsAfterAccept: Ref.Ref<boolean>;
  readonly acceptedCommands: Ref.Ref<ReadonlySet<CommandId>>;
  /** While true, a thread's shell cannot be read. */
  readonly threadsUnreadable: Ref.Ref<boolean>;
  /** When set, an interrupt signals `reached` and then waits for `release`. */
  readonly interruptGate: Ref.Ref<Gate | undefined>;
  /** When set, a send signals `reached` and then waits for `release` before it is accepted. */
  readonly sendGate: Ref.Ref<Gate | undefined>;
  /** When set, the next thread shell read signals `reached` and then waits for `release`. */
  readonly shellGate: Ref.Ref<Gate | undefined>;
}

interface Gate {
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const passGate = (gate: Ref.Ref<Gate | undefined>) =>
  Effect.gen(function* () {
    const current = yield* Ref.get(gate);
    if (current === undefined) return;
    yield* Deferred.succeed(current.reached, undefined);
    yield* Deferred.await(current.release);
  });

const closeGate = (gate: Ref.Ref<Gate | undefined>) =>
  Effect.gen(function* () {
    const closed = {
      reached: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    yield* Ref.set(gate, closed);
    return closed;
  });

interface HarnessOptions {
  readonly launch?: LaunchOutcome;
  readonly defaultRuntimeMode?: RuntimeMode;
  readonly subagents?: ReadonlyArray<Record<string, unknown>>;
}

const makeLayer = (harness: Harness, options: HarnessOptions) => {
  const outcome = options.launch ?? "starts";
  const commitThread = (threadId: ThreadId) =>
    Ref.update(harness.threads, (threads) => new Map(threads).set(threadId, { deleted: false }));
  return CaptainService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(harness.launches, (all) => [...all, input]);
              const threadId = input.threadId!;
              if (outcome === "fails-before-thread" || outcome === "above-ceiling") {
                return yield* new ThreadLaunchService.ThreadLaunchError({
                  operation: "create-thread",
                  commandId: input.commandId,
                  projectId: input.projectId,
                  cause:
                    outcome === "above-ceiling"
                      ? new OrchestratorRuntimeModeAboveCeilingError({
                          commandId: input.commandId,
                          threadId,
                          refused: "mode",
                          runtimeMode: input.runtimeMode,
                          maxRuntimeMode: "approval-required",
                          organization: "Example Corp",
                        })
                      : "provider unavailable",
                });
              }
              yield* commitThread(threadId);
              if (outcome === "fails-after-thread") {
                return yield* new ThreadLaunchService.ThreadLaunchError({
                  operation: "update-thread",
                  commandId: input.commandId,
                  projectId: input.projectId,
                  threadId,
                  cause: "projection read failed",
                });
              }
              return { threadId, projection: {} as never, resumed: false };
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: (input) =>
            Effect.gen(function* () {
              if (yield* Ref.get(harness.threadArchived)) {
                return yield* new ThreadManagementService.ThreadManagementThreadArchivedError({
                  threadId: input.threadId,
                });
              }
              yield* passGate(harness.sendGate);
              yield* Ref.update(harness.sends, (all) => [...all, input]);
              yield* Ref.update(harness.acceptedCommands, (all) =>
                new Set(all).add(input.commandId),
              );
              if (yield* Ref.get(harness.sendFailsAfterAccept)) {
                return yield* new ThreadManagementService.ThreadManagementThreadNotFoundError({
                  projectId: input.projectId,
                  threadId: input.threadId,
                });
              }
              return {} as never;
            }),
          interruptThread: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(harness.interrupts, (all) => [...all, input.threadId]);
              yield* passGate(harness.interruptGate);
              return { type: "no_active_run" } as const;
            }),
          getThreadRecords: () => Effect.succeed({ subagents: options.subagents ?? [] } as never),
          getThreadShell: (threadId) =>
            Effect.gen(function* () {
              // Only the first read waits, so a second caller is held back by nothing but a lock.
              const gate = yield* Ref.getAndSet(harness.shellGate, undefined);
              if (gate !== undefined) {
                yield* Deferred.succeed(gate.reached, undefined);
                yield* Deferred.await(gate.release);
              }
              if (yield* Ref.get(harness.threadsUnreadable)) {
                return yield* Effect.fail("projection unavailable" as never);
              }
              const thread = (yield* Ref.get(harness.threads)).get(threadId);
              return thread === undefined
                ? null
                : ({
                    id: threadId,
                    deletedAt: thread.deleted ? "2026-01-01T00:00:00.000Z" : null,
                  } as unknown as OrchestrationV2ThreadShell);
            }),
        }),
        Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
          getByCommandId: (commandId) =>
            Ref.get(harness.acceptedCommands).pipe(
              Effect.map((accepted) =>
                accepted.has(commandId)
                  ? Option.some({ commandId, status: "accepted" } as never)
                  : Option.none(),
              ),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              id === projectId || id === apiProjectId || id === bareProjectId
                ? Option.some({
                    id,
                    title: id === bareProjectId ? "Bare" : "Docs site",
                    workspaceRoot: "/projects/test",
                    defaultModelSelection: id === bareProjectId ? null : modelSelection,
                  } as unknown as Project)
                : Option.none(),
            ),
        }),
        ServerSettings.layerTest(
          options.defaultRuntimeMode === undefined
            ? {}
            : { defaultRuntimeMode: options.defaultRuntimeMode },
        ),
        IdAllocator.layer,
      ),
    ),
  );
};

const withService = <A, E>(
  body: (
    service: CaptainService.CaptainService["Service"],
    harness: Harness,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
  options: HarnessOptions = {},
) =>
  Effect.gen(function* () {
    const harness: Harness = {
      launches: yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]),
      sends: yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>([]),
      interrupts: yield* Ref.make<ReadonlyArray<ThreadId>>([]),
      threads: yield* Ref.make<ReadonlyMap<ThreadId, { readonly deleted: boolean }>>(new Map()),
      threadArchived: yield* Ref.make(false),
      sendFailsAfterAccept: yield* Ref.make(false),
      acceptedCommands: yield* Ref.make<ReadonlySet<CommandId>>(new Set()),
      threadsUnreadable: yield* Ref.make(false),
      interruptGate: yield* Ref.make<Gate | undefined>(undefined),
      sendGate: yield* Ref.make<Gate | undefined>(undefined),
      shellGate: yield* Ref.make<Gate | undefined>(undefined),
    };
    return yield* Effect.gen(function* () {
      const service = yield* CaptainService.CaptainService;
      return yield* body(service, harness);
    }).pipe(Effect.provide(makeLayer(harness, options)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

const createCaptain = (service: CaptainService.CaptainService["Service"], name = "Docs") =>
  service.create({ projectId, name, charter: "Keep the user docs accurate.", ...fromUser });

const storedCaptainCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly total: number }>`SELECT COUNT(*) AS total FROM captains`;
  return rows[0]?.total;
});

const raiseDecision = (
  service: CaptainService.CaptainService["Service"],
  threadId: ThreadId,
  summary = "Ship v2 docs now?",
) =>
  service
    .report(threadId, { needs: [{ kind: "decision", summary }] })
    .pipe(Effect.map(({ raised }) => raised[0]!));

it.effect("create launches the briefing with the project's default model and mode", () =>
  withService(
    (service, harness) =>
      Effect.gen(function* () {
        const { captain } = yield* createCaptain(service);
        const [launch] = yield* Ref.get(harness.launches);
        assert.strictEqual(launch?.threadId, captain.threadId);
        assert.strictEqual(launch?.projectId, projectId);
        assert.deepStrictEqual(launch?.modelSelection, modelSelection);
        assert.strictEqual(launch?.runtimeMode, "approval-required");
        assert.deepStrictEqual(launch?.workspaceStrategy, { type: "root" });
        assert.include(launch?.initialMessage?.text ?? "", "Keep the user docs accurate.");
        assert.include(launch?.initialMessage?.text ?? "", captain.id);
        assert.include(launch?.initialMessage?.text ?? "", "captain_report");
        assert.strictEqual(captain.status, "active");
        assert.deepStrictEqual(captain.openNeeds, []);

        const { captains } = yield* service.list({ projectId });
        assert.deepStrictEqual(
          captains.map((listed) => listed.id),
          [captain.id],
        );
        const other = yield* service.list({ projectId: ProjectId.make("project:other") });
        assert.deepStrictEqual(other.captains, []);
      }),
    { defaultRuntimeMode: "approval-required" },
  ),
);

it.effect("create refuses a project it cannot find or that has no default model", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const request = { name: "Docs", charter: "Keep docs accurate.", ...fromUser };
      const missing = yield* Effect.exit(
        service.create({ ...request, projectId: ProjectId.make("project:missing") }),
      );
      assert.strictEqual(failureOf(missing).code, "not_found");
      const bare = yield* Effect.exit(service.create({ ...request, projectId: bareProjectId }));
      assert.strictEqual(failureOf(bare).code, "invalid_request");
      assert.include(failureOf(bare).message, "Project Bare has no default model");
      assert.lengthOf(yield* Ref.get(harness.launches), 0);
      assert.strictEqual(yield* storedCaptainCount, 0);
    }),
  ),
);

it.effect("create removes the captain when its thread never started", () =>
  withService(
    (service) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(createCaptain(service));
        assert.strictEqual(failureOf(exit).code, "unavailable");
        assert.strictEqual(yield* storedCaptainCount, 0);
      }),
    { launch: "fails-before-thread" },
  ),
);

it.effect("create keeps the captain when the launch fails after its thread started", () =>
  withService(
    (service) =>
      Effect.gen(function* () {
        const { captain } = yield* createCaptain(service);
        assert.strictEqual(yield* storedCaptainCount, 1);
        // The running thread can still report as this captain.
        const reported = yield* service.report(captain.threadId, { plan: "1. Audit docs" });
        assert.strictEqual(reported.captain.plan, "1. Audit docs");
      }),
    { launch: "fails-after-thread" },
  ),
);

it.effect("create says what to change when a managed mode limit refuses the launch", () =>
  withService(
    (service) =>
      Effect.gen(function* () {
        const error = failureOf(yield* Effect.exit(createCaptain(service)));
        assert.strictEqual(error.code, "invalid_request");
        assert.include(error.message, "Example Corp");
        assert.include(error.message, "approval-required");
      }),
    { launch: "above-ceiling" },
  ),
);

it.effect("a captain whose thread was deleted leaves the list until the thread returns", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const setDeleted = (deleted: boolean) =>
        Ref.update(harness.threads, (threads) =>
          new Map(threads).set(captain.threadId, { deleted }),
        );
      yield* setDeleted(true);
      assert.deepStrictEqual((yield* service.list({})).captains, []);
      // It is gone everywhere, not only from the list.
      assert.strictEqual(
        failureOf(yield* Effect.exit(service.digest(captain.id))).code,
        "not_found",
      );
      assert.strictEqual(
        failureOf(
          yield* Effect.exit(
            service.setStatus({ captainId: captain.id, status: "retired", ...fromUser }),
          ),
        ).code,
        "not_found",
      );
      yield* setDeleted(false);
      assert.lengthOf((yield* service.list({})).captains, 1);
    }),
  ),
);

it.effect("a thread that cannot be read hides no captain", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      yield* Ref.set(harness.threadsUnreadable, true);
      assert.deepStrictEqual(
        (yield* service.list({})).captains.map((listed) => listed.id),
        [captain.id],
      );
    }),
  ),
);

it.effect("the live list re-emits when a captain changes", () =>
  withService((service) =>
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(service.subscribeList({}));
      assert.deepStrictEqual(
        (yield* pull).map(({ captains }) => captains.length),
        [0],
      );
      const { captain } = yield* createCaptain(service);
      assert.deepStrictEqual(
        (yield* pull).map(({ captains }) => captains.map((listed) => listed.id)),
        [[captain.id]],
      );
    }),
  ),
);

it.effect("report saves the plan and raises needs only from the captain's own thread", () =>
  withService((service) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const { captain: other } = yield* createCaptain(service, "Infra");

      const reported = yield* service.report(captain.threadId, {
        plan: "1. Audit docs\n2. Fix drift",
        needs: [
          { kind: "decision", summary: "Drop the legacy CLI page?" },
          { kind: "blocker", summary: "Need docs deploy token", detail: "CI secret is missing." },
        ],
      });
      assert.strictEqual(reported.captain.plan, "1. Audit docs\n2. Fix drift");
      assert.isNotNull(reported.captain.planUpdatedAt);
      assert.deepStrictEqual(
        reported.raised.map((need) => [need.kind, need.summary, need.detail]),
        [
          ["decision", "Drop the legacy CLI page?", null],
          ["blocker", "Need docs deploy token", "CI secret is missing."],
        ],
      );
      assert.lengthOf(reported.captain.openNeeds, 2);

      const stranger = yield* Effect.exit(
        service.report(ThreadId.make("thread:not-a-captain"), { plan: "hijack" }),
      );
      assert.strictEqual(failureOf(stranger).code, "invalid_request");

      // Another captain cannot withdraw this captain's needs.
      yield* service.report(other.threadId, {
        withdrawNeedIds: reported.raised.map((need) => need.id),
      });
      const { captains } = yield* service.list({ projectId });
      const mine = captains.find((listed) => listed.id === captain.id);
      assert.lengthOf(mine?.openNeeds ?? [], 2);
      assert.strictEqual(captains.find((listed) => listed.id === other.id)?.plan, "");

      yield* service.report(captain.threadId, { withdrawNeedIds: [reported.raised[0]!.id] });
      const digest = yield* service.digest(captain.id);
      assert.deepStrictEqual(
        digest.captain.openNeeds.map((need) => need.summary),
        ["Need docs deploy token"],
      );
      assert.deepStrictEqual(
        digest.recentlyResolved.map((need) => need.resolution),
        ["Withdrawn by the captain."],
      );
    }),
  ),
);

it.effect("resolving a need answers the captain once, even when two answers race", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const need = yield* raiseDecision(service, captain.threadId);
      const resolve = (resolution: string) =>
        Effect.exit(service.resolveNeed({ needId: need.id, resolution, ...fromUser }));

      const exits = yield* Effect.all([resolve("Yes, ship them today."), resolve("No, wait.")], {
        concurrency: 2,
      });
      const won = exits.filter(Exit.isSuccess);
      assert.lengthOf(won, 1);
      const lost = exits.find(Exit.isFailure)!;
      assert.strictEqual(failureOf(lost).code, "invalid_request");

      const resolved = won[0]!.value;
      assert.strictEqual(resolved.need.status, "resolved");
      assert.deepStrictEqual(resolved.captain.openNeeds, []);

      // The loser was stopped by the claim, so the captain got the winner's answer and no other.
      const sends = yield* Ref.get(harness.sends);
      assert.lengthOf(sends, 1);
      assert.strictEqual(sends[0]?.threadId, captain.threadId);
      assert.strictEqual(sends[0]?.mode, "queue");
      assert.include(sends[0]?.text ?? "", "Ship v2 docs now?");
      assert.include(sends[0]?.text ?? "", resolved.need.resolution ?? "<none>");
      assert.include(sends[0]?.text ?? "", "resolved by the user");

      assert.strictEqual(failureOf(yield* resolve("Again.")).code, "invalid_request");
      const missing = yield* Effect.exit(
        service.resolveNeed({
          needId: CaptainNeedId.make("need:missing"),
          resolution: "x",
          ...fromUser,
        }),
      );
      assert.strictEqual(failureOf(missing).code, "not_found");
      assert.lengthOf(yield* Ref.get(harness.sends), 1);
    }),
  ),
);

it.effect("an answer that cannot be delivered leaves the need open to answer again", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const need = yield* raiseDecision(service, captain.threadId);
      const resolve = service.resolveNeed({ needId: need.id, resolution: "Yes.", ...fromUser });

      yield* Ref.set(harness.threadArchived, true);
      const error = failureOf(yield* Effect.exit(resolve));
      assert.strictEqual(error.code, "invalid_request");
      assert.include(error.message, "archived");
      const { captains } = yield* service.list({});
      assert.deepStrictEqual(
        captains[0]?.openNeeds.map((open) => [open.id, open.status, open.resolution]),
        [[need.id, "open", null]],
      );

      yield* Ref.set(harness.threadArchived, false);
      const resolved = yield* resolve;
      assert.strictEqual(resolved.need.resolution, "Yes.");
      assert.lengthOf(yield* Ref.get(harness.sends), 1);
    }),
  ),
);

it.effect("an answer the captain received stays resolved when its send then fails", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const need = yield* raiseDecision(service, captain.threadId);
      yield* Ref.set(harness.sendFailsAfterAccept, true);
      const resolved = yield* service.resolveNeed({
        needId: need.id,
        resolution: "Yes.",
        ...fromUser,
      });
      // Reopening it would let the user send the captain a second, possibly different, answer.
      assert.strictEqual(resolved.need.status, "resolved");
      assert.deepStrictEqual(resolved.captain.openNeeds, []);
      assert.lengthOf(yield* Ref.get(harness.sends), 1);
    }),
  ),
);

it.effect("an agent's relay is labeled, and no captain's thread can answer a need", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const need = yield* raiseDecision(service, captain.threadId);
      const fromAgent = { createdBy: "agent", creationSource: "mcp" } as const;

      const { captain: other } = yield* createCaptain(service, "Infra");
      for (const senderThreadId of [captain.threadId, other.threadId]) {
        const refused = yield* Effect.exit(
          service.resolveNeed({
            needId: need.id,
            resolution: "Yes.",
            ...fromAgent,
            senderThreadId,
          }),
        );
        assert.strictEqual(failureOf(refused).code, "invalid_request");
      }
      const toSelf = yield* Effect.exit(
        service.message({
          captainId: captain.id,
          text: "Keep going.",
          ...fromAgent,
          senderThreadId: captain.threadId,
        }),
      );
      assert.strictEqual(failureOf(toSelf).code, "invalid_request");
      assert.lengthOf(yield* Ref.get(harness.sends), 0);

      const relay = ThreadId.make("thread:helper");
      yield* service.resolveNeed({
        needId: need.id,
        resolution: "Yes.",
        ...fromAgent,
        senderThreadId: relay,
      });
      yield* service.message({
        captainId: captain.id,
        text: "Status?",
        ...fromAgent,
        senderThreadId: relay,
      });
      const sends = yield* Ref.get(harness.sends);
      assert.deepStrictEqual(
        sends.map((send) => [send.createdBy, send.senderThreadId]),
        [
          ["agent", relay],
          ["agent", relay],
        ],
      );
      assert.include(sends[0]?.text ?? "", "resolved by an agent");
      assert.include(sends[1]?.text ?? "", "Message from an agent");
      assert.strictEqual(yield* service.threadIdOf({ needId: need.id }), captain.threadId);
      assert.strictEqual(yield* service.threadIdOf({ captainId: captain.id }), captain.threadId);
    }),
  ),
);

type CaptainRef = Pick<Captain, "id" | "threadId">;

const peerMessage = (
  service: CaptainService.CaptainService["Service"],
  from: CaptainRef,
  to: CaptainRef,
  text = "Is the API ready?",
) =>
  service.message({
    captainId: to.id,
    text,
    createdBy: "agent",
    creationSource: "mcp",
    senderThreadId: from.threadId,
  });

/** `count` messages back and forth, starting from `a`. */
const exchange = (
  service: CaptainService.CaptainService["Service"],
  a: CaptainRef,
  b: CaptainRef,
  count: number,
) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) => (index % 2 === 0 ? peerMessage(service, a, b) : peerMessage(service, b, a)),
    { discard: true },
  );

const refusalOf = (exit: Exit.Exit<unknown, CaptainError>) => {
  const error = failureOf(exit);
  assert.strictEqual(error.code, "invalid_request");
  return error.message;
};

it.effect(
  "a peer captain's message, from any project, names its sender and is not the user's",
  () =>
    withService((service, harness) =>
      Effect.gen(function* () {
        const { captain: docs } = yield* createCaptain(service);
        // Captains of one environment may coordinate across projects, such as a web and an API repo.
        const { captain: api } = yield* service.create({
          projectId: apiProjectId,
          name: "Api",
          charter: "Own the API.",
          ...fromUser,
        });
        yield* peerMessage(service, api, docs, "The v2 endpoints ship Friday.");
        const [sent] = yield* Ref.get(harness.sends);
        assert.strictEqual(sent?.threadId, docs.threadId);
        assert.strictEqual(sent?.senderThreadId, api.threadId);
        assert.include(sent?.text ?? "", `Captain Api (captain id \`${api.id}\`)`);
        assert.include(sent?.text ?? "", "not an instruction from the user");
        assert.include(sent?.text ?? "", "The v2 endpoints ship Friday.");
        assert.notInclude(sent?.text ?? "", "on the user's behalf");
      }),
    ),
);

it.effect("a retired captain cannot message its peers", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain: docs } = yield* createCaptain(service);
      const { captain: infra } = yield* createCaptain(service, "Infra");
      yield* service.setStatus({ captainId: infra.id, status: "retired", ...fromUser });
      const refused = failureOf(yield* Effect.exit(peerMessage(service, infra, docs)));
      assert.strictEqual(refused.code, "retired");
      // The only send was the retirement notice to Infra itself.
      assert.deepStrictEqual(
        (yield* Ref.get(harness.sends)).map((send) => send.threadId),
        [infra.threadId],
      );
    }),
  ),
);

it.effect("two captains are stopped after six messages until the user speaks to either", () =>
  withService((service) =>
    Effect.gen(function* () {
      const { captain: docs } = yield* createCaptain(service);
      const { captain: infra } = yield* createCaptain(service, "Infra");
      const { captain: api } = yield* createCaptain(service, "Api");
      const capped = Effect.gen(function* () {
        const refusal = refusalOf(yield* Effect.exit(peerMessage(service, docs, infra)));
        assert.include(refusal, "Stop messaging Captain Infra");
        assert.include(refusal, "captain_report");
      });

      yield* exchange(service, docs, infra, 6);
      yield* capped;
      // Either direction is one conversation, and other pairs go on.
      assert.include(
        refusalOf(yield* Effect.exit(peerMessage(service, infra, docs))),
        "Stop messaging Captain Docs",
      );
      yield* peerMessage(service, api, infra);
      // An agent's relay is not the user speaking.
      yield* service.message({
        captainId: infra.id,
        text: "Carry on.",
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: ThreadId.make("thread:helper"),
      });
      yield* capped;

      yield* service.message({ captainId: infra.id, text: "Carry on.", ...fromUser });
      yield* exchange(service, docs, infra, 6);
      yield* capped;

      const need = yield* raiseDecision(service, docs.threadId);
      yield* service.resolveNeed({ needId: need.id, resolution: "Yes.", ...fromUser });
      yield* exchange(service, docs, infra, 6);
      yield* capped;
    }),
  ),
);

it.effect("a refused or undelivered message does not count toward the limit", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain: docs } = yield* createCaptain(service);
      const { captain: infra } = yield* createCaptain(service, "Infra");
      yield* exchange(service, docs, infra, 4);

      yield* Ref.set(harness.threadArchived, true);
      assert.include(refusalOf(yield* Effect.exit(peerMessage(service, docs, infra))), "archived");
      yield* Ref.set(harness.threadArchived, false);
      yield* service.setStatus({ captainId: infra.id, status: "retired", ...fromUser });
      assert.strictEqual(
        failureOf(yield* Effect.exit(peerMessage(service, docs, infra))).code,
        "retired",
      );
      yield* service.setStatus({ captainId: infra.id, status: "active", ...fromUser });

      yield* exchange(service, docs, infra, 2);
      assert.include(
        refusalOf(yield* Effect.exit(peerMessage(service, docs, infra))),
        "Stop messaging Captain Infra",
      );
    }),
  ),
);

it.effect("two captains messaging each other at once cannot both take the last slot", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain: docs } = yield* createCaptain(service);
      const { captain: infra } = yield* createCaptain(service, "Infra");
      yield* exchange(service, docs, infra, 5);

      // The sixth message is being sent, under Infra's lock, when Infra's reply takes Docs' lock.
      const gate = yield* closeGate(harness.sendGate);
      const sixth = yield* peerMessage(service, docs, infra).pipe(Effect.forkChild);
      yield* Deferred.await(gate.reached);
      yield* Ref.set(harness.sendGate, undefined);
      const reply = yield* Effect.exit(peerMessage(service, infra, docs));
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(sixth);

      assert.include(refusalOf(reply), "Stop messaging Captain Docs");
      assert.lengthOf(yield* Ref.get(harness.sends), 6);
    }),
  ),
);

it.effect("retiring stops the captain, tells it once, and holds its needs until reactivated", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const need = yield* raiseDecision(service, captain.threadId);
      const retire = service.setStatus({ captainId: captain.id, status: "retired", ...fromUser });

      const retired = yield* retire;
      assert.strictEqual(retired.captain.status, "retired");
      assert.deepStrictEqual(retired.captain.openNeeds, []);
      yield* retire;
      assert.deepStrictEqual(yield* Ref.get(harness.interrupts), [captain.threadId]);
      const notices = yield* Ref.get(harness.sends);
      assert.lengthOf(notices, 1);
      assert.include(notices[0]?.text ?? "", "retired you");

      const message = { captainId: captain.id, text: "Status?", ...fromUser } as const;
      assert.strictEqual(failureOf(yield* Effect.exit(service.message(message))).code, "retired");
      assert.strictEqual(
        failureOf(yield* Effect.exit(service.report(captain.threadId, { plan: "x" }))).code,
        "retired",
      );
      assert.strictEqual(
        failureOf(
          yield* Effect.exit(
            service.resolveNeed({ needId: need.id, resolution: "Yes.", ...fromUser }),
          ),
        ).code,
        "retired",
      );
      assert.lengthOf(yield* Ref.get(harness.sends), 1);

      const reactivated = yield* service.setStatus({
        captainId: captain.id,
        status: "active",
        ...fromUser,
      });
      assert.deepStrictEqual(
        reactivated.captain.openNeeds.map((open) => open.id),
        [need.id],
      );
      yield* service.message(message);
      const sends = yield* Ref.get(harness.sends);
      assert.lengthOf(sends, 3);
      assert.include(sends[1]?.text ?? "", "reactivated you");
      assert.include(sends[2]?.text ?? "", "Status?");
      assert.lengthOf(yield* Ref.get(harness.interrupts), 1);
    }),
  ),
);

it.effect("retiring succeeds even when the captain's thread cannot be reached", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      yield* Ref.set(harness.threadArchived, true);
      const retired = yield* service.setStatus({
        captainId: captain.id,
        status: "retired",
        ...fromUser,
      });
      assert.strictEqual(retired.captain.status, "retired");
    }),
  ),
);

it.effect("a reactivation that races a retirement is told to the captain after it", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const setStatus = (status: "active" | "retired") =>
        service.setStatus({ captainId: captain.id, status, ...fromUser });
      const gate = yield* closeGate(harness.interruptGate);

      // The retirement is stored and is stopping the captain when the reactivation arrives.
      const retiring = yield* setStatus("retired").pipe(Effect.forkChild);
      yield* Deferred.await(gate.reached);
      const reactivating = yield* setStatus("active").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.lengthOf(yield* Ref.get(harness.sends), 0);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(retiring);
      const reactivated = yield* Fiber.join(reactivating);

      // The last thing the captain heard matches what is stored.
      assert.strictEqual(reactivated.captain.status, "active");
      const notices = (yield* Ref.get(harness.sends)).map((send) => send.text);
      assert.lengthOf(notices, 2);
      assert.include(notices[0] ?? "", "retired you");
      assert.include(notices[1] ?? "", "reactivated you");
    }),
  ),
);

it.effect("a retirement cancelled while it stops the captain still tells the captain", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const gate = yield* closeGate(harness.interruptGate);
      const retiring = yield* service
        .setStatus({ captainId: captain.id, status: "retired", ...fromUser })
        .pipe(Effect.forkChild);
      yield* Deferred.await(gate.reached);
      const cancelling = yield* Fiber.interrupt(retiring).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(cancelling);

      const notices = (yield* Ref.get(harness.sends)).map((send) => send.text);
      assert.lengthOf(notices, 1);
      assert.include(notices[0] ?? "", "retired you");
      const { captains } = yield* service.list({});
      assert.strictEqual(captains[0]?.status, "retired");
    }),
  ),
);

const reportWithNeed = (service: CaptainService.CaptainService["Service"], threadId: ThreadId) =>
  service.report(threadId, {
    plan: "1. Keep going",
    needs: [{ kind: "decision", summary: "Ship anyway?" }],
  });

it.effect("a retirement waits for a report already under way, then holds its needs", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      // The report holds the captain's lock and has not yet read whether it is still active.
      const gate = yield* closeGate(harness.shellGate);
      const reporting = yield* reportWithNeed(service, captain.threadId).pipe(Effect.forkChild);
      yield* Deferred.await(gate.reached);
      const retiring = yield* service
        .setStatus({ captainId: captain.id, status: "retired", ...fromUser })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      // The retirement has neither stored nor announced anything while the report runs.
      assert.lengthOf(yield* Ref.get(harness.interrupts), 0);
      assert.lengthOf(yield* Ref.get(harness.sends), 0);
      yield* Deferred.succeed(gate.release, undefined);

      // The report lands whole and tells the captain what it raised; then the captain is retired.
      const reported = yield* Fiber.join(reporting);
      assert.deepStrictEqual(
        reported.raised.map((need) => need.summary),
        ["Ship anyway?"],
      );
      const retired = yield* Fiber.join(retiring);
      assert.strictEqual(retired.captain.status, "retired");
      assert.strictEqual(retired.captain.plan, "1. Keep going");
      assert.deepStrictEqual(retired.captain.openNeeds, []);
      assert.deepStrictEqual(yield* Ref.get(harness.interrupts), [captain.threadId]);
    }),
  ),
);

it.effect("a report that arrives during a retirement is refused and stores nothing", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const gate = yield* closeGate(harness.interruptGate);
      const retiring = yield* service
        .setStatus({ captainId: captain.id, status: "retired", ...fromUser })
        .pipe(Effect.forkChild);
      yield* Deferred.await(gate.reached);
      const reporting = yield* Effect.exit(reportWithNeed(service, captain.threadId)).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(retiring);
      assert.strictEqual(failureOf(yield* Fiber.join(reporting)).code, "retired");

      const sql = yield* SqlClient.SqlClient;
      const needs = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS total FROM captain_needs
      `;
      assert.strictEqual(needs[0]?.total, 0);
    }),
  ),
);

it.effect("a report whose request was cancelled is still saved and shown", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const pull = yield* Stream.toPull(service.subscribeList({}));
      assert.deepStrictEqual(
        (yield* pull).map(({ captains }) => captains[0]?.openNeeds.length),
        [0],
      );

      const gate = yield* closeGate(harness.shellGate);
      const reporting = yield* reportWithNeed(service, captain.threadId).pipe(Effect.forkChild);
      yield* Deferred.await(gate.reached);
      const cancelling = yield* Fiber.interrupt(reporting).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(cancelling);

      // Saved needs that no client is shown would wait on the user forever.
      assert.deepStrictEqual(
        (yield* pull).map(({ captains }) => captains[0]?.openNeeds.map((need) => need.summary)),
        [["Ship anyway?"]],
      );
    }),
  ),
);

it.effect("an answer whose request was cancelled still updates the live list", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const need = yield* raiseDecision(service, captain.threadId);
      const pull = yield* Stream.toPull(service.subscribeList({}));
      assert.deepStrictEqual(
        (yield* pull).map(({ captains }) => captains[0]?.openNeeds.map((open) => open.id)),
        [[need.id]],
      );

      const gate = yield* closeGate(harness.sendGate);
      const resolving = yield* service
        .resolveNeed({ needId: need.id, resolution: "Yes.", ...fromUser })
        .pipe(Effect.forkChild);
      yield* Deferred.await(gate.reached);
      const cancelling = yield* Fiber.interrupt(resolving).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(cancelling);

      // The answer was delivered, so every other client must stop showing the need.
      assert.lengthOf(yield* Ref.get(harness.sends), 1);
      assert.deepStrictEqual(
        (yield* pull).map(({ captains }) => captains[0]?.openNeeds),
        [[]],
      );
    }),
  ),
);

it.effect("digest reports the app-owned crew and its counts", () =>
  withService(
    (service) =>
      Effect.gen(function* () {
        const { captain } = yield* createCaptain(service);
        const digest = yield* service.digest(captain.id);
        assert.deepStrictEqual(
          digest.crew.map((member) => [member.taskId, member.status, member.result]),
          [
            ["task:a", "running", null],
            ["task:b", "completed", `${"x".repeat(600)}…`],
          ],
        );
        assert.deepStrictEqual(digest.crewCounts, { active: 1, finished: 1 });
      }),
    {
      subagents: [
        {
          id: "task:a",
          origin: "app_owned",
          childThreadId: ThreadId.make("thread:crew-a"),
          title: "Audit docs",
          status: "running",
          result: null,
        },
        {
          id: "task:b",
          origin: "app_owned",
          childThreadId: ThreadId.make("thread:crew-b"),
          title: "Fix links",
          status: "completed",
          result: "x".repeat(700),
        },
        {
          id: "native:1",
          origin: "provider_native",
          childThreadId: null,
          title: null,
          status: "running",
          result: null,
        },
      ],
    },
  ),
);
