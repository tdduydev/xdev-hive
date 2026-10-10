# Docs, memory and skills

Three kinds of knowledge that people and agents both read. Vietnamese version: [../vi/knowledge.md](../vi/knowledge.md).

| Kind | For | Agents read it with |
|---|---|---|
| **Docs** | Conventions, architecture, API contracts, `AGENTS.md`, the decision log. Versioned. | `doc_list`, `doc_get`; and the files Hive writes into the repo |
| **Memory** | What agents or people learned while working: small decisions, gotchas, conventions. | `memory_search` |
| **Skills** | How to do a recurring kind of work (one `SKILL.md`). | Claude Code loads them from `.claude/skills/`; other agents use `skill_get` |

Each kind has three levels: **Shared (whole team)**, **System** and **Service**. Pick the level with the scope picker in the sidebar.

## Docs

### Write and edit a page

1. Open **Docs** (⌘5). The page tree is split by space: *Shared (whole team)*, *System <name>*, *Service <name>*.
2. Press *+ Page* (or *Add a page inside* within a page). *Put in* picks the space; within a system, a new page goes to the system level by default.
3. *Edit* mode: an editor with a `/` menu, tables, links to other pages, images. *Markdown* to edit the Markdown directly. A ` ```mermaid ` block is drawn as a diagram.
4. Write a *Change note*, press *Save vX* (⌘S). An unsaved draft is kept on the device (*Draft kept on this device*).

Not allowed to edit directly? The button becomes *Send proposal*: write the *Reason for the proposal*, send. Reviewers see it in the *Pending review* tab.

### Page properties

- *Inside*: the parent page.
- *Applies to*: paths in the repo (for example `apps/web/**`). A page with paths does not go into the main `AGENTS.md`; it becomes a nested `AGENTS.md` or a path rule.
- *In AGENTS.md*: put the page into the service's `AGENTS.md` (or every service's in the system).
- *Space*: *Move to <space>* to move the page; history and pages inside follow, old links keep working.

### History, removal, restore

- *History*: every version; pick two to compare.
- *Remove page*, then *Remove it*: a soft delete. The *Removed* section at the end of the tree has *Restore*.
- *Files*: upload images or files to the page, *Insert*, *Download*.
- *Open the reader*: the reader has contents, *Links to*, *Linked from*, *Memory that names it*.

### Writing assistant

Press *Assistant* next to the page. Pick the sources (this page, linked pages, memory), then a job: *Draft the whole page*, *Write what is missing*, *Update from the code*, *Check for contradictions*, *Summarise for agents*. A machine with the service's repo writes it. Look at *Changes*, press *Apply to draft* or *Drop*, then save as usual.

### Review proposals

1. **Docs** › the *Pending review* tab.
2. Open a proposal, *Show changes*, then approve or reject. Pick several to approve them at once.
3. A proposal based on an older version (the page changed since) is marked as a conflict; the agent has to read the page again and re-propose.

> `AGENTS.md`, `CLAUDE.md` and `docs/decisions.md` in the repo are written by Hive. Do not edit them by hand in the repo: a hook blocks it. Edit the page on the hub (or send a proposal), then *Sync docs*.

### Docs into the repo

- In the app: **Tools & setup** › *Services on this machine* › *Sync docs*. A repo with a GitLab/GitHub remote gets an MR from branch `chore/xdev-hive-context`; otherwise the app commits in place.
- Before each run, the runner writes the latest version into the run's worktree.
- An `AGENTS.md` the repo wrote itself (no Hive block) is kept as is; use *Propose into Hive* to send its content to the hub.

## Memory

1. Open **Memory**. Filters: *All*, *Pending*, *Conflicts*, *Needs review*, *Stale index*.
2. Write one by hand: *+ Memory*, pick the *Kind*, *Belongs to* (system or service), the content, *Write memory*.
3. Review memory agents wrote: *Approve* or *Remove*.
4. Two entries in *Conflict*: pick *Keep this one*, *Keep #id*, or *No conflict*.
5. *Needs review* (a file the memory names has changed): press *Still true* if it still holds.
6. *Stale* (unused for long, agents no longer see it): press *Keep* if it is still needed.

Periodic cleanup: **Service settings** › *Agent context* › *Periodic memory cleanup*.

> Keep memory short, one idea per entry. Never write secrets, tokens or passwords.

## Skills

1. Open **Skills**. Pick a service to see exactly the skills its agents get: a service's own skill is marked *replaces team skill*; the team skill it replaces is marked *not used in this service*.
2. *New skill*: *Name* (lowercase letters, digits, `-`), *Description* (what the skill does and when to use it), *Instructions*. Pick *Shared* or a service. Press *Create skill*.
3. To edit: *Edit skill*, look at *Changes*, *Save*. Without the right you send a proposal; the count shows as *n pending*.
4. Columns *Runs using skill in 30 days*, *Last used*; filter *Unused skills* to tidy up.

Skills are written into the repo on *Sync docs* (`.claude/skills/<name>/SKILL.md`) and listed in `AGENTS.md` for other agents.
