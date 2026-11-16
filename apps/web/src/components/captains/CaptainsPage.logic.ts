import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "../chat/providerIconUtils";

/**
 * A pick follows the user to another project while that project still enables its provider.
 * Otherwise the form shows the project's default and sends no model, so the server applies it.
 * A default the project cannot run is not offered: the server would only refuse it.
 */
export function captainModelChoice(input: {
  readonly picked: ModelSelection | null;
  readonly projectDefault: ModelSelection | null;
  readonly entries: ReadonlyArray<Pick<ProviderInstanceEntry, "instanceId" | "enabled">>;
}): { readonly send: ModelSelection | undefined; readonly shown: ModelSelection | null } {
  const usable = <Selection extends ModelSelection>(
    selection: Selection | null,
  ): selection is Selection =>
    selection !== null &&
    input.entries.some((entry) => entry.instanceId === selection.instanceId && entry.enabled);
  if (usable(input.picked)) return { send: input.picked, shown: input.picked };
  return { send: undefined, shown: usable(input.projectDefault) ? input.projectDefault : null };
}

/**
 * The picker names its first listed model when the one in use is not listed, such as a model
 * hidden in the provider's preferences. Listing the model in use keeps it on what will start.
 */
export function listCaptainModelInUse(input: {
  readonly options: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly shown: ModelSelection | null;
  readonly entries: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly models: ReadonlyArray<Pick<ModelEsque, "slug" | "name">>;
  }>;
}): ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> {
  const { shown } = input;
  if (shown === null) return input.options;
  const listed = input.options.get(shown.instanceId) ?? [];
  if (listed.some((option) => option.slug === shown.model)) return input.options;
  const known = input.entries
    .find((entry) => entry.instanceId === shown.instanceId)
    ?.models.find((model) => model.slug === shown.model);
  return new Map(input.options).set(shown.instanceId, [
    ...listed,
    { slug: shown.model, name: known?.name ?? shown.model },
  ]);
}
