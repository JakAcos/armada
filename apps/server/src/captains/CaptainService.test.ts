import { assert, it } from "@effect/vitest";
import {
  CaptainNeedId,
  type CaptainError,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  isCaptainError,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { OrchestratorRuntimeModeAboveCeilingError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CaptainService from "./CaptainService.ts";

const projectId = ProjectId.make("project:test");
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
}

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
              yield* Ref.update(harness.sends, (all) => [...all, input]);
              return {} as never;
            }),
          interruptThread: (input) =>
            Ref.update(harness.interrupts, (all) => [...all, input.threadId]).pipe(
              Effect.as({ type: "no_active_run" } as const),
            ),
          getThreadRecords: () => Effect.succeed({ subagents: options.subagents ?? [] } as never),
          getThreadShell: (threadId) =>
            Ref.get(harness.threads).pipe(
              Effect.map((threads) => {
                const thread = threads.get(threadId);
                return thread === undefined
                  ? null
                  : ({
                      id: threadId,
                      deletedAt: thread.deleted ? "2026-01-01T00:00:00.000Z" : null,
                    } as unknown as OrchestrationV2ThreadShell);
              }),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              id === projectId || id === bareProjectId
                ? Option.some({
                    id,
                    workspaceRoot: "/projects/test",
                    defaultModelSelection: id === projectId ? modelSelection : null,
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
      assert.include(failureOf(bare).message, "no default model");
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
      yield* setDeleted(false);
      assert.lengthOf((yield* service.list({})).captains, 1);
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

it.effect("an agent's relay is labeled, and a captain cannot answer its own need", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const need = yield* raiseDecision(service, captain.threadId);
      const fromAgent = { createdBy: "agent", creationSource: "mcp" } as const;

      const own = yield* Effect.exit(
        service.resolveNeed({
          needId: need.id,
          resolution: "Yes.",
          ...fromAgent,
          senderThreadId: captain.threadId,
        }),
      );
      assert.strictEqual(failureOf(own).code, "invalid_request");
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
