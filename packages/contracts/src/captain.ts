import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const CaptainId = TrimmedNonEmptyString.pipe(Schema.brand("CaptainId"));
export type CaptainId = typeof CaptainId.Type;
export const CaptainNeedId = TrimmedNonEmptyString.pipe(Schema.brand("CaptainNeedId"));
export type CaptainNeedId = typeof CaptainNeedId.Type;

export const CAPTAIN_NAME_MAX_LENGTH = 80;
export const CAPTAIN_CHARTER_MAX_LENGTH = 8_000;
const CAPTAIN_PLAN_MAX_LENGTH = 20_000;
const CAPTAIN_NEED_SUMMARY_MAX_LENGTH = 200;
const CAPTAIN_NEED_DETAIL_MAX_LENGTH = 4_000;
export const CAPTAIN_MESSAGE_MAX_LENGTH = 8_000;

export const CaptainStatus = Schema.Literals(["active", "retired"]);
export type CaptainStatus = typeof CaptainStatus.Type;

export const CaptainNeedKind = Schema.Literals(["blocker", "decision"]);
export type CaptainNeedKind = typeof CaptainNeedKind.Type;

export const CaptainNeedStatus = Schema.Literals(["open", "resolved"]);
export type CaptainNeedStatus = typeof CaptainNeedStatus.Type;

const CaptainName = TrimmedNonEmptyString.check(Schema.isMaxLength(CAPTAIN_NAME_MAX_LENGTH));
const CaptainCharter = TrimmedNonEmptyString.check(Schema.isMaxLength(CAPTAIN_CHARTER_MAX_LENGTH));
const CaptainPlan = Schema.String.check(Schema.isMaxLength(CAPTAIN_PLAN_MAX_LENGTH));
const CaptainNeedSummary = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CAPTAIN_NEED_SUMMARY_MAX_LENGTH),
);
const CaptainNeedDetail = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CAPTAIN_NEED_DETAIL_MAX_LENGTH),
);
const CaptainMessageText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CAPTAIN_MESSAGE_MAX_LENGTH),
);

export const CaptainNeed = Schema.Struct({
  id: CaptainNeedId,
  captainId: CaptainId,
  kind: CaptainNeedKind,
  summary: Schema.String,
  detail: Schema.NullOr(Schema.String),
  status: CaptainNeedStatus,
  resolution: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type CaptainNeed = typeof CaptainNeed.Type;

export const Captain = Schema.Struct({
  id: CaptainId,
  projectId: ProjectId,
  name: Schema.String,
  charter: Schema.String,
  threadId: ThreadId,
  status: CaptainStatus,
  plan: Schema.String,
  planUpdatedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Captain = typeof Captain.Type;

/** A captain with what it needs from the user, the shape lists and the needs-you surface read. */
export const CaptainSummary = Schema.Struct({
  ...Captain.fields,
  openNeeds: ForwardCompatibleArray(CaptainNeed),
});
export type CaptainSummary = typeof CaptainSummary.Type;

export const CaptainCrewMember = Schema.Struct({
  taskId: Schema.String,
  childThreadId: Schema.NullOr(ThreadId),
  title: Schema.NullOr(Schema.String),
  status: Schema.String,
  result: Schema.NullOr(Schema.String),
});
export type CaptainCrewMember = typeof CaptainCrewMember.Type;

export const CaptainDigest = Schema.Struct({
  captain: CaptainSummary,
  recentlyResolved: ForwardCompatibleArray(CaptainNeed),
  crew: ForwardCompatibleArray(CaptainCrewMember),
  crewCounts: Schema.Struct({
    active: NonNegativeInt,
    finished: NonNegativeInt,
  }),
});
export type CaptainDigest = typeof CaptainDigest.Type;

export const CaptainListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type CaptainListInput = typeof CaptainListInput.Type;

export const CaptainListResult = Schema.Struct({
  captains: ForwardCompatibleArray(CaptainSummary),
});
export type CaptainListResult = typeof CaptainListResult.Type;

export const CaptainCreateInput = Schema.Struct({
  projectId: ProjectId,
  name: CaptainName,
  charter: CaptainCharter.annotate({
    description: "The area the captain owns and the outcome it works toward.",
  }),
  modelSelection: Schema.optional(ModelSelection),
});
export type CaptainCreateInput = typeof CaptainCreateInput.Type;

export const CaptainDigestInput = Schema.Struct({ captainId: CaptainId });
export type CaptainDigestInput = typeof CaptainDigestInput.Type;

export const CaptainMessageInput = Schema.Struct({
  captainId: CaptainId,
  text: CaptainMessageText,
});
export type CaptainMessageInput = typeof CaptainMessageInput.Type;

export const CaptainResolveNeedInput = Schema.Struct({
  needId: CaptainNeedId,
  resolution: CaptainMessageText.annotate({
    description: "The user's answer or decision. The captain receives it as a message.",
  }),
});
export type CaptainResolveNeedInput = typeof CaptainResolveNeedInput.Type;

export const CaptainSetStatusInput = Schema.Struct({
  captainId: CaptainId,
  status: CaptainStatus,
});
export type CaptainSetStatusInput = typeof CaptainSetStatusInput.Type;

export const CaptainReportNeed = Schema.Struct({
  kind: CaptainNeedKind,
  summary: CaptainNeedSummary,
  detail: Schema.optional(CaptainNeedDetail),
});
export type CaptainReportNeed = typeof CaptainReportNeed.Type;

export const CaptainReportInput = Schema.Struct({
  plan: Schema.optional(
    CaptainPlan.annotate({ description: "The whole plan as Markdown. Replaces the stored plan." }),
  ),
  needs: Schema.optional(
    Schema.Array(CaptainReportNeed)
      .check(Schema.isMaxLength(10))
      .annotate({ description: "New blockers or decisions only the user can settle." }),
  ),
  withdrawNeedIds: Schema.optional(
    Schema.Array(CaptainNeedId)
      .check(Schema.isMaxLength(20))
      .annotate({ description: "Open needs that no longer need the user." }),
  ),
});
export type CaptainReportInput = typeof CaptainReportInput.Type;

export const CaptainMutationResult = Schema.Struct({ captain: CaptainSummary });
export type CaptainMutationResult = typeof CaptainMutationResult.Type;

export const CaptainResolveNeedResult = Schema.Struct({
  need: CaptainNeed,
  captain: CaptainSummary,
});
export type CaptainResolveNeedResult = typeof CaptainResolveNeedResult.Type;

export const CaptainReportResult = Schema.Struct({
  captain: CaptainSummary,
  raised: ForwardCompatibleArray(CaptainNeed),
});
export type CaptainReportResult = typeof CaptainReportResult.Type;

export class CaptainError extends Schema.TaggedError<CaptainError>()("CaptainError", {
  code: Schema.Literals(["not_found", "invalid_request", "retired", "unavailable"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
