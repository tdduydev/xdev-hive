# Hub administration

For hub admins and service leads. The **Admin** entry on the web is for hub admins only; **Service settings** shows for people with the settings or member-management right on a service. Vietnamese version: [../vi/admin.md](../vi/admin.md).

## Admin tabs

| Group | Tab | Use it to |
|---|---|---|
| Operations | *Operations overview* | Hub health, queue, costs (24h / 7d / 30d), *Stop all agents*. |
| | *Budgets* | *Spending caps* per service, per person or for the whole hub, per day or month, in estimated USD or run count. |
| | *Alerts* | Open incidents and alert rules (failing runs in a row, machine offline, failing webhook, quota near its limit…); press *Seen*. |
| Access | *Users & access* | Accounts, hub roles, per-service access. |
| | *Roles & permissions* | The permission matrix of each role on a service. |
| | *Org chart* | Who holds which role in each system and service. |
| | *Policy* | The hub's policy for every project: agent policy, SDLC gate ceiling, self-approval rule, run time limits, *Merge queue*, *Services at rest*. |
| | *Tools* | The tool catalog (MCP, hook, plugin, CLI) with pinned versions. |
| System | *Audit log* | Every action that changes data, by people and by agents (which agent, on whose behalf, which run). |
| | *Notifications & webhooks* | Messages to Teams or Slack. |
| | *App versions* | Rolling out desktop app builds to machines. |
| | *Hub* | Hub version, database, doc files, backups. |

## Users and access

### Invite people

1. **Admin** › *Users & access* › *Invite user*.
2. Tab *Invite link*: pick the *Hub role*, *Valid for (days)*, press *Create link*, send the link to the person. Or tab *Create account*.
3. Links you created are in the *Invite links* list (*Valid*, *Used*, *Expired*); *Revoke* one sent by mistake.

### Grant access per service

1. In the user list, click a person (*Edit access of <name>*).
2. For each service (and *Shared*) pick a role: *Viewer*, *Member*, *QA*, *Reviewer*, *Service lead*, or *Custom* then tick each right under *Permissions*.
3. A service not granted is invisible to that person, including through agents and MCP.

Service leads grant access within their own services on **Service settings** › *Members*.

### Other jobs

- Pick several people: *Change hub role*, *Make hub admin*, *Remove hub admin*, *Disable accounts*, *Unlock*, *Move to trash*.
- *Trash*: *Restore* or *Delete for good*; deleted for good automatically after the number of days shown on the row.
- Tokens: account menu › *My tokens* (admins see every token, with the *Account* and *Machines* using it); *Revoke* a leaked token.

> Never send tokens or passwords through Hive's chat, docs or memory.

## Service settings

**Service settings** has the tabs *Process*, *Agent*, *Tools*, *Agent context*, *Leader*, *Members*, *Systems*. Each tab shows a summary; press *Edit* to open the editor.

| Tab | Content |
|---|---|
| *Process* | The service's SDLC gates, within the hub's ceiling. (*Approve the plan before coding* is set on the **Pipeline** page › *Process & models*.) |
| *Agent* | Agent policy: allowed models, autonomy, task classification. A service can only tighten the hub's policy, never loosen it. |
| *Tools* | Turn catalog tools on or off for the service. |
| *Agent context* | The `AGENTS.md` and what the service's agents get; *Periodic memory cleanup*. |
| *Leader* | The chat leader's guide, commands and what it runs on its own. |
| *Members* | Who has which role in the service. |
| *Systems* | Create and edit systems; the *Services* card: *Archive*, *Restore*, *Delete for good*; repo reachability on the machines. |

### Archive and delete a service

1. **Service settings** › *Systems* › the *Services* card.
2. *Archive*: hides the service and keeps its data; *Restore* to bring it back.
3. *Delete for good*: type the service's name to confirm. The hub takes a backup first; that backup is pinned.

> Warning: after deleting for good, only the backup brings the data back (see *Restore a service* below).

To hide a project key whose work is done, deleting nothing: **Admin** › *Policy* › *Services at rest* › *Let it rest*; *Reopen* undoes it.

## Backups and restore

Backups are on when the hub has a backup folder (set when installing the hub, or the `HIVE_BACKUP_DIR` variable). The hub backs itself up on a schedule and before running a new migration.

1. **Admin** › *Hub*. The *Backup* row shows the last backup.
2. *Back up now*: makes one right away (for example before a risky change). It is pinned.
3. The *Backups* list: *Backup*, *Reason* (*Start*, *Scheduled*, *By hand*, *Before deleting <service>*), *Size*, *Pin*.
   - *Pin* / *Unpin*: a pinned backup is not removed by the rotation (for the pin period; pinned backups have a total size cap).
   - *Download*: download the backup file.

### Restore a service

1. On a backup that still holds the service (usually *Before deleting <service>*), press *Restore project*.
2. Pick the *Project in the backup*, type its name to confirm, press *Restore*.
3. The hub copies every row of the service back in one transaction and lifts its deleted state.

> Only a service with no data on the hub can be restored: a restore never merges. Restoring the whole hub is done on the server; see the root `README.md`, section *Backup, khôi phục, nâng cấp*.

## Update the app for the whole team

The desktop app downloads new builds from the hub. Admins drive the rollout on **Admin** › *App versions*:

1. The *Releases* list: pick a build, press *Make it the target*.
2. *Download new builds*: on or off.
3. *Install when*: *The person restarts*, *The app quits*, or *No run is going*.
4. *Pause* / *Resume* the rollout at any time. The machine table shows *Current*, *Target* and the update state.
5. *Oldest version that gets runs from the hub*: machines on an older build get no runs.

On a person's machine: the top bar shows *Restart to update to vX*; or **This machine** › *Update* › *Install and restart*. Turn on *Update automatically when no run is active* (Agent profiles › *Runner settings*) to let the app install while idle.

> New builds are also on https://github.com/tdduydev/xdev-hive/releases for first installs.

## Notifications and webhooks

1. **Admin** › *Notifications & webhooks* › *Add webhook*.
2. Pick Teams (Workflows) or Slack (Incoming Webhook), paste the URL (`https` only), pick the events, filter by service, pick the message language.
3. *Send a test* to check. The URL is shown masked on the page.

## Agent operations that need a person

When an agent calls an operation that deletes or removes data (for example deleting a service), it does not run right away: the hub holds it as an operation proposal. People with the right see it on **Today** and in the *Pending review* tab, press *Show operation* to read the method and its input, and only then approve. Approval runs with the approver's rights; the *Audit log* names both the agent and the approver.

## The team's machines

**Machines & agents** › *Agent map* (hub admin):

- *Projects on each machine*: *Add a project to this machine* (pick the project, an absolute path, a clone URL if the folder is missing), *Send add command*; *Remove from machine*. The machine takes the command at its next heartbeat and reports the result. Removing never deletes the folder.
- Each machine's *Tools*: *Allow on this machine* for tools from the hub.
- Tab *Fleet*: pick offline machines, then *Remove offline machines* to drop them from the list (a machine still running shows up again at its next heartbeat).
