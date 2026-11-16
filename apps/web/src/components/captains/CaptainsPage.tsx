import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  CAPTAIN_CHARTER_MAX_LENGTH,
  CAPTAIN_MESSAGE_MAX_LENGTH,
  CAPTAIN_NAME_MAX_LENGTH,
  type CaptainNeed,
  type CaptainSummary,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { pickModelSelection } from "@t3tools/shared/model";
import {
  type LegacyProjectSettingsFields,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { captainEnvironment } from "../../state/captains";
import { useProjects, useQuietThreadShell } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { captainModelChoice } from "./CaptainsPage.logic";

/** The server's reason is the useful part ("no default model", "thread is archived"), so show it. */
function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: formatEnvironmentQueryError(result.cause),
    }),
  );
}

export function CaptainsPage() {
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  return (
    <AppRouteModal label="Captains">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          <h1 className="flex-1 font-medium text-sm">Captains</h1>
          <AppRouteModalClose />
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {connected.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Connect an environment to see captains.
              </p>
            ) : (
              connected.map((environment) => (
                <CaptainEnvironmentSection
                  key={environment.environmentId}
                  environment={environment}
                  showLabel={connected.length > 1}
                />
              ))
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AppRouteModal>
  );
}

function CaptainEnvironmentSection({
  environment,
  showLabel,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showLabel: boolean;
}) {
  const environmentId = environment.environmentId;
  const query = useEnvironmentQuery(captainEnvironment.live({ environmentId, input: {} }));
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const projectTitle = (projectId: ProjectId) =>
    projects.find((project) => project.id === projectId)?.title ?? projectId;
  const captains = query.data?.captains ?? [];
  const openNeeds = captains.flatMap((captain) =>
    captain.openNeeds.map((need) => ({ need, captain })),
  );

  return (
    <section className="flex flex-col gap-6" aria-label={`Captains on ${environment.label}`}>
      {showLabel ? <h2 className="font-medium text-sm">{environment.label}</h2> : null}
      {query.error ? (
        <p className="text-destructive-foreground text-sm">
          Could not load captains: {query.error}
        </p>
      ) : query.data === null ? (
        <p className="text-muted-foreground text-sm" role="status">
          Loading captains…
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <h3 className="font-medium text-sm">Needs you ({openNeeds.length})</h3>
            {openNeeds.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nothing needs you. Captains surface blockers and decisions here.
              </p>
            ) : (
              openNeeds.map(({ need, captain }) => (
                <NeedCard
                  key={need.id}
                  environmentId={environmentId}
                  need={need}
                  captainName={captain.name}
                />
              ))
            )}
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="font-medium text-sm">Fleet ({captains.length})</h3>
            {captains.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No captains yet. Start one below to hand it an area of a project.
              </p>
            ) : (
              captains.map((captain) => (
                <CaptainCard
                  key={captain.id}
                  environmentId={environmentId}
                  captain={captain}
                  projectTitle={projectTitle(captain.projectId)}
                />
              ))
            )}
          </div>
          <NewCaptainForm environmentId={environmentId} projects={projects} />
        </>
      )}
    </section>
  );
}

function NeedCard({
  environmentId,
  need,
  captainName,
}: {
  readonly environmentId: EnvironmentId;
  readonly need: CaptainNeed;
  readonly captainName: string;
}) {
  const [resolution, setResolution] = useState("");
  const [pending, setPending] = useState(false);
  const canOperate = useAtomValue(captainEnvironment.resolveNeed.permissionAtom(environmentId));
  const resolve = useAtomCommand(captainEnvironment.resolveNeed, { label: "resolve need" });
  const submit = async () => {
    const text = resolution.trim();
    if (!canOperate || pending || text.length === 0) return;
    setPending(true);
    const result = await resolve({ environmentId, input: { needId: need.id, resolution: text } });
    setPending(false);
    reportFailure("Could not resolve the need", result);
    if (result._tag === "Success") setResolution("");
  };
  return (
    <article className="flex flex-col gap-2 rounded-lg border p-3" data-testid="captain-need">
      <div className="flex items-center gap-2">
        <Badge variant={need.kind === "blocker" ? "error" : "warning"}>
          {need.kind === "blocker" ? "Blocker" : "Decision"}
        </Badge>
        <span className="text-muted-foreground text-xs">Captain {captainName}</span>
      </div>
      <p className="font-medium text-sm">{need.summary}</p>
      {need.detail ? (
        <p className="whitespace-pre-wrap text-muted-foreground text-sm">{need.detail}</p>
      ) : null}
      <Textarea
        aria-label={`Answer for ${need.summary}`}
        placeholder="Your answer or decision"
        value={resolution}
        maxLength={CAPTAIN_MESSAGE_MAX_LENGTH}
        disabled={!canOperate || pending}
        onChange={(event) => setResolution(event.target.value)}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!canOperate || pending || resolution.trim().length === 0}
          onClick={() => void submit()}
        >
          Resolve
        </Button>
      </div>
    </article>
  );
}

function CaptainCard({
  environmentId,
  captain,
  projectTitle,
}: {
  readonly environmentId: EnvironmentId;
  readonly captain: CaptainSummary;
  readonly projectTitle: string;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [statusPending, setStatusPending] = useState(false);
  const canMessage = useAtomValue(captainEnvironment.message.permissionAtom(environmentId));
  const canSetStatus = useAtomValue(captainEnvironment.setStatus.permissionAtom(environmentId));
  const send = useAtomCommand(captainEnvironment.message, { label: "message captain" });
  const setStatus = useAtomCommand(captainEnvironment.setStatus, { label: "update captain" });
  const digest = useEnvironmentQuery(
    expanded
      ? captainEnvironment.digest({ environmentId, input: { captainId: captain.id } })
      : null,
  );
  const retired = captain.status === "retired";
  // The shell is already in local state when loaded; an older settled thread may be missing.
  const modelSelection = useQuietThreadShell(
    scopeThreadRef(environmentId, captain.threadId),
  )?.modelSelection;
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const submitMessage = async () => {
    const text = message.trim();
    if (!canMessage || sending || text.length === 0) return;
    setSending(true);
    const result = await send({ environmentId, input: { captainId: captain.id, text } });
    setSending(false);
    reportFailure(`Could not message Captain ${captain.name}`, result);
    if (result._tag === "Success") setMessage("");
  };
  const toggleStatus = async () => {
    if (!canSetStatus || statusPending) return;
    setStatusPending(true);
    const result = await setStatus({
      environmentId,
      input: { captainId: captain.id, status: retired ? "active" : "retired" },
    });
    setStatusPending(false);
    reportFailure(`Could not ${retired ? "reactivate" : "retire"} Captain ${captain.name}`, result);
  };

  return (
    <article className="flex flex-col gap-2 rounded-lg border p-3" data-testid="captain-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">Captain {captain.name}</span>
        <Badge variant={retired ? "secondary" : "success"}>{retired ? "Retired" : "Active"}</Badge>
        <span className="text-muted-foreground text-xs">{projectTitle}</span>
        {modelSelection ? (
          <span className="text-muted-foreground text-xs">
            {modelLabel(providers, modelSelection)}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams({ environmentId, threadId: captain.threadId }),
            })
          }
        >
          Open thread
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setExpanded((open) => !open)}>
          {expanded ? "Hide details" : "Details"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canSetStatus || statusPending}
          onClick={() => void toggleStatus()}
        >
          {retired ? "Reactivate" : "Retire"}
        </Button>
      </div>
      <p className="whitespace-pre-wrap text-muted-foreground text-sm">{captain.charter}</p>
      {expanded ? (
        <div className="flex flex-col gap-2 text-sm">
          <h4 className="font-medium">Plan</h4>
          <pre className="whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
            {captain.plan.length > 0 ? captain.plan : "No plan reported yet."}
          </pre>
          <h4 className="font-medium">Crew</h4>
          {digest.error ? (
            <p className="text-destructive-foreground">Could not load crew: {digest.error}</p>
          ) : digest.data === null ? (
            <p className="text-muted-foreground" role="status">
              Loading crew…
            </p>
          ) : digest.data.crew.length === 0 ? (
            <p className="text-muted-foreground">No crew started yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {digest.data.crew.map((member) => (
                <li key={member.taskId} className="flex gap-2">
                  <Badge variant="outline">{member.status}</Badge>
                  <span className="truncate">{member.title ?? member.taskId}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {retired ? null : (
        <div className="flex gap-2">
          <Input
            aria-label={`Message Captain ${captain.name}`}
            placeholder="Message this captain"
            value={message}
            maxLength={CAPTAIN_MESSAGE_MAX_LENGTH}
            disabled={!canMessage || sending}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              // Enter that confirms an IME composition is not a send.
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void submitMessage();
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!canMessage || sending || message.trim().length === 0}
            onClick={() => void submitMessage()}
          >
            Send
          </Button>
        </div>
      )}
    </article>
  );
}

function modelLabel(providers: ReadonlyArray<ServerProvider>, selection: ModelSelection) {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  return model ? getTriggerDisplayModelName(model, provider?.driver) : selection.model;
}

function NewCaptainForm({
  environmentId,
  projects,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<
    LegacyProjectSettingsFields & { readonly id: ProjectId; readonly title: string }
  >;
}) {
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [name, setName] = useState("");
  const [charter, setCharter] = useState("");
  const [pickedModel, setPickedModel] = useState<ModelSelection | null>(null);
  const [pending, setPending] = useState(false);
  const canOperate = useAtomValue(captainEnvironment.create.permissionAtom(environmentId));
  const create = useAtomCommand(captainEnvironment.create, { label: "start captain" });
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const selectedProject = projects.find((project) => project.id === projectId) ?? projects[0];
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    selectedProject?.id ?? null,
  );
  const model = captainModelChoice({
    picked: pickedModel,
    projectDefault: selectedProject
      ? resolveProjectSettings(settings, selectedProject.id, selectedProject).settings
          .defaultModelSelection
      : null,
    entries: instanceEntries,
  });
  const ready =
    selectedProject !== undefined &&
    model.shown !== null &&
    name.trim().length > 0 &&
    charter.trim().length > 0;
  const submit = async () => {
    if (!canOperate || pending || !ready) return;
    setPending(true);
    const result = await create({
      environmentId,
      input: {
        projectId: selectedProject.id,
        name: name.trim(),
        charter: charter.trim(),
        ...(model.send === undefined ? {} : { modelSelection: model.send }),
      },
    });
    setPending(false);
    reportFailure("Could not start the captain", result);
    if (result._tag === "Success") {
      setName("");
      setCharter("");
      setPickedModel(null);
    }
  };
  if (projects.length === 0) {
    return <p className="text-muted-foreground text-sm">Add a project to start a captain.</p>;
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      aria-label="Start a captain"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="font-medium text-sm">Start a captain</h3>
      <Select
        value={selectedProject?.id ?? null}
        onValueChange={(value) => setProjectId(value as ProjectId)}
      >
        <SelectTrigger size="sm" aria-label="Project">
          <SelectValue>{selectedProject?.title}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Input
        aria-label="Captain name"
        placeholder="Name, such as Docs or Release"
        value={name}
        maxLength={CAPTAIN_NAME_MAX_LENGTH}
        disabled={!canOperate || pending}
        onChange={(event) => setName(event.target.value)}
      />
      <Textarea
        aria-label="Charter"
        placeholder="What this captain owns and the outcome it works toward"
        value={charter}
        maxLength={CAPTAIN_CHARTER_MAX_LENGTH}
        disabled={!canOperate || pending}
        onChange={(event) => setCharter(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {model.shown === null ? (
          <p className="flex-1 text-muted-foreground text-xs" role="status">
            {selectedProject?.title} has no default model. Choose one for this captain.
          </p>
        ) : null}
        <ProviderModelPicker
          environmentId={environmentId}
          activeInstanceId={
            model.shown?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId)
          }
          model={model.shown?.model ?? ""}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={getCustomModelOptionsByInstance(
            settings,
            providers,
            model.shown?.instanceId,
            model.shown?.model,
          )}
          isComposerOwned={false}
          disabled={!canOperate || pending}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          triggerAriaLabel="Captain model"
          {...(model.shown === null ? { triggerLabel: "Choose a model" } : {})}
          onInstanceModelChange={(instanceId, picked) =>
            setPickedModel(pickModelSelection(model.shown, instanceId, picked))
          }
        />
        <Button size="sm" type="submit" disabled={!canOperate || !ready || pending}>
          Start captain
        </Button>
      </div>
    </form>
  );
}
