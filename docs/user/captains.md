# Captains

A captain is a long-lived orchestrator agent that owns one area of a project, such as docs,
releases, or a migration. It keeps a plan, runs a crew of child tasks to do the work, and only
comes to you when it hits a blocker or needs a decision. You manage captains from one place
instead of watching every thread.

Open **Captains** from the sidebar or the command palette.

## Start a captain

1. Open **Captains** and find **Start a captain**.
2. Pick the project, give the captain a short name, and write its charter: what it owns and the
   outcome it works toward.
3. Check the model. It starts as the project's default model; pick another one for this captain
   if you like. A project without a default model needs you to choose one here.
4. Select **Start captain**.

The captain gets its own thread in that project and runs in the project's default mode. Its card
shows the model it runs on. Its first turn writes a plan, then starts crew tasks. To change the
model later, open the captain's thread and switch it there, as in any thread.

Agents can also start and manage captains with the `captain_create`, `captain_list`,
`captain_message`, and `captain_resolve_need` tools, but only when you ask them to. An agent can
name a model when it starts a captain; otherwise the captain uses the project's default. The
captain is told when a message or an answer was relayed by an agent rather than sent by you. An
agent needs the same access to the captain's thread as it needs to message any other thread. A
need is yours to answer: no captain can resolve one, and neither can a captain's crew.

## Needs you

**Needs you** lists every open blocker and decision your captains have raised. Write your answer
and select **Resolve**. The captain receives the answer as a message and carries on. If the answer
cannot be delivered, for example because the captain's thread is archived, the need stays in the
list so you can answer again. A captain can also withdraw a need it no longer has.

Captains are told not to ask questions in chat, so this list is the one place to look. You can
still open a captain's thread to watch it work or send it a message from its card.

## Plan and crew

Select **Details** on a captain to see its current plan and the status of each crew task. Crew
tasks are ordinary child threads; open them from the captain's thread.

## Retire a captain

Select **Retire** to stop a captain. Its current turn is stopped and it is told it is retired. A
retired captain cannot receive messages or raise needs, and its open needs leave **Needs you**.
Crew tasks that are already running finish on their own; stop one from its thread if you need to.
A turn that was already queued for the captain, such as a crew result, can run before it reads the
retirement notice.

Select **Reactivate** to bring it back. Its needs return to **Needs you** and it picks its charter
up again.

A captain lives in its thread. If you delete that thread, the captain leaves the list.
