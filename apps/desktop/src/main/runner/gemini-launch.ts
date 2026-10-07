import { existsSync } from "node:fs";
import path from "node:path";

/** Node cannot spawn npm .cmd wrappers directly. Run the official npm entry without a command shell. */
export function geminiLaunch(bin: string, args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
  const p = platform === "win32" ? path.win32 : path;
  if (platform !== "win32" || !/^gemini(?:\.cmd|\.bat)?$/i.test(p.basename(bin))) return { bin, args, env };
  const dir = p.dirname(bin);
  const entry = [p.join(dir, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"), p.join(dir, "..", "@google", "gemini-cli", "bundle", "gemini.js")].find(exists);
  if (!entry) throw new Error("Gemini npm entry not found; reinstall @google/gemini-cli on this machine");
  return { bin: process.execPath, args: [entry, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}
