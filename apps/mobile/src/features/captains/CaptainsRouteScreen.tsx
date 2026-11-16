import { useAtomValue } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  CAPTAIN_CHARTER_MAX_LENGTH,
  CAPTAIN_MESSAGE_MAX_LENGTH,
  CAPTAIN_NAME_MAX_LENGTH,
  resolveEnvironmentMachineKind,
  type CaptainNeed,
  type CaptainSummary,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Platform, Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { captainEnvironment } from "../../state/captains";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useSettingsEnvironmentMenu } from "../settings/components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  useSettingsEnvironmentFilter,
  type SettingsTarget,
} from "../settings/settings-environment-filter";
import { settingsTargetsForProject } from "../settings/settings-environment-filter.logic";
import {
  captainFailureMessage,
  captainStartForm,
  captainsInProjects,
  collectOpenNeeds,
  crewMemberLabel,
  nextCaptainStatus,
} from "./captains.logic";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  const message = captainFailureMessage(result);
  if (message !== null) Dialog.alert(title, message);
}

/** One submission at a time: a second tap before React re-renders must not send twice. */
function useSubmission() {
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const run = (action: () => Promise<void>) => {
    if (running.current) return Promise.resolve();
    running.current = true;
    setPending(true);
    return action().finally(() => {
      running.current = false;
      setPending(false);
    });
  };
  return [pending, run] as const;
}

const ROW = "gap-2 px-4 py-3";
const ROW_DIVIDED = "gap-2 border-t border-border-subtle px-4 py-3";

function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength: number;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly multiline?: boolean;
  readonly borderTop?: boolean;
}) {
  return (
    <View className={props.borderTop ? ROW_DIVIDED : ROW}>
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <RNTextInput
        accessibilityLabel={props.label}
        value={props.value}
        readOnly={props.disabled}
        onChangeText={props.onChange}
        maxLength={props.maxLength}
        multiline={props.multiline}
        textAlignVertical={props.multiline ? "top" : "center"}
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-foreground-muted"
        className={
          props.multiline
            ? "min-h-20 font-sans text-base text-foreground"
            : "min-h-8 font-sans text-base text-foreground"
        }
      />
    </View>
  );
}

export function CaptainsRouteScreen() {
  const { availableTargets, selectedTargets, selectedProjectKey, projectGroups } =
    useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const visibleEnvironments = settingsTargetsForProject(
    selectedTargets,
    selectedProjectKey === null ? null : selectedGroup,
  );
  const insets = useSafeAreaInsets();
  const environmentMenu = useSettingsEnvironmentMenu();

  return (
    <SettingsScreen title="Captains" menus={[environmentMenu]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {visibleEnvironments.length > 0 ? (
          visibleEnvironments.map((environment) => (
            <EnvironmentCaptains
              key={environment.environmentId}
              environment={environment}
              projectIds={
                selectedProjectKey === null
                  ? null
                  : (selectedGroup?.members
                      .filter(
                        (member) => member.project.environmentId === environment.environmentId,
                      )
                      .map((member) => member.project.id) ?? [])
              }
            />
          ))
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? "Connect an environment to see captains."
              : "No environments match these filters. Change the filter above."}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentCaptains({
  environment,
  projectIds,
}: {
  readonly environment: SettingsTarget;
  readonly projectIds: readonly ProjectId[] | null;
}) {
  const environmentId = environment.environmentId;
  const live = useEnvironmentQuery(captainEnvironment.live({ environmentId, input: {} }));
  const environmentProjects = useProjects().filter(
    (project) => project.environmentId === environmentId,
  );
  const projectTitle = (projectId: ProjectId) =>
    environmentProjects.find((project) => project.id === projectId)?.title ?? projectId;
  const captains = live.data ? captainsInProjects(live.data.captains, projectIds) : [];
  const needs = collectOpenNeeds(captains);

  return (
    <View className="gap-5">
      <View
        className={
          // Lines up with the section titles below, which ListSection pads per platform.
          Platform.OS === "android"
            ? "flex-row items-center gap-2 px-4"
            : "flex-row items-center gap-2 px-2"
        }
      >
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          size={16}
          tintColorClassName={
            Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
          }
        />
        <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
          {environment.label}
        </Text>
      </View>
      {live.error ? (
        <Text className="px-2 text-base text-danger-foreground">
          Could not load captains: {live.error}
        </Text>
      ) : live.data === null ? (
        <Text className="px-2 text-base text-foreground-muted">Loading captains…</Text>
      ) : (
        <>
          <SettingsSection title={`Needs you (${needs.length})`}>
            {needs.length === 0 ? (
              <Text className="p-4 text-base text-foreground-muted">
                Nothing needs you. Captains surface blockers and decisions here.
              </Text>
            ) : null}
            {needs.map(({ need, captain }, index) => (
              <NeedRow
                key={need.id}
                environmentId={environmentId}
                need={need}
                captainName={captain.name}
                borderTop={index > 0}
              />
            ))}
          </SettingsSection>
          <SettingsSection title={`Fleet (${captains.length})`}>
            {captains.length === 0 ? (
              <Text className="p-4 text-base text-foreground-muted">
                No captains yet. Start one below to hand it an area of a project.
              </Text>
            ) : null}
            {captains.map((captain, index) => (
              <CaptainRow
                key={captain.id}
                environmentId={environmentId}
                captain={captain}
                projectTitle={projectTitle(captain.projectId)}
                borderTop={index > 0}
              />
            ))}
          </SettingsSection>
          <StartCaptainForm
            environmentId={environmentId}
            projects={environmentProjects.filter(
              (project) =>
                project.isScratch !== true &&
                (projectIds === null || projectIds.includes(project.id)),
            )}
          />
        </>
      )}
    </View>
  );
}

function NeedRow({
  environmentId,
  need,
  captainName,
  borderTop,
}: {
  readonly environmentId: EnvironmentId;
  readonly need: CaptainNeed;
  readonly captainName: string;
  readonly borderTop: boolean;
}) {
  const [answer, setAnswer] = useState("");
  const [pending, run] = useSubmission();
  const canResolve = useAtomValue(captainEnvironment.resolveNeed.permissionAtom(environmentId));
  const resolve = useAtomCommand(captainEnvironment.resolveNeed, {
    label: "resolve captain need",
    reportFailure: false,
  });
  const submit = () =>
    run(async () => {
      const resolution = answer.trim();
      if (!canResolve || resolution.length === 0) return;
      const result = await resolve({
        environmentId,
        input: { needId: need.id, resolution, creationSource: "mobile" },
      });
      if (result._tag === "Success") setAnswer("");
      else reportFailure("Could not resolve the need", result);
    });

  return (
    <View className={borderTop ? ROW_DIVIDED : ROW}>
      <Text
        textRole="footnote"
        className={need.kind === "blocker" ? "text-danger-foreground" : "text-foreground-muted"}
      >
        {need.kind === "blocker" ? "Blocker" : "Decision"} · Captain {captainName}
      </Text>
      <Text textRole="body" className="text-foreground">
        {need.summary}
      </Text>
      {need.detail ? <Text className="text-sm text-foreground-muted">{need.detail}</Text> : null}
      <RNTextInput
        accessibilityLabel={`Answer for ${need.summary}`}
        value={answer}
        readOnly={!canResolve || pending}
        onChangeText={setAnswer}
        maxLength={CAPTAIN_MESSAGE_MAX_LENGTH}
        multiline
        textAlignVertical="top"
        placeholder="Your answer or decision"
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-16 font-sans text-base text-foreground"
      />
      <Button
        label="Resolve"
        size="compact"
        tone="primary"
        loading={pending}
        disabled={!canResolve || pending || answer.trim().length === 0}
        onPress={() => void submit()}
      />
    </View>
  );
}

function CaptainRow({
  environmentId,
  captain,
  projectTitle,
  borderTop,
}: {
  readonly environmentId: EnvironmentId;
  readonly captain: CaptainSummary;
  readonly projectTitle: string;
  readonly borderTop: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, runSend] = useSubmission();
  const [statusPending, runStatus] = useSubmission();
  const canMessage = useAtomValue(captainEnvironment.message.permissionAtom(environmentId));
  const canSetStatus = useAtomValue(captainEnvironment.setStatus.permissionAtom(environmentId));
  const send = useAtomCommand(captainEnvironment.message, {
    label: "message captain",
    reportFailure: false,
  });
  const setStatus = useAtomCommand(captainEnvironment.setStatus, {
    label: "update captain",
    reportFailure: false,
  });
  const selectDetail = useSelectWorkspaceDetail();
  const retired = captain.status === "retired";

  const submitMessage = () =>
    runSend(async () => {
      const text = message.trim();
      if (!canMessage || text.length === 0) return;
      const result = await send({
        environmentId,
        input: { captainId: captain.id, text, creationSource: "mobile" },
      });
      if (result._tag === "Success") setMessage("");
      else reportFailure(`Could not message Captain ${captain.name}`, result);
    });
  const toggleStatus = () =>
    runStatus(async () => {
      if (!canSetStatus) return;
      const result = await setStatus({
        environmentId,
        input: {
          captainId: captain.id,
          status: nextCaptainStatus(captain.status),
          creationSource: "mobile",
        },
      });
      reportFailure(
        `Could not ${retired ? "reactivate" : "retire"} Captain ${captain.name}`,
        result,
      );
    });

  return (
    <View className={borderTop ? ROW_DIVIDED : ROW}>
      <View className="flex-row items-start gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Captain ${captain.name}, ${retired ? "Retired" : "Active"}, ${projectTitle}`}
          accessibilityHint={expanded ? "Hides the plan and crew" : "Shows the plan and crew"}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((open) => !open)}
          className="min-w-0 flex-1 gap-1 active:opacity-70"
        >
          <View className="flex-row items-center gap-2">
            <Text textRole="body" className="shrink text-foreground" numberOfLines={1}>
              Captain {captain.name}
            </Text>
            <SymbolView
              name={expanded ? "chevron.up" : "chevron.down"}
              size={12}
              tintColorClassName="accent-chevron"
              type="monochrome"
            />
          </View>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {retired ? "Retired" : "Active"} · {projectTitle}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={expanded ? undefined : 2}>
            {captain.charter}
          </Text>
        </Pressable>
        <Menu
          actions={[
            { id: "thread", title: "Open thread" },
            {
              id: "status",
              title: retired ? "Reactivate" : "Retire",
              attributes: { destructive: !retired, disabled: !canSetStatus || statusPending },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "thread") {
              selectDetail({
                name: "Thread",
                params: {
                  environmentId: String(environmentId),
                  threadId: String(captain.threadId),
                },
              });
            } else if (nativeEvent.event === "status") {
              void toggleStatus();
            }
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Actions for Captain ${captain.name}`}
            className="h-11 w-11 items-center justify-center"
          >
            <SymbolView
              name="ellipsis"
              size={18}
              tintColorClassName="accent-icon"
              type="monochrome"
            />
          </Pressable>
        </Menu>
      </View>
      {expanded ? <CaptainDetails environmentId={environmentId} captain={captain} /> : null}
      {retired ? null : (
        <View className="flex-row items-end gap-2">
          <RNTextInput
            accessibilityLabel={`Message Captain ${captain.name}`}
            value={message}
            readOnly={!canMessage || sending}
            onChangeText={setMessage}
            maxLength={CAPTAIN_MESSAGE_MAX_LENGTH}
            multiline
            placeholder="Message this captain"
            placeholderTextColorClassName="accent-foreground-muted"
            className="min-h-8 min-w-0 flex-1 font-sans text-base text-foreground"
          />
          <Button
            label="Send"
            size="compact"
            loading={sending}
            disabled={!canMessage || sending || message.trim().length === 0}
            onPress={() => void submitMessage()}
          />
        </View>
      )}
    </View>
  );
}

/** Mounted only while a captain's details are open, so the crew digest is fetched on demand. */
function CaptainDetails({
  environmentId,
  captain,
}: {
  readonly environmentId: EnvironmentId;
  readonly captain: CaptainSummary;
}) {
  const digest = useEnvironmentQuery(
    captainEnvironment.digest({ environmentId, input: { captainId: captain.id } }),
  );
  return (
    <View className="gap-2 rounded-xl bg-screen p-3">
      <Text textRole="footnote" className="font-t3-medium text-foreground">
        Plan
      </Text>
      <Text className="text-sm text-foreground-muted" selectable>
        {captain.plan.length > 0 ? captain.plan : "No plan reported yet."}
      </Text>
      <Text textRole="footnote" className="font-t3-medium text-foreground">
        Crew
      </Text>
      {digest.error ? (
        <Text className="text-sm text-danger-foreground">Could not load crew: {digest.error}</Text>
      ) : digest.data === null ? (
        <Text className="text-sm text-foreground-muted">Loading crew…</Text>
      ) : digest.data.crew.length === 0 ? (
        <Text className="text-sm text-foreground-muted">No crew started yet.</Text>
      ) : (
        digest.data.crew.map((member) => (
          <Text key={member.taskId} className="text-sm text-foreground" numberOfLines={1}>
            <Text className="text-sm text-foreground-muted">{member.status}</Text> ·{" "}
            {crewMemberLabel(member)}
          </Text>
        ))
      )}
    </View>
  );
}

function StartCaptainForm({
  environmentId,
  projects,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
}) {
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [name, setName] = useState("");
  const [charter, setCharter] = useState("");
  const [pending, run] = useSubmission();
  const canCreate = useAtomValue(captainEnvironment.create.permissionAtom(environmentId));
  const create = useAtomCommand(captainEnvironment.create, {
    label: "start captain",
    reportFailure: false,
  });
  const form = captainStartForm({ projects, projectId, name, charter });
  const submit = () =>
    run(async () => {
      if (!canCreate || form.input === null) return;
      const result = await create({
        environmentId,
        input: { ...form.input, creationSource: "mobile" },
      });
      if (result._tag === "Success") {
        setName("");
        setCharter("");
      } else {
        reportFailure("Could not start the captain", result);
      }
    });

  if (projects.length === 0) {
    return (
      <Text className="px-2 text-sm text-foreground-muted">Add a project to start a captain.</Text>
    );
  }
  return (
    <View className="gap-3">
      <SettingsSection
        title="Start a captain"
        footer="The captain runs on the project's default model and mode."
      >
        <Menu
          actions={projects.map((project) => ({
            id: project.id,
            title: project.title,
            state: project.id === form.project?.id ? ("on" as const) : undefined,
          }))}
          onPressAction={({ nativeEvent }) => {
            const picked = projects.find((project) => project.id === nativeEvent.event);
            if (picked) setProjectId(picked.id);
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Project, ${form.project?.title ?? ""}`}
            disabled={pending}
            className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
          >
            <Text textRole="body" className="text-foreground">
              Project
            </Text>
            <Text
              textRole="footnote"
              className="min-w-0 flex-1 text-right text-foreground-muted"
              numberOfLines={1}
            >
              {form.project?.title}
            </Text>
            <SymbolView
              name="chevron.down"
              size={14}
              tintColorClassName="accent-chevron"
              type="monochrome"
            />
          </Pressable>
        </Menu>
        <Field
          label="Name"
          value={name}
          onChange={setName}
          maxLength={CAPTAIN_NAME_MAX_LENGTH}
          disabled={!canCreate || pending}
          placeholder="Docs or Release"
          borderTop
        />
        <Field
          label="Charter"
          value={charter}
          onChange={setCharter}
          maxLength={CAPTAIN_CHARTER_MAX_LENGTH}
          disabled={!canCreate || pending}
          placeholder="What this captain owns and the outcome it works toward"
          multiline
          borderTop
        />
      </SettingsSection>
      <Button
        label="Start captain"
        tone="primary"
        fullWidth
        loading={pending}
        disabled={!canCreate || pending || form.input === null}
        onPress={() => void submit()}
      />
    </View>
  );
}
