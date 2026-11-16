import { expect, it } from "@effect/vitest";
import {
  type CaptainNeed,
  type CaptainSummary,
  CaptainId,
  CaptainNeedId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CaptainService from "../../../captains/CaptainService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CaptainHandlers from "./handlers.ts";
import { CaptainToolkit } from "./tools.ts";

const callerThreadId = ThreadId.make("thread:caller");
const captainThreadId = ThreadId.make("thread:captain");
const captainId = CaptainId.make("captain:docs");
const needId = CaptainNeedId.make("need:ship");
const projectId = ProjectId.make("project:mcp-test");

const captain: CaptainSummary = {
  id: captainId,
  projectId,
  name: "Docs",
  charter: "Keep the docs accurate.",
  threadId: captainThreadId,
  status: "active",
  plan: "",
  planUpdatedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  openNeeds: [],
};
const need: CaptainNeed = {
  id: needId,
  captainId,
  kind: "decision",
  summary: "Ship v2 docs now?",
  detail: null,
  status: "resolved",
  resolution: "Yes.",
  createdAt: "2026-01-01T00:00:00.000Z",
  resolvedAt: "2026-01-01T00:00:01.000Z",
};

interface ServiceCall {
  readonly method: "create" | "list" | "message" | "resolveNeed" | "report";
  readonly input: unknown;
}

/** A thread caller at `callerMode`, and a captain whose thread runs full-access. */
const harness = (input: {
  readonly callerMode: RuntimeMode;
  readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
  /** The caller is a delegated child, as a captain's crew is. */
  readonly subagent?: true;
  readonly calls: Array<ServiceCall>;
}) => {
  const record =
    <A>(method: ServiceCall["method"], result: A) =>
    (...args: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        input.calls.push({ method, input: args.length === 1 ? args[0] : args });
        return result;
      });
  return McpToolAccess.HandlersLayer.layer(CaptainHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment:captains"),
          requestNamespace: "provider:captains",
          thread: {
            threadId: callerThreadId,
            providerSessionId: "provider:captains",
            providerInstanceId: ProviderInstanceId.make("codex"),
            ...(input.subagent === true ? { subagent: true } : {}),
          },
          client: undefined,
          capabilities: new Set<McpInvocationContext.McpCapability>(
            input.capabilities ?? ["orchestration"],
          ),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              liveThreadShell(threadId, {
                runtimeMode: threadId === callerThreadId ? input.callerMode : "full-access",
              }),
            ),
        }),
        Layer.mock(CaptainService.CaptainService)({
          threadIdOf: () => Effect.succeed(captainThreadId),
          create: record("create", { captain }),
          list: record("list", { captains: [captain] }),
          message: record("message", { captain }),
          resolveNeed: record("resolveNeed", { need, captain }),
          report: record("report", { captain, raised: [] }),
        }),
      ),
    ),
  );
};

const callAll = Effect.gen(function* () {
  const toolkit = yield* CaptainToolkit;
  const result = <Name extends keyof typeof CaptainToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result as { readonly code?: string } | undefined),
    );
  return {
    create: yield* result("captain_create", {
      projectId,
      name: "Docs",
      charter: "Keep the docs accurate.",
    }),
    list: yield* result("captain_list", {}),
    message: yield* result("captain_message", { captainId, text: "Status?" }),
    resolve: yield* result("captain_resolve_need", { needId, resolution: "Yes." }),
    report: yield* result("captain_report", { plan: "1. Audit" }),
  };
});

it.effect("a caller below the captain thread's mode cannot message it or answer its needs", () =>
  Effect.gen(function* () {
    const calls: Array<ServiceCall> = [];
    const results = yield* callAll.pipe(
      Effect.provide(harness({ callerMode: "approval-required", calls })),
    );
    expect(results.message).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(results.resolve).toMatchObject({ code: "runtime_mode_escalation_denied" });
    // Reading, reporting as itself, and starting a captain at its own mode stay open to it.
    expect(calls.map((call) => call.method)).toEqual(["create", "list", "report"]);
    expect(calls[0]?.input).toMatchObject({
      createdBy: "agent",
      creationSource: "mcp",
      runtimeMode: "approval-required",
    });
  }),
);

it.effect("a peer captain, or any caller at the captain's mode, sends from its thread", () =>
  Effect.gen(function* () {
    const calls: Array<ServiceCall> = [];
    yield* callAll.pipe(Effect.provide(harness({ callerMode: "full-access", calls })));
    // The service tells a peer captain from any other agent by this thread.
    const relayed = { createdBy: "agent", creationSource: "mcp", senderThreadId: callerThreadId };
    expect(calls).toEqual([
      expect.objectContaining({ method: "create" }),
      expect.objectContaining({ method: "list" }),
      { method: "message", input: { captainId, text: "Status?", ...relayed } },
      { method: "resolveNeed", input: { needId, resolution: "Yes.", ...relayed } },
      { method: "report", input: [callerThreadId, { plan: "1. Audit" }] },
    ]);
  }),
);

it.effect("a credential that cannot control threads reaches no captain tool", () =>
  Effect.gen(function* () {
    const calls: Array<ServiceCall> = [];
    const results = yield* callAll.pipe(
      Effect.provide(harness({ callerMode: "full-access", capabilities: ["preview"], calls })),
    );
    for (const result of Object.values(results)) {
      expect(result).toMatchObject({ code: "capability_denied" });
    }
    expect(calls).toEqual([]);
  }),
);

it.effect("a delegated child, such as a captain's crew, cannot act for the user", () =>
  Effect.gen(function* () {
    const calls: Array<ServiceCall> = [];
    const results = yield* callAll.pipe(
      Effect.provide(harness({ callerMode: "full-access", subagent: true, calls })),
    );
    expect(results.create).toMatchObject({ code: "capability_denied" });
    expect(results.message).toMatchObject({ code: "capability_denied" });
    expect(results.resolve).toMatchObject({ code: "capability_denied" });
    // It can still read, and a report is judged by whether its thread is a captain's.
    expect(calls.map((call) => call.method)).toEqual(["list", "report"]);
  }),
);
