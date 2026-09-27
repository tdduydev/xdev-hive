import { execFile } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, shell, Tray, type IpcMainInvokeEvent } from "electron";
import {
  agentProfileSchema,
  HiveError,
  HubBackend,
  isMethod,
  PROJECT_NAME,
  toErrorPayload,
  transferHive,
  type Actor,
  type AgentProfile,
  type AgentRun,
  type DesktopProject,
  type DesktopSettings,
  type DesktopSettingsPatch,
  type GitLabCheck,
  type HiveBackend,
  type Me,
  type ProfileCheck,
  type StartRunRequest,
  type TransferReport,
  type TransferSide,
} from "@xdev-hive/core";
import {
  configPath,
  configSchema,
  gitlabSettingsSchema,
  loadConfig,
  localDbPath,
  pinMachine,
  resolveBackend,
  runnerSettingsSchema,
  saveConfig,
  SqliteHive,
  type HiveConfig,
} from "@xdev-hive/core/node";
import { GitLabClient } from "./gitlab/client.ts";
import { MergeRequester } from "./gitlab/mr.ts";
import { installAgents, installShim } from "./installer.ts";
import { expandEnv, expandHome, resolveBin } from "./runner/command.ts";
import { Runner, type RunnerEvent } from "./runner/runner.ts";
import { agentPath } from "./runner/shell-path.ts";
import { Setup } from "./setup.ts";
import { syncProject } from "./sync.ts";

app.setName("xDev Hive");
const smokeShot = process.env.HIVE_SMOKE_SCREENSHOT;
const devUrl = process.env.ELECTRON_RENDERER_URL;

let config: HiveConfig;
let backend: HiveBackend;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let runner: Runner;
let mergeRequester: MergeRequester;
let setup: Setup;
// Electron's network stack: honours system proxy settings and the macOS keychain's certificates.
const gitlabFetch = (url: string, init: RequestInit) => net.fetch(url, init);
let quitting = false;

const actor = (): Actor =>
  config.mode === "hub" ? { name: "desktop", role: "admin" } : { name: os.userInfo().username, role: "admin" };

function reload(): void {
  config = loadConfig();
  try {
    pinMachine(config);
  } catch (err) {
    console.warn("[xdev-hive] could not pin the machine name in config.json:", toErrorPayload(err).message);
  }
  backend = resolveBackend(config);
}

const resource = (...p: string[]) =>
  app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(app.getAppPath(), ...p);
const mcpEntry = () => (app.isPackaged ? resource("mcp", "hive-mcp.mjs") : resource("out", "mcp", "hive-mcp.mjs"));
const trayIcon = () => (app.isPackaged ? resource("icons", "trayTemplate.png") : resource("resources", "trayTemplate.png"));
/** Window icon on Windows/Linux and the Dock icon in dev; packaged macOS builds use build/icon.icns. */
const appIcon = () => (app.isPackaged ? resource("icons", "icon.png") : resource("resources", "icon.png"));

function settings(): DesktopSettings {
  return {
    mode: config.mode,
    machine: config.machine,
    hubUrl: config.hub.url,
    hasHubToken: config.hub.token.length > 0,
    projects: config.projects,
    memoryRequiresApproval: config.memoryRequiresApproval,
    autoCommit: config.sync.autoCommit,
    configPath: configPath(),
    dbPath: localDbPath(config),
    runner: config.runner,
    gitlab: { url: config.gitlab.url, hasToken: config.gitlab.token.length > 0, mr: config.gitlab.mr },
  };
}

function project(name: unknown): DesktopProject {
  const p = config.projects.find((x) => x.name === name);
  if (!p) throw new HiveError("not_found", `Dự án ${String(name)} chưa được thêm.`);
  return p;
}

function persist(next: HiveConfig): DesktopSettings {
  saveConfig(next);
  reload();
  return settings();
}

async function updateSettings(patch: DesktopSettingsPatch): Promise<DesktopSettings> {
  const next: HiveConfig = structuredClone(config);
  if (patch.mode === "local" || patch.mode === "hub") next.mode = patch.mode;
  if (typeof patch.hubUrl === "string") next.hub.url = patch.hubUrl.trim().replace(/\/+$/, "");
  if (typeof patch.hubToken === "string" && patch.hubToken.trim()) next.hub.token = patch.hubToken.trim();
  if (typeof patch.memoryRequiresApproval === "boolean") next.memoryRequiresApproval = patch.memoryRequiresApproval;
  if (typeof patch.autoCommit === "boolean") next.sync.autoCommit = patch.autoCommit;
  if (patch.runner) {
    const r = patch.runner;
    next.runner = runnerSettingsSchema.parse({
      ...next.runner,
      ...r,
      worktreeRoot: typeof r.worktreeRoot === "string" && r.worktreeRoot.trim() ? expandHome(r.worktreeRoot.trim()) : r.worktreeRoot === undefined ? next.runner.worktreeRoot : null,
    });
  }
  if (patch.gitlab) {
    const g = patch.gitlab;
    next.gitlab = gitlabSettingsSchema.parse({
      url: typeof g.url === "string" ? g.url.trim().replace(/\/+$/, "") : next.gitlab.url,
      token: typeof g.token === "string" && g.token.trim() ? g.token.trim() : next.gitlab.token,
      mr: { ...next.gitlab.mr, ...g.mr },
    });
    if (next.gitlab.url && !/^https?:\/\//.test(next.gitlab.url)) throw new HiveError("bad_request", "GitLab URL phải bắt đầu bằng http(s)://");
  }
  if (next.mode === "hub") {
    if (!/^https?:\/\//.test(next.hub.url) || !next.hub.token) {
      throw new HiveError("bad_request", "Chế độ hub cần URL (http/https) và token.");
    }
    try {
      await new HubBackend(next.hub.url, next.hub.token).me("desktop");
    } catch (err) {
      throw new HiveError("bad_request", `Không kết nối được hub: ${toErrorPayload(err).message}`);
    }
  }
  return persist(next);
}

function addProject(p: DesktopProject): DesktopSettings {
  const name = String(p?.name ?? "");
  const repo = path.resolve(String(p?.repo ?? ""));
  if (!PROJECT_NAME.test(name)) throw new HiveError("bad_request", "Project key: chữ thường, số, . _ -");
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new HiveError("bad_request", `Không thấy thư mục ${repo}`);
  if (config.projects.some((x) => x.name === name)) throw new HiveError("conflict", `Đã có dự án ${name}.`);
  return persist({ ...config, projects: [...config.projects, { name, repo }] });
}

// ── agent profiles & runs ────────────────────────────────────────────────────

const agentEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: agentPath() });

function saveProfile(input: AgentProfile, previousId?: string) {
  const profile = agentProfileSchema.parse(input);
  const replacing = previousId ?? profile.id;
  if (previousId && previousId !== profile.id && runner.store.running(previousId)) {
    throw new HiveError("conflict", `Profile ${previousId} đang chạy, không đổi id được.`);
  }
  if (profile.id !== replacing && config.agents.some((a) => a.id === profile.id)) {
    throw new HiveError("conflict", `Đã có profile ${profile.id}.`);
  }
  const exists = config.agents.some((a) => a.id === replacing);
  const agents = exists ? config.agents.map((a) => (a.id === replacing ? profile : a)) : [...config.agents, profile];
  persist({ ...config, agents });
  void runner.tick();
  return runner.profileStatuses();
}

function removeProfile(id: string) {
  if (runner.store.running(id)) throw new HiveError("conflict", `Profile ${id} đang chạy.`);
  persist({ ...config, agents: config.agents.filter((a) => a.id !== id) });
  return runner.profileStatuses();
}

function checkProfile(id: string): Promise<ProfileCheck> {
  const profile = config.agents.find((a) => a.id === id);
  if (!profile) throw new HiveError("not_found", `Không có profile ${id}.`);
  const env = agentEnv();
  const bin = resolveBin(expandHome(profile.bin), env.PATH ?? "");
  if (!bin) return Promise.resolve({ ok: false, path: null, output: `Không tìm thấy "${profile.bin}" trong PATH:\n${env.PATH}` });
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { env: { ...env, ...expandEnv(profile.env) }, timeout: 15_000 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim() || (err ? err.message : "");
      resolve({ ok: !err, path: bin, output });
    });
  });
}

function updateProject(name: string, patch: { gitlabProject?: string | null; targetBranch?: string | null }) {
  const current = project(name);
  const clean = (v: string | null | undefined, keep: string | undefined) =>
    v === undefined ? keep : v === null || !v.trim() ? undefined : v.trim();
  const next = { ...current, gitlabProject: clean(patch?.gitlabProject, current.gitlabProject), targetBranch: clean(patch?.targetBranch, current.targetBranch) };
  return persist({ ...config, projects: config.projects.map((p) => (p.name === name ? next : p)) });
}

async function checkGitLab(): Promise<GitLabCheck> {
  try {
    const user = await new GitLabClient(config.gitlab.url, config.gitlab.token, gitlabFetch).user();
    return { ok: true, user: user.username, message: `Đăng nhập GitLab với tài khoản ${user.name} (@${user.username})` };
  } catch (err) {
    return { ok: false, user: null, message: toErrorPayload(err).message };
  }
}

async function createMergeRequest(runId: string): Promise<AgentRun> {
  const run = runner.store.get(runId);
  if (!run) throw new HiveError("not_found", `Không có run ${runId}.`);
  if (run.status !== "succeeded") throw new HiveError("bad_request", "Chỉ tạo MR từ run đã xong.");
  try {
    return runner.store.update(run.id, await mergeRequester.open(run, { manual: true }));
  } catch (err) {
    runner.store.update(run.id, { mrState: "failed", mrNote: toErrorPayload(err).message });
    throw err;
  }
}

// ── shared data between this machine and the hub ────────────────────────────

/** push: local database → hub (a differing doc becomes a proposal) · pull: hub → local database (a new version). */
async function transferHub(direction: unknown): Promise<TransferReport> {
  if (direction !== "push" && direction !== "pull") throw new HiveError("bad_request", "direction: push | pull");
  if (!config.hub.url || !config.hub.token) throw new HiveError("bad_request", "Chưa có URL và token hub: điền ở Nguồn dữ liệu rồi bấm Lưu.");
  const hub = backend instanceof HubBackend ? backend : new HubBackend(config.hub.url, config.hub.token);
  try {
    await hub.me("hive-transfer");
  } catch (err) {
    throw new HiveError("bad_request", `Không kết nối được hub: ${toErrorPayload(err).message}`);
  }
  const local = backend instanceof SqliteHive ? backend : new SqliteHive(localDbPath(config), { memoryRequiresApproval: config.memoryRequiresApproval });
  try {
    const localSide: TransferSide = { backend: local, actor: { name: `hive-transfer@${os.userInfo().username}`, role: "admin" }, label: `máy ${config.machine}` };
    // The hub decides the role from the token; the name is only the label on what gets written.
    const hubSide: TransferSide = { backend: hub, actor: { name: "hive-transfer", role: "admin" }, label: "hub" };
    return direction === "push" ? await transferHive(localSide, hubSide) : await transferHive(hubSide, localSide, { newVersions: true });
  } finally {
    if (local !== backend) local.close();
  }
}

function knownPath(p: string): boolean {
  return config.projects.some((x) => x.repo === p) || runner.store.list({ limit: 500 }).some((r) => r.worktree === p);
}

function onRunnerEvent(event: RunnerEvent): void {
  if (!Notification.isSupported()) return;
  const r = event.run;
  const title = `${r.taskId} · ${r.profileId ?? ""}`;
  const mr = r.mrUrl ? ` MR !${r.mrIid}${r.mrDraft ? " (draft)" : ""} ${r.mrState === "updated" ? "đã cập nhật" : "đã tạo"}.` : r.mrState === "failed" ? ` Tạo MR lỗi: ${r.mrNote}` : "";
  const body =
    event.type === "rotated"
      ? `${r.profileId} hết quota hoặc không chạy được. Chuyển sang gói khác (lần ${event.next.attempt}).`
      : event.type === "follow-up"
        ? "Xong. Đã xếp lịch review chéo."
        : r.status === "succeeded"
          ? r.role === "review"
            ? "Review xong."
            : `Xong, ${r.commits} commit. Task chuyển sang Chờ review.`
          : `${r.status}: ${r.error ?? ""}`;
  const n = new Notification({ title, body: body + mr });
  n.on("click", () => {
    showWindow();
    win?.webContents.executeJavaScript('location.hash = "#/board"').catch(() => undefined);
  });
  n.show();
}

async function me(): Promise<Me> {
  if (backend instanceof HubBackend) return backend.me("desktop");
  return { ...actor(), mode: "local" };
}

function isTrusted(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? "";
  return devUrl ? url.startsWith(devUrl) : url.startsWith("file://");
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!isTrusted(event)) return { ok: false, error: { code: "forbidden", message: "Untrusted sender" } };
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: toErrorPayload(err) };
    }
  });
}

function registerIpc(): void {
  handle("hive:call", (method: unknown, input: unknown) => {
    if (!isMethod(method)) throw new HiveError("bad_request", `Unknown method ${String(method)}`);
    return backend.call(method, input as never, actor());
  });
  handle("hive:me", me);
  handle("desktop:settings", settings);
  handle("desktop:updateSettings", updateSettings);
  handle("desktop:addProject", addProject);
  handle("desktop:removeProject", (name: string) =>
    persist({ ...config, projects: config.projects.filter((p) => p.name !== name) }),
  );
  handle("desktop:pickFolder", async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  handle("desktop:syncProject", (name: string) => syncProject(backend, actor(), project(name), { autoCommit: config.sync.autoCommit }));
  handle("desktop:installAgents", (name: string) => installAgents(project(name).repo, name));
  handle("desktop:installShim", () => installShim({ electronPath: process.execPath, entry: mcpEntry() }, agentPath()));
  handle("desktop:setupStatus", () => setup.status());
  handle("desktop:installSetup", (id: unknown) => setup.install(String(id)));
  handle("desktop:transferHub", transferHub);
  handle("desktop:showInFolder", async (p: string) => {
    if (!knownPath(p)) throw new HiveError("forbidden", "Chỉ mở được thư mục dự án hoặc worktree của run.");
    await shell.openPath(p);
  });

  handle("desktop:profiles", () => runner.profileStatuses());
  handle("desktop:saveProfile", saveProfile);
  handle("desktop:removeProfile", removeProfile);
  handle("desktop:resetCooldown", async (id: string) => (await runner.resetCooldown(id), runner.profileStatuses()));
  handle("desktop:checkProfile", checkProfile);
  handle("desktop:startRun", (req: StartRunRequest) => runner.enqueue(req));
  handle("desktop:runs", (filter?: { project?: string; limit?: number }) => runner.list(filter));
  handle("desktop:runLog", (id: string) => runner.log(id));
  handle("desktop:runDiff", (id: string) => runner.diff(id));
  handle("desktop:cancelRun", (id: string): AgentRun => runner.cancel(id));
  handle("desktop:removeWorktree", (id: string) => runner.removeWorktree(id));
  handle("desktop:updateProject", updateProject);
  handle("desktop:checkGitLab", checkGitLab);
  handle("desktop:createMergeRequest", createMergeRequest);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: "xDev Hive",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    ...(process.platform === "darwin" ? {} : { icon: appIcon() }),
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!(devUrl && url.startsWith(devUrl))) e.preventDefault();
  });
  win.on("close", (e) => {
    if (!quitting && process.platform === "darwin" && !smokeShot) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.once("ready-to-show", () => {
    if (!smokeShot) win?.show();
  });

  const hash = process.env.HIVE_SMOKE_HASH;
  if (devUrl) void win.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
  else void win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"), hash ? { hash } : undefined);

  if (smokeShot) {
    win.webContents.once("did-finish-load", () => {
      const delay = Number(process.env.HIVE_SMOKE_DELAY_MS ?? 1500);
      setTimeout(async () => {
        const image = await win!.webContents.capturePage();
        writeFileSync(smokeShot, image.toPNG());
        console.log(`[xdev-hive] smoke screenshot ${smokeShot}`);
        app.exit(0);
      }, delay);
    });
  }
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  win!.show();
  win!.focus();
}

let lastPending = 0;
async function refreshTray(): Promise<void> {
  if (!tray) return;
  try {
    const pending = (await backend.call("proposals.list", { status: "pending" }, actor())).length;
    tray.setTitle(pending ? ` ${pending}` : "");
    tray.setToolTip(pending ? `xDev Hive: ${pending} đề xuất chờ duyệt` : "xDev Hive");
    if (pending > lastPending && Notification.isSupported()) {
      const n = new Notification({ title: "xDev Hive", body: `${pending} đề xuất sửa tài liệu đang chờ duyệt` });
      n.on("click", () => {
        showWindow();
        win?.webContents.executeJavaScript('location.hash = "#/proposals"').catch(() => undefined);
      });
      n.show();
    }
    lastPending = pending;
  } catch {
    tray.setToolTip("xDev Hive: không kết nối được nguồn dữ liệu");
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(trayIcon());
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("xDev Hive");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Mở xDev Hive", click: showWindow },
      { label: "Đề xuất chờ duyệt", click: () => (showWindow(), win?.webContents.executeJavaScript('location.hash = "#/proposals"')) },
      { type: "separator" },
      { label: "Thoát", role: "quit" },
    ]),
  );
  void refreshTray();
  setInterval(() => void refreshTray(), 20_000).unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  let stopped = false;
  app.on("before-quit", (e) => {
    quitting = true;
    if (stopped || !runner) return;
    // Stop agents and let the runner commit their work and update Hive before exiting.
    e.preventDefault();
    stopped = true;
    void runner.stop().finally(() => app.quit());
  });
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  void app.whenReady().then(() => {
    try {
      reload();
    } catch (err) {
      dialog.showErrorBox("xDev Hive", `Không dùng được cấu hình ${configPath()}:\n${toErrorPayload(err).message}\n\nTạm chạy chế độ cục bộ.`);
      config = configSchema.parse({});
      backend = resolveBackend(config);
    }
    mergeRequester = new MergeRequester({
      gitlab: () => config.gitlab,
      projects: () => config.projects,
      backend: () => backend,
      mode: () => config.mode,
      store: () => runner.store,
      fetch: gitlabFetch,
      user: os.userInfo().username,
    });
    runner = new Runner(
      {
        backend: () => backend,
        profiles: () => config.agents,
        settings: () => config.runner,
        projects: () => config.projects,
        mode: () => config.mode,
        machine: () => config.machine,
        env: agentEnv,
      },
      {
        dataDir: path.dirname(configPath()),
        version: app.getVersion(),
        onEvent: onRunnerEvent,
        afterFinish: (run) => mergeRequester.afterFinish(run),
      },
    );
    setup = new Setup({
      pathEnv: (refresh) => agentPath(refresh),
      env: agentEnv,
      projects: () => config.projects,
      shim: { electronPath: process.execPath, entry: mcpEntry() },
    });
    runner.start();
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(appIcon());
    registerIpc();
    createWindow();
    if (!smokeShot) createTray();
  });
}

