import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { captainModelChoice } from "./CaptainsPage.logic";

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
