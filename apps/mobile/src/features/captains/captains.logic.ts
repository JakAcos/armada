import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  CaptainCrewMember,
  CaptainNeed,
  CaptainStatus,
  CaptainSummary,
  ProjectId,
} from "@t3tools/contracts";

/** Captains in the projects the Settings filter keeps; `null` keeps every project. */
export function captainsInProjects(
  captains: readonly CaptainSummary[],
  projectIds: readonly ProjectId[] | null,
): readonly CaptainSummary[] {
  return projectIds === null
    ? captains
    : captains.filter((captain) => projectIds.includes(captain.projectId));
}

/** Every open need across the fleet, with the captain that raised it. */
export function collectOpenNeeds(
  captains: readonly CaptainSummary[],
): ReadonlyArray<{ readonly need: CaptainNeed; readonly captain: CaptainSummary }> {
  return captains.flatMap((captain) => captain.openNeeds.map((need) => ({ need, captain })));
}

export function nextCaptainStatus(status: CaptainStatus): CaptainStatus {
  return status === "retired" ? "active" : "retired";
}

export function crewMemberLabel(member: CaptainCrewMember): string {
  return member.title ?? member.taskId;
}

/**
 * The project the start form uses, and the input it sends once every field is filled. The first
 * project stands in until one is picked, and again if the picked one disappears.
 */
export function captainStartForm<Project extends { readonly id: ProjectId }>(form: {
  readonly projects: readonly Project[];
  readonly projectId: ProjectId | null;
  readonly name: string;
  readonly charter: string;
}): {
  readonly project: Project | undefined;
  readonly input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly charter: string;
  } | null;
} {
  const project = form.projects.find((entry) => entry.id === form.projectId) ?? form.projects[0];
  const name = form.name.trim();
  const charter = form.charter.trim();
  return {
    project,
    input:
      project === undefined || name.length === 0 || charter.length === 0
        ? null
        : { projectId: project.id, name, charter },
  };
}

/** The server's reason for a failed command, such as "no default model"; null when there is none to show. */
export function captainFailureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}
