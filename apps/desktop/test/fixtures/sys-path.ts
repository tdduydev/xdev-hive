import { accessSync, constants, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

// Whole host PATH directories can contain real agent CLIs, npm or Docker. Only
// expose utilities used by the shell fixtures and temporary Git repositories.
const UTILITIES = ["sh", "git", "mkdir", "chmod", "cat", "cp", "env", "rm"];
let bin: string | undefined;

export function sysBin(): string {
  if (bin) return bin;
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-test-sys-"));
  try {
    const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), "/usr/bin", "/bin"];
    for (const name of UTILITIES) {
      const source = dirs.map((d) => path.resolve(d, name)).find((file) => {
        try {
          accessSync(file, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
      if (!source) throw new Error(`Test fixture requires system utility: ${name}`);
      symlinkSync(source, path.join(dir, name));
    }
    bin = dir;
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

after(() => {
  if (bin) rmSync(bin, { recursive: true, force: true });
  bin = undefined;
});
