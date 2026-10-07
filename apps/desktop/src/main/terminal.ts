// Opens a terminal window that runs one command: sign-ins a CLI can only do interactively (a browser
// page, a pasted code), and a profile's CLI for the person to work in (roadmap 32a). The command goes
// into a small script file, since each OS starts terminals differently. No Electron imports.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TerminalCommand {
  title: string;
  /** Absolute path of the CLI. */
  bin: string;
  args: string[];
  /** Only non-secret env (login dirs): it is written into the script file. */
  env: Record<string, string>;
  /** Credential names cleared for a profile using a separate account directory. Never values. */
  unsetEnv?: string[];
  /** Printed when the command ends, before the window waits. */
  done: string;
  /** Where the command runs; left out: wherever the terminal starts. */
  cwd?: string;
  /** The script's file name without its extension ("login" when left out). */
  name?: string;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** cmd.exe: no quoting survives every case, so refuse the characters that break out of a quoted string. */
const cmdq = (s: string) => {
  if (/["%^&|<>\r\n]/.test(s)) throw new Error(`Cannot pass ${JSON.stringify(s)} to cmd.exe safely`);
  return `"${s}"`;
};

export function terminalScript(platform: NodeJS.Platform, c: TerminalCommand): { name: string; content: string } {
  const base = c.name ?? "login";
  if (platform === "win32") {
    const lines = [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      `title ${c.title.replace(/[^\w .:-]/g, "")}`,
      ...(c.unsetEnv ?? []).map((k) => { if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error("Invalid env name"); return `set "${k}="`; }),
      ...Object.entries(c.env).map(([k, v]) => {
        // SET accepts JSON quotes; without expansion or command metacharacters they cannot run a command.
        if (!/^[A-Z_][A-Z0-9_]*$/i.test(k) || /[%^&|<>\r\n]/.test(v)) throw new Error("Cannot pass env to cmd.exe safely");
        return `set "${k}=${v}"`;
      }),
      // /d: the repo may be on another drive than the terminal starts on.
      ...(c.cwd ? [`cd /d ${cmdq(c.cwd)} || exit /b 1`] : []),
      // `call` so a CLI that is itself a .cmd returns here.
      `call ${[c.bin, ...c.args].map(cmdq).join(" ")}`,
      "echo.",
      `echo ${c.done.replace(/[^\p{L}\p{N} .,:()-]/gu, "")}`,
      "pause",
    ];
    return { name: `${base}.cmd`, content: `${lines.join("\r\n")}\r\n` };
  }
  const lines = [
    "#!/bin/sh",
    `# ${c.title.replace(/\n/g, " ")}`,
    ...(c.unsetEnv ?? []).map((k) => { if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error("Invalid env name"); return `unset ${k}`; }),
    ...Object.entries(c.env).map(([k, v]) => `export ${k}=${shq(v)}`),
    // A repo that went away must not leave the CLI working in the home folder instead.
    ...(c.cwd ? [`cd ${shq(c.cwd)} || exit 1`] : []),
    [c.bin, ...c.args].map(shq).join(" "),
    "echo",
    `echo ${shq(c.done)}`,
  ];
  // Terminal on macOS keeps the window open after the script; elsewhere, wait for Enter.
  if (platform !== "darwin") lines.push("read _");
  return { name: `${base}.${platform === "darwin" ? "command" : "sh"}`, content: `${lines.join("\n")}\n` };
}

/** Terminal emulators tried on Linux, in order, with how each takes a command. */
export const LINUX_TERMINALS: Array<[bin: string, args: (file: string) => string[]]> = [
  ["x-terminal-emulator", (f) => ["-e", "sh", f]],
  ["gnome-terminal", (f) => ["--", "sh", f]],
  ["konsole", (f) => ["-e", "sh", f]],
  ["xfce4-terminal", (f) => ["-x", "sh", f]],
  ["xterm", (f) => ["-e", "sh", f]],
];

export type Launch = (bin: string, args: string[]) => void;

const launch: Launch = (bin, args) => {
  const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => undefined);
  child.unref();
};

/**
 * Writes the script into `dir` and opens it in a terminal. `which` finds a Linux terminal.
 * Returns the script path, or null when no terminal was found.
 */
export function openInTerminal(
  c: TerminalCommand,
  opts: { dir: string; platform?: NodeJS.Platform; which: (bin: string) => string | null; run?: Launch },
): string | null {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? launch;
  const script = terminalScript(platform, c);
  mkdirSync(opts.dir, { recursive: true });
  const file = path.join(opts.dir, script.name);
  writeFileSync(file, script.content, { mode: 0o700 });
  if (platform !== "win32") chmodSync(file, 0o700);
  if (platform === "darwin") {
    run("open", ["-a", "Terminal", file]);
    return file;
  }
  if (platform === "win32") {
    run("cmd.exe", ["/c", "start", "", file]);
    return file;
  }
  for (const [bin, args] of LINUX_TERMINALS) {
    const found = opts.which(bin);
    if (found) {
      run(found, args(file));
      return file;
    }
  }
  return null;
}
