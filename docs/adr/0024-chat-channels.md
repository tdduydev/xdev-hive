# 0024. Reach Hive from Telegram and Slack through commands that skip the LLM, and send free text to Leader only

- Status: Proposed
- Date: 2026-10-14
- Deciders: product owner (tdduydev), maintainers

## Context

People who approve plans, proposals and reviews are often away from the web. Hermes Agent (nousresearch/hermes-agent)
shows the shape: one gateway that connects Telegram, Discord and Slack to an agent. Hive is different: it is a hub
for many organizations and teams, already has `notify` (organization channels, inbox), `leader` (chat → proposal →
human approval) and roles checked per request. A copy of the Hermes gateway would route every message through an LLM
and would have no tenant or role model.

## Decision

1. **New hub module `chat`.** One bot per organization and kind (`telegram` or `slack`), configured on the web by an
   organization admin. Bot tokens and signing secrets are stored with the envelope encryption the hub already uses for
   SCM and notification secrets (`config_enc`, context = row id). Inbound traffic is webhooks only
   (`/hooks/chat/telegram/{botId}`, `/hooks/chat/slack/{botId}/{events,commands,interact}`), verified with Telegram's
   secret-token header and Slack's v0 HMAC signature. Long polling is not built in this version.
2. **Link by one-time code, never by display name.** A signed-in user asks the web for a code (10 minutes, 40 bits,
   stored as SHA-256). Sending `/link CODE` (Telegram) or `/hive link CODE` (Slack) from the chat account binds that
   chat account id to the user for that bot. Every later message resolves the user from the chat account id.
3. **Commands and buttons never call an LLM.** They map straight to hub functions run in `withTenant` as the linked
   user, so roles are checked exactly as on the web: approve or reject a Leader proposal, approve or return a plan or
   a document review checkpoint, cancel a run, list runs and tasks, show machine quota. Code-review checkpoints are
   web-only because their decision is bound to a head SHA the reviewer has to see.
4. **Only free text reaches Leader.** In a private chat, free text goes to the user's own Leader thread for the project
   chosen with `/project`, with the same proposal → approval flow as the web. The run uses the organization's chat
   model (default `sonnet`, Claude CLI). Free text is limited per user per day and per organization per day (defaults
   30 and 300). Chat never enables any auto-approve mode; proposals always wait for a person.
5. **Notifications go to linked accounts.** `notify()` calls a hook that `chat` installs at startup (the hook inverts
   the dependency because `chat` depends on modules that depend on `notify`). Each recipient with a link whose event
   list contains the event gets an outbox row; job `chat.deliver` sends it with retries. Events may carry structured
   actions (approve, return, open on web) that become buttons.
6. **Safety.** Group chats are refused unless the organization turns them on; even then only slash commands work, not
   free text. Button presses must come from the chat account the message was sent to. Every command and button is
   audited (`chat.command`, `chat.action`). A per-account burst limit applies before any database work. Outbound text
   is redacted for token and key patterns, fenced code is replaced by a pointer to the web, and bodies are clipped:
   chat carries a summary and a link, not code.

## Consequences

- Cheap by construction: only free text can cost model tokens, and it is capped.
- A webhook needs a public HTTPS hub URL. Self-hosters without one cannot use Telegram yet; long polling is the
  follow-up.
- One bot per organization and kind keeps tenant routing trivial: the bot id in the URL selects the organization.
- A chat account can be linked to one user per bot; unlinking on the web or with `/unlink` frees it.
- Discord, Teams, per-team bots and rich Slack formatting are out of scope.

## Follow-up: T011 and T012 (2026-10-14)

Telegram long polling is now opt-in per bot UUID through `HIVE_TELEGRAM_POLL_BOT_IDS` on the API process. It removes
the webhook without dropping pending updates, shares webhook command/action handling, and uses a separate PostgreSQL
session with an advisory lock per token. The next update id is stored inside the encrypted bot config, preserving
the cursor across restarts without a new table or migration. Token replacement resets the cursor; replacing the same
token preserves it. Transient failures retry after five seconds and shutdown cancels the pending request. There is
an at-least-once window between the business transaction and saving the cursor, so free-text Leader turns can repeat
after a crash in that window. Each polling bot consumes one extra database connection.

Human code-review checkpoints now have chat buttons containing server-side `headSha` and `gateRunId`. Notifications
show the full SHA and link to the diff; decisions reuse the web function, including provider head checks, permissions,
requester exclusion and quorum. Checking the gate run under the review lock prevents a stale button from approving a
later checkpoint on the same SHA. Chat returns use the checkpoint's configured route and a fixed Vietnamese note;
detailed feedback still uses the web. Automatic gate overrides remain on the web.

Operation: create the Telegram bot on the web, obtain its UUID from `GET /v1/chat/bots`, set the comma-separated env
list, and restart the API process. The connection test reports polling and does not register a webhook for that bot.
To return to webhooks, remove the UUID, restart the API process, then run the connection test with an HTTPS public URL.
Polling IDs must be configured consistently on all API instances so an instance cannot reinstall the webhook.

Reference: [Telegram Bot API: getUpdates](https://core.telegram.org/bots/api#getupdates) and
[deleteWebhook](https://core.telegram.org/bots/api#deletewebhook).
