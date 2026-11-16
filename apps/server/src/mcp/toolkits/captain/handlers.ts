import { type CaptainError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CaptainService from "../../../captains/CaptainService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CaptainToolkit } from "./tools.ts";

const toMcpFailure = (error: CaptainError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "invalid_request" || error.code === "retired"
        ? "invalid_request"
        : error.code === "not_found"
          ? "task_not_found"
          : "orchestration_error",
    message: error.message,
  });

const fromAgent = { createdBy: "agent", creationSource: "mcp" } as const;

export const layer = McpToolAccess.toLayer(CaptainToolkit, {
  captain_create: McpToolAccess.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        const captains = yield* CaptainService.CaptainService;
        return yield* captains.create({
          ...input,
          ...fromAgent,
          runtimeMode: modes.runtimeMode,
          interactionMode: modes.interactionMode,
        });
      }).pipe(Effect.mapError(toMcpFailure)),
    { refused: "start a captain for another environment" },
  ),
  captain_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      const listed = yield* captains.list(
        input.projectId === undefined ? {} : { projectId: input.projectId },
      );
      if (input.captainId === undefined) return listed;
      return { ...listed, digest: yield* captains.digest(input.captainId) };
    }).pipe(Effect.mapError(toMcpFailure)),
  ),
  captain_message: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      return yield* captains.message({ ...input, ...fromAgent });
    }).pipe(Effect.mapError(toMcpFailure)),
  ),
  captain_resolve_need: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const captains = yield* CaptainService.CaptainService;
      return yield* captains.resolveNeed({ ...input, ...fromAgent });
    }).pipe(Effect.mapError(toMcpFailure)),
  ),
  captain_report: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const thread = yield* McpInvocationContext.requireThreadScope(scope, "captain_report");
      const captains = yield* CaptainService.CaptainService;
      return yield* captains
        .report(thread.thread.threadId, input)
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
});
