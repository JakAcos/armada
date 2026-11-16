import { assert, it } from "@effect/vitest";
import {
  CaptainError,
  CaptainNeedId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CaptainService from "./CaptainService.ts";

const isCaptainError = Schema.is(CaptainError);
const projectId = ProjectId.make("project:test");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
  const value = error !== undefined && "error" in error ? error.error : undefined;
  assert.isTrue(isCaptainError(value), `expected a CaptainError, got ${String(value)}`);
  return value as CaptainError;
};

interface Harness {
  readonly launches: Ref.Ref<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>;
  readonly sends: Ref.Ref<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>;
}

const makeLayer = (
  harness: Harness,
  options: {
    readonly launchFails?: boolean;
    readonly subagents?: ReadonlyArray<Record<string, unknown>>;
  } = {},
) =>
  CaptainService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            options.launchFails === true
              ? Effect.fail(
                  new ThreadLaunchService.ThreadLaunchError({
                    operation: "create-thread",
                    commandId: input.commandId,
                    projectId: input.projectId,
                    cause: "provider unavailable",
                  }),
                )
              : Ref.update(harness.launches, (all) => [...all, input]).pipe(
                  Effect.as({
                    threadId: input.threadId!,
                    projection: {} as never,
                    resumed: false,
                  }),
                ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: (input) =>
            Ref.update(harness.sends, (all) => [...all, input]).pipe(Effect.as({} as never)),
          getThreadRecords: () => Effect.succeed({ subagents: options.subagents ?? [] } as never),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        IdAllocator.layer,
      ),
    ),
  );

const withService = <A, E>(
  body: (
    service: CaptainService.CaptainService["Service"],
    harness: Harness,
  ) => Effect.Effect<A, E>,
  options?: Parameters<typeof makeLayer>[1],
) =>
  Effect.gen(function* () {
    const harness: Harness = {
      launches: yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]),
      sends: yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>([]),
    };
    return yield* Effect.gen(function* () {
      const service = yield* CaptainService.CaptainService;
      return yield* body(service, harness);
    }).pipe(Effect.provide(makeLayer(harness, options)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

const createCaptain = (service: CaptainService.CaptainService["Service"], name = "Docs") =>
  service.create({
    projectId,
    name,
    charter: "Keep the user docs accurate.",
    modelSelection,
    createdBy: "user",
    creationSource: "web",
  });

it.effect("create saves the captain before launching its thread with the briefing", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const [launch] = yield* Ref.get(harness.launches);
      assert.strictEqual(launch?.threadId, captain.threadId);
      assert.strictEqual(launch?.projectId, projectId);
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
  ),
);

it.effect("create removes the captain when its thread cannot start", () =>
  withService(
    (service) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(createCaptain(service));
        assert.strictEqual(failureOf(exit).code, "unavailable");
        const { captains } = yield* service.list({});
        assert.deepStrictEqual(captains, []);
      }),
    { launchFails: true },
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

it.effect("resolving a need answers the captain once", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const { raised } = yield* service.report(captain.threadId, {
        needs: [{ kind: "decision", summary: "Ship v2 docs now?" }],
      });
      const need = raised[0]!;

      const resolved = yield* service.resolveNeed({
        needId: need.id,
        resolution: "Yes, ship them today.",
        createdBy: "user",
        creationSource: "web",
      });
      assert.strictEqual(resolved.need.status, "resolved");
      assert.strictEqual(resolved.need.resolution, "Yes, ship them today.");
      assert.deepStrictEqual(resolved.captain.openNeeds, []);

      const again = yield* Effect.exit(
        service.resolveNeed({
          needId: need.id,
          resolution: "No, wait.",
          createdBy: "user",
          creationSource: "web",
        }),
      );
      assert.strictEqual(failureOf(again).code, "invalid_request");

      const sends = yield* Ref.get(harness.sends);
      assert.lengthOf(sends, 1);
      assert.strictEqual(sends[0]?.threadId, captain.threadId);
      assert.strictEqual(sends[0]?.mode, "queue");
      assert.include(sends[0]?.text ?? "", "Ship v2 docs now?");
      assert.include(sends[0]?.text ?? "", "Yes, ship them today.");

      const missing = yield* Effect.exit(
        service.resolveNeed({
          needId: CaptainNeedId.make("need:missing"),
          resolution: "x",
          createdBy: "user",
          creationSource: "web",
        }),
      );
      assert.strictEqual(failureOf(missing).code, "not_found");
    }),
  ),
);

it.effect("a retired captain refuses work until it is reactivated", () =>
  withService((service, harness) =>
    Effect.gen(function* () {
      const { captain } = yield* createCaptain(service);
      const retired = yield* service.setStatus({ captainId: captain.id, status: "retired" });
      assert.strictEqual(retired.captain.status, "retired");

      const message = {
        captainId: captain.id,
        text: "Status?",
        createdBy: "user",
        creationSource: "web",
      } as const;
      assert.strictEqual(failureOf(yield* Effect.exit(service.message(message))).code, "retired");
      assert.strictEqual(
        failureOf(yield* Effect.exit(service.report(captain.threadId, { plan: "x" }))).code,
        "retired",
      );
      assert.lengthOf(yield* Ref.get(harness.sends), 0);

      yield* service.setStatus({ captainId: captain.id, status: "active" });
      yield* service.message(message);
      const sends = yield* Ref.get(harness.sends);
      assert.lengthOf(sends, 1);
      assert.include(sends[0]?.text ?? "", "Status?");
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
