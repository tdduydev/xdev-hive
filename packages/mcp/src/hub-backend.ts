import { HubBackend, issueMcpCredential, type HiveBackend } from "@xdev-hive/core";

/** Keep the machine token on the exchange path; agent RPCs use only an expiring MCP credential. */
export function mcpHubBackend(hub: { url: string; token: string }, project: string | undefined, readOnly: boolean): HiveBackend {
  let current: HubBackend | undefined;
  let refreshAt = 0;
  let pending: Promise<void> | undefined;
  return {
    async call(method, input, actor) {
      if (!current || Date.now() >= refreshAt) {
        pending ??= issueMcpCredential(hub, project, readOnly).then((token) => {
          current = new HubBackend(hub.url, token);
          refreshAt = Date.now() + 55 * 60_000;
        }).finally(() => { pending = undefined; });
        await pending;
      }
      return current!.call(method, input, actor);
    },
  };
}
