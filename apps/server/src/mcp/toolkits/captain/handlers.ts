import { type CaptainError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CaptainService from "../../../captains/CaptainService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestrationMcp from "../../OrchestratorMcpService.ts";
import { readCaller } from "../../threadAccess.ts";
import { CaptainToolkit } from "./tools.ts";

const toMcpFailure = (error: CaptainError) =>
  new OrchestratorMcpFailure({
    code: error.code === "unavailable" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

/**
 * What the captain is told about an agent's relay, and which thread may not answer for the user.
 * A delegated child works for its parent, not the user, so it relays nothing: the tools are hidden
 * from it, and a call made anyway is refused here.
 */
const fromAgent = Effect.gen(function* () {
  const { scope, caller } = yield* readCaller();
  if (scope.thread?.subagent === true || caller?.lineage.relationshipToParent === "subagent") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "A delegated task cannot start, message, or answer for a captain. Report back to your parent instead.",
    });
  }
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
        // A made-up model would leave a captain whose first turn fails at the provider.
        if (input.modelSelection !== undefined) {
          const { instanceId, model } = input.modelSelection;
          const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
          const provider = providers.find((candidate) => candidate.instanceId === instanceId);
          if (provider !== undefined)
            yield* OrchestrationMcp.requireAdvertisedModel(provider, model);
        }
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
