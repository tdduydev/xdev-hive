import { Button } from "@xdev-hive/ui/button";
import { DownloadIcon, KeyRoundIcon, LogOutIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { SecretsCleanupDialog } from "@/components/secrets-cleanup-dialog.tsx";
import { Toggle } from "@/components/toggle.tsx";
import { UpdateNotes, useRestart } from "@/components/update-banner.tsx";
import { type Account, initials, useConnect, useLinkedAccount, useSignOut } from "@/lib/account.ts";
import { formatBuiltAt, useBuildInfo } from "@/lib/build-info.ts";
import { type Dict, type Lang, setLang, useLang, useT } from "@/lib/i18n.ts";
import { thisMachine } from "@/lib/machine-runs.ts";
import { type AppSettings, appSettings, type SettingKey, setAppSetting } from "@/lib/settings.ts";
import { errorText } from "@/lib/tauri.ts";
import { readTheme, setTheme, type ThemeChoice } from "@/lib/theme.ts";
import { checkUpdatesNow, useReadyUpdate } from "@/lib/update.ts";
import { cn } from "@/lib/utils.ts";
import { useWorkerState } from "@/lib/worker.ts";

type Row = { key: SettingKey; label: string; hint: string };

const text: Dict<{
  ready: (version: string) => string;
  readyHint: string;
  notes: string;
  restart: string;
  restarting: string;
  current: (version: string) => string;
  devBuild: string;
  check: string;
  checking: string;
  upToDate: (version: string) => string;
  account: string;
  hub: string;
  role: string;
  teams: string;
  noTeams: string;
  orgRoles: Record<NonNullable<Account["orgRole"]>, string>;
  teamRoles: Record<Account["teams"][number]["role"], string>;
  signOut: string;
  signOutHint: string;
  change: string;
  local: string;
  connect: string;
  look: string;
  language: string;
  theme: string;
  themes: Record<ThemeChoice, string>;
  machine: string;
  machineName: string;
  build: string;
  notRegistered: string;
  worker: Row[];
  notify: string;
  secrets: string;
  secretsHint: string;
  secretsClean: string;
  notifyRows: Row[];
  settingsFailed: string;
  saveFailed: string;
}> = {
  vi: {
    ready: (v) => `Đã có bản ${v}.`,
    readyHint: "App tải sẵn rồi; mở lại để cập nhật. Worker dừng êm trước để run đang chạy kịp ghi kết quả.",
    notes: "Xem thay đổi",
    restart: "Mở lại để cập nhật",
    restarting: "Đang mở lại…",
    current: (v) => `Đang dùng bản ${v}.`,
    devBuild: "Đang dùng bản dựng tại máy.",
    check: "Kiểm tra bản mới",
    checking: "Đang kiểm…",
    upToDate: (v) => `Đang dùng bản mới nhất (${v}).`,
    account: "Tài khoản Hive",
    hub: "Hub",
    role: "Vai trò",
    teams: "Đội",
    noTeams: "Chưa ở đội nào",
    orgRoles: { owner: "Chủ sở hữu", admin: "Quản trị", member: "Thành viên" },
    teamRoles: { admin: "Quản trị đội", member: "Thành viên", viewer: "Chỉ xem", ba: "BA/PO" },
    signOut: "Đăng xuất khỏi Hive",
    signOutHint: "Máy vẫn đăng ký với hub: worker vẫn nhận việc, gói agent, dự án và công cụ trên máy vẫn dùng được.",
    change: "Đổi hub hoặc đăng nhập lại",
    local:
      "Không đăng nhập vẫn dùng được các mục trên máy: gói agent, dự án, môi trường, skills, token và tài liệu từ code.",
    connect: "Kết nối Hive",
    look: "Ngôn ngữ và giao diện",
    language: "Ngôn ngữ",
    theme: "Giao diện",
    themes: { system: "Theo hệ thống", light: "Sáng", dark: "Tối" },
    machine: "Máy và worker",
    machineName: "Tên máy",
    build: "Bản app",
    notRegistered: "Chưa đăng ký",
    worker: [
      { key: "startWorker", label: "Bật worker khi mở app", hint: "Máy đã đăng ký thì nhận việc ngay khi app chạy." },
      {
        key: "hideOnClose",
        label: "Đóng cửa sổ chỉ ẩn xuống khay",
        hint: "Worker vẫn chạy; thoát hẳn ở menu khay. Tắt thì đóng cửa sổ là thoát app.",
      },
    ],
    notify: "Thông báo Windows",
    secrets: "Bí mật trên máy",
    secretsHint:
      "Giá trị bí mật nằm trong kho của hệ điều hành, không nằm trong file của app. Trước khi xoá dữ liệu app hay gỡ cài app, hãy xoá chúng khỏi kho hoặc ghi lại mục nào còn lại.",
    secretsClean: "Dọn bí mật trước khi gỡ app…",
    notifyRows: [
      { key: "notifyRuns", label: "Run trên máy xong hoặc lỗi", hint: "Bấm vào mở Lượt chạy trong app." },
      {
        key: "notifyApprovals",
        label: "Kế hoạch hoặc PR chờ tôi duyệt",
        hint: "Cả tài liệu chờ duyệt. Bấm vào mở trang duyệt trên web.",
      },
      { key: "notifyQuestions", label: "Agent hoặc Leader hỏi tôi", hint: "Bấm vào mở câu hỏi trên web." },
      { key: "notifyOffline", label: "Worker mất kết nối hub", hint: "Báo khi mất quá 1 phút." },
    ],
    settingsFailed: "Không đọc được cài đặt của app.",
    saveFailed: "Không lưu được cài đặt:",
  },
  en: {
    ready: (v) => `Version ${v} is ready.`,
    readyHint: "It is downloaded; restart to update. The worker stops gracefully first so running tasks save results.",
    notes: "What's new",
    restart: "Restart to update",
    restarting: "Restarting…",
    current: (v) => `Running version ${v}.`,
    devBuild: "Running a local build.",
    check: "Check for updates",
    checking: "Checking…",
    upToDate: (v) => `You're on the latest version (${v}).`,
    account: "Hive account",
    hub: "Hub",
    role: "Role",
    teams: "Teams",
    noTeams: "Not in any team yet",
    orgRoles: { owner: "Owner", admin: "Admin", member: "Member" },
    teamRoles: { admin: "Team admin", member: "Member", viewer: "Viewer", ba: "BA/PO" },
    signOut: "Sign out of Hive",
    signOutHint:
      "The machine stays registered: the worker keeps taking tasks, and agent plans, projects and tools still work.",
    change: "Change hub or sign in again",
    local:
      "Everything on this machine works without signing in: agent plans, projects, environment, skills, tokens and docs from code.",
    connect: "Connect to Hive",
    look: "Language and appearance",
    language: "Language",
    theme: "Appearance",
    themes: { system: "Match system", light: "Light", dark: "Dark" },
    machine: "Machine and worker",
    machineName: "Machine name",
    build: "App build",
    notRegistered: "Not registered",
    worker: [
      {
        key: "startWorker",
        label: "Start the worker when the app opens",
        hint: "A registered machine takes tasks as soon as the app runs.",
      },
      {
        key: "hideOnClose",
        label: "Closing the window hides it to the tray",
        hint: "The worker keeps running; quit from the tray menu. Off: closing the window quits the app.",
      },
    ],
    notify: "Windows notifications",
    secrets: "Secrets on this machine",
    secretsHint:
      "Secret values live in the OS store, not in the app's files. Before clearing the app's data or uninstalling it, delete them from the store or note which entries remain.",
    secretsClean: "Clean up secrets before removing the app…",
    notifyRows: [
      { key: "notifyRuns", label: "A run on this machine finishes or fails", hint: "Click to open Runs in the app." },
      {
        key: "notifyApprovals",
        label: "A plan or PR awaits my review",
        hint: "Documents awaiting review too. Click to open the review page on the web.",
      },
      {
        key: "notifyQuestions",
        label: "An agent or the Leader asks me",
        hint: "Click to open the question on the web.",
      },
      { key: "notifyOffline", label: "The worker loses the hub", hint: "Shown after more than a minute." },
    ],
    settingsFailed: "Could not read the app settings.",
    saveFailed: "Could not save the setting:",
  },
};

/** Tên ngôn ngữ viết bằng chính ngôn ngữ đó, để người không đọc được ngôn ngữ đang chọn vẫn tìm ra. */
const LANG_NAME: Record<Lang, string> = { vi: "Tiếng Việt", en: "English" };

function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
      <h3 id={id} className="border-b px-4 py-3 text-[15px] font-semibold">
        {title}
      </h3>
      <div className="flex flex-col gap-3 px-4 py-3">{children}</div>
    </section>
  );
}

/** Nhóm nút chọn một trong vài giá trị, như ô VI/EN của thiết kế. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: nhóm nút bấm đổi ngay, không phải ô nhập của form như fieldset
    <div role="group" aria-label={label} className="inline-flex shrink-0 rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 cursor-pointer rounded-md px-2.5 text-sm whitespace-nowrap text-muted-foreground",
            o.value === value && "bg-card font-semibold text-foreground shadow-sm",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Fact({ term, children, mono }: { term: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className={cn("min-w-0 truncate", mono && "font-mono")}>{children}</dd>
    </>
  );
}

function SettingRows({
  rows,
  settings,
  busy,
  onChange,
}: {
  rows: Row[];
  settings: AppSettings | null;
  busy: SettingKey | null;
  onChange: (key: SettingKey, value: boolean) => void;
}) {
  return (
    <ul className="flex flex-col divide-y">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
          <span className="flex min-w-0 flex-col">
            <span className="text-sm">{r.label}</span>
            <span className="text-xs text-muted-foreground">{r.hint}</span>
          </span>
          <Toggle
            on={settings?.[r.key] ?? false}
            label={r.label}
            disabled={!settings || busy !== null}
            onChange={(next) => onChange(r.key, next)}
          />
        </li>
      ))}
    </ul>
  );
}

function UpdateCard() {
  const t = useT(text);
  const ready = useReadyUpdate();
  const build = useBuildInfo();
  const { busy, error, restart } = useRestart();
  const [notesOpen, setNotesOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    setNote(null);
    setCheckError(null);
    try {
      const s = await checkUpdatesNow();
      // Có bản mới thì sự kiện "update-ready" đổi thẻ này thành lời mời mở lại; không có thì nói rõ đang mới nhất.
      if (!s.ready) setNote(t.upToDate(s.current));
    } catch (e) {
      setCheckError(errorText(e));
    } finally {
      setChecking(false);
    }
  }

  if (ready)
    return (
      <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border bg-accent px-4 py-3">
        <DownloadIcon aria-hidden="true" className="size-4 shrink-0 text-accent-foreground" />
        <p className="min-w-60 flex-1 text-sm">
          <strong className="font-semibold">{t.ready(ready.version)}</strong> {t.readyHint}
        </p>
        {error && (
          <p role="alert" className="w-full text-xs text-destructive">
            {error}
          </p>
        )}
        {ready.notes && (
          <Button variant="ghost" size="sm" onClick={() => setNotesOpen(true)}>
            {t.notes}
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={() => void restart()}>
          {busy ? t.restarting : t.restart}
        </Button>
        {ready.notes && <UpdateNotes ready={ready} open={notesOpen} onOpenChange={setNotesOpen} />}
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3">
      <p className="min-w-60 flex-1 text-sm text-muted-foreground">
        {note ?? (build.version ? t.current(build.version) : t.devBuild)}
      </p>
      {checkError && (
        <p role="alert" className="w-full text-xs text-destructive">
          {checkError}
        </p>
      )}
      <Button variant="outline" size="sm" disabled={checking} onClick={() => void check()}>
        <RefreshCwIcon aria-hidden="true" className={cn(checking && "animate-spin")} />
        {checking ? t.checking : t.check}
      </Button>
    </div>
  );
}

/** FR-064: app chưa có thao tác "xoá dữ liệu" riêng, nên nút này mở hộp đề nghị xoá bí mật trước khi người dùng gỡ app. */
function SecretsCard() {
  const t = useT(text);
  const [open, setOpen] = useState(false);
  return (
    <Card title={t.secrets}>
      <p className="text-sm text-muted-foreground">{t.secretsHint}</p>
      <Button size="sm" variant="outline" className="self-start" onClick={() => setOpen(true)}>
        <KeyRoundIcon aria-hidden="true" />
        {t.secretsClean}
      </Button>
      <SecretsCleanupDialog open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

function AccountCard({ hub }: { hub: string | null }) {
  const t = useT(text);
  const account = useLinkedAccount();
  const connect = useConnect();
  const signOut = useSignOut();
  if (!account)
    return (
      <Card title={t.account}>
        <p className="text-sm text-muted-foreground">{t.local}</p>
        {connect && (
          <Button size="sm" variant="outline" className="self-start" onClick={connect}>
            {t.connect}
          </Button>
        )}
      </Card>
    );
  return (
    <Card title={t.account}>
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
          {initials(account.name || account.email)}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{account.name || account.email}</span>
          <span className="truncate text-xs text-muted-foreground">{account.email}</span>
        </span>
      </div>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        {hub && (
          <Fact term={t.hub} mono>
            {hub}
          </Fact>
        )}
        <Fact term={t.role}>
          {account.orgRole ? `${t.orgRoles[account.orgRole]} · ${account.orgName}` : account.orgName}
        </Fact>
        <Fact term={t.teams}>
          {account.teams.length
            ? account.teams.map((team) => `${team.name} · ${t.teamRoles[team.role]}`).join(", ")
            : t.noTeams}
        </Fact>
      </dl>
      <div className="flex flex-wrap gap-2">
        {signOut && (
          <Button size="sm" variant="destructive" onClick={signOut}>
            <LogOutIcon aria-hidden="true" />
            {t.signOut}
          </Button>
        )}
        {connect && (
          <Button size="sm" variant="outline" onClick={connect}>
            {t.change}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t.signOutHint}</p>
    </Card>
  );
}

/**
 * Màn Cài đặt ở chân menu: tài khoản Hive, ngôn ngữ và giao diện, bản cập nhật, worker và thông báo Windows. Cài đặt bật/tắt
 * lưu ở Rust (lib/settings.ts) vì Rust cần chúng cả lúc chưa có cửa sổ. "Khởi động cùng Windows" chưa có: cần thêm
 * plugin autostart của Tauri.
 */
export function SettingsScreen() {
  const t = useT(text);
  const lang = useLang();
  const worker = useWorkerState();
  const build = useBuildInfo();
  const [theme, setThemeChoice] = useState<ThemeChoice>(readTheme);
  const [machine, setMachine] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SettingKey | null>(null);

  useEffect(() => {
    appSettings().then(setSettings, (e) => setLoadError(errorText(e)));
    thisMachine().then(setMachine, () => setMachine(null));
  }, []);

  async function change(key: SettingKey, value: boolean) {
    setBusy(key);
    setSaveError(null);
    try {
      setSettings(await setAppSetting(key, value));
    } catch (e) {
      setSaveError(`${t.saveFailed} ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const hub = worker?.hub ? new URL(worker.hub).host : null;
  const built = `${build.version ?? "dev"} · ${build.sha} · ${formatBuiltAt(build.builtAt)}`;

  return (
    <div className="flex flex-col gap-3.5">
      <UpdateCard />
      {(loadError || saveError) && (
        <p role="alert" className="text-sm text-destructive" title={loadError ?? undefined}>
          {saveError ?? t.settingsFailed}
        </p>
      )}
      <div className="grid grid-cols-1 items-start gap-3.5 min-[1000px]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3.5">
          <AccountCard hub={hub} />
          <Card title={t.look}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">{t.language}</span>
              <Segmented
                label={t.language}
                value={lang}
                options={(["vi", "en"] as const).map((v) => ({ value: v, label: LANG_NAME[v] }))}
                onChange={setLang}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">{t.theme}</span>
              <Segmented
                label={t.theme}
                value={theme}
                options={(["system", "light", "dark"] as const).map((v) => ({ value: v, label: t.themes[v] }))}
                onChange={(v) => {
                  setTheme(v);
                  setThemeChoice(v);
                }}
              />
            </div>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-3.5">
          <Card title={t.machine}>
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              <Fact term={t.machineName} mono>
                {machine ?? t.notRegistered}
              </Fact>
              {hub && (
                <Fact term={t.hub} mono>
                  {hub}
                </Fact>
              )}
              <Fact term={t.build} mono>
                {built}
              </Fact>
            </dl>
            <SettingRows rows={t.worker} settings={settings} busy={busy} onChange={(k, v) => void change(k, v)} />
          </Card>
          <SecretsCard />
          <Card title={t.notify}>
            <SettingRows rows={t.notifyRows} settings={settings} busy={busy} onChange={(k, v) => void change(k, v)} />
          </Card>
        </div>
      </div>
    </div>
  );
}
