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
3. Select **Start captain**.

The captain gets its own thread in that project and runs on the project's default model, so set
one in the project settings first. Its first turn writes a plan, then starts crew tasks.

Agents can also start and manage captains with the `captain_create`, `captain_list`,
`captain_message`, and `captain_resolve_need` tools, but only when you ask them to.

## Needs you

**Needs you** lists every open blocker and decision your captains have raised. Write your answer
and select **Resolve**. The captain receives the answer as a message and carries on. A captain can
also withdraw a need it no longer has.

Captains are told not to ask questions in chat, so this list is the one place to look. You can
still open a captain's thread to watch it work or send it a message from its card.

## Plan and crew

Select **Details** on a captain to see its current plan and the status of each crew task. Crew
tasks are ordinary child threads; open them from the captain's thread.

## Retire a captain

Select **Retire** when the work is done. A retired captain cannot receive messages or raise
needs, and its open needs leave **Needs you**. Select **Reactivate** to bring it back.
