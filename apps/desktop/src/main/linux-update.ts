import { execFile } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type UpdateCommand = (file: string, args: string[], options: { cwd?: string; timeout: number }) => Promise<{ stdout: string }>;
export const updateCommand: UpdateCommand = async (file, args, options) => exec(file, args, { ...options, maxBuffer: 1024 * 1024 });

export interface LinuxLayout { root: string; app: string; current: string }

/** Only manage a version directory selected by its sibling current symlink. */
export function linuxLayout(execPath: string): LinuxLayout | null {
  try {
    let app = path.dirname(realpathSync(execPath));
    while (app !== path.dirname(app)) {
      if (/^app-\d/.test(path.basename(app))) {
        const root = path.dirname(app);
        const current = path.join(root, "current");
        if (lstatSync(current).isSymbolicLink() && realpathSync(current) === app && existsSync(path.join(app, "AppRun"))) return { root, app, current };
        return null;
      }
      app = path.dirname(app);
    }
  } catch { /* An unmanaged/extracted app must report why it cannot update itself. */ }
  return null;
}

export async function extractLinuxUpdate(layout: LinuxLayout, image: string, version: string, run: UpdateCommand): Promise<string> {
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Invalid Linux update version.");
  accessSync(layout.root, constants.W_OK);
  const target = path.join(layout.root, `app-${version}`);
  if (existsSync(target)) throw new Error(`Update directory already exists: ${target}`);
  const stage = mkdtempSync(path.join(layout.root, ".update-"));
  try {
    chmodSync(image, 0o755);
    await run(image, ["--appimage-extract"], { cwd: stage, timeout: 120_000 });
    const extracted = path.join(stage, "squashfs-root");
    const entry = path.join(extracted, "AppRun");
    // A missing or broken launcher must fail while the running version and current are untouched.
    accessSync(entry, constants.X_OK);
    if (!realpathSync(entry).startsWith(`${realpathSync(extracted)}${path.sep}`)) throw new Error("AppRun points outside the extracted update.");
    renameSync(extracted, target);
    return target;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export interface UpdateService { unit: string; user: boolean }

/** Match the manager's ControlGroup too: wrappers such as xvfb-run may be the service's MainPID. */
export async function linuxUpdateService(run: UpdateCommand, cgroup: string | undefined, runtime: LinuxLayout): Promise<UpdateService | null> {
  const text = cgroup ?? readFileSync("/proc/self/cgroup", "utf8");
  const units = text.split(/[\n/]/).filter((s) => /^[A-Za-z0-9_.@\\-]+\.service$/.test(s) && !s.startsWith("user@"));
  let unsupportedLaunch = false;
  for (const unit of units.reverse()) {
    for (const user of [true, false]) {
      try {
        const result = await run("systemctl", [...(user ? ["--user"] : []), "show", unit, "--property=ControlGroup", "--value"], { timeout: 5000 });
        const group = result.stdout.trim();
        if (group.endsWith(`/${unit}`) && text.split("\n").some((line) => {
          const owned = line.slice(line.indexOf(":", line.indexOf(":") + 1) + 1);
          return owned === group || owned.startsWith(`${group}/`);
        })) {
          const launch = await run("systemctl", [...(user ? ["--user"] : []), "show", unit, "--property=ExecStart", "--value"], { timeout: 5000 });
          // A shell launched under ssh/terminal also inherits a service cgroup; never stop that ancestor service.
          if (!launch.stdout.includes(`${runtime.current}/`)) {
            unsupportedLaunch = true;
            continue;
          }
          return { unit, user };
        }
      } catch { /* Try the other manager; a desktop launched by hand has neither. */ }
    }
  }
  // A service-owned process without a verified manager cannot safely relaunch outside that service.
  if (unsupportedLaunch) throw new Error("The systemd ExecStart must launch this app through its current symlink.");
  if (units.length) throw new Error("Cannot identify the systemd service for this app.");
  return null;
}

export const extractedInstallScript = [
  "#!/bin/sh",
  'log() { printf "[%s] updater helper: %s\\n" "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }',
  'fail() { log "$*"; printf "%s\\n" "$*" > "$ERROR"; exit 1; }',
  'ctl() { if [ "$USER_MANAGER" = 1 ]; then systemctl --user "$@"; else systemctl "$@"; fi; }',
  // A transient helper lives outside the app service's cgroup, so stop cannot kill the installer.
  '[ -n "$UNIT" ] && { log "stop $UNIT"; ctl stop "$UNIT" || fail "Cannot stop systemd service $UNIT"; }',
  'while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done',
  'log "switch current to $NEW"',
  'ln -s "$NEW" "$CURRENT.update-$PID" && mv -Tf "$CURRENT.update-$PID" "$CURRENT" || { [ -n "$UNIT" ] && ctl start "$UNIT"; fail "Cannot switch current; old build retained"; }',
  'if [ "$RELAUNCH" = 1 ]; then',
  '  if [ -n "$UNIT" ]; then',
  '    ctl restart "$UNIT" || { ln -s "$OLD" "$CURRENT.rollback-$PID" && mv -Tf "$CURRENT.rollback-$PID" "$CURRENT"; ctl start "$UNIT"; fail "Cannot restart systemd service; restored old build"; }',
  '  else nohup "$CURRENT/AppRun" >/dev/null 2>&1 &',
  '  fi',
  'fi',
  'log "update installed"',
  "",
].join("\n");
