import {
  CaptainError,
  CaptainId,
  CaptainNeedId,
  ProjectId,
  ThreadId,
  type CaptainNeed,
  type CaptainSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  captainFailureMessage,
  captainStartForm,
  captainsInProjects,
  collectOpenNeeds,
  nextCaptainStatus,
} from "./captains.logic";

const at = "2026-11-16T00:00:00.000Z";

function need(id: string, captainId: string): CaptainNeed {
  return {
    id: CaptainNeedId.make(id),
    captainId: CaptainId.make(captainId),
    kind: "decision",
    summary: id,
    detail: null,
    status: "open",
    resolution: null,
    createdAt: at,
    resolvedAt: null,
  };
}

function captain(id: string, projectId: string, openNeeds: CaptainNeed[] = []): CaptainSummary {
  return {
    id: CaptainId.make(id),
    projectId: ProjectId.make(projectId),
    name: id,
    charter: "Charter",
    threadId: ThreadId.make(`${id}-thread`),
    status: "active",
    plan: "",
    planUpdatedAt: null,
    createdAt: at,
    updatedAt: at,
    openNeeds,
  };
}

describe("collectOpenNeeds", () => {
  it("lists every open need in fleet order with the captain that raised it", () => {
    const docs = captain("docs", "p1", [need("n1", "docs"), need("n2", "docs")]);
    const release = captain("release", "p2", [need("n3", "release")]);
    expect(
      collectOpenNeeds([docs, captain("idle", "p1"), release]).map(
        (entry) => `${entry.captain.name}:${entry.need.id}`,
      ),
    ).toEqual(["docs:n1", "docs:n2", "release:n3"]);
  });

  it("drops the needs of captains outside the filtered projects", () => {
    const fleet = [
      captain("docs", "p1", [need("n1", "docs")]),
      captain("ops", "p2", [need("n2", "ops")]),
    ];
    expect(
      collectOpenNeeds(captainsInProjects(fleet, [ProjectId.make("p2")])).map(
        (entry) => entry.need.id,
      ),
    ).toEqual(["n2"]);
    expect(captainsInProjects(fleet, null)).toBe(fleet);
  });
});

describe("nextCaptainStatus", () => {
  it("retires an active captain and reactivates a retired one", () => {
    expect(nextCaptainStatus("active")).toBe("retired");
    expect(nextCaptainStatus("retired")).toBe("active");
  });
});

describe("captainStartForm", () => {
  const projects = [
    { id: ProjectId.make("p1"), title: "One" },
    { id: ProjectId.make("p2"), title: "Two" },
  ];

  it("sends the trimmed fields for the picked project", () => {
    expect(
      captainStartForm({
        projects,
        projectId: ProjectId.make("p2"),
        name: " Docs ",
        charter: " Own docs\n",
      }),
    ).toEqual({
      project: projects[1],
      input: { projectId: "p2", name: "Docs", charter: "Own docs" },
    });
  });

  it("falls back to the first project until one is picked or when the picked one is gone", () => {
    expect(
      captainStartForm({ projects, projectId: null, name: "a", charter: "b" }).input?.projectId,
    ).toBe("p1");
    expect(
      captainStartForm({ projects, projectId: ProjectId.make("gone"), name: "a", charter: "b" })
        .input?.projectId,
    ).toBe("p1");
  });

  it("is not ready while a field is blank or there is no project", () => {
    expect(
      captainStartForm({ projects, projectId: null, name: "  ", charter: "b" }).input,
    ).toBeNull();
    expect(
      captainStartForm({ projects, projectId: null, name: "a", charter: "\n" }).input,
    ).toBeNull();
    expect(captainStartForm({ projects: [], projectId: null, name: "a", charter: "b" })).toEqual({
      project: undefined,
      input: null,
    });
  });
});

describe("captainFailureMessage", () => {
  it("shows the server's reason for a failed command", () => {
    const failure = AsyncResult.failure(
      Cause.fail(
        new CaptainError({ code: "invalid_request", message: "Set a default model first." }),
      ),
    );
    expect(captainFailureMessage(failure)).toBe("Set a default model first.");
  });

  it("stays quiet for a success or an interrupted command", () => {
    expect(captainFailureMessage(AsyncResult.success({}))).toBeNull();
    expect(captainFailureMessage(AsyncResult.failure(Cause.interrupt()))).toBeNull();
  });
});
