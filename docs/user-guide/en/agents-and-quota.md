# Agent profiles and quota

Each **profile** (subscription) is an agent account signed in on one machine, for example a Claude or ChatGPT (Codex) account. The runner on the machine picks a profile for each run and rotates when one runs out of quota. Vietnamese version: [../vi/agents-and-quota.md](../vi/agents-and-quota.md).

Most of this happens in the **desktop app** › *Agent profiles*. On the web, **Machines & agents** shows the team's machines, profiles and quota.

## Add a profile and sign it in

1. App › **Agent profiles** › *Add a subscription*.
2. Under *Signed-in accounts*, pick the kind: *Claude account*, *ChatGPT (Codex) account*, *Google account (Antigravity)*, *Google account (Gemini CLI)*, *Mistral Vibe account*, *OpenCode (provider / model)*, *Kilo Code account*, *GitHub Copilot account*.
3. Set a *Display name* (optional), pick *Sign in with* (for example *Claude plan (Pro, Max, Team)*, *Company SSO*, *A browser on this machine*, *A device code (sign in elsewhere)*).
4. Press *Add and sign in*, follow the terminal or browser that opens.
5. The profile's row turns *Ready*. If it shows *No CLI*, press *Install the CLI*; if *Signed out*, press *Sign in*.

Each profile has its own config folder, so two accounts of the same kind do not mix. Hive does not keep a profile's password or API key on the hub.

> *Custom agent types* (in the same *Add a subscription* box) make a profile from any command; only use them when you know how that CLI runs headless.

## Actions on a profile

| Button | Does |
|---|---|
| *Enable* / *Disable* | A disabled profile gets no runs. |
| *Edit* | *Command*, *Arguments*, *Environment variables*, *Roles* (plan, work on tasks, review), *Priority*, *Max in parallel*, *Default rest (minutes)*, *Limit per run (minutes)*, *Read-only Hive*, *Run in a container (Docker)*. Press *Save profile*. |
| *Check CLI* | Checks the CLI and the sign-in again. |
| *Open the CLI* / *Open the CLI in <service>* | Opens a terminal with the interactive CLI on the profile's account (not counted as a run). |
| *Remove* | Removes the profile from the machine. |

## Quota

The profile table has the columns *5-hour session*, *Week*, *Cost*.

- *Stop thresholds*: *Stop at session use (%)*, *Stop at weekly use (%)*. A profile at its threshold turns *At limit* and gets no new runs.
- *Read quota again*: read it now (the app also reads it on its own from time to time).
- A *Resting* profile (just ran out of quota): shows the reset time; *Use again* if you know the quota is back.
- *Reset counter*: resets the limit-hit and run counts.
- *Tokens and cache*: fresh input, cache write/read, output and % from cache over 24 hours / 7 days / 30 days.

Some CLIs do not report quota; the column then shows *Unknown* with the reason.

### How the runner picks a profile

The pinned profile (if any) → skip profiles that are off, busy, resting or of the wrong role → a review uses another vendor than the work → the profile whose quota resets sooner → the one with more quota left → the lower priority number → the one unused the longest.

Out of quota midway: the unfinished work is committed as `wip`, and the next run continues on the same branch with another profile.

## Take work from the hub

1. App › **Agent profiles** › the *Take work on this machine* card: turn it on, set *At most at once*. Changes save right away.
2. *Runner settings*: *Accept runs from the hub*, *Agents in parallel*, *Worktree folder*, *Update automatically when no run is active*. Press *Save*.

Hub admins and the machine's owner can also do this on the web: **Machines & agents** › *Agent map* › the machine › *Accept work from hub*, *Turn on/off and order subscriptions*.

## The whole team on the web

**Machines & agents** has these tabs:

| Tab | Who sees it | Content |
|---|---|---|
| *Agent map* | Anyone who can see the service | Machine → profile → running runs; CPU, RAM, disk; pick profiles then *Prompt the agent*. Each machine has *Tools* (allow hub tools) and *Worktrees*. |
| *Quota* | Anyone who can see the service | *Team quota*: 5-hour session, week and reset time of every profile. |
| *Fleet*, *Queue*, *Costs* | Hub admin | Machine heartbeats, runs waiting for a machine and why, estimated cost at API prices. |

## Worktrees

Each task runs in its own worktree on branch `ai/<task>`, without touching your main checkout.

- App › **Worktrees** (or web › *Agent map* › the machine › *Worktrees*): size, *On remote* (*Pushed*), *Uncommitted*, *In main*.
- *Delete* / *Delete selected (n)*: deletes the folders, the branch is kept.
- *Automatically clean worktrees*: on by default; only cleans worktrees with no run, no uncommitted change, and a pushed HEAD. Set *Days to keep done tasks outside main* and *Minimum free disk space (GB)*, press *Save cleanup*.

> Warning: deleting a worktree with uncommitted changes loses those files. The app asks you to tick a confirmation first.

## Stop all agents

When you need to stop quickly (for example agents going wrong at scale): **Admin** › *Operations overview* › *Stop all agents* for one service or *the whole hub*. The hub cancels waiting run requests, tells machines to stop running runs, and refuses new runs until someone presses *Let agents run again*. Stopping the whole hub needs a hub admin. Someone with the dispatch/stop right on a service (not a hub admin) uses the button of the same name on the *Overview* page (⌘K › *Overview*).
