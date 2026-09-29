import { HiveError } from "./errors.ts";

const PATTERNS: Array<[label: string, pattern: RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["GitHub token", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["API key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["xDev Hive token", /\bhive_[A-Za-z0-9_-]{30,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

/** Every line that looks like it holds a secret is replaced by a note saying so (logs, run output). */
export function redactLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const hit = findSecret(line);
      return hit ? `(line hidden: it looked like a ${hit})` : line;
    })
    .join("\n");
}

export function findSecret(text: string): string | null {
  for (const [label, pattern] of PATTERNS) if (pattern.test(text)) return label;
  return null;
}

/** Memory and docs are read by every agent, so anything that looks like a credential is refused. */
export function assertNoSecret(text: string, field: string): void {
  const hit = findSecret(text);
  if (hit) {
    throw new HiveError(
      "bad_request",
      `${field} looks like it contains a ${hit}. Secrets must never be stored in xDev Hive.`,
      { key: "errors.secret", vars: { kind: hit } },
    );
  }
}
