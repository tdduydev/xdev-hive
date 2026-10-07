import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tr } from "#desktop/main/i18n.ts";
import { hookEnv, shellQuote, type ReadyHook } from "#desktop/main/runner/tools.ts";

export interface CodexRtkRun {
  ready: ReadyHook[];
  args: string[];
  env: Record<string, string>;
  note: string;
}

/** Self-contained because the installed Electron bundle is not a script a child Node process can import. */
export function codexRtkScript(argv: string[], originalPath: string): string {
  return `import { execFileSync, spawnSync } from 'node:child_process';
const hook = ${JSON.stringify(argv)};
const originalPath = ${JSON.stringify(originalPath)};
const quote = s => /^[a-zA-Z0-9_./:=@%+,-]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\\\\''") + "'";
const env = { ...process.env, PATH: originalPath };
delete env.ELECTRON_RUN_AS_NODE;
function rewrite(input) {
  try {
    const output = execFileSync(hook[0], hook.slice(1), { input: JSON.stringify(input), env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
    const command = JSON.parse(output).hookSpecificOutput?.updatedInput?.command;
    return typeof command === 'string' && command !== input.tool_input.command ? command : null;
  } catch { return null; }
}
const [bin, ...args] = process.argv.slice(2);
const command = [bin, ...args.map(quote)].join(' ');
const rewritten = rewrite({ tool_name: 'Bash', tool_input: { command } });
const pinned = rewritten?.replace(/^rtk(?=\\s)/, () => quote(hook[0]));
const result = pinned ? spawnSync('/bin/sh', ['-c', pinned], { env, stdio: 'inherit' }) : spawnSync(bin, args, { env, stdio: 'inherit' });
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 127);
`;
}

/** Commands RTK can compress; the adapter passes unsupported arguments through to the original program. */
const WRAPPED = ["git", "ls", "cat", "head", "tail", "rg", "grep", "find", "diff", "cargo", "rustc", "go", "pytest", "python", "python3", "npm", "npx", "pnpm", "yarn", "bun", "tsc", "eslint", "vitest", "docker", "kubectl", "curl", "wget", "make"];

/** Codex 0.160 ignores hook trust in -c overrides; PATH wrappers avoid changing the account's config. */
export function readyCodexRtk(o: {
  ready: ReadyHook[]; runDir: string; env: NodeJS.ProcessEnv;
}): CodexRtkRun {
  const rtk = o.ready[0]!;
  const binDir = path.join(o.runDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const script = path.join(o.runDir, "codex-rtk.mjs");
  writeFileSync(script, codexRtkScript(rtk.hooks[0]!.argv, o.env.PATH ?? ""), { mode: 0o600 });
  // `rtk proxy` must bypass compression too: restore PATH before RTK starts its child command.
  writeFileSync(path.join(binDir, "rtk"), `#!/bin/sh\nPATH=${shellQuote(o.env.PATH ?? "")} exec ${shellQuote(rtk.hooks[0]!.argv[0]!)} "$@"\n`, { mode: 0o700 });
  const env = { ...hookEnv(o.ready, o.runDir), RTK_DB_PATH: path.join(o.runDir, "rtk.db"), PATH: `${binDir}${path.delimiter}${o.env.PATH ?? ""}` };
  // Codex shells may discard inherited variables or reset PATH in a login shell. Set these only for this invocation.
  const shellEnv = Object.entries(env).flatMap(([k, v]) => ["-c", `shell_environment_policy.set.${k}=${JSON.stringify(v)}`]);
  for (const bin of WRAPPED) {
    writeFileSync(path.join(binDir, bin), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(bin)} "$@"\n`, { mode: 0o700 });
  }
  return { ready: o.ready, args: [...shellEnv, "-c", "allow_login_shell=false", "--add-dir", o.runDir], env, note: tr("runNote.toolCodexRtkWrapper") };
}
