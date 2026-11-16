import {
  CaptainError,
  CaptainId,
  CaptainNeedId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  isCaptainError,
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
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type ProviderInteractionMode,
  type RuntimeMode,
  DEFAULT_PROVIDER_INTERACTION_MODE,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  CAPTAIN_REACTIVATED_MESSAGE,
  CAPTAIN_RETIRED_MESSAGE,
  captainBriefing,
  captainResolutionMessage,
  captainUserMessage,
} from "./captainPrompt.ts";

export interface CaptainProvenance {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /** The agent thread that relays this, if one does. A captain's thread cannot answer a need. */
  readonly senderThreadId?: ThreadId;
}

export interface CaptainCreateRequest extends CaptainCreateInput, CaptainProvenance {
  /** Modes the captain's thread runs at; MCP callers pass their own so a captain never exceeds them. */
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

/** A captain, or the captain that raised a need. */
export type CaptainTarget = { readonly captainId: CaptainId } | { readonly needId: CaptainNeedId };

const RECENTLY_RESOLVED_LIMIT = 10;
const CREW_RESULT_PREVIEW_LENGTH = 600;
const LIVE_THREAD_CHECK_CONCURRENCY = 8;

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
    /** The thread a message or a need's answer is delivered to, for a caller's access check. */
    readonly threadIdOf: (target: CaptainTarget) => Effect.Effect<ThreadId, CaptainError>;
    readonly message: (
      input: CaptainMessageInput & CaptainProvenance,
    ) => Effect.Effect<CaptainMutationResult, CaptainError>;
    readonly resolveNeed: (
      input: CaptainResolveNeedInput & CaptainProvenance,
    ) => Effect.Effect<CaptainResolveNeedResult, CaptainError>;
    readonly setStatus: (
      input: CaptainSetStatusInput & CaptainProvenance,
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

/** Wraps a lower-level failure with what was being done; a captain's own error passes through. */
const unavailable = (what: string) => (cause: unknown) =>
  isCaptainError(cause)
    ? cause
    : new CaptainError({ code: "unavailable", message: `Could not ${what}.`, cause });

const isRuntimeModeAboveCeiling = Schema.is(OrchestratorRuntimeModeAboveCeilingError);

/** A launch refusal the user can act on says what to change; anything else is only "unavailable". */
const launchFailure = (
  error:
    | ThreadLaunchService.ThreadLaunchError
    | ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
) => {
  if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
    return new CaptainError({
      code: "invalid_request",
      message: `Provider "${error.instanceId}" is disabled for this project. Enable it, or set another default model for the project.`,
      cause: error,
    });
  }
  const refusal: unknown = error.cause;
  return isRuntimeModeAboveCeiling(refusal)
    ? new CaptainError({
        code: "invalid_request",
        message: `${refusal.organization} limits this environment to ${refusal.maxRuntimeMode} mode, so a captain cannot start in ${refusal.runtimeMode} mode. Lower the project's default mode.`,
        cause: error,
      })
    : unavailable("start the captain's thread")(error);
};

const ACTIVE_CREW_STATUSES = new Set(["idle", "pending", "running", "waiting"]);

/** The preview's last unit is never half of a surrogate pair, which would not encode as text. */
const previewOf = (result: string) => {
  const last = result.charCodeAt(CREW_RESULT_PREVIEW_LENGTH - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return result.slice(0, CREW_RESULT_PREVIEW_LENGTH - (splitsPair ? 1 : 0));
};

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
          : `${previewOf(task.result)}…`,
    }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  // Everything a captain is told (a message, an answer, a status change) and everything it
  // reports goes through its lock, so what it last heard and what is stored about it always
  // agree. Nothing that holds the lock waits on the captain's turn, so a turn cannot deadlock it.
  const tellLock = yield* KeyedLock.make<CaptainId>();
  // A change re-emits the whole list; a slow subscriber needs only the latest signal.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = randomUuidV4;

  const findCaptain = Effect.fn("CaptainService.findCaptain")(function* (
    where: { readonly id: CaptainId } | { readonly threadId: ThreadId },
  ) {
    const rows = yield* (
      "id" in where
        ? sql<CaptainRow>`SELECT * FROM captains WHERE captain_id = ${where.id}`
        : sql<CaptainRow>`SELECT * FROM captains WHERE thread_id = ${where.threadId}`
    ).pipe(NodeSqliteClient.readOnly, Effect.mapError(unavailable("read the captain")));
    return Option.fromNullishOr(rows[0]).pipe(Option.map(captainFromRow));
  });

  /**
   * A captain whose thread was deleted has nothing to run in. Its row stays, in case the thread is
   * restored. A thread that cannot be read counts as present, so one bad read hides no captain.
   */
  const hasLiveThread = Effect.fn("CaptainService.hasLiveThread")(function* (captain: Captain) {
    const shell = yield* threadManagement
      .getThreadShell(captain.threadId)
      .pipe(Effect.orElseSucceed(() => undefined));
    return shell === undefined || (shell !== null && shell.deletedAt === null);
  });

  const requireCaptain = Effect.fn("CaptainService.requireCaptain")(function* (
    captainId: CaptainId,
  ) {
    const captain = yield* findCaptain({ id: captainId });
    if (Option.isNone(captain)) {
      return yield* new CaptainError({
        code: "not_found",
        message: `Captain ${captainId} was not found.`,
      });
    }
    if (!(yield* hasLiveThread(captain.value))) {
      return yield* new CaptainError({
        code: "not_found",
        message: `Captain ${captain.value.name}'s thread no longer exists.`,
      });
    }
    return captain.value;
  });

  const requireActive = (captain: Captain) =>
    captain.status === "retired"
      ? Effect.fail(
          new CaptainError({
            code: "retired",
            message: `Captain ${captain.name} is retired. Reactivate it first.`,
          }),
        )
      : Effect.succeed(captain);

  const openNeedsOf = Effect.fn("CaptainService.openNeedsOf")(function* (
    captainIds: ReadonlyArray<string>,
  ) {
    if (captainIds.length === 0) return [] as ReadonlyArray<CaptainNeed>;
    const rows = yield* sql<NeedRow>`
      SELECT * FROM captain_needs
      WHERE status = 'open' AND ${sql.in("captain_id", captainIds)}
      ORDER BY created_at ASC, rowid ASC
    `.pipe(NodeSqliteClient.readOnly, Effect.mapError(unavailable("read the captain's needs")));
    return rows.map(needFromRow);
  });

  const summarize = Effect.fn("CaptainService.summarize")(function* (
    captains: ReadonlyArray<Captain>,
  ) {
    // A retired captain cannot be answered, so none of its needs are waiting on the user.
    const open = yield* openNeedsOf(
      captains.filter((captain) => captain.status === "active").map((captain) => captain.id),
    );
    return captains.map((captain): CaptainSummary => ({
      ...captain,
      openNeeds: open.filter((need) => need.captainId === captain.id),
    }));
  });

  const summaryOf = Effect.fn("CaptainService.summaryOf")(function* (captainId: CaptainId) {
    const summaries = yield* summarize([yield* requireCaptain(captainId)]);
    return summaries[0]!;
  });

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
      const live = yield* Effect.filter(rows.map(captainFromRow), hasLiveThread, {
        concurrency: LIVE_THREAD_CHECK_CONCURRENCY,
      });
      return { captains: yield* summarize(live) };
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

  const projectDefaults = Effect.fn("CaptainService.projectDefaults")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(unavailable(`read project ${projectId}`)));
    if (Option.isNone(project)) {
      return yield* new CaptainError({
        code: "not_found",
        message: `Project ${projectId} was not found.`,
      });
    }
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(unavailable("read server settings")),
    );
    return {
      title: project.value.title,
      ...resolveProjectSettings(settings, project.value.id, project.value).settings,
    };
  });

  const create: CaptainService["Service"]["create"] = Effect.fn("CaptainService.create")(
    function* (input) {
      const defaults = yield* projectDefaults(input.projectId);
      const modelSelection = input.modelSelection ?? defaults.defaultModelSelection;
      if (modelSelection == null) {
        return yield* new CaptainError({
          code: "invalid_request",
          message: `Project ${defaults.title} has no default model. Set one in the project's settings, then start the captain.`,
        });
      }
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
      // A launch can fail, or be interrupted, after it committed the thread. That captain is
      // running, so its row stays. An unreadable thread counts as committed: a row with no thread
      // is only hidden from the list, while a thread with no row is a captain that cannot report.
      const threadCommitted = threadManagement.getThreadShell(threadId).pipe(
        Effect.map((shell) => shell !== null),
        Effect.orElseSucceed(() => true),
      );
      yield* threadLaunch
        .launch({
          commandId: CommandId.make(`captain-launch:${key}`),
          threadId,
          projectId: input.projectId,
          title: `Captain ${input.name}`,
          modelSelection,
          // The project's own default, as a thread the user starts there gets.
          runtimeMode: input.runtimeMode ?? defaults.defaultRuntimeMode,
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
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.flatMap(threadCommitted, (committed) =>
              committed
                ? Effect.logWarning("Captain launch failed after its thread started.", error).pipe(
                    Effect.annotateLogs({ captainId: id, threadId }),
                  )
                : Effect.fail(error),
            ),
          ),
          Effect.onError(() =>
            Effect.flatMap(threadCommitted, (committed) =>
              committed
                ? // An interrupted launch returns nothing, but its captain is running: show it.
                  notifyChanged
                : sql`DELETE FROM captains WHERE captain_id = ${id}`.pipe(
                    Effect.ignore({ log: true }),
                  ),
            ),
          ),
          Effect.mapError(launchFailure),
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
    const commandId = CommandId.make(`captain-message:${key}`);
    const accepted = receipts.getByCommandId(commandId).pipe(
      Effect.map(Option.exists((receipt) => receipt.status === "accepted")),
      Effect.orElseSucceed(() => false),
    );
    yield* threadManagement
      .sendToThread({
        projectId: captain.projectId,
        commandId,
        threadId: captain.threadId,
        messageId: MessageId.make(`captain-message:${key}`),
        ...(provenance.senderThreadId === undefined
          ? {}
          : { senderThreadId: provenance.senderThreadId }),
        text,
        attachments: [],
        mode: "queue",
        createdBy: provenance.createdBy,
        creationSource: provenance.creationSource,
      })
      .pipe(
        // A send can fail after the thread accepted the message, on the read that builds its
        // reply. The captain has it, so reporting a failure would invite a second copy.
        Effect.catch((error) =>
          Effect.flatMap(accepted, (delivered) =>
            delivered
              ? Effect.logWarning("Captain message was delivered, then its send failed.", error)
              : Effect.fail(error),
          ),
        ),
        Effect.catchTags({
          ThreadManagementThreadArchivedError: (cause) =>
            Effect.fail(
              new CaptainError({
                code: "invalid_request",
                message: `Captain ${captain.name}'s thread is archived. Unarchive it to reach the captain.`,
                cause,
              }),
            ),
          ThreadManagementThreadNotFoundError: (cause) =>
            Effect.fail(
              new CaptainError({
                code: "not_found",
                message: `Captain ${captain.name}'s thread no longer exists.`,
                cause,
              }),
            ),
          ThreadManagementProviderInstanceDisabledError: (cause) =>
            Effect.fail(
              new CaptainError({
                code: "invalid_request",
                message: `Captain ${captain.name}'s provider "${cause.instanceId}" is disabled. Enable it to reach the captain.`,
                cause,
              }),
            ),
        }),
        Effect.mapError(unavailable(`message captain ${captain.name}`)),
      );
  });

  const touch = (captainId: CaptainId, now: string) =>
    sql`UPDATE captains SET updated_at = ${now} WHERE captain_id = ${captainId}`;

  const findNeed = Effect.fn("CaptainService.findNeed")(function* (needId: CaptainNeedId) {
    const rows = yield* sql<NeedRow>`SELECT * FROM captain_needs WHERE need_id = ${needId}`.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(unavailable("read the need")),
    );
    const row = rows[0];
    if (row === undefined) {
      return yield* new CaptainError({
        code: "not_found",
        message: `Need ${needId} was not found.`,
      });
    }
    return needFromRow(row);
  });

  const threadIdOf: CaptainService["Service"]["threadIdOf"] = Effect.fn(
    "CaptainService.threadIdOf",
  )(function* (target) {
    const captainId =
      "captainId" in target ? target.captainId : (yield* findNeed(target.needId)).captainId;
    return (yield* requireCaptain(captainId)).threadId;
  });

  const message: CaptainService["Service"]["message"] = Effect.fn("CaptainService.message")(
    function* (input) {
      yield* tellLock.withLock(
        input.captainId,
        // A message that was sent is always announced, even if its sender has gone.
        Effect.uninterruptible(
          Effect.gen(function* () {
            const captain = yield* requireCaptain(input.captainId).pipe(
              Effect.flatMap(requireActive),
            );
            if (input.senderThreadId === captain.threadId) {
              return yield* new CaptainError({
                code: "invalid_request",
                message:
                  "A captain cannot message itself. Use `captain_report` to update your plan or needs.",
              });
            }
            yield* sendToCaptain(captain, captainUserMessage(input.text, input.createdBy), input);
            yield* touch(captain.id, yield* nowIso).pipe(Effect.ignore({ log: true }));
            yield* notifyChanged;
          }),
        ),
      );
      return { captain: yield* summaryOf(input.captainId) };
    },
  );

  const resolveNeed: CaptainService["Service"]["resolveNeed"] = Effect.fn(
    "CaptainService.resolveNeed",
  )(function* (input) {
    const need = yield* findNeed(input.needId);
    // A need is for the user. No captain's thread answers one, its own or another captain's.
    if (
      input.senderThreadId !== undefined &&
      Option.isSome(yield* findCaptain({ threadId: input.senderThreadId }))
    ) {
      return yield* new CaptainError({
        code: "invalid_request",
        message:
          "A captain cannot resolve a need, its own or another captain's. Withdraw your own with `captain_report` once it no longer needs the user.",
      });
    }
    yield* tellLock.withLock(
      need.captainId,
      // Claiming and delivering are one step to the user: a disconnect between them must not
      // leave an answer that was recorded but never sent.
      Effect.uninterruptible(
        Effect.gen(function* () {
          const captain = yield* requireCaptain(need.captainId).pipe(Effect.flatMap(requireActive));
          const now = yield* nowIso;
          // Only the first resolver wins; a second click must not send the captain a second
          // answer. The status is checked in the same statement, so a retired captain gets none.
          const claimed = yield* sql<{ readonly need_id: string }>`
            UPDATE captain_needs
            SET status = 'resolved', resolution = ${input.resolution}, resolved_at = ${now}
            WHERE need_id = ${need.id} AND status = 'open'
              AND EXISTS (
                SELECT 1 FROM captains
                WHERE captain_id = ${captain.id} AND status = 'active'
              )
            RETURNING need_id
          `.pipe(Effect.mapError(unavailable("resolve the need")));
          if (claimed.length === 0) {
            return yield* new CaptainError({
              code: "invalid_request",
              message: `Need ${need.id} is already resolved.`,
            });
          }
          // An answer the captain never received is not an answer: the need goes back to the user.
          const reopen = sql`
            UPDATE captain_needs SET status = 'open', resolution = NULL, resolved_at = NULL
            WHERE need_id = ${need.id} AND status = 'resolved' AND resolved_at = ${now}
          `.pipe(Effect.andThen(notifyChanged), Effect.ignore({ log: true }));
          yield* sendToCaptain(
            captain,
            captainResolutionMessage(need, input.resolution, input.createdBy),
            input,
          ).pipe(Effect.onError(() => reopen));
          yield* touch(captain.id, now).pipe(Effect.ignore({ log: true }));
          // Inside the protected step: a caller that disconnected still changed the list.
          yield* notifyChanged;
        }),
      ),
    );
    return {
      need: yield* findNeed(need.id),
      captain: yield* summaryOf(need.captainId),
    };
  });

  /**
   * Retiring stops the captain's turn and tells it so, because crew results still wake its thread
   * and it would otherwise carry on. The status is what the user asked for, so a thread that
   * cannot be reached does not fail it.
   */
  const announceStatus = Effect.fn("CaptainService.announceStatus")(function* (
    captain: Captain,
    status: CaptainStatus,
    provenance: CaptainProvenance,
  ) {
    if (status === "retired") {
      const key = yield* uuid;
      yield* threadManagement
        .interruptThread({
          projectId: captain.projectId,
          commandId: CommandId.make(`captain-retire:${key}`),
          threadId: captain.threadId,
          reason: "The captain was retired.",
        })
        .pipe(Effect.ignore({ log: true }));
    }
    yield* sendToCaptain(
      captain,
      status === "retired" ? CAPTAIN_RETIRED_MESSAGE : CAPTAIN_REACTIVATED_MESSAGE,
      provenance,
    ).pipe(Effect.ignore({ log: true }));
  });

  const setStatus: CaptainService["Service"]["setStatus"] = Effect.fn("CaptainService.setStatus")(
    function* (input) {
      const status: CaptainStatus = input.status;
      yield* tellLock.withLock(
        input.captainId,
        // The stored status and what the captain was told change together, or a cancelled
        // request would leave a "retired" captain that was never stopped.
        Effect.uninterruptible(
          Effect.gen(function* () {
            const captain = yield* requireCaptain(input.captainId);
            const now = yield* nowIso;
            // Two clicks change the status once, so the captain is told once.
            const changed = yield* sql<{ readonly captain_id: string }>`
              UPDATE captains SET status = ${status}, updated_at = ${now}
              WHERE captain_id = ${captain.id} AND status <> ${status}
              RETURNING captain_id
            `.pipe(Effect.mapError(unavailable("update the captain")));
            if (changed.length > 0) {
              yield* notifyChanged;
              yield* announceStatus(captain, status, input);
            }
          }),
        ),
      );
      return { captain: yield* summaryOf(input.captainId) };
    },
  );

  const report: CaptainService["Service"]["report"] = Effect.fn("CaptainService.report")(
    function* (callerThreadId, input) {
      const found = yield* findCaptain({ threadId: callerThreadId });
      if (Option.isNone(found)) {
        return yield* new CaptainError({
          code: "invalid_request",
          message: "Only a captain's own thread can report. This thread is not a captain.",
        });
      }
      // Under the captain's lock, with its state read inside: a report that races a retirement
      // either lands before it or is refused, and never stores needs the captain was told nothing
      // about. It is one step: a cancelled request must not save needs that no client is shown.
      return yield* tellLock.withLock(
        found.value.id,
        Effect.uninterruptible(
          Effect.gen(function* () {
            const captain = yield* requireCaptain(found.value.id).pipe(
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
          }),
        ),
      );
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
    threadIdOf,
    message,
    resolveNeed,
    setStatus,
    report,
  });
});

export const layer = Layer.effect(CaptainService, make);
