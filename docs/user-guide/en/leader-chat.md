# Chat with the leader

The leader is an agent that runs on a team machine and answers on the **Chat** page. It reads the scope's tasks, runs, docs, memory and costs, then proposes concrete work. A proposal only runs when someone presses *Confirm*, unless its kind was allowed to run on its own. Vietnamese version: [../vi/leader-chat.md](../vi/leader-chat.md).

Rights needed: using chat needs the service's chat right. A proposal runs with the rights of the person who presses *Confirm*.

## Start a chat

1. Open **Chat** (⌘2), press *New chat*.
2. Under *Scope, machine and plan*: pick the service (hub admins also get *Whole hub*), the machine that runs the leader, and the plan (leave *the machine picks a plan with quota* unless you want to pin one).
3. Type a message, press *Send*. The status shows *Waiting for <machine> to take it…*, then *Writing…*.

> No machine takes it? The machine needs *Take work on this machine* on (app › Agent profiles) and the service's repo.

Quick question from another page: press *Ask leader* in the top bar. The panel opens with *Context sent with your message* (the page you are on); press *Remove context* if you do not want it sent.

## Confirm proposals

An answer can carry a *Proposed by the leader* block: create a task, move a task, classify, run a task, cancel a run, merge an MR/PR, turn a machine's subscription on or off, change the policy, stop or resume agents, ask a machine to install, turn a tool on or off. Each proposal has a *Why*.

1. Read each proposal.
2. Press *Confirm* (runs with your rights) or *Set aside*.
3. Several proposals: *Confirm all (n)* or *Set all aside*.

Proposals nobody has decided also show on **Today** › *Needs your decision*.

## Commands

Type `/` in the input for suggestions:

| Command | Does |
|---|---|
| `/assign` | Assign work |
| `/research` | Read-only research |
| `/status` | A *Status* card: completed tasks, running runs, tasks awaiting review, blocked tasks, quota |
| `/release` | Release |
| `/cancel <run>` | Cancel a run |
| `/retry <run>` | Redispatch a run |

## Plans and research

- **Plan**: ask the leader to turn a request into a *Plan* (spec, *Tasks and acceptance criteria*, *Expected batches*). Press *Start* to create the spec and tasks, or *Request changes*.
- **Research**: the leader queues a read-only run with a *Scope*, *Requested sources* (repository, Hive documents, web) and a *Result format*. When done you get *View report*, *Draft awaiting approval* and *Turn into a Plan*.

## Files, models, search

- *Attach*: add files to a message (there is a limit per message).
- *Model and effort*: pick *Model*, *Effort*; *Save as default* for later chats.
- *Search titles and messages* in the chat list; *Find in loaded messages* inside a chat.
- *Rename*, *Delete chat* (only when no proposal is still waiting).

## Set up the leader (service lead)

Open **Chat** › *Leader guide*, or **Service settings** › the *Leader* tab:

1. *Instructions*: guidance for this service's leader. Without its own guide the service uses the team's (the `hive-leader` skill).
2. *Commands the leader may run*: the commands the leader may run on the machine (there is a maximum).
3. *The leader runs on its own*: tick the proposal kinds the leader may carry out without a confirmation. By default every kind is *always confirmed*.
4. Press the matching save button: *Save for <service>* (guide), *Save commands for <service>*, *Save what runs on its own for <service>*.

> Warning: only let the leader run on its own the kinds you accept with nobody looking first, for example *Research*. A data-deleting operation called by an agent still always waits for a person.
