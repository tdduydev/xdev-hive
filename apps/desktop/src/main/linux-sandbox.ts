import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Keep Chromium's sandbox unless the host's user namespace policy or bundled helper makes it unusable. */
export function linuxSandboxFallback(
  executablePath: string,
  read = readFileSync,
  stat = statSync,
): string | null {
  try {
    if (read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1") {
      return "AppArmor restricts unprivileged user namespaces";
    }
  } catch {
    // The sysctl is absent on systems without this AppArmor restriction.
  }

  const helper = path.join(path.dirname(executablePath), "chrome-sandbox");
  try {
    const mode = stat(helper);
    if (mode.uid !== 0 || (mode.mode & 0o4000) === 0) return "chrome-sandbox is not root-owned setuid";
  } catch {
    return "chrome-sandbox is missing";
  }
  return null;
}
