import { agentActorName, agentSource, readRun, type Actor } from "@xdev-hive/core/node";

/** The hub replaces this transport actor with the credential's current account rights. */
export function stdioActor(mode: "local" | "hub", machine: string, username: string, env: Record<string, string | undefined>): Actor {
  const agent = (env.HIVE_AGENT ?? "agent").replace(/[^\w.-]/g, "").slice(0, 40) || "agent";
  const run = readRun(env.HIVE_RUN);
  // On the hub, only the authenticated reply credential decides chat scope.
  const chatReply = mode === "local" && /^[1-9]\d{0,15}$/.test(env.HIVE_CHAT_REPLY ?? "") ? Number(env.HIVE_CHAT_REPLY) : undefined;
  const interactive = !env.HIVE_RUN && chatReply === undefined && env.HIVE_READONLY !== "1";
  return {
    name: agentActorName(agent, mode, machine, username),
    // Local CLI sessions act for this machine's user; the credential allowlist still limits their methods.
    role: interactive ? "member" : "agent",
    source: agentSource(machine, env),
    ...(mode === "local" ? { agent, onBehalf: username } : {}),
    mcpCredential: interactive,
    ...(run ? { run } : {}),
    ...(chatReply === undefined ? {} : { chatReply }),
  };
}
