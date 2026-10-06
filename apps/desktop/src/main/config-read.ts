// config.json as the app reads it (BUG-config-silent, 6/10): a part that does not parse is left out and said in main.log,
// never the whole file failing in silence while the runner sends no heartbeat.
import type { ConfigIssue } from "@xdev-hive/core";
import { configIssueText, readConfig, type HiveConfig } from "@xdev-hive/core/node";

/**
 * Reads config.json and writes each part it could not use to `log`. `previous` is what the last read found: reload runs
 * after every settings save, and the same lines again would bury the rest of main.log. config is null when the file is
 * not a JSON object at all; the caller then runs on defaults.
 */
export function readDesktopConfig(file: string, log: (line: string) => void, previous: ConfigIssue[] = []): { config: HiveConfig | null; issues: ConfigIssue[] } {
  let read: { config: HiveConfig | null; issues: ConfigIssue[] };
  try {
    read = readConfig(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    read = { config: null, issues: [{ section: "file", id: null, field: "", message, action: "default" }] };
  }
  const text = read.issues.map(configIssueText);
  if (text.join("\n") !== previous.map(configIssueText).join("\n")) {
    for (const line of text) log(`config: ${file} ${line}`);
  }
  return read;
}
