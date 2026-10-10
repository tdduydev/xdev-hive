# Feature list

What xDev Hive does on the `main` branch today, grouped by area, with where to find each feature in the interface. Vietnamese version: [../vi/features.md](../vi/features.md).

xDev Hive has two parts:

- **The web hub**: where the whole team works (tasks, chat, docs, administration). Open it in a browser, for example `https://hub.example.com`.
- **The desktop app**: runs on each machine that holds repos. It stays connected to the hub, runs agents (Claude Code, Codex, Gemini…) on that machine, and installs the tools agents need. The app only has the machine's work; every other page opens on the web.

The web menu has three groups: **Work** (Today, Tasks, Chat, Pipeline, Features, Runs), **Workspace** (Docs, Memory, Skills, Artifacts, History, Graph) and **Operations** (Machines & agents, Service settings, Admin). Each person only sees the entries they have rights to.

Terms: a **service** is one repo (one project key). A **system** groups the services of one product. A **profile** (subscription) is an agent account signed in on a machine, for example one Claude account.

## 1. The web's common frame

| Feature | Where |
|---|---|
| Scope picker: *All services*, *Shared (whole team)*, one system or one service. Every page filters by it. | Top of the sidebar |
| *+ New* button: *Ask the leader*, *Quick task*, *New feature (full workflow)*. Shortcut ⌘N. | Top bar |
| *Ask leader* panel opens from any page and sends the page you are on as context. | Top bar |
| Quick search for pages, tasks, docs, commands (⌘K). ⌘1–5: Today, Chat, Tasks, Runs, Docs. | Every page |
| Light/dark, language (Tiếng Việt, English), *My tokens*, *Sign out*. | Account menu |
| Phone layout: drawer menu, tables as cards, one pane at a time. | Open the web on a phone |

## 2. Tasks and runs

| Feature | Where |
|---|---|
| *Today*: everything waiting for your decision, grouped by job (*Needs your decision*, *Needs your review*, *Needs your testing*, *Agents waiting on you*, *To watch*). Only items you are allowed to act on. | Work › Today |
| Tasks with three views *Kanban*, *Board*, *List*; statuses *To do*, *In progress*, *In review*, *Done*, *Blocked*; drag a card to change its status. | Work › Tasks |
| Dependencies between tasks (same service, or another service in the same system). A task still waiting sits in *Blocked*; the *Ready next:* line suggests what to do first. | Tasks › *Depends on* column › *Edit* |
| *Assigned agent*: put a task in a machine's or profile's queue; view *By agent*. | Task panel |
| *Run on a machine*: pick the machine and options, then *Run*. | Task panel |
| *Prompt an agent*: send a free prompt, Hive creates task `P-<n>`; send to several agents at once to compare. | Tasks |
| *Give to agents (n)*: pick several tasks and create a *run group* with a maximum in parallel. | Tasks › pick several tasks |
| *Split a job*: split a large job into parts for several agents, writing the parts yourself or *Ask an agent to split it*. | Tasks |
| *Chain of roles*: steps that follow each other on the same branch (for example write code → write tests → review). | Task panel |
| *Note history*: every handoff note update, by an agent or a person, keeps a version. | Task panel |
| Task platform (Windows, Linux, macOS): the hub only hands it to a machine of that platform. | Task panel |
| *Runs*: runs from every machine, filters *Needs attention*, *Running*, *Waiting for a machine*, *Waiting for you*, *Failed*, *Done*; filter by group, task, machine. | Work › Runs |
| A run's page: *The run's steps*, handoff (*DONE / NOT DONE / HOW TO VERIFY / RISKS*), *Log*, *Changes* (diff), MR/PR and CI. | Runs › pick a run |
| Run actions: *Cancel run*, *Message agent* (more instructions for a running run), *Merge*, *Request changes*, *Redispatch* (other machine or plan, continue on the branch), *Run again*. | Run page |
| Cross review: a finished run is reviewed by an agent from another vendor; verdict *Review: approved* or *Review: changes needed*. | Automatic |
| *Approve the plan before coding*: the agent writes a read-only plan and waits for *Approve* or *Revise plan*; optional auto-approve after a deadline. | Today, task panel |
| Diff review per hunk, *Risk flags* (migration, permissions, security, data deletion, large file), *Queue fix*. | Run page › *Changes* |
| GitLab MR / GitHub PR: created after review, CI followed, a failing pipeline handed to an agent to fix, task moved to *Done* when the MR is merged. | App: Machine settings › *Merge request / Pull request* |
| *Merge queue*: a *Gate runner* machine batches branches, runs the checks, and lands green ones on the target branch. | Runs (pick a service) |
| *Artifacts*: images, reports and files agents produced in a run, attached to the run and the task. | Workspace › Artifacts, task panel, run page |
| *Graph*: tasks and dependencies, an agent layer (drag and drop to assign), SDLC and system layers. | Workspace › Graph |
| *History*: timeline and content search across runs, chat, SDLC gates and the admin audit. | Workspace › History |

## 3. Pipeline, features and releases

| Feature | Where |
|---|---|
| *Features*: each feature by step (Spec, Plan, Tasks, In progress, Review, Done); tabs Spec, Plan, Tasks, *Testing*, *Runs*, *Gate history*; *Pass* / *Request changes* at a gate. | Work › Features |
| Spec Kit: agents write `spec.md`, `plan.md`, `tasks.md` (*New feature*, *Plan it*, *Break into tasks*); *Import as tasks* keeps the dependencies. | Features; *+ New* › *New feature (full workflow)* |
| *Pipeline*: tabs *Results to accept* and *Process & models*; a gate per step (*A person*, *AI check*, *Automatic*), presets (*Cautious*, *Balanced*, *Maximum automation*, *Fast path*), 30-day figures. | Work › Pipeline |
| *Auto-dispatch tasks*: the hub hands ready tasks to idle profiles. | Pipeline |
| *Models by task type*: model tier per task type and size, for each step. | Pipeline › *Process & models* |
| Release: *Release* gate, *Approve release* or *Reject*, release queue. | Pipeline |

## 4. Agents, machines and quota

| Feature | Where |
|---|---|
| Many agent kinds: Claude Code, Codex (ChatGPT), Gemini CLI, Antigravity, GitHub Copilot CLI, Mistral Vibe, OpenCode, Kilo Code. | App › Agent profiles › *Add a subscription* |
| Sign the CLI in from the app, each profile in its own folder; *Open the CLI* to work by hand. | App › Agent profiles |
| Quota: 5-hour session and week, *Stop thresholds*, *Read quota again*, *Use again*, estimated cost, tokens and cache-read share. | App › Agent profiles; web › Machines & agents › Quota |
| Profile rotation: out of quota moves to another profile, the one resetting sooner is used first, unfinished work is committed and continued. | Automatic |
| *Take work on this machine*: accept runs from the hub, *At most at once*. | App › Agent profiles |
| Run in a Docker container, with a limited network (per profile). | App › Agent profiles › *Edit* |
| *Agent map*: machine → profile → run, pick profiles and *Prompt the agent*. | Operations › Machines & agents |
| *Fleet*, *Queue*, *Costs* (hub admin). | Machines & agents |
| *Stop all agents* / *Let agents run again* for one service or the whole hub. | Admin › Operations overview; *Overview* page (⌘K) |
| Worktrees: one worktree per task on branch `ai/<task>`; cleaned up automatically once the branch is pushed. | App › Worktrees |

## 5. Chat with the leader

| Feature | Where |
|---|---|
| Chat with the *leader* agent of a service (the leader knows the other services of its system), or *Whole hub* (hub admin). The leader reads tasks, runs and docs and proposes work. | Work › Chat, *Ask leader* panel |
| The leader's proposals (create a task, queue a run, merge, change a policy…) wait for *Confirm*; *Confirm all (n)*, *Set all aside*. | Chat, Today |
| *The leader runs on its own* and *Commands the leader may run*: which proposal kinds the leader may carry out by itself, and which commands it may run. | Chat › *Leader guide*; Service settings › *Leader* |
| Commands `/assign`, `/research`, `/status`, `/release`, `/cancel`, `/retry`. | Chat input, type `/` |
| A *Plan* from chat: spec, tasks and acceptance criteria, press *Start*. Read-only *Research* with a report and *Turn into a Plan*. | Chat |
| Attach files, pick *Model* and *Effort*, *Leader guide*. | Chat |

## 6. Docs, memory and skills

| Feature | Where |
|---|---|
| Docs by space (Shared, System, Service), a page tree, an editor with Markdown, tables, Mermaid, images and attached files, *History* and version comparison. | Workspace › Docs |
| *Applies to* (paths in the repo), *In AGENTS.md*; synced into the repo as `AGENTS.md`, `CLAUDE.md` and path rules. | Docs; app › *Sync docs* |
| *Pending review* tab: edits proposed by agents or by people who cannot edit directly; approve several at once. | Docs › *Pending review* |
| *Writing assistant*: draft, write what is missing, update from the code, check for contradictions, summarise for agents. | Docs › *Assistant* |
| *Remove page* (soft delete, *Restore* possible), move a page to another space. | Docs |
| Memory: what agents learned; filters *Pending*, *Conflicts*, *Needs review*, *Stale index*; buttons *Approve*, *Keep*, *Still true*. | Workspace › Memory |
| *Periodic memory cleanup*. | Service settings › *Agent context* |
| Skills: guidance for agents, for the whole team or one service; runs using a skill in 30 days, filter *Unused skills*. | Workspace › Skills |

## 7. Systems, groups and repos

| Feature | Where |
|---|---|
| Create systems, group services; a system's docs and memory. | Service settings › *Systems* |
| Archive, restore, *Delete for good* a service (deleting for good takes a backup first). | Service settings › *Systems* › *Services* card |
| *Link a group*: tie a system to a GitLab group or a GitHub owner, preview the matched services. | App › Tools & setup › the system's section |
| *Set up the group on this machine*: clone the missing repos in the group's tree; *Sync now*. | App › Tools & setup |
| *Repos here*: branch, ahead/behind, changes, access; *Fetch all*, *Pull*, *Pull all* (fast-forward only). | App › Tools & setup › the system's section |
| *Open <CLI> for the system*: one CLI session that sees every repo of the system on the machine. | App › Tools & setup |
| Repo reachability check (`git ls-remote` every 6 hours), shown on the Systems page. | Service settings › *Systems* |
| *Import a GitLab group* / *Import from GitHub*, *Put them in system*. | App › Tools & setup (once a token is set) |
| *Reference repos*: a run reads other repos of the same system, read-only. | App › Tools & setup › *Services on this machine* |
| Hub admins add or remove projects on a machine from the web (*Projects on each machine*). | Machines & agents › *Agent map* |

## 8. Setting up a machine (desktop app)

| Feature | Where |
|---|---|
| *Get started*: steps *Connection*, *Tools*, *Services*, *Agent accounts*, *Accept work*, each with *Do now*. | Opens on first run; ⌘K › *Get started* |
| *This machine*: hub connection, resources (CPU, memory, disk), app version and update. | App › This machine |
| *Tools & setup*: agent CLIs, the `hive-mcp` command (*Connect agents to Hive*), Spec Kit, codegraph; *Install everything missing*; install requests from an admin (*Agree and install* / *Decline*); *Tools from the hub* (*Allow*). | App › Tools & setup |
| *Machine settings*: *Connection* (hub), *Advanced* (machine name, data transfer with the hub), *GitLab/GitHub connection* (the machine's tokens, never sent to the hub), *Merge request / Pull request*. | App › Machine settings |
| *Runs here*, *Worktrees* (size, delete, automatic cleanup). | App |
| Local mode: *Use this machine on its own*, no hub needed. | App › Get started / Machine settings |
| Remote terminal on an agent machine (when an admin enables it on the hub). | ⌘K › *Terminal* |

## 9. App updates and releases

| Feature | Where |
|---|---|
| Download the app from GitHub Releases: macOS (`.dmg`), Windows (`.exe`), Linux (`.AppImage`, `.deb`). | https://github.com/tdduydev/xdev-hive/releases |
| The app downloads new builds from the hub; installs when the person restarts, when the app quits, or when no run is going (*Update automatically when no run is active*). | App › This machine › *Update* |
| Rollout: *Make it the target*, *Pause*, *Install when*, *Oldest version that gets runs from the hub*, versions in use. | Admin › *App versions* |

## 10. Hub administration

| Feature | Where |
|---|---|
| *Operations overview*: hub health, queue, costs, *Stop all agents*. | Admin |
| *Users & access*: *Invite user* (*Invite link* or *Create account*), hub role, lock, trash. | Admin |
| *Roles & permissions* (permission matrix per service), *Org chart*. | Admin |
| Per-service roles: *Viewer*, *Member*, *QA*, *Reviewer*, *Service lead*, *Custom*. | Admin › Users & access; Service settings › *Members* |
| *Policy* (agent policy, the hub's SDLC gate ceiling), *Tools* (tool catalog with pinned versions). | Admin |
| *Budgets* (spending caps), *Alerts*, *Audit log*, *Notifications & webhooks* (Teams, Slack). | Admin |
| *Hub*: version, database, doc files, *Back up now*, the *Backups* list (*Pin*, *Download*, *Restore project*). | Admin › Hub |
| SSO sign-in (OpenID Connect), linking an SSO account. | Sign-in page, account menu |
| A data-deleting operation called by an agent waits for a person's approval. | Today; Docs › *Pending review* |

## 11. MCP tools for agents

Agents (Claude Code, Codex, Gemini…) talk to Hive through the `xdev-hive` MCP server. What a tool may do follows the token; a read-only token only sees the read tools.

| Group | Tools |
|---|---|
| Tasks | `task_list`, `task_get`, `task_next`, `task_claim`, `task_update`, `task_notes`, `task_create`, `task_set_deps`, `task_status`, `task_assign` |
| Docs, skills | `doc_list`, `doc_get`, `doc_asset`, `doc_propose`, `skill_list`, `skill_get`, `skill_propose` |
| Memory | `memory_search`, `memory_write`, `memory_list` |
| Runs, machines | `run_list`, `run_get`, `run_count`, `run_requests`, `run_dispatch`, `machine_list`, `setup_missing` |
| Costs, policy | `cost_summary`, `token_usage`, `policy_get`, `alert_list`, `project_list`, `tool_list`, `tool_status` |
| Artifacts | `artifact_put`, `artifact_list`, `artifact_get` |
| Leader (chat) | `plan_create`, `propose_task`, `propose_task_status`, `propose_task_classify`, `propose_task_agent`, `propose_run`, `propose_research`, `propose_plan`, `propose_cancel_run`, `propose_merge`, `propose_profile`, `propose_policy`, `propose_stop_agents`, `propose_resume_agents`, `propose_install`, `propose_tool` |

Some tools exist only for one role (for example the `propose_*` tools only exist in the chat leader's session). An agent sees the tools its token allows with the CLI's `/mcp` command.
