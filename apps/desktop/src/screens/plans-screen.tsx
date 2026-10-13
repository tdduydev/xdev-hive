import { Menu } from "@base-ui/react/menu";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { ChevronRightIcon, EllipsisIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { type FormEvent, Fragment, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { shortPath, useFolder } from "@/lib/folder.ts";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import {
  addPlan,
  CLI_NAME,
  clock,
  DEFAULTS,
  type Limit,
  LOGIN_WAYS,
  type LoginWay,
  lastChecked,
  machineSummary,
  meterTone,
  openCliTerminal,
  openLoginTerminal,
  type Plan,
  type PlanPatch,
  type PlanState,
  planRows,
  planState,
  plans,
  RANGES,
  type RangeField,
  ROLES,
  type Role,
  readUsage,
  reloginOf,
  removePlan,
  resumePlan,
  setPlanEnabled,
  updatePlan,
} from "@/lib/plans.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

/** Đăng nhập trong Terminal xong thì gói mới chuyển trạng thái: kiểm lại 4 giây một lần, tối đa 5 phút. */
export const LOGIN_POLL_MS = 4000;
export const LOGIN_WAIT_MS = 5 * 60_000;

type Notice = { tone: "ok" | "info" | "bad"; text: string };

const text: Dict<{
  lead: string;
  add: string;
  loading: string;
  empty: string;
  summaryReady: string;
  summaryReadySub: (total: number) => string;
  summaryRunning: string;
  summaryRunningSub: string;
  summarySlots: string;
  summarySlotsSub: (reset: string) => string;
  unknown: string;
  updatedAt: (time: string) => string;
  readAll: string;
  readingAll: string;
  readAllHint: string;
  offGroup: (n: number) => string;
  states: Record<PlanState, string>;
  session: string;
  week: string;
  stopMark: (percent: number) => string;
  resetAt: (time: string) => string;
  resetPast: string;
  why: { signedOut: string; notChecked: string; noReport: string };
  meta: (priority: number, runs: number) => string;
  enable: string;
  disable: string;
  toggleLabel: (on: boolean, label: string) => string;
  rowActions: (label: string) => string;
  edit: string;
  relogin: string;
  openCli: string;
  openCliIn: (folder: string) => string;
  cliOpened: (id: string) => string;
  login: string;
  installCli: string;
  remove: string;
  unsupported: string;
  noCli: string;
  signedOut: string;
  coolingUntil: (time: string) => string;
  overLimit: string;
  resume: string;
  resumeLabel: (label: string) => string;
  resumeHint: string;
  resumed: (id: string) => string;
  resumedUntil: (time: string) => string;
  loginOpened: (id: string) => string;
  loginWaiting: string;
  signedIn: (id: string, email: string) => string;
  loginTimeout: (id: string) => string;
  terminalFailed: (id: string, error: string, command: string) => string;
  removeTitle: string;
  confirmRemove: (id: string) => string;
  keep: string;
  removing: string;
  removed: (id: string) => string;
  cancel: string;
  addTitle: string;
  addLead: string;
  cli: string;
  accountLabel: string;
  accountLabelHint: (example: string) => string;
  loginWay: string;
  ways: Record<LoginWay, string>;
  wayHints: Record<LoginWay, string>;
  email: string;
  addAndSignIn: string;
  adding: string;
  addNote: string;
  editTitle: (id: string) => string;
  editLead: string;
  name: string;
  fields: Record<RangeField, string>;
  roles: string;
  roleNames: Record<Role, string>;
  stopHint: string;
  save: string;
  saving: string;
  needName: string;
  needRole: string;
  range: (field: string, min: number, max: number) => string;
}> = {
  vi: {
    lead: "Mỗi gói là một tài khoản Claude Code hay Codex đăng nhập trên máy này. Worker chia run cho các gói đang bật: gói còn nhiều quota trước, rồi theo ưu tiên; gói chạm ngưỡng dừng hay hết lượt được nghỉ tới giờ reset.",
    add: "Thêm gói",
    loading: "Đang đọc gói…",
    empty: "Chưa có gói nào: worker dùng đăng nhập mặc định của từng CLI. Bấm Thêm gói để đăng nhập thêm tài khoản.",
    summaryReady: "Gói sẵn sàng",
    summaryReadySub: (total) => `trên ${total} gói đang bật`,
    summaryRunning: "Đang chạy",
    summaryRunningSub: "agent trên máy này",
    summarySlots: "Chỗ trống",
    summarySlotsSub: (reset) => `reset sớm nhất: ${reset}`,
    unknown: "Chưa biết",
    updatedAt: (time) => `cập nhật lúc ${time}`,
    readAll: "Đọc lại quota",
    readingAll: "Đang đọc quota…",
    readAllHint: "Kiểm lại đăng nhập và mức dùng của mọi gói đang bật",
    offGroup: (n) => `${n} gói đang tắt`,
    states: {
      running: "Đang chạy",
      ready: "Sẵn sàng",
      disabled: "Tắt",
      noCli: "Chưa có CLI",
      signedOut: "Chưa đăng nhập",
      overLimit: "Chạm ngưỡng",
      cooling: "Đang nghỉ",
      near: "Gần ngưỡng",
    },
    session: "Phiên 5 giờ",
    week: "Tuần",
    stopMark: (percent) => `Ngưỡng dừng ${percent}%`,
    resetAt: (time) => `reset ${time}`,
    resetPast: "đã tới giờ reset, chờ đọc lại",
    why: { signedOut: "chưa đăng nhập", notChecked: "chưa kiểm", noReport: "CLI không báo" },
    meta: (priority, runs) => `ưu tiên ${priority} · tối đa ${runs} run cùng lúc`,
    enable: "Bật",
    disable: "Tắt",
    toggleLabel: (on, label) => `${on ? "Tắt" : "Bật"} gói ${label}`,
    rowActions: (label) => `Thao tác cho ${label}`,
    edit: "Sửa",
    relogin: "Đăng nhập lại",
    openCli: "Mở CLI",
    openCliIn: (folder) => `Mở trong ${folder}`,
    cliOpened: (id) => `Đã mở Terminal chạy CLI của ${id}.`,
    login: "Đăng nhập",
    installCli: "Cài CLI",
    remove: "Xoá",
    unsupported: "Worker chưa chạy CLI này.",
    noCli: "Chưa có CLI trên máy: worker bỏ qua gói này tới khi cài ở màn Môi trường.",
    signedOut: "Chưa đăng nhập CLI: worker bỏ qua gói này. Bấm Đăng nhập để mở Terminal.",
    coolingUntil: (time) => `Đang nghỉ tới ${time}`,
    overLimit: "Chạm ngưỡng dừng: worker không giao run mới cho gói tới lần reset.",
    resume: "Dùng tiếp",
    resumeLabel: (label) => `Dùng tiếp ${label}`,
    resumeHint: "Bỏ giờ nghỉ và tạm bỏ ngưỡng dừng tới lần reset kế tiếp để worker giao run ngay",
    resumed: (id) => `${id} dùng tiếp: worker giao run cho gói ngay khi có việc.`,
    resumedUntil: (time) => `Dùng tiếp, bỏ ngưỡng tới ${time}`,
    loginOpened: (id) => `Đã mở Terminal để đăng nhập ${id}. Đăng nhập xong quay lại app: app tự kiểm lại.`,
    loginWaiting: "Đang chờ đăng nhập xong trong Terminal và trình duyệt; app tự kiểm lại mỗi vài giây.",
    signedIn: (id, email) => `${id} đã đăng nhập${email ? ` ${email}` : ""}.`,
    loginTimeout: (id) => `Sau 5 phút vẫn chưa thấy ${id} đăng nhập. Mở menu ⋯ của gói, chọn Đăng nhập lại để thử lại.`,
    terminalFailed: (id, error, command) =>
      `Đã thêm ${id} nhưng không mở được Terminal: ${error} Chạy trong terminal: ${command}`,
    removeTitle: "Xoá gói",
    confirmRemove: (id) => `Xoá gói ${id}? Lịch sử run vẫn giữ.`,
    keep: "Giữ lại",
    removing: "Đang xoá…",
    removed: (id) => `Đã xoá gói ${id}. Thư mục đăng nhập của CLI vẫn còn trên máy.`,
    cancel: "Huỷ",
    addTitle: "Thêm gói",
    addLead:
      "Đăng nhập thêm một tài khoản của CLI trên máy này, trong thư mục đăng nhập riêng để worker xoay vòng các gói.",
    cli: "CLI",
    accountLabel: "Tên hiển thị",
    accountLabelHint: (example) => `để trống: ${example}`,
    loginWay: "Cách đăng nhập",
    ways: {
      plan: "Gói Claude (Pro, Max, Team)",
      sso: "SSO của công ty",
      console: "Anthropic Console (trả theo API)",
      browser: "Trình duyệt trên máy này",
      device: "Mã thiết bị (đăng nhập ở máy khác)",
    },
    wayHints: {
      plan: "Trang đăng nhập claude.ai mở trên trình duyệt: Google, email, hay SSO đều được.",
      sso: "Đi thẳng luồng SSO của tổ chức (claude auth login --sso). Nhập email công ty để trang biết tổ chức nào.",
      console: "Đăng nhập Anthropic Console, tính tiền theo API (claude auth login --console).",
      browser: "Trang đăng nhập ChatGPT mở trên trình duyệt của máy này (codex login).",
      device:
        "Terminal hiện một mã: mở link trên bất kỳ máy nào, đăng nhập ChatGPT rồi nhập mã (codex login --device-auth).",
    },
    email: "Email (tuỳ chọn)",
    addAndSignIn: "Thêm và đăng nhập",
    adding: "Đang thêm…",
    addNote:
      "App mở Terminal chạy lệnh đăng nhập của CLI. App không thấy mật khẩu hay token: CLI tự giữ đăng nhập trong thư mục của gói.",
    editTitle: (id) => `Sửa ${id}`,
    editLead: "Worker đọc lại cài đặt ở run sau, không cần khởi động lại.",
    name: "Tên",
    fields: {
      priority: "Ưu tiên",
      maxConcurrent: "Song song tối đa",
      cooldownMinutes: "Nghỉ mặc định (phút)",
      timeoutMinutes: "Giới hạn mỗi run (phút)",
      stopAtSession: "Dừng khi phiên đạt (%)",
      stopAtWeek: "Dừng khi tuần đạt (%)",
    },
    roles: "Vai trò",
    roleNames: { plan: "Lập kế hoạch", implement: "Làm task", review: "Review" },
    stopHint:
      "Tới ngưỡng thì worker thôi giao run mới cho gói, để phần còn lại cho bạn dùng tay. 100 = chỉ dừng khi CLI báo hết quota.",
    save: "Lưu",
    saving: "Đang lưu…",
    needName: "Nhập tên của gói.",
    needRole: "Chọn ít nhất một vai trò.",
    range: (field, min, max) => `${field}: nhập số nguyên từ ${min} đến ${max}.`,
  },
  en: {
    lead: "Each plan is a Claude Code or Codex account signed in on this machine. The worker spreads runs over the enabled plans: most quota left first, then priority; a plan at its stop threshold or out of usage rests until the reset.",
    add: "Add plan",
    loading: "Reading plans…",
    empty: "No plans yet: the worker uses each CLI's default sign-in. Press Add plan to sign in another account.",
    summaryReady: "Plans ready",
    summaryReadySub: (total) => `of ${total} enabled plans`,
    summaryRunning: "Running",
    summaryRunningSub: "agents on this machine",
    summarySlots: "Free slots",
    summarySlotsSub: (reset) => `earliest reset: ${reset}`,
    unknown: "Unknown",
    updatedAt: (time) => `updated at ${time}`,
    readAll: "Read quota again",
    readingAll: "Reading quota…",
    readAllHint: "Check sign-in and usage of every enabled plan again",
    offGroup: (n) => `${n} plans off`,
    states: {
      running: "Running",
      ready: "Ready",
      disabled: "Off",
      noCli: "No CLI",
      signedOut: "Signed out",
      overLimit: "At threshold",
      cooling: "Resting",
      near: "Near threshold",
    },
    session: "5-hour session",
    week: "Week",
    stopMark: (percent) => `Stop threshold ${percent}%`,
    resetAt: (time) => `resets ${time}`,
    resetPast: "reset time passed, waiting for a new read",
    why: { signedOut: "not signed in", notChecked: "not checked", noReport: "the CLI does not report it" },
    meta: (priority, runs) => `priority ${priority} · up to ${runs} runs at once`,
    enable: "Enable",
    disable: "Disable",
    toggleLabel: (on, label) => `${on ? "Disable" : "Enable"} plan ${label}`,
    rowActions: (label) => `Actions for ${label}`,
    edit: "Edit",
    relogin: "Sign in again",
    openCli: "Open CLI",
    openCliIn: (folder) => `Opens in ${folder}`,
    cliOpened: (id) => `Opened a terminal running ${id}'s CLI.`,
    login: "Sign in",
    installCli: "Install CLI",
    remove: "Remove",
    unsupported: "The worker does not run this CLI.",
    noCli:
      "The CLI is not on this machine: the worker skips this plan until it is installed on the Environment screen.",
    signedOut: "The CLI is not signed in: the worker skips this plan. Press Sign in to open a terminal.",
    coolingUntil: (time) => `Resting until ${time}`,
    overLimit: "At the stop threshold: the worker gives this plan no new runs until the reset.",
    resume: "Use again",
    resumeLabel: (label) => `Use ${label} again`,
    resumeHint: "Drop the rest and the stop thresholds until the next reset so the worker gives runs right away",
    resumed: (id) => `${id} is back in use: the worker gives it runs as soon as there is work.`,
    resumedUntil: (time) => `In use again, thresholds off until ${time}`,
    loginOpened: (id) =>
      `Opened a terminal to sign in ${id}. Come back to the app when done: it checks again by itself.`,
    loginWaiting: "Waiting for the sign-in in the terminal and browser; the app checks again every few seconds.",
    signedIn: (id, email) => `${id} is signed in${email ? ` as ${email}` : ""}.`,
    loginTimeout: (id) =>
      `${id} is still not signed in after 5 minutes. Open the plan's ⋯ menu and pick Sign in again.`,
    terminalFailed: (id, error, command) =>
      `Added ${id} but could not open a terminal: ${error} Run it in a terminal: ${command}`,
    removeTitle: "Remove plan",
    confirmRemove: (id) => `Remove plan ${id}? Run history is kept.`,
    keep: "Keep",
    removing: "Removing…",
    removed: (id) => `Removed plan ${id}. The CLI's sign-in folder stays on this machine.`,
    cancel: "Cancel",
    addTitle: "Add plan",
    addLead:
      "Sign in one more CLI account on this machine, in a sign-in folder of its own so the worker can rotate plans.",
    cli: "CLI",
    accountLabel: "Display name",
    accountLabelHint: (example) => `leave empty: ${example}`,
    loginWay: "Sign-in method",
    ways: {
      plan: "Claude plan (Pro, Max, Team)",
      sso: "Company SSO",
      console: "Anthropic Console (API billing)",
      browser: "Browser on this machine",
      device: "Device code (sign in on another machine)",
    },
    wayHints: {
      plan: "The claude.ai sign-in page opens in the browser: Google, email or SSO all work.",
      sso: "Goes straight to your organization's SSO (claude auth login --sso). Enter your work email so the page knows the organization.",
      console: "Signs in to the Anthropic Console, billed by API usage (claude auth login --console).",
      browser: "The ChatGPT sign-in page opens in this machine's browser (codex login).",
      device:
        "The terminal shows a code: open the link on any machine, sign in to ChatGPT and enter the code (codex login --device-auth).",
    },
    email: "Email (optional)",
    addAndSignIn: "Add and sign in",
    adding: "Adding…",
    addNote:
      "The app opens a terminal running the CLI's sign-in command. It never sees passwords or tokens: the CLI keeps its sign-in in the plan's folder.",
    editTitle: (id) => `Edit ${id}`,
    editLead: "The worker reads the settings again on its next run; no restart needed.",
    name: "Name",
    fields: {
      priority: "Priority",
      maxConcurrent: "Max parallel runs",
      cooldownMinutes: "Default rest (minutes)",
      timeoutMinutes: "Limit per run (minutes)",
      stopAtSession: "Stop at session (%)",
      stopAtWeek: "Stop at week (%)",
    },
    roles: "Roles",
    roleNames: { plan: "Planning", implement: "Tasks", review: "Review" },
    stopHint:
      "At the threshold the worker stops giving the plan new runs, leaving the rest for your own use. 100 = stop only when the CLI reports no quota left.",
    save: "Save",
    saving: "Saving…",
    needName: "Enter the plan's name.",
    needRole: "Choose at least one role.",
    range: (field, min, max) => `${field}: enter a whole number from ${min} to ${max}.`,
  },
};

type T = (typeof text)["vi"];

const STATE_TONE: Record<PlanState, "neutral" | "ok" | "warn" | "bad" | "sel"> = {
  running: "sel",
  ready: "ok",
  disabled: "neutral",
  noCli: "bad",
  signedOut: "bad",
  overLimit: "warn",
  cooling: "warn",
  near: "warn",
};

const BAR_TONE = { ok: "bg-primary", near: "bg-warning", over: "bg-destructive" } as const;

const name = (p: Plan) => p.label || p.id;
const future = (iso: string | null | undefined, now: number) => !!iso && Date.parse(iso) > now;

/** Giờ của trang, nhích mỗi phút: giờ reset và giờ nghỉ không đổi nhanh hơn thế. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(h);
  }, []);
  return now;
}

/**
 * Màn Gói agent (mục "plans" của AppNav), làm theo trang Gói agent của app v1: dải tóm tắt, danh sách gói với trạng
 * thái và hai thanh quota, thêm gói bằng đăng nhập trong Terminal, sửa, xoá, dùng tiếp.
 */
export function PlansScreen() {
  const t = useT(text);
  const lang = useLang();
  const now = useMinute();
  const [list, setList] = useState<Plan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showOff, setShowOff] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [removing, setRemoving] = useState<Plan | null>(null);
  const [folder] = useFolder();
  // Gói vừa mở đăng nhập từ đây, theo id: lúc bắt đầu chờ.
  const [waiting, setWaiting] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    try {
      setList((await plans()).accounts);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const waitingIds = Object.keys(waiting).sort().join(",");
  useEffect(() => {
    if (!waitingIds) return;
    const h = setInterval(() => {
      plans().then(
        ({ accounts }) => {
          setList(accounts);
          setWaiting((w) => {
            const next = { ...w };
            for (const [id, since] of Object.entries(w)) {
              const p = accounts.find((a) => a.id === id);
              if (p?.loggedIn) {
                setNotice({ tone: "ok", text: t.signedIn(id, p.email ?? "") });
                delete next[id];
              } else if (!p || Date.now() - since > LOGIN_WAIT_MS) {
                if (p) setNotice({ tone: "info", text: t.loginTimeout(id) });
                delete next[id];
              }
            }
            return next;
          });
        },
        () => {},
      );
    }, LOGIN_POLL_MS);
    return () => clearInterval(h);
  }, [waitingIds, t]);

  const waitFor = (id: string) => setWaiting((w) => ({ ...w, [id]: Date.now() }));

  async function act(id: string, run: () => Promise<{ accounts: Plan[] }>, done?: string) {
    setBusy(id);
    try {
      setList((await run()).accounts);
      setError(null);
      if (done) setNotice({ tone: "ok", text: done });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function relogin(p: Plan) {
    const login = reloginOf(p);
    if (!login) return;
    setBusy(p.id);
    try {
      await openLoginTerminal(login.command, login.env);
      setError(null);
      setNotice({ tone: "info", text: t.loginOpened(p.id) });
      waitFor(p.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function openCli(p: Plan) {
    setBusy(p.id);
    try {
      await openCliTerminal(p.id, folder);
      setError(null);
      setNotice({ tone: "info", text: t.cliOpened(p.id) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function readAll() {
    setReading(true);
    try {
      setList((await readUsage()).accounts);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setReading(false);
    }
  }

  const all = list ?? [];
  const summary = machineSummary(all, now);
  const checked = lastChecked(all);
  const { on, off } = planRows(all, now);

  const row = (p: Plan) => (
    <PlanRow
      key={p.id}
      plan={p}
      t={t}
      lang={lang}
      now={now}
      folder={folder}
      busy={busy === p.id || reading}
      waiting={p.id in waiting}
      onToggle={() => void act(p.id, () => setPlanEnabled(p.id, !p.enabled))}
      onEdit={() => setEditing(p)}
      onRelogin={() => void relogin(p)}
      onOpenCli={() => void openCli(p)}
      onRemove={() => setRemoving(p)}
      onResume={() => void act(p.id, () => resumePlan(p.id), t.resumed(p.id))}
    />
  );

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-72 flex-1 text-sm text-muted-foreground">{t.lead}</p>
        <Button size="sm" onClick={() => setAdding(true)}>
          <PlusIcon aria-hidden="true" />
          {t.add}
        </Button>
      </header>

      <section aria-label={t.summaryReady} className="grid grid-cols-1 gap-2.5 min-[760px]:grid-cols-3">
        <SummaryCard
          label={t.summaryReady}
          value={list ? summary.ready : "—"}
          sub={t.summaryReadySub(summary.enabled)}
          warn={summary.enabled > 0 && summary.ready === 0}
        />
        <SummaryCard label={t.summaryRunning} value={list ? summary.running : "—"} sub={t.summaryRunningSub} />
        <SummaryCard
          label={t.summarySlots}
          value={list ? summary.slots : "—"}
          sub={t.summarySlotsSub(
            summary.reset ? `${summary.reset.label} · ${clock(summary.reset.at, now, lang)}` : t.unknown,
          )}
        />
      </section>

      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        {checked && <span className="text-xs text-muted-foreground">{t.updatedAt(clock(checked, now, lang))}</span>}
        <Button
          size="sm"
          variant="outline"
          title={t.readAllHint}
          aria-busy={reading}
          disabled={reading || !all.some((p) => p.enabled)}
          onClick={() => void readAll()}
        >
          <RefreshCwIcon aria-hidden="true" className={cn(reading && "motion-safe:animate-spin")} />
          {reading ? t.readingAll : t.readAll}
        </Button>
      </div>

      {notice && (
        <p
          role="status"
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            notice.tone === "ok" && "bg-success-soft text-success",
            notice.tone === "info" && "bg-muted text-foreground",
            notice.tone === "bad" && "bg-destructive-soft text-destructive",
          )}
        >
          {notice.text}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!list && !error && <p className="text-sm text-muted-foreground">{t.loading}</p>}
      {list?.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}

      {all.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {on.map(row)}
          {off.length > 0 && (
            <li>
              <button
                type="button"
                aria-expanded={showOff}
                onClick={() => setShowOff((v) => !v)}
                className="flex min-h-9 w-full cursor-pointer items-center gap-1 rounded-xl border px-4 text-left text-xs font-medium text-muted-foreground hover:bg-muted"
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cn("size-3.5 transition-transform", showOff && "rotate-90")}
                />
                {t.offGroup(off.length)}
              </button>
            </li>
          )}
          {showOff && off.map(row)}
        </ul>
      )}

      <AddPlanDialog
        open={adding}
        list={all}
        t={t}
        onOpenChange={setAdding}
        onAdded={(id, terminalError, command) => {
          setAdding(false);
          void load();
          waitFor(id);
          setNotice(
            terminalError
              ? { tone: "bad", text: t.terminalFailed(id, terminalError, command) }
              : { tone: "info", text: t.loginOpened(id) },
          );
        }}
      />
      {editing && (
        <EditPlanDialog
          key={editing.id}
          plan={editing}
          t={t}
          onClose={() => setEditing(null)}
          onSaved={(accounts) => {
            setList(accounts);
            setEditing(null);
          }}
        />
      )}
      <RemovePlanDialog
        plan={removing}
        t={t}
        onClose={() => setRemoving(null)}
        onRemoved={(id, accounts) => {
          setList(accounts);
          setRemoving(null);
          setWaiting(({ [id]: _, ...rest }) => rest);
          setNotice({ tone: "ok", text: t.removed(id) });
        }}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: number | string;
  sub: string;
  warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-card-foreground">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-2xl font-semibold tracking-tight", warn && "text-warning")}>{value}</span>
      <span className="truncate text-xs text-muted-foreground">{sub}</span>
    </div>
  );
}

function PlanRow({
  plan: p,
  t,
  lang,
  now,
  folder,
  busy,
  waiting,
  onToggle,
  onEdit,
  onRelogin,
  onOpenCli,
  onRemove,
  onResume,
}: {
  plan: Plan;
  t: T;
  lang: Lang;
  now: number;
  folder: string;
  busy: boolean;
  waiting: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRelogin: () => void;
  onOpenCli: () => void;
  onRemove: () => void;
  onResume: () => void;
}) {
  const state = planState(p, now);
  const relogin = reloginOf(p);
  const cooling = future(p.coolUntil, now);
  const why =
    p.usage?.reason ||
    (p.loggedIn === false ? t.why.signedOut : p.usage?.checkedAt ? t.why.noReport : t.why.notChecked);
  return (
    <li
      data-plan={p.id}
      data-state={state}
      className={cn("rounded-xl border bg-card text-card-foreground", !p.enabled && "opacity-75")}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
        <span className="flex min-w-52 flex-[1.4] flex-col gap-0.5 leading-snug">
          <strong className="truncate text-sm font-semibold">{name(p)}</strong>
          <span className="truncate text-xs text-muted-foreground">
            {CLI_NAME[p.cli] ?? p.cli} · <span className="font-mono">{p.id}</span>
          </span>
          {p.email && <span className="truncate text-xs text-muted-foreground">{p.email}</span>}
          <span className="truncate text-xs text-muted-foreground">
            {t.meta(p.priority, Math.max(p.maxConcurrent, 1))}
          </span>
        </span>
        <Pill tone={STATE_TONE[state]} dot={state === "running"}>
          {t.states[state]}
        </Pill>
        <Meter
          label={t.session}
          plan={name(p)}
          limit={p.usage?.session ?? null}
          stop={p.stopAtSession ?? DEFAULTS.stopAtSession}
          why={why}
          t={t}
          lang={lang}
          now={now}
        />
        <Meter
          label={t.week}
          plan={name(p)}
          limit={p.usage?.week ?? null}
          stop={p.stopAtWeek ?? DEFAULTS.stopAtWeek}
          why={why}
          t={t}
          lang={lang}
          now={now}
        />
        <span className="ml-auto flex items-center justify-end gap-1.5">
          {state === "signedOut" && relogin && (
            <Button size="sm" disabled={busy} onClick={onRelogin}>
              {t.login}
            </Button>
          )}
          {state === "noCli" && p.supported && (
            <Button size="sm" variant="outline" render={<a href="#/setup">{t.installCli}</a>} nativeButton={false} />
          )}
          <Button
            size="sm"
            variant="outline"
            aria-label={t.toggleLabel(p.enabled, name(p))}
            disabled={busy || !p.supported}
            onClick={onToggle}
          >
            {p.enabled ? t.disable : t.enable}
          </Button>
          <RowMenu
            label={t.rowActions(name(p))}
            t={t}
            disabled={busy}
            canRelogin={!!relogin}
            folder={folder}
            onEdit={onEdit}
            onRelogin={onRelogin}
            onOpenCli={onOpenCli}
            onRemove={onRemove}
          />
        </span>
      </div>
      {(cooling ||
        state === "overLimit" ||
        future(p.resumeUntil, now) ||
        !p.supported ||
        state === "noCli" ||
        state === "signedOut" ||
        waiting) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-3 text-xs text-muted-foreground">
          {!p.supported ? (
            <span>{t.unsupported}</span>
          ) : state === "noCli" ? (
            <span className="text-destructive">{t.noCli}</span>
          ) : state === "signedOut" && !waiting ? (
            <span className="text-destructive">{t.signedOut}</span>
          ) : null}
          {waiting && state === "signedOut" && <span>{t.loginWaiting}</span>}
          {(cooling || state === "overLimit") && (
            <span className="flex items-center gap-2">
              {cooling && p.coolUntil ? (
                <Pill tone="warn">{t.coolingUntil(clock(p.coolUntil, now, lang))}</Pill>
              ) : (
                <span className="text-warning">{t.overLimit}</span>
              )}
              <Button
                size="sm"
                variant="outline"
                aria-label={t.resumeLabel(name(p))}
                title={t.resumeHint}
                disabled={busy}
                onClick={onResume}
              >
                {t.resume}
              </Button>
            </span>
          )}
          {p.resumeUntil && future(p.resumeUntil, now) && (
            <span>{t.resumedUntil(clock(p.resumeUntil, now, lang))}</span>
          )}
        </div>
      )}
    </li>
  );
}

function Meter({
  label,
  plan,
  limit,
  stop,
  why,
  t,
  lang,
  now,
}: {
  label: string;
  plan: string;
  limit: Limit | null;
  stop: number;
  why: string;
  t: T;
  lang: Lang;
  now: number;
}) {
  if (!limit) {
    return (
      <span data-usage-unknown={label} className="flex min-w-32 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="text-xs font-medium text-foreground">{t.unknown}</span>
        <span className="truncate">{why}</span>
      </span>
    );
  }
  const pct = Math.max(0, Math.min(100, Math.round(limit.percent)));
  return (
    <span className="flex min-w-32 flex-1 flex-col gap-1.5">
      <span className="flex items-baseline text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="ml-auto font-mono text-xs font-semibold text-foreground">{pct}%</span>
      </span>
      {/* biome-ignore lint/a11y/useSemanticElements: thẻ <meter> không vẽ được vạch ngưỡng dừng bên trong thanh. */}
      <span
        role="meter"
        aria-label={`${label}: ${plan}`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-1.5 rounded-[3px] bg-muted"
      >
        <span
          data-tone={meterTone(pct, stop)}
          className={cn("absolute inset-y-0 left-0 rounded-[3px]", BAR_TONE[meterTone(pct, stop)])}
          style={{ width: `${pct}%` }}
        />
        <span
          data-stop={stop}
          title={t.stopMark(stop)}
          className="absolute -top-[3px] -bottom-[3px] w-0.5 bg-muted-foreground"
          style={{ left: `${Math.min(100, stop)}%` }}
        />
      </span>
      {limit.resetsAt && (
        <span className="truncate text-xs text-muted-foreground">
          {future(limit.resetsAt, now) ? t.resetAt(clock(limit.resetsAt, now, lang)) : t.resetPast}
        </span>
      )}
    </span>
  );
}

const MENU_ITEM =
  "flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50";

function RowMenu({
  label,
  t,
  disabled,
  canRelogin,
  folder,
  onEdit,
  onRelogin,
  onOpenCli,
  onRemove,
}: {
  label: string;
  t: T;
  disabled: boolean;
  canRelogin: boolean;
  folder: string;
  onEdit: () => void;
  onRelogin: () => void;
  onOpenCli: () => void;
  onRemove: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        render={<Button size="icon-sm" variant="ghost" aria-label={label} title={label} />}
      >
        <EllipsisIcon aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup className="min-w-36 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            <Menu.Item className={MENU_ITEM} onClick={onEdit}>
              {t.edit}
            </Menu.Item>
            <Menu.Item className={MENU_ITEM} disabled={!canRelogin} onClick={onRelogin}>
              {t.relogin}
            </Menu.Item>
            <Menu.Item className={cn(MENU_ITEM, "flex-col items-start")} onClick={onOpenCli}>
              {t.openCli}
              {folder && (
                <span title={folder} className="max-w-64 truncate text-xs text-muted-foreground">
                  {t.openCliIn(shortPath(folder))}
                </span>
              )}
            </Menu.Item>
            <Menu.Item
              className={cn(MENU_ITEM, "mt-1 text-destructive data-highlighted:text-destructive")}
              onClick={onRemove}
            >
              {t.remove}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function AddPlanDialog({
  open,
  list,
  t,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  list: Plan[];
  t: T;
  onOpenChange: (open: boolean) => void;
  onAdded: (id: string, terminalError: string | null, command: string) => void;
}) {
  const id = useId();
  const [cli, setCli] = useState<"claude" | "codex">("claude");
  const [label, setLabel] = useState("");
  const [how, setHow] = useState<LoginWay>("plan");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallback = `${CLI_NAME[cli]} ${list.filter((p) => p.cli === cli).length + 1}`;

  useEffect(() => {
    if (!open) return;
    setCli("claude");
    setLabel("");
    setHow("plan");
    setEmail("");
    setError(null);
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const added = await addPlan({ cli, label: label.trim() || fallback, how, email });
      let terminalError: string | null = null;
      try {
        await openLoginTerminal(added.loginCommand, added.env ?? {});
      } catch (err) {
        terminalError = errorText(err);
      }
      onAdded(added.account.id, terminalError, added.loginCommand);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.addTitle}</DialogTitle>
          <DialogDescription>{t.addLead}</DialogDescription>
        </DialogHeader>
        <form id={`${id}-form`} onSubmit={submit} className="grid gap-x-3 gap-y-2.5 sm:grid-cols-[140px_minmax(0,1fr)]">
          <Label htmlFor={`${id}-cli`}>{t.cli}</Label>
          <NativeSelect
            id={`${id}-cli`}
            value={cli}
            onChange={(e) => {
              const next = e.target.value as "claude" | "codex";
              setCli(next);
              setHow(LOGIN_WAYS[next][0] as LoginWay);
            }}
          >
            <NativeSelectOption value="claude">Claude Code</NativeSelectOption>
            <NativeSelectOption value="codex">Codex</NativeSelectOption>
          </NativeSelect>
          <Label htmlFor={`${id}-label`}>{t.accountLabel}</Label>
          <Input
            id={`${id}-label`}
            value={label}
            placeholder={t.accountLabelHint(fallback)}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Label htmlFor={`${id}-how`}>{t.loginWay}</Label>
          <NativeSelect id={`${id}-how`} value={how} onChange={(e) => setHow(e.target.value as LoginWay)}>
            {LOGIN_WAYS[cli].map((w) => (
              <NativeSelectOption key={w} value={w}>
                {t.ways[w]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <span className="text-xs text-muted-foreground sm:col-start-2">{t.wayHints[how]}</span>
          {cli === "claude" && (
            <>
              <Label htmlFor={`${id}-email`}>{t.email}</Label>
              <Input
                id={`${id}-email`}
                type="email"
                value={email}
                placeholder="ten@congty.vn"
                onChange={(e) => setEmail(e.target.value)}
              />
            </>
          )}
        </form>
        <p className="text-xs text-muted-foreground">{t.addNote}</p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={busy}>
            {busy ? t.adding : t.addAndSignIn}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

const FIELDS: readonly RangeField[] = [
  "priority",
  "maxConcurrent",
  "cooldownMinutes",
  "timeoutMinutes",
  "stopAtSession",
  "stopAtWeek",
];

function EditPlanDialog({
  plan: p,
  t,
  onClose,
  onSaved,
}: {
  plan: Plan;
  t: T;
  onClose: () => void;
  onSaved: (accounts: Plan[]) => void;
}) {
  const id = useId();
  const [label, setLabel] = useState(p.label);
  const [values, setValues] = useState<Record<RangeField, string>>({
    priority: String(p.priority),
    maxConcurrent: String(Math.max(1, p.maxConcurrent)),
    cooldownMinutes: String(p.cooldownMinutes),
    timeoutMinutes: String(p.timeoutMinutes ?? DEFAULTS.timeoutMinutes),
    stopAtSession: String(p.stopAtSession ?? DEFAULTS.stopAtSession),
    stopAtWeek: String(p.stopAtWeek ?? DEFAULTS.stopAtWeek),
  });
  const [roles, setRoles] = useState<Role[]>(p.roles ?? [...DEFAULTS.roles]);
  const [errors, setErrors] = useState<Partial<Record<RangeField | "label" | "roles", string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function check(): PlanPatch | null {
    const found: typeof errors = {};
    if (!label.trim()) found.label = t.needName;
    const nums = {} as Record<RangeField, number>;
    for (const f of FIELDS) {
      const [min, max] = RANGES[f];
      const raw = values[f].trim();
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n < min || n > max) found[f] = t.range(t.fields[f], min, max);
      nums[f] = n;
    }
    if (roles.length === 0) found.roles = t.needRole;
    setErrors(found);
    if (Object.keys(found).length > 0) return null;
    return { label: label.trim(), ...nums, roles: ROLES.filter((r) => roles.includes(r)) };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const patch = check();
    if (!patch) return;
    setBusy(true);
    try {
      onSaved((await updatePlan(p.id, patch)).accounts);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.editTitle(p.id)}</DialogTitle>
          <DialogDescription>{t.editLead}</DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          noValidate
          onSubmit={submit}
          className="grid items-center gap-x-3 gap-y-2.5 sm:grid-cols-[180px_minmax(0,1fr)]"
        >
          <Label htmlFor={`${id}-label`}>{t.name}</Label>
          <Input
            id={`${id}-label`}
            value={label}
            aria-invalid={!!errors.label || undefined}
            onChange={(e) => setLabel(e.target.value)}
          />
          {errors.label && <FieldError>{errors.label}</FieldError>}
          {FIELDS.map((f) => (
            <Fragment key={f}>
              <Label htmlFor={`${id}-${f}`}>{t.fields[f]}</Label>
              <Input
                id={`${id}-${f}`}
                type="number"
                inputMode="numeric"
                min={RANGES[f][0]}
                max={RANGES[f][1]}
                className="sm:max-w-32"
                value={values[f]}
                aria-invalid={!!errors[f] || undefined}
                onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
              />
              {errors[f] && <FieldError>{errors[f]}</FieldError>}
            </Fragment>
          ))}
          <span className="text-xs text-muted-foreground sm:col-start-2">{t.stopHint}</span>
          <span className="text-sm leading-none font-medium">{t.roles}</span>
          <span className="flex flex-wrap items-center gap-4">
            {ROLES.map((r) => (
              <label key={r} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  onChange={(e) => setRoles((rs) => (e.target.checked ? [...rs, r] : rs.filter((x) => x !== r)))}
                  className="size-4 cursor-pointer accent-primary"
                />
                {t.roleNames[r]}
              </label>
            ))}
          </span>
          {errors.roles && <FieldError>{errors.roles}</FieldError>}
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t.cancel}
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={busy}>
            {busy ? t.saving : t.save}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  return <span className="text-xs text-destructive sm:col-start-2">{children}</span>;
}

function RemovePlanDialog({
  plan,
  t,
  onClose,
  onRemoved,
}: {
  plan: Plan | null;
  t: T;
  onClose: () => void;
  onRemoved: (id: string, accounts: Plan[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mở hộp thoại cho gói khác thì bỏ lỗi của lần xoá trước.
  useEffect(() => setError(null), [plan]);

  async function confirm() {
    if (!plan) return;
    setBusy(true);
    try {
      onRemoved(plan.id, (await removePlan(plan.id)).accounts);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={plan !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogTitle>{t.removeTitle}</DialogTitle>
        <DialogDescription>{plan ? t.confirmRemove(plan.id) : ""}</DialogDescription>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t.keep}
          </Button>
          <Button variant="destructive-solid" disabled={busy} onClick={() => void confirm()}>
            {busy ? t.removing : t.remove}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
