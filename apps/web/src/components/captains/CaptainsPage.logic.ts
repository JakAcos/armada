import type { ModelSelection } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";

/**
 * A pick follows the user to another project while that project still enables its provider.
 * Otherwise the form shows the project's default and sends no model, so the server applies it.
 */
export function captainModelChoice(input: {
  readonly picked: ModelSelection | null;
  readonly projectDefault: ModelSelection | null;
  readonly entries: ReadonlyArray<Pick<ProviderInstanceEntry, "instanceId" | "enabled">>;
}): { readonly send: ModelSelection | undefined; readonly shown: ModelSelection | null } {
  const { picked } = input;
  const usable =
    picked !== null &&
    input.entries.some((entry) => entry.instanceId === picked.instanceId && entry.enabled);
  return usable
    ? { send: picked, shown: picked }
    : { send: undefined, shown: input.projectDefault };
}
