import {
  CaptainError,
  CaptainId,
  CaptainNeedId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type Captain,
  type CaptainCreateInput,
  type CaptainCrewMember,
  type CaptainDigest,
  type CaptainListInput,
  type CaptainListResult,
  type CaptainMessageInput,
  type CaptainMutationResult,
  type CaptainNeed,
  type CaptainReportInput,
  type CaptainReportResult,
  type CaptainResolveNeedInput,
  type CaptainResolveNeedResult,
  type CaptainSetStatusInput,
  type CaptainStatus,
  type CaptainSummary,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type ProviderInteractionMode,
  type RuntimeMode,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { captainBriefing, captainResolutionMessage, captainUserMessage } from "./captainPrompt.ts";

export interface CaptainProvenance {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface CaptainCreateRequest extends CaptainCreateInput, CaptainProvenance {
  /** Modes the captain's thread runs at; MCP callers pass their own so a captain never exceeds them. */
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

const RECENTLY_RESOLVED_LIMIT = 10;
const CREW_RESULT_PREVIEW_LENGTH = 600;

export class CaptainService extends Context.Service<
  CaptainService,
  {
    readonly create: (
      input: CaptainCreateRequest,
    ) => Effect.Effect<CaptainMutationResult, CaptainError>;
    readonly list: (input: CaptainListInput) => Effect.Effect<CaptainListResult, CaptainError>;
    readonly subscribeList: (
      input: CaptainListInput,
    ) => Stream.Stream<CaptainListResult, CaptainError>;
    readonly digest: (captainId: CaptainId) => Effect.Effect<CaptainDigest, CaptainError>;
    readonly message: (
      input: CaptainMessageInput & CaptainProvenance,
    ) => Effect.Effect<CaptainMutationResult, CaptainError>;
    readonly resolveNeed: (
      input: CaptainResolveNeedInput & CaptainProvenance,
    ) => Effect.Effect<CaptainResolveNeedResult, CaptainError>;
    readonly setStatus: (
      input: CaptainSetStatusInput,
    ) => Effect.Effect<CaptainMutationResult, CaptainError>;
    /** The captain's own report, identified by the thread it runs in. */
    readonly report: (
      callerThreadId: ThreadId,
      input: CaptainReportInput,
    ) => Effect.Effect<CaptainReportResult, CaptainError>;
  }
>()("t3/captains/CaptainService") {}

interface CaptainRow {
  readonly captain_id: string;
  readonly project_id: string;
  readonly name: string;
  readonly charter: string;
  readonly thread_id: string;
  readonly status: string;
  readonly plan: string;
  readonly plan_updated_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface NeedRow {
  readonly need_id: string;
  readonly captain_id: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly status: string;
  readonly resolution: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

const captainFromRow = (row: CaptainRow): Captain => ({
  id: CaptainId.make(row.captain_id),
  projectId: ProjectId.make(row.project_id),
  name: row.name,
  charter: row.charter,
  threadId: ThreadId.make(row.thread_id),
  status: row.status === "retired" ? "retired" : "active",
  plan: row.plan,
  planUpdatedAt: row.plan_updated_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const needFromRow = (row: NeedRow): CaptainNeed => ({
  id: CaptainNeedId.make(row.need_id),
  captainId: CaptainId.make(row.captain_id),
  kind: row.kind === "decision" ? "decision" : "blocker",
  summary: row.summary,
  detail: row.detail,
  status: row.status === "resolved" ? "resolved" : "open",
  resolution: row.resolution,
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
});

const captainError = (code: CaptainError["code"], message: string, cause?: unknown) =>
  new CaptainError({ code, message, ...(cause === undefined ? {} : { cause }) });

const unavailable = (what: string) => (cause: unknown) =>
  captainError("unavailable", `Could not ${what}.`, cause);

const ACTIVE_CREW_STATUSES = new Set(["idle", "pending", "running", "waiting"]);

const crewFromSubagents = (
  subagents: ReadonlyArray<{
    readonly id: string;
    readonly origin: string;
    readonly childThreadId: ThreadId | null;
    readonly title: string | null;
    readonly status: string;
    readonly result: string | null;
  }>,
): ReadonlyArray<CaptainCrewMember> =>
  subagents
    .filter((task) => task.origin === "app_owned")
    .map((task) => ({
      taskId: task.id,
      childThreadId: task.childThreadId,
      title: task.title,
      status: task.status,
      result:
        task.result === null || task.result.length <= CREW_RESULT_PREVIEW_LENGTH
          ? task.result
          : `${task.result.slice(0, CREW_RESULT_PREVIEW_LENGTH)}…`,
    }));

export const layer = Layer.effect(
  CaptainService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const ids = yield* IdAllocator.IdAllocatorV2;
    // A change re-emits the whole list; a slow subscriber needs only the latest signal.
    const changes = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const uuid = randomUuidV4;

    const findCaptainRow = (where: { readonly id: CaptainId } | { readonly threadId: ThreadId }) =>
      ("id" in where
        ? sql<CaptainRow>`SELECT * FROM captains WHERE captain_id = ${where.id}`
        : sql<CaptainRow>`SELECT * FROM captains WHERE thread_id = ${where.threadId}`
      ).pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(captainFromRow))),
        Effect.mapError(unavailable("read the captain")),
      );

    const requireCaptain = (captainId: CaptainId) =>
      findCaptainRow({ id: captainId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(captainError("not_found", `Captain ${captainId} was not found.`)),
            onSome: Effect.succeed,
          }),
        ),
      );

    const requireActive = (captain: Captain) =>
      captain.status === "retired"
        ? Effect.fail(
            captainError("retired", `Captain ${captain.name} is retired. Reactivate it first.`),
          )
        : Effect.succeed(captain);

    const needsFor = (captainIds: ReadonlyArray<string>, status: CaptainNeed["status"]) =>
      captainIds.length === 0
        ? Effect.succeed([] as ReadonlyArray<CaptainNeed>)
        : sql<NeedRow>`
            SELECT * FROM captain_needs
            WHERE status = ${status} AND ${sql.in("captain_id", captainIds)}
            ORDER BY created_at ASC, rowid ASC
          `.pipe(
            NodeSqliteClient.readOnly,
            Effect.map((rows) => rows.map(needFromRow)),
            Effect.mapError(unavailable("read the captain's needs")),
          );

    const summarize = Effect.fn("CaptainService.summarize")(function* (
      captains: ReadonlyArray<Captain>,
    ) {
      const open = yield* needsFor(
        captains.map((captain) => captain.id),
        "open",
      );
      return captains.map((captain): CaptainSummary => ({
        ...captain,
        openNeeds: open.filter((need) => need.captainId === captain.id),
      }));
    });

    const summaryOf = (captainId: CaptainId) =>
      requireCaptain(captainId).pipe(
        Effect.flatMap((captain) => summarize([captain])),
        Effect.map((summaries) => summaries[0]!),
      );

    const list: CaptainService["Service"]["list"] = Effect.fn("CaptainService.list")(
      function* (input) {
        const rows = yield* (
          input.projectId === undefined
            ? sql<CaptainRow>`SELECT * FROM captains ORDER BY created_at ASC, captain_id ASC`
            : sql<CaptainRow>`
                SELECT * FROM captains WHERE project_id = ${input.projectId}
                ORDER BY created_at ASC, captain_id ASC
              `
        ).pipe(NodeSqliteClient.readOnly, Effect.mapError(unavailable("list captains")));
        return { captains: yield* summarize(rows.map(captainFromRow)) };
      },
    );

    const subscribeList: CaptainService["Service"]["subscribeList"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before the first read so a change during it is not lost.
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list(input)),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
          );
        }),
      );

    const defaultModelSelection = Effect.fn("CaptainService.defaultModelSelection")(function* (
      projectId: ProjectId,
    ) {
      const project = yield* projects.getById(projectId).pipe(
        Effect.mapError(unavailable(`read project ${projectId}`)),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(captainError("not_found", `Project ${projectId} was not found.`)),
            onSome: Effect.succeed,
          }),
        ),
      );
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(unavailable("read server settings")),
      );
      const selection: ModelSelection | null = resolveProjectSettings(settings, project.id, project)
        .settings.defaultModelSelection;
      if (selection === null) {
        return yield* captainError(
          "invalid_request",
          `Project ${projectId} has no default model. Pick a model for the captain.`,
        );
      }
      return selection;
    });

    const create: CaptainService["Service"]["create"] = Effect.fn("CaptainService.create")(
      function* (input) {
        const modelSelection =
          input.modelSelection ?? (yield* defaultModelSelection(input.projectId));
        const key = yield* uuid;
        const id = CaptainId.make(`captain:${key}`);
        const threadId = yield* ids.allocate
          .thread({ projectId: input.projectId })
          .pipe(Effect.mapError(unavailable("allocate the captain's thread")));
        const now = yield* nowIso;
        // The row exists before the thread so the captain's first `captain_report` always finds it.
        yield* sql`INSERT INTO captains ${sql.insert({
          captain_id: id,
          project_id: input.projectId,
          name: input.name,
          charter: input.charter,
          thread_id: threadId,
          status: "active",
          plan: "",
          plan_updated_at: null,
          created_at: now,
          updated_at: now,
        })}`.pipe(Effect.mapError(unavailable("save the captain")));
        yield* threadLaunch
          .launch({
            commandId: CommandId.make(`captain-launch:${key}`),
            threadId,
            projectId: input.projectId,
            title: `Captain ${input.name}`,
            modelSelection,
            runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make(`captain-briefing:${key}`),
              text: captainBriefing({ id, name: input.name, charter: input.charter }),
              attachments: [],
            },
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          })
          .pipe(
            // Any failure, defects and interruption included, must not leave a captain without a thread.
            Effect.onError(() =>
              sql`DELETE FROM captains WHERE captain_id = ${id}`.pipe(Effect.ignore),
            ),
            Effect.mapError(unavailable("start the captain's thread")),
          );
        yield* notifyChanged;
        return { captain: yield* summaryOf(id) };
      },
    );

    const sendToCaptain = Effect.fn("CaptainService.sendToCaptain")(function* (
      captain: Captain,
      text: string,
      provenance: CaptainProvenance,
    ) {
      const key = yield* uuid;
      yield* threadManagement
        .sendToThread({
          projectId: captain.projectId,
          commandId: CommandId.make(`captain-message:${key}`),
          threadId: captain.threadId,
          messageId: MessageId.make(`captain-message:${key}`),
          text,
          attachments: [],
          mode: "queue",
          createdBy: provenance.createdBy,
          creationSource: provenance.creationSource,
        })
        .pipe(Effect.mapError(unavailable(`message captain ${captain.name}`)));
    });

    const touch = (captainId: CaptainId, now: string) =>
      sql`UPDATE captains SET updated_at = ${now} WHERE captain_id = ${captainId}`;

    const message: CaptainService["Service"]["message"] = Effect.fn("CaptainService.message")(
      function* (input) {
        const captain = yield* requireCaptain(input.captainId).pipe(Effect.flatMap(requireActive));
        yield* sendToCaptain(captain, captainUserMessage(input.text), input);
        return { captain: yield* summaryOf(captain.id) };
      },
    );

    const findNeed = (needId: CaptainNeedId) =>
      sql<NeedRow>`SELECT * FROM captain_needs WHERE need_id = ${needId}`.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(needFromRow))),
        Effect.mapError(unavailable("read the need")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(captainError("not_found", `Need ${needId} was not found.`)),
            onSome: Effect.succeed,
          }),
        ),
      );

    const resolveNeed: CaptainService["Service"]["resolveNeed"] = Effect.fn(
      "CaptainService.resolveNeed",
    )(function* (input) {
      const need = yield* findNeed(input.needId);
      if (need.status !== "open") {
        return yield* captainError("invalid_request", `Need ${need.id} is already resolved.`);
      }
      const captain = yield* requireCaptain(need.captainId).pipe(Effect.flatMap(requireActive));
      const now = yield* nowIso;
      // Only the first resolver wins; a second click must not send the captain a second answer.
      const claimed = yield* sql<{ readonly need_id: string }>`
        UPDATE captain_needs
        SET status = 'resolved', resolution = ${input.resolution}, resolved_at = ${now}
        WHERE need_id = ${need.id} AND status = 'open'
        RETURNING need_id
      `.pipe(Effect.mapError(unavailable("resolve the need")));
      if (claimed.length === 0) {
        return yield* captainError("invalid_request", `Need ${need.id} is already resolved.`);
      }
      yield* touch(captain.id, now).pipe(Effect.mapError(unavailable("update the captain")));
      yield* notifyChanged;
      yield* sendToCaptain(captain, captainResolutionMessage(need, input.resolution), input);
      return {
        need: yield* findNeed(need.id),
        captain: yield* summaryOf(captain.id),
      };
    });

    const setStatus: CaptainService["Service"]["setStatus"] = Effect.fn("CaptainService.setStatus")(
      function* (input) {
        const captain = yield* requireCaptain(input.captainId);
        if (captain.status !== input.status) {
          const now = yield* nowIso;
          const status: CaptainStatus = input.status;
          yield* sql`
          UPDATE captains SET status = ${status}, updated_at = ${now}
          WHERE captain_id = ${captain.id}
        `.pipe(Effect.mapError(unavailable("update the captain")));
          yield* notifyChanged;
        }
        return { captain: yield* summaryOf(captain.id) };
      },
    );

    const report: CaptainService["Service"]["report"] = Effect.fn("CaptainService.report")(
      function* (callerThreadId, input) {
        const captain = yield* findCaptainRow({ threadId: callerThreadId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  captainError(
                    "invalid_request",
                    "Only a captain's own thread can report. This thread is not a captain.",
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.flatMap(requireActive),
        );
        const now = yield* nowIso;
        const raisedIds: Array<CaptainNeedId> = [];
        const newNeeds = yield* Effect.forEach(input.needs ?? [], (need) =>
          uuid.pipe(Effect.map((key) => ({ need, id: CaptainNeedId.make(`need:${key}`) }))),
        );
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (input.plan !== undefined) {
                yield* sql`
                  UPDATE captains SET plan = ${input.plan}, plan_updated_at = ${now}
                  WHERE captain_id = ${captain.id}
                `;
              }
              for (const { need, id } of newNeeds) {
                yield* sql`INSERT INTO captain_needs ${sql.insert({
                  need_id: id,
                  captain_id: captain.id,
                  kind: need.kind,
                  summary: need.summary,
                  detail: need.detail ?? null,
                  status: "open",
                  resolution: null,
                  created_at: now,
                  resolved_at: null,
                })}`;
                raisedIds.push(id);
              }
              const withdraw = input.withdrawNeedIds ?? [];
              if (withdraw.length > 0) {
                // Scoped to this captain so it cannot close another captain's needs.
                yield* sql`
                  UPDATE captain_needs
                  SET status = 'resolved', resolution = 'Withdrawn by the captain.', resolved_at = ${now}
                  WHERE captain_id = ${captain.id} AND status = 'open'
                    AND ${sql.in("need_id", withdraw)}
                `;
              }
              yield* touch(captain.id, now);
            }),
          )
          .pipe(Effect.mapError(unavailable("save the captain's report")));
        yield* notifyChanged;
        const summary = yield* summaryOf(captain.id);
        return {
          captain: summary,
          raised: summary.openNeeds.filter((need) => raisedIds.includes(need.id)),
        };
      },
    );

    const digest: CaptainService["Service"]["digest"] = Effect.fn("CaptainService.digest")(
      function* (captainId) {
        const summary = yield* summaryOf(captainId);
        const recentlyResolved = yield* sql<NeedRow>`
          SELECT * FROM captain_needs
          WHERE captain_id = ${captainId} AND status = 'resolved'
          ORDER BY resolved_at DESC, rowid DESC
          LIMIT ${RECENTLY_RESOLVED_LIMIT}
        `.pipe(
          NodeSqliteClient.readOnly,
          Effect.map((rows) => rows.map(needFromRow)),
          Effect.mapError(unavailable("read the captain's resolved needs")),
        );
        const { subagents } = yield* threadManagement
          .getThreadRecords(summary.threadId, ["subagents"])
          .pipe(Effect.mapError(unavailable("read the captain's crew")));
        const crew = crewFromSubagents(subagents);
        const active = crew.filter((member) => ACTIVE_CREW_STATUSES.has(member.status)).length;
        return {
          captain: summary,
          recentlyResolved,
          crew,
          crewCounts: { active, finished: crew.length - active },
        };
      },
    );

    return CaptainService.of({
      create,
      list,
      subscribeList,
      digest,
      message,
      resolveNeed,
      setStatus,
      report,
    });
  }),
);
