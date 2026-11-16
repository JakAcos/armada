import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createCaptainEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const digest = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:captains:digest",
    tag: WS_METHODS.captainsDigest,
    staleTimeMs: 5_000,
  });
  return {
    live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:captains:live",
      tag: WS_METHODS.captainsSubscribe,
    }),
    digest,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:create",
      tag: WS_METHODS.captainsCreate,
    }),
    message: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:message",
      tag: WS_METHODS.captainsMessage,
    }),
    resolveNeed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:resolve-need",
      tag: WS_METHODS.captainsResolveNeed,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.needId]),
      },
      // The list is pushed by the server; only the digest is a plain query.
      onSuccess: ({ environmentId }, registry, result) =>
        Effect.sync(() =>
          registry.refresh(digest({ environmentId, input: { captainId: result.captain.id } })),
        ),
    }),
    setStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:captains:set-status",
      tag: WS_METHODS.captainsSetStatus,
    }),
  };
}
