export interface HubConfig {
  port: number;
  version: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const port = Number(env.HIVE_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`HIVE_PORT không hợp lệ: ${env.HIVE_PORT}`);
  return { port, version: env.HIVE_VERSION ?? "0.0.0-dev" };
}
