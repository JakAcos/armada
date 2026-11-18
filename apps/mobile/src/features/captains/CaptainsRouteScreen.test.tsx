import { RegistryContext } from "@effect/atom-react";
import {
  CaptainError,
  CaptainId,
  CaptainNeedId,
  ProjectId,
  ThreadId,
  type CaptainSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    alert: vi.fn(),
    digest: vi.fn(),
    run: {
      create: vi.fn(),
      message: vi.fn(),
      resolveNeed: vi.fn(),
      setStatus: vi.fn(),
    } as Record<string, ReturnType<typeof vi.fn>>,
    inputs: new Map<string, (value: string) => void>(),
    permissions: {} as Record<string, unknown>,
    captains: [] as CaptainSummary[],
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: Children,
  TextInput: ({
    accessibilityLabel,
    value,
    readOnly,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    readOnly?: boolean;
    onChangeText: (value: string) => void;
  }) => {
    mocks.inputs.set(accessibilityLabel, onChangeText);
    return (
      <input
        aria-label={accessibilityLabel}
        value={value}
        readOnly={readOnly}
        onChange={() => {}}
      />
    );
  },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({
    actions,
    onPressAction,
  }: {
    actions: readonly { id: string; title: string; attributes?: { disabled?: boolean } }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) =>
    actions.map(({ id, title, attributes }) => (
      <button
        key={id}
        disabled={attributes?.disabled}
        onClick={() => onPressAction({ nativeEvent: { event: id } })}
      >
        Select {title}
      </button>
    )),
}));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../settings/components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("../settings/components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => null,
}));
vi.mock("../settings/settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    availableTargets: [{ environmentId: "environment", label: "Environment", serverConfig: null }],
    selectedTargets: [{ environmentId: "environment", label: "Environment", serverConfig: null }],
    selectedProjectKey: null,
    projectGroups: [],
  }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "environment", id: "project", title: "Project" }],
}));
vi.mock("../../state/captains", () => {
  const command = (name: string) => ({ name, permissionAtom: () => mocks.permissions[name] });
  return {
    captainEnvironment: {
      live: () => "live",
      digest: mocks.digest,
      create: command("create"),
      message: command("message"),
      resolveNeed: command("resolveNeed"),
      setStatus: command("setStatus"),
    },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === "live"
      ? { data: { captains: mocks.captains }, error: null }
      : { data: { crew: [] }, error: null },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { name: string }) => mocks.run[command.name],
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { CaptainsRouteScreen } from "./CaptainsRouteScreen";

const at = "2026-11-16T00:00:00.000Z";

function captain(name: string, status: CaptainSummary["status"], withNeed = false): CaptainSummary {
  const id = CaptainId.make(name);
  return {
    id,
    projectId: ProjectId.make("project"),
    name,
    charter: "Charter",
    threadId: ThreadId.make(`${name}-thread`),
    status,
    plan: "",
    planUpdatedAt: null,
    createdAt: at,
    updatedAt: at,
    openNeeds: withNeed
      ? [
          {
            id: CaptainNeedId.make("need"),
            captainId: id,
            kind: "decision",
            summary: "Pick a host",
            detail: null,
            status: "open",
            resolution: null,
            createdAt: at,
            resolvedAt: null,
          },
        ]
      : [],
  };
}

let root: Root;
let container: HTMLDivElement;

function render(denied: ReadonlyArray<string> = []) {
  for (const command of Object.keys(mocks.run)) {
    mocks.permissions[command] = Atom.make(!denied.includes(command));
  }
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <CaptainsRouteScreen />
      </RegistryContext.Provider>,
    ),
  );
}

function button(label: string) {
  const element = Array.from(container.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent === label || candidate.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

function input(label: string) {
  const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing input: ${label}`);
  return element;
}

function type(label: string, value: string) {
  const onChange = mocks.inputs.get(label);
  if (!onChange) throw new Error(`Missing input: ${label}`);
  act(() => onChange(value));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.alert.mockReset();
  mocks.digest.mockReset();
  mocks.digest.mockReturnValue("digest");
  mocks.inputs.clear();
  for (const run of Object.values(mocks.run)) {
    run.mockReset();
    run.mockResolvedValue(AsyncResult.success({}));
  }
  mocks.captains = [captain("Docs", "active", true), captain("Release", "retired")];
});

afterEach(() => {
  act(() => root.unmount());
});

describe("CaptainsRouteScreen", () => {
  it("resolves a need once with the trimmed answer and clears it when the server accepts", async () => {
    render();
    let accept: (value: unknown) => void = () => {};
    mocks.run.resolveNeed!.mockReturnValue(new Promise((resolve) => (accept = resolve)));
    type("Answer for Pick a host", "  Fly.io  ");
    act(() => {
      button("Resolve").click();
      button("Resolve").click();
    });
    expect(button("Resolve").disabled).toBe(true);
    await act(async () => accept(AsyncResult.success({})));

    expect(mocks.run.resolveNeed).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment",
      input: { needId: "need", resolution: "Fly.io", creationSource: "mobile" },
    });
    expect(input("Answer for Pick a host").value).toBe("");
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("keeps the answer and shows the server's reason when resolving fails", async () => {
    render();
    mocks.run.resolveNeed!.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new CaptainError({ code: "unavailable", message: "The captain's thread is archived." }),
        ),
      ),
    );
    type("Answer for Pick a host", "Fly.io");
    await act(async () => button("Resolve").click());

    expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
      "Could not resolve the need",
      "The captain's thread is archived.",
    );
    expect(input("Answer for Pick a host").value).toBe("Fly.io");
    expect(button("Resolve").disabled).toBe(false);
  });

  it("retires an active captain and reactivates a retired one", async () => {
    render();
    await act(async () => button("Select Retire").click());
    await act(async () => button("Select Reactivate").click());

    expect(mocks.run.setStatus!.mock.calls).toEqual([
      [
        {
          environmentId: "environment",
          input: { captainId: "Docs", status: "retired", creationSource: "mobile" },
        },
      ],
      [
        {
          environmentId: "environment",
          input: { captainId: "Release", status: "active", creationSource: "mobile" },
        },
      ],
    ]);
  });

  it.each([
    { denied: "resolveNeed", disabled: ["Resolve"] },
    { denied: "message", disabled: ["Send"] },
    { denied: "create", disabled: ["Select Project", "Start captain"] },
    { denied: "setStatus", disabled: ["Select Retire", "Select Reactivate"] },
  ])("denying $denied disables only its controls", ({ denied, disabled }) => {
    render([denied]);
    type("Answer for Pick a host", "Fly.io");
    type("Message Captain Docs", "Status?");
    type("Name", "Ops");
    type("Charter", "Keep CI green");

    for (const label of [
      "Resolve",
      "Send",
      "Select Project",
      "Start captain",
      "Select Retire",
      "Select Reactivate",
    ]) {
      expect(button(label).disabled, label).toBe(disabled.includes(label));
    }
  });

  it("starts a captain in the first project with the trimmed fields", async () => {
    render();
    expect(button("Start captain").disabled).toBe(true);
    type("Name", " Ops ");
    type("Charter", " Keep CI green ");
    await act(async () => button("Start captain").click());

    expect(mocks.run.create).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment",
      input: {
        projectId: "project",
        name: "Ops",
        charter: "Keep CI green",
        creationSource: "mobile",
      },
    });
    expect(input("Name").value).toBe("");
  });

  it("loads a captain's crew only while its details are open", () => {
    render();
    expect(mocks.digest).not.toHaveBeenCalled();
    act(() => button("Captain Docs, Active, Project").click());
    expect(mocks.digest).toHaveBeenCalledWith({
      environmentId: "environment",
      input: { captainId: "Docs" },
    });
    expect(container.textContent).toContain("No crew started yet.");
  });
});
