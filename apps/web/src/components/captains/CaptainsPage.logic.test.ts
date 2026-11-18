import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { captainModelChoice, listCaptainModelInUse } from "./CaptainsPage.logic";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const projectDefault = { instanceId: codex, model: "gpt-5" };
const picked = { instanceId: claude, model: "claude-haiku-5-5" };

describe("captainModelChoice", () => {
  it.each([
    {
      name: "no pick shows the project default and leaves it to the server",
      picked: null,
      projectDefault,
      enabled: [codex, claude],
      expected: { send: undefined, shown: projectDefault },
    },
    {
      name: "no pick and no project default shows nothing",
      picked: null,
      projectDefault: null,
      enabled: [codex, claude],
      expected: { send: undefined, shown: null },
    },
    {
      name: "a pick is shown and sent",
      picked,
      projectDefault: null,
      enabled: [codex, claude],
      expected: { send: picked, shown: picked },
    },
    {
      name: "a pick the new project disables falls back to that project's default",
      picked,
      projectDefault,
      enabled: [codex],
      expected: { send: undefined, shown: projectDefault },
    },
    {
      name: "a default whose provider the project disables is not offered",
      picked: null,
      projectDefault,
      enabled: [claude],
      expected: { send: undefined, shown: null },
    },
  ])("$name", ({ picked: pick, projectDefault: fallback, enabled, expected }) => {
    const entries = [codex, claude].map((instanceId) => ({
      instanceId,
      enabled: enabled.includes(instanceId),
    }));
    expect(captainModelChoice({ picked: pick, projectDefault: fallback, entries })).toEqual(
      expected,
    );
  });
});

describe("listCaptainModelInUse", () => {
  const visible = { slug: "gpt-5-mini", name: "GPT-5 Mini" };
  const options = new Map([[codex, [visible]]]);
  const entries = [{ instanceId: codex, models: [{ slug: "gpt-5", name: "GPT-5" }] }];

  it.each([
    {
      name: "a model hidden from the picker is listed under its own name",
      shown: projectDefault,
      expected: [visible, { slug: "gpt-5", name: "GPT-5" }],
    },
    {
      name: "a model the provider does not report is listed by its id",
      shown: { instanceId: codex, model: "gpt-custom" },
      expected: [visible, { slug: "gpt-custom", name: "gpt-custom" }],
    },
    {
      name: "a listed model changes nothing",
      shown: { instanceId: codex, model: visible.slug },
      expected: [visible],
    },
    { name: "no model in use changes nothing", shown: null, expected: [visible] },
  ])("$name", ({ shown, expected }) => {
    expect(listCaptainModelInUse({ options, shown, entries }).get(codex)).toEqual(expected);
  });
});
