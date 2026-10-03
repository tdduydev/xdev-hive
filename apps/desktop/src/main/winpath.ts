// Windows only: the user's Path in HKCU\Environment, so the hive-mcp shim's folder is on PATH of every program
// started afterwards — including Claude Code opened from a shortcut, which never sees a shell's PATH. HKCU needs
// no admin rights. The registry sits behind UserPath so the rules below can be tested on any machine with a fake.
import { execFileSync } from "node:child_process";

export interface UserPath {
  /** HKCU\Environment → Path, or null when the value is not there. expand: it is stored as REG_EXPAND_SZ. */
  read(): { value: string; expand: boolean } | null;
  write(value: string, expand: boolean): void;
  /** Tells programs already running that the environment changed (WM_SETTINGCHANGE); new ones read the registry anyway. */
  broadcast(): void;
}

/** %NAME% replaced from `env`, case-insensitive as Windows is; a name the env does not have is left as written. */
export function expandVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key && env[key] !== undefined ? env[key]! : whole;
  });
}

/**
 * One PATH entry as Windows compares it: case does not count, nor a trailing separator, nor the quotes some
 * installers leave, and %USERPROFILE%\.xdev-hive\bin is the same folder as C:\Users\me\.xdev-hive\bin.
 */
const sameDir = (entry: string, env: NodeJS.ProcessEnv): string =>
  expandVars(entry.trim().replace(/^"(.*)"$/, "$1"), env).replace(/[\\/]+$/, "").replaceAll("/", "\\").toLowerCase();

export function pathHasDir(value: string | null | undefined, dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!value) return false;
  const want = sameDir(dir, env);
  return value.split(";").filter(Boolean).some((entry) => sameDir(entry, env) === want);
}

/**
 * The Path with `dir` appended, or null when it is already there. Every entry that was there keeps its own text,
 * %VAR% included: rewriting them expanded would freeze a path that the user meant to follow their profile.
 */
export function pathWithDir(value: string | null | undefined, dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (pathHasDir(value, dir, env)) return null;
  const current = (value ?? "").replace(/;+$/, "");
  return current ? `${current};${dir}` : dir;
}

export interface PathChange {
  /** false: the folder was already on the user's Path, nothing was written. */
  added: boolean;
  value: string;
}

/** Appends `dir` to the user's Path and tells running programs. Keeps REG_EXPAND_SZ, since the value may hold %VAR%. */
export function addToUserPath(reg: UserPath, dir: string, env: NodeJS.ProcessEnv = process.env): PathChange {
  const current = reg.read();
  const next = pathWithDir(current?.value, dir, env);
  if (next === null) return { added: false, value: current?.value ?? dir };
  // A value with %VAR% only works as REG_EXPAND_SZ; a Path that had none still gets that type, which Windows itself uses.
  reg.write(next, current ? current.expand || /%[^%]+%/.test(next) : true);
  reg.broadcast();
  return { added: true, value: next };
}

const RUN_MS = 20_000;

/** HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG: no Node API sends it, so PowerShell calls SendMessageTimeout. */
const BROADCAST_PS = [
  "$sig = '[DllImport(\"user32.dll\", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);';",
  "$api = Add-Type -MemberDefinition $sig -Name HiveEnv -Namespace Win32 -PassThru;",
  "[UIntPtr]$out = [UIntPtr]::Zero;",
  "$api::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$out) | Out-Null",
].join(" ");

/** The real registry, through reg.exe (no shell, so a % in a value is not touched). */
export function windowsUserPath(): UserPath {
  const run = (bin: string, args: string[]) => execFileSync(bin, args, { encoding: "utf8", timeout: RUN_MS, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return {
    read() {
      let out: string;
      try {
        out = run("reg", ["query", "HKCU\\Environment", "/v", "Path"]);
      } catch {
        return null; // the user has no Path value of their own yet
      }
      const m = /^\s*Path\s+(REG_EXPAND_SZ|REG_SZ)\s+(.*)$/im.exec(out);
      return m ? { value: m[2]!.trimEnd(), expand: m[1]!.toUpperCase() === "REG_EXPAND_SZ" } : null;
    },
    write(value, expand) {
      // reg.exe, not setx: setx stores the value as REG_SZ (so %USERPROFILE% stops following the account) and cuts it at 1024 characters.
      run("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", expand ? "REG_EXPAND_SZ" : "REG_SZ", "/d", value, "/f"]);
    },
    broadcast() {
      try {
        run("powershell", ["-NoProfile", "-NonInteractive", "-Command", BROADCAST_PS]);
      } catch {
        // Only programs already open miss the change; the ones started next read the registry.
      }
    },
  };
}
