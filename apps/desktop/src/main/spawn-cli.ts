// Finding and starting a CLI the way each OS needs. Windows is the reason this file exists: npm installs every
// CLI (npx, npm, claude, codex…) as an extensionless sh script next to a .cmd shim, CreateProcess cannot start the
// sh script (spawn … ENOENT), and Node refuses to start the .cmd without a shell (EINVAL, CVE-2024-27980).
import { execFile, spawn, type ChildProcess, type ChildProcessByStdio, type ExecFileException, type ExecFileOptions, type SpawnOptions, type SpawnOptionsWithStdioTuple, type StdioPipe } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import path from "node:path";

export interface SpawnPlatform {
  platform?: NodeJS.Platform;
  /** Windows only; process.env.PATHEXT when left out. */
  pathext?: string;
  /** Windows only; process.env.ComSpec when left out. */
  comspec?: string;
  isFile?: (file: string) => boolean;
}

/** The extensions CreateProcess (or cmd.exe for .bat/.cmd) can start; PATHEXT may also list .JS/.VBS/.PS1 associations Node cannot. */
const SPAWNABLE = [".com", ".exe", ".bat", ".cmd"];

const defaultIsFile = (platform: NodeJS.Platform) => (p: string) => {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function windowsExts(pathext: string | undefined): string[] {
  const listed = (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => SPAWNABLE.includes(e));
  return listed.length ? [...new Set(listed)] : SPAWNABLE;
}

/** Finds an executable like `which`. Returns null when missing. Windows: never an extensionless file, which only sh can run. */
export function resolveBin(bin: string, pathEnv: string, o: SpawnPlatform = {}): string | null {
  const platform = o.platform ?? process.platform;
  const isFile = o.isFile ?? defaultIsFile(platform);
  const p = platform === "win32" ? path.win32 : path.posix;
  const candidates = (base: string) => {
    if (platform !== "win32") return [base];
    const own = p.extname(base).toLowerCase();
    // PATHEXT order puts .exe before .cmd: a native install (claude.exe, gemini.exe) wins over an npm shim.
    const exts = windowsExts(o.pathext ?? process.env.PATHEXT);
    return SPAWNABLE.includes(own) ? [base] : exts.map((e) => base + e);
  };
  if (bin.includes("/") || bin.includes("\\")) return candidates(bin).find(isFile) ?? null;
  for (const dir of pathEnv.split(p.delimiter).filter(Boolean)) {
    const found = candidates(p.join(dir, bin)).find(isFile);
    if (found) return found;
  }
  return null;
}

// cmd.exe metacharacters, escaped with ^ the way cross-spawn does.
const META = /([()\][%!^"`<>&|;, *?])/g;
/** cmd.exe stops reading a command line at 8191 characters. */
const CMD_MAX = 8000;

function escapeArg(arg: string, twice: boolean): string {
  // MSVCRT quoting first (what node.exe reads back), then ^ for cmd.exe.
  let s = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  s = `"${s}"`.replace(META, "^$1");
  // An npm shim forwards %*, so cmd.exe parses the arguments a second time.
  return twice ? s.replace(META, "^$1") : s;
}

/** How to start `bin args` with execFile/spawn: .cmd/.bat go through %ComSpec% with every argument escaped. */
export function cliLaunch(bin: string, args: string[], o: SpawnPlatform = {}): { bin: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const platform = o.platform ?? process.platform;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) return { bin, args };
  if ([bin, ...args].some((a) => /[\r\n]/.test(a))) throw new Error("cmd.exe cannot pass an argument with a line break; send it on stdin");
  const line = [bin.replace(META, "^$1"), ...args.map((a) => escapeArg(a, true))].join(" ");
  if (line.length > CMD_MAX) throw new Error(`Command line is ${line.length} characters, cmd.exe allows ${CMD_MAX}`);
  return { bin: o.comspec ?? process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/** spawn for a CLI; throws when cmd.exe cannot carry the arguments (a line break, too long). */
export function spawnCli(bin: string, args: string[], options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnCli(bin: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnCli(bin: string, args: string[], options: SpawnOptions): ChildProcess {
  const l = cliLaunch(bin, args);
  return spawn(l.bin, l.args, l.windowsVerbatimArguments ? { ...options, windowsVerbatimArguments: true } : options);
}

/** execFile for a CLI (utf8 output); arguments cmd.exe cannot carry come back as the callback's error. */
export function execFileCli(bin: string, args: string[], options: ExecFileOptions, callback: (err: ExecFileException | null, stdout: string, stderr: string) => void): ChildProcess | null {
  let l: ReturnType<typeof cliLaunch>;
  try {
    l = cliLaunch(bin, args);
  } catch (err) {
    queueMicrotask(() => callback(err as ExecFileException, "", ""));
    return null;
  }
  const opts = { ...options, encoding: "utf8" as const, ...(l.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) };
  return execFile(l.bin, l.args, opts, (err, stdout, stderr) => callback(err, String(stdout), String(stderr)));
}
