import {
  CaptainCreateInput,
  CaptainDigest,
  CaptainId,
  CaptainListResult,
  CaptainMessageInput,
  CaptainMutationResult,
  CaptainReportInput,
  CaptainReportResult,
  CaptainResolveNeedInput,
  CaptainResolveNeedResult,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as CaptainService from "../../../captains/CaptainService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CaptainService.CaptainService,
  ],
};

const CaptainCreateTool = Tool.make("captain_create", {
  ...shared,
  dependencies: [...shared.dependencies, ProviderRegistry.ProviderRegistry],
  description:
    "Start a Captain: a long-lived orchestrator thread that owns `charter` in one project, runs a crew of child tasks, and surfaces only blockers and decisions to the user. Only when the user asks for a captain. Omit `modelSelection` for the project's default; values from `orchestrator_capabilities`.",
  parameters: CaptainCreateInput,
  success: CaptainMutationResult,
})
  .annotate(Tool.Title, "Start a captain")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const CaptainListTool = Tool.make("captain_list", {
  ...shared,
  description:
    "List captains and their open needs-you items. With `captainId`, also return its digest: plan, crew status, and recently resolved needs.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    captainId: Schema.optional(CaptainId),
  }),
  success: Schema.Struct({
    ...CaptainListResult.fields,
    digest: Schema.optional(CaptainDigest),
  }),
})
  .annotate(Tool.Title, "List captains")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CaptainMessageTool = Tool.make("captain_message", {
  ...shared,
  description:
    "Relay the user's instruction to a captain. It is queued as the captain's next turn, marked as relayed by an agent.",
  parameters: CaptainMessageInput,
  success: CaptainMutationResult,
})
  .annotate(Tool.Title, "Message a captain")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const CaptainResolveNeedTool = Tool.make("captain_resolve_need", {
  ...shared,
  description:
    "Resolve a captain's open need with the user's actual answer, never your own. The captain receives `resolution` as a message marked as relayed by an agent.",
  parameters: CaptainResolveNeedInput,
  success: CaptainResolveNeedResult,
})
  .annotate(Tool.Title, "Resolve a captain's need")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const CaptainReportTool = Tool.make("captain_report", {
  ...shared,
  description:
    "Captains only: save your plan, raise needs-you items (blockers or decisions only the user can settle), or withdraw open ones.",
  parameters: CaptainReportInput,
  success: CaptainReportResult,
})
  .annotate(Tool.Title, "Captain report")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const CaptainToolkit = Toolkit.make(
  CaptainCreateTool,
  CaptainListTool,
  CaptainMessageTool,
  CaptainResolveNeedTool,
  CaptainReportTool,
);
