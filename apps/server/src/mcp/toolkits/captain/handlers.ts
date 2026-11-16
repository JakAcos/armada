import { type CaptainError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CaptainService from "../../../captains/CaptainService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
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

/** What the captain is told about an agent's relay, and which thread may not answer for the user. */
const fromAgent = Effect.gen(function* () {
  const { scope } = yield* readCaller();
  return {
    createdBy: "agent",
    creationSource: "mcp",
    ...(scope.thread === undefined ? {} : { senderThreadId: scope.thread.threadId }),
  } as const;
});

/**
 * A message or an answer becomes a turn in the captain's thread, so the caller needs the same
 * access to that thread as `t3_thread_send` asks for.
 */
const captainThread = Effect.fn("CaptainHandlers.captainThread")(function* (
  target: CaptainService.CaptainTarget,
) {
  yield* readCaller();
  const captains = yield* CaptainService.CaptainService;
  return [yield* captains.threadIdOf(target).pipe(Effect.mapError(toMcpFailure))];
});

export const layer = McpToolAccess.toLayer(CaptainToolkit, {
  captain_create: McpToolAccess.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        const provenance = yield* fromAgent;
        const captains = yield* CaptainService.CaptainService;
        return yield* captains
          .create({
            ...input,
            ...provenance,
            runtimeMode: modes.runtimeMode,
            interactionMode: modes.interactionMode,
          })
          .pipe(Effect.mapError(toMcpFailure));
      }),
    { refused: "start a captain for another environment" },
  ),
  captain_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const captains = yield* CaptainService.CaptainService;
      return yield* Effect.gen(function* () {
        const listed = yield* captains.list(
          input.projectId === undefined ? {} : { projectId: input.projectId },
        );
        if (input.captainId === undefined) return listed;
        return { ...listed, digest: yield* captains.digest(input.captainId) };
      }).pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  captain_message: McpToolAccess.writesResolvedThreads(
    (input) => captainThread({ captainId: input.captainId }),
    (input) =>
      Effect.gen(function* () {
        const provenance = yield* fromAgent;
        const captains = yield* CaptainService.CaptainService;
        return yield* captains
          .message({ ...input, ...provenance })
          .pipe(Effect.mapError(toMcpFailure));
      }),
  ),
  captain_resolve_need: McpToolAccess.writesResolvedThreads(
    (input) => captainThread({ needId: input.needId }),
    (input) =>
      Effect.gen(function* () {
        const provenance = yield* fromAgent;
        const captains = yield* CaptainService.CaptainService;
        return yield* captains
          .resolveNeed({ ...input, ...provenance })
          .pipe(Effect.mapError(toMcpFailure));
      }),
  ),
  captain_report: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const thread = yield* McpInvocationContext.requireThreadScope(scope, "captain_report");
      const captains = yield* CaptainService.CaptainService;
      return yield* captains
        .report(thread.thread.threadId, input)
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
});
