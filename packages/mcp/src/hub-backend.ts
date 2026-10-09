import { HiveError, HubBackend, issueMcpCredential, type HiveBackend } from "@xdev-hive/core";

const CLOSED = new Set(["errors.projectDeleted", "errors.projectArchived"]);

/**
 * The hub's refusal for a project that was archived or deleted, with what to do about it. The agent passes the text on
 * to its user, and the fix is on their side (.mcp.json) or an admin's, never a retry.
 */
function explainClosed(err: unknown, project: string | undefined): unknown {
  if (!project || !(err instanceof HiveError) || !err.key || !CLOSED.has(err.key) || err.vars?.project !== project) return err;
  const fix = `HIVE_PROJECT=${project} (in this repo's .mcp.json) points at it, so no xdev-hive tool works here. ` +
    `Change HIVE_PROJECT to a live project and restart the agent, or ask a hub admin to restore ${project}.`;
  return new HiveError(err.code, `${err.message} ${fix}`, { key: err.key, ...(err.vars ? { vars: err.vars } : {}) });
}

export interface McpHubBackend extends HiveBackend {
  /** Exchanges the credential now; the hub's error when HIVE_PROJECT is archived or deleted, else null (unreachable included). */
  check(): Promise<HiveError | null>;
}

/** Keep the machine token on the exchange path; agent RPCs use only an expiring MCP credential. */
export function mcpHubBackend(hub: { url: string; token: string }, project: string | undefined, readOnly: boolean): McpHubBackend {
  let current: HubBackend | undefined;
  let refreshAt = 0;
  let pending: Promise<void> | undefined;
  const ready = async () => {
    if (!current || Date.now() >= refreshAt) {
      pending ??= issueMcpCredential(hub, project, readOnly).then((token) => {
        current = new HubBackend(hub.url, token);
        refreshAt = Date.now() + 55 * 60_000;
      }).finally(() => { pending = undefined; });
      await pending;
    }
    return current!;
  };
  return {
    async call(method, input, actor) {
      // No latch on a closed project: each call asks again, so a restore works without restarting the agent.
      try {
        return await (await ready()).call(method, input, actor);
      } catch (err) {
        throw explainClosed(err, project);
      }
    },
    async check() {
      try {
        await ready();
        return null;
      } catch (err) {
        const closed = explainClosed(err, project);
        return closed !== err && closed instanceof HiveError ? closed : null;
      }
    },
  };
}
