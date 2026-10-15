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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@xdev-hive/ui/empty";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { Pill } from "@xdev-hive/ui/pill";
import {
  ActivityIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  EllipsisIcon,
  HourglassIcon,
  LockIcon,
  type LucideIcon,
  OctagonAlertIcon,
  PackageXIcon,
  PlusIcon,
  PowerOffIcon,
  RefreshCwIcon,
  ScanSearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { ClaudeDesktopPanel, ClaudeDesktopRow, useClaudeDesktop } from "@/components/claude-desktop.tsx";
import { shortPath, useFolder } from "@/lib/folder.ts";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import {
  ADDABLE_CLIS,
  type AddableCli,
  addFoundPlan,
  addPlan,
  CLI_NAME,
  cliBlocks,
  cliSummary,
  clock,
  DEFAULTS,
  discoverPlans,
  type FoundLogin,
  type GroupLimit,
  type Limit,
  LOGIN_WAYS,
  type LoginWay,
  lastChecked,
  type ModelLimit,
  machineSummary,
  meterTone,
  openCliTerminal,
  openLoginTerminal,
  type Plan,
  type PlanPatch,
  type PlanState,
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
  type Spread,
  sameAccount,
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
  addFor: (cli: string) => string;
  loading: string;
  emptyTitle: string;
  empty: string;
  machine: string;
  summaryReady: string;
  summaryReadySub: (total: number) => string;
  summaryRunning: string;
  summaryRunningSub: string;
  summarySlots: string;
  summarySlotsSub: (reset: string) => string;
  cliCount: (n: number) => string;
  sessionLeft: string;
  weekLeft: string;
  spread: (lowest: number, average: number) => string;
  earliestReset: (time: string) => string;
  unknown: string;
  updatedAt: (time: string) => string;
  readAll: string;
  readingAll: string;
  readDone: (n: number) => string;
  readAllHint: string;
  offGroup: (n: number) => string;
  states: Record<PlanState, string>;
  session: string;
  sessionShort: string;
  week: string;
  byModel: string;
  byGroup: (n: number) => string;
  weekOf: (model: string) => string;
  groupDisabled: string;
  stopMark: (percent: number) => string;
  resetAt: (time: string) => string;
  resetPast: string;
  why: { signedOut: string; notChecked: string; noReport: string };
  meta: (priority: number, active: number, max: number) => string;
  enable: string;
  disable: string;
  toggleLabel: (on: boolean, label: string) => string;
  rowActions: (label: string) => string;
  edit: string;
  relogin: string;
  openCli: string;
  openCliIn: (folder: string) => string;
  openCliBypass: string;
  bypassTitle: string;
  bypassBody: (plan: string, flag: string) => string;
  bypassOpen: string;
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
  sameAccount: (ids: string) => string;
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
  foundTitle: (n: number) => string;
  foundSub: string;
  foundReview: string;
  foundHide: string;
  foundLead: string;
  foundDefault: (cli: string) => string;
  foundSignedOut: string;
  foundAdd: (n: number) => string;
  foundAdding: string;
  foundAdded: (n: number) => string;
  addTitle: string;
  addStep: (step: number) => string;
  addPickCli: string;
  addCliHints: Record<AddableCli, string>;
  addAntigravityHint: string;
  agyTitle: string;
  agySteps: readonly string[];
  agyLimit: string;
  agyFind: string;
  agyNone: string;
  agyFindFailed: (error: string) => string;
  addChangeCli: string;
  addLead: string;
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
    lead: "Mỗi gói là một tài khoản Claude Code, Codex hay Antigravity đăng nhập trên máy này. Worker chia run cho các gói đang bật: gói còn nhiều quota trước, rồi theo ưu tiên; gói chạm ngưỡng dừng hay hết lượt được nghỉ tới giờ reset.",
    add: "Thêm gói",
    addFor: (cli) => `Thêm gói ${cli}`,
    loading: "Đang đọc gói…",
    emptyTitle: "Chưa có gói nào",
    empty:
      "Worker đang dùng đăng nhập mặc định của từng CLI. Thêm gói để đăng nhập thêm tài khoản cho worker xoay vòng.",
    machine: "Cả máy",
    summaryReady: "Gói sẵn sàng",
    summaryReadySub: (total) => `trên ${total} gói đang bật`,
    summaryRunning: "Đang chạy",
    summaryRunningSub: "agent trên máy này",
    summarySlots: "Chỗ trống",
    summarySlotsSub: (reset) => `reset sớm nhất: ${reset}`,
    cliCount: (n) => `${n} gói`,
    sessionLeft: "Phiên còn",
    weekLeft: "Tuần còn",
    spread: (lowest, average) => `thấp nhất ${lowest}% · TB ${average}%`,
    earliestReset: (time) => `reset sớm nhất ${time}`,
    unknown: "Chưa biết",
    updatedAt: (time) => `cập nhật lúc ${time}`,
    readAll: "Đọc lại quota",
    readingAll: "Đang đọc quota…",
    readDone: (n) => `Đã đọc lại quota của ${n} gói.`,
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
    sessionShort: "5 giờ",
    week: "Tuần",
    byModel: "Tuần theo model",
    byGroup: (n) => `${n} nhóm model`,
    weekOf: (model) => `Tuần ${model}`,
    groupDisabled: "Phiên 5 giờ của nhóm này đang tắt",
    stopMark: (percent) => `Ngưỡng dừng ${percent}%`,
    resetAt: (time) => `reset ${time}`,
    resetPast: "đã tới giờ reset, chờ đọc lại",
    why: { signedOut: "chưa đăng nhập", notChecked: "chưa kiểm", noReport: "CLI không báo" },
    meta: (priority, active, max) => `ưu tiên ${priority} · ${active}/${max} run`,
    enable: "Bật",
    disable: "Tắt",
    toggleLabel: (on, label) => `${on ? "Tắt" : "Bật"} gói ${label}`,
    rowActions: (label) => `Thao tác cho ${label}`,
    edit: "Sửa",
    relogin: "Đăng nhập lại",
    openCli: "Mở CLI",
    openCliIn: (folder) => `Mở trong ${folder}`,
    openCliBypass: "Mở CLI (bỏ hỏi quyền)",
    bypassTitle: "Mở CLI không hỏi quyền?",
    bypassBody: (plan, flag) =>
      `CLI của gói ${plan} sẽ chạy với ${flag}: tự chạy lệnh, sửa và xoá file trong thư mục mà không hỏi lại. Chỉ dùng trong repo bạn tin, có commit sẵn để quay lại được.`,
    bypassOpen: "Mở, bỏ hỏi quyền",
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
    sameAccount: (ids) => `Gói này trùng tài khoản với ${ids}: các gói dùng chung một quota.`,
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
    foundTitle: (n) => `Tìm thấy ${n} đăng nhập chưa thêm`,
    foundSub: "trên máy này, ngoài danh sách gói.",
    foundReview: "Xem và thêm",
    foundHide: "Ẩn",
    foundLead:
      "Tích những đăng nhập muốn thêm vào danh sách gói. App chỉ ghi đường dẫn thư mục đăng nhập, không đọc token.",
    foundDefault: (cli) => `Đăng nhập mặc định của ${cli}`,
    foundSignedOut: "Chưa đăng nhập",
    foundAdd: (n) => `Thêm ${n} gói`,
    foundAdding: "Đang thêm…",
    foundAdded: (n) => `Đã thêm ${n} gói từ đăng nhập có sẵn trên máy.`,
    addTitle: "Thêm gói",
    addStep: (step) =>
      step === 1
        ? "Bước 1/2: chọn CLI."
        : "Bước 2/2: chọn cách đăng nhập. App mở Terminal chạy lệnh đăng nhập rồi tự chờ bạn đăng nhập xong.",
    addPickCli: "CLI",
    addCliHints: {
      claude: "Gói Pro, Max, Team, SSO hay Console",
      codex: "Đăng nhập bằng ChatGPT",
    },
    addAntigravityHint: "Đăng nhập trong ứng dụng Antigravity, rồi tìm trên máy",
    agyTitle: "Thêm gói Antigravity",
    agySteps: [
      "Mở ứng dụng Antigravity và đăng nhập tài khoản muốn dùng.",
      "Quay lại đây, bấm “Tìm đăng nhập trên máy”.",
      "Tích đăng nhập Antigravity vừa thấy rồi bấm Thêm.",
    ],
    agyLimit:
      "Antigravity không tách tài khoản theo thư mục: đăng nhập nằm trong keychain của máy, nên mỗi máy chỉ có một gói Antigravity. Muốn đổi tài khoản thì đăng nhập lại trong ứng dụng Antigravity.",
    agyFind: "Tìm đăng nhập trên máy",
    agyNone:
      "Chưa thấy đăng nhập Antigravity nào chưa thêm. Hãy đăng nhập trong ứng dụng Antigravity rồi tìm lại; nếu máy đã có gói Antigravity thì không thêm được gói thứ hai.",
    agyFindFailed: (error) => `Không tìm được đăng nhập trên máy: ${error}`,
    addChangeCli: "Đổi CLI",
    addLead:
      "Đăng nhập thêm một tài khoản của CLI trên máy này, trong thư mục đăng nhập riêng để worker xoay vòng các gói.",
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
    lead: "Each plan is a Claude Code, Codex or Antigravity account signed in on this machine. The worker spreads runs over the enabled plans: most quota left first, then priority; a plan at its stop threshold or out of usage rests until the reset.",
    add: "Add plan",
    addFor: (cli) => `Add ${cli} plan`,
    loading: "Reading plans…",
    emptyTitle: "No plans yet",
    empty:
      "The worker uses each CLI's default sign-in. Add a plan to sign in another account for the worker to rotate.",
    machine: "Whole machine",
    summaryReady: "Plans ready",
    summaryReadySub: (total) => `of ${total} enabled plans`,
    summaryRunning: "Running",
    summaryRunningSub: "agents on this machine",
    summarySlots: "Free slots",
    summarySlotsSub: (reset) => `earliest reset: ${reset}`,
    cliCount: (n) => `${n} ${n === 1 ? "plan" : "plans"}`,
    sessionLeft: "Session left",
    weekLeft: "Week left",
    spread: (lowest, average) => `lowest ${lowest}% · avg ${average}%`,
    earliestReset: (time) => `earliest reset ${time}`,
    unknown: "Unknown",
    updatedAt: (time) => `updated at ${time}`,
    readAll: "Read quota again",
    readingAll: "Reading quota…",
    readDone: (n) => `Read the quota of ${n} ${n === 1 ? "plan" : "plans"} again.`,
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
    sessionShort: "5 h",
    week: "Week",
    byModel: "Week by model",
    byGroup: (n) => `${n} model groups`,
    weekOf: (model) => `Week ${model}`,
    groupDisabled: "The 5-hour session of this group is off",
    stopMark: (percent) => `Stop threshold ${percent}%`,
    resetAt: (time) => `resets ${time}`,
    resetPast: "reset time passed, waiting for a new read",
    why: { signedOut: "not signed in", notChecked: "not checked", noReport: "the CLI does not report it" },
    meta: (priority, active, max) => `priority ${priority} · ${active}/${max} runs`,
    enable: "Enable",
    disable: "Disable",
    toggleLabel: (on, label) => `${on ? "Disable" : "Enable"} plan ${label}`,
    rowActions: (label) => `Actions for ${label}`,
    edit: "Edit",
    relogin: "Sign in again",
    openCli: "Open CLI",
    openCliIn: (folder) => `Opens in ${folder}`,
    openCliBypass: "Open CLI (skip permission prompts)",
    bypassTitle: "Open the CLI without permission prompts?",
    bypassBody: (plan, flag) =>
      `The CLI of ${plan} runs with ${flag}: it runs commands and edits or deletes files in the folder without asking. Use it only in a repository you trust, with work committed so you can go back.`,
    bypassOpen: "Open without prompts",
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
    sameAccount: (ids) => `This plan uses the same account as ${ids}: they share one quota.`,
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
    foundTitle: (n) => `Found ${n} sign-in${n === 1 ? "" : "s"} not added yet`,
    foundSub: "on this machine, outside the plan list.",
    foundReview: "Review and add",
    foundHide: "Hide",
    foundLead:
      "Tick the sign-ins to add to the plan list. The app only records the sign-in folder path and never reads tokens.",
    foundDefault: (cli) => `Default ${cli} sign-in`,
    foundSignedOut: "Not signed in",
    foundAdd: (n) => `Add ${n} ${n === 1 ? "plan" : "plans"}`,
    foundAdding: "Adding…",
    foundAdded: (n) => `Added ${n} ${n === 1 ? "plan" : "plans"} from sign-ins already on this machine.`,
    addTitle: "Add plan",
    addStep: (step) =>
      step === 1
        ? "Step 1 of 2: pick the CLI."
        : "Step 2 of 2: pick how to sign in. The app opens a terminal with the sign-in command and waits until you finish.",
    addPickCli: "CLI",
    addCliHints: {
      claude: "Pro, Max, Team, SSO or Console plan",
      codex: "Sign in with ChatGPT",
    },
    addAntigravityHint: "Sign in inside the Antigravity app, then scan this machine",
    agyTitle: "Add Antigravity plan",
    agySteps: [
      "Open the Antigravity app and sign in with the account you want to use.",
      "Come back here and press “Find sign-ins on this machine”.",
      "Tick the Antigravity sign-in that shows up and press Add.",
    ],
    agyLimit:
      "Antigravity does not split accounts by folder: its sign-in lives in the machine's keychain, so each machine has one Antigravity plan. To switch accounts, sign in again inside the Antigravity app.",
    agyFind: "Find sign-ins on this machine",
    agyNone:
      "No Antigravity sign-in that is not added yet. Sign in inside the Antigravity app and search again; if this machine already has an Antigravity plan, a second one cannot be added.",
    agyFindFailed: (error) => `Could not search this machine: ${error}`,
    addChangeCli: "Change CLI",
    addLead:
      "Sign in one more CLI account on this machine, in a sign-in folder of its own so the worker can rotate plans.",
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

/** Trạng thái đi kèm ký hiệu để không chỉ phân biệt bằng màu. */
const STATE_ICON: Record<PlanState, LucideIcon> = {
  running: ActivityIcon,
  ready: CircleCheckIcon,
  disabled: PowerOffIcon,
  noCli: PackageXIcon,
  signedOut: LockIcon,
  overLimit: OctagonAlertIcon,
  cooling: HourglassIcon,
  near: TriangleAlertIcon,
};

const BAR_TONE = { ok: "bg-primary", near: "bg-warning", over: "bg-destructive" } as const;

/** Cờ bỏ hỏi quyền Rust thêm khi mở CLI (profiles.rs bypass_flag); chỉ để hiện trong hộp xác nhận. */
const BYPASS_FLAG: Record<string, string> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  antigravity: "--dangerously-skip-permissions",
};

/** Chữ cái làm logo của CLI: app không có logo thương hiệu của các CLI. */
const CLI_MARK: Record<string, string> = { claude: "C", codex: "O", antigravity: "A" };

/** Lưới thẻ gọn: 1 cột khi hẹp, 2 cột từ 560px, 3 cột từ 820px (cửa sổ app thường rộng ~1100px, vùng nội dung ~860px). */
const CARD_GRID =
  "m-0 grid list-none grid-cols-1 items-start gap-2 p-0 min-[560px]:grid-cols-2 min-[820px]:grid-cols-3 [&>li]:min-w-0";

const name = (p: Plan) => p.label || p.id;
const cliName = (cli: string) => CLI_NAME[cli] ?? cli;
const future = (iso: string | null | undefined, now: number) => !!iso && Date.parse(iso) > now;
const pctOf = (limit: Limit) => Math.max(0, Math.min(100, Math.round(limit.percent)));
const foundKey = (f: FoundLogin) => `${f.cli}|${f.configDir ?? ""}`;
const isAddable = (cli: string): cli is AddableCli => (ADDABLE_CLIS as readonly string[]).includes(cli);
/** Hộp Thêm gói còn có thẻ Antigravity: không có form đăng nhập, chỉ hướng dẫn rồi tìm trên máy. */
type AddDialogCli = AddableCli | "antigravity";

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
 * Màn Gói agent (mục "plans" của AppNav; thiết kế AppPlans.dc.html): ô "Cả máy" ở đầu, rồi mỗi CLI một khối với lưới
 * thẻ gói. Thêm gói bằng đăng nhập trong Terminal, tìm đăng nhập có sẵn trên máy, sửa, xoá, dùng tiếp.
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
  const [showOff, setShowOff] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState<{ cli: AddDialogCli | null } | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [removing, setRemoving] = useState<Plan | null>(null);
  const [bypassing, setBypassing] = useState<Plan | null>(null);
  const [found, setFound] = useState<FoundLogin[]>([]);
  const [foundOpen, setFoundOpen] = useState(false);
  const [foundHidden, setFoundHidden] = useState(false);
  const [folder] = useFolder();
  const desktop = useClaudeDesktop();
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

  // Không chặn màn: worker cũ chưa có `accounts discover` thì lỗi, và băng tìm gói không hiện.
  const discover = useCallback(async () => {
    try {
      setFound((await discoverPlans()).found ?? []);
    } catch {
      setFound([]);
    }
  }, []);
  useEffect(() => {
    void discover();
  }, [discover]);

  // Nút của hướng dẫn Antigravity: tìm lại ngay rồi mở hộp liệt kê; không thấy thì nói rõ vì sao, khác băng im lặng.
  async function findLogins() {
    setAdding(null);
    try {
      const { found: list } = await discoverPlans();
      setFound(list ?? []);
      if (list?.some((f) => f.cli === "antigravity")) {
        setFoundHidden(false);
        setFoundOpen(true);
      } else {
        setNotice({ tone: "info", text: t.agyNone });
      }
    } catch (e) {
      setNotice({ tone: "bad", text: t.agyFindFailed(errorText(e)) });
    }
  }

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

  async function openCli(p: Plan, bypass = false) {
    setBusy(p.id);
    try {
      await openCliTerminal(p.id, folder, bypass);
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
    setNotice(null);
    try {
      const { accounts } = await readUsage();
      setList(accounts);
      setError(null);
      setNotice({ tone: "ok", text: t.readDone(accounts.length) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setReading(false);
    }
  }

  const all = list ?? [];
  const summary = machineSummary(all, now);
  const checked = lastChecked(all);
  const blocks = cliBlocks(all, now);
  const perCli = cliSummary(all, now);
  const twins = sameAccount(all);

  // Chỉ macOS (Rust báo supported); gói Claude mới thêm chưa có trong lần đọc trước thì chờ lượt đọc kế tiếp.
  const desktopRow = (p: Plan) => {
    const view = desktop.view;
    const profile = view?.supported ? view.profiles.find((d) => d.id === p.id) : undefined;
    if (!view || !profile) return null;
    return <ClaudeDesktopRow plan={name(p)} profile={profile} view={view} onChanged={() => void desktop.reload()} />;
  };

  const card = (p: Plan) => (
    <PlanCard
      key={p.id}
      plan={p}
      t={t}
      lang={lang}
      now={now}
      folder={folder}
      busy={busy === p.id || reading}
      waiting={p.id in waiting}
      twins={twins[p.id]}
      onToggle={() => void act(p.id, () => setPlanEnabled(p.id, !p.enabled))}
      onEdit={() => setEditing(p)}
      onRelogin={() => void relogin(p)}
      onOpenCli={() => void openCli(p)}
      onOpenCliBypass={() => setBypassing(p)}
      onRemove={() => setRemoving(p)}
      onResume={() => void act(p.id, () => resumePlan(p.id), t.resumed(p.id))}
      desktop={desktopRow(p)}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-72 flex-1 text-sm text-muted-foreground">{t.lead}</p>
        <Button size="sm" onClick={() => setAdding({ cli: null })}>
          <PlusIcon aria-hidden="true" />
          {t.add}
        </Button>
      </header>

      <section
        aria-label={t.machine}
        style={{ "--cols": perCli.length + 1 } as CSSProperties}
        className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border min-[560px]:grid-cols-2 min-[820px]:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]"
      >
        <div className="flex flex-col gap-1 bg-card px-3 py-2 text-card-foreground">
          <span className="text-sm font-medium text-muted-foreground">{t.machine}</span>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <Stat
              label={t.summaryReady}
              value={list ? summary.ready : "—"}
              warn={summary.enabled > 0 && summary.ready === 0}
            />
            <Stat label={t.summaryRunning} value={list ? summary.running : "—"} />
            <Stat label={t.summarySlots} value={list ? summary.slots : "—"} />
          </div>
          <span className="text-xs text-muted-foreground">
            {t.summaryReadySub(summary.enabled)} ·{" "}
            {t.summarySlotsSub(
              summary.reset ? `${summary.reset.label} · ${clock(summary.reset.at, now, lang)}` : t.unknown,
            )}
          </span>
        </div>
        {perCli.map((c) => (
          <div
            key={c.cli}
            data-cli-summary={c.cli}
            className="flex flex-col gap-0.5 bg-card px-3 py-2 text-card-foreground"
          >
            <span className="flex items-center gap-2">
              <CliMark cli={c.cli} />
              <strong className="text-sm font-semibold">{cliName(c.cli)}</strong>
              <span className="text-xs text-muted-foreground">{t.cliCount(c.plans)}</span>
            </span>
            <SpreadLine label={t.sessionLeft} spread={c.session} t={t} />
            <SpreadLine label={t.weekLeft} spread={c.week} t={t} />
            <span className="text-xs text-muted-foreground">
              {c.reset ? t.earliestReset(clock(c.reset.at, now, lang)) : ""}
            </span>
          </div>
        ))}
      </section>

      {found.length > 0 && !foundHidden && (
        <section
          aria-label={t.foundTitle(found.length)}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-accent px-4 py-2.5 text-sm text-accent-foreground"
        >
          <ScanSearchIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-56 flex-1">
            <strong className="font-semibold">{t.foundTitle(found.length)}</strong> {t.foundSub}
          </span>
          <Button size="sm" onClick={() => setFoundOpen(true)}>
            {t.foundReview}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFoundHidden(true)}>
            {t.foundHide}
          </Button>
        </section>
      )}

      {desktop.view && <ClaudeDesktopPanel view={desktop.view} onChanged={() => void desktop.reload()} />}

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
      {list?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>{t.emptyTitle}</EmptyTitle>
            <EmptyDescription>{t.empty}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row flex-wrap justify-center">
            {ADDABLE_CLIS.map((cli) => (
              <Button key={cli} size="sm" variant="outline" onClick={() => setAdding({ cli })}>
                <PlusIcon aria-hidden="true" />
                {t.addFor(cliName(cli))}
              </Button>
            ))}
          </EmptyContent>
        </Empty>
      )}

      {blocks.map(({ cli, on, off }) => (
        <section key={cli} data-cli={cli} aria-label={cliName(cli)} className="flex flex-col gap-3">
          <header className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <CliMark cli={cli} large />
            <h2 className="text-base font-semibold">{cliName(cli)}</h2>
            <Pill>{t.cliCount(on.length + off.length)}</Pill>
            <span className="flex-1" />
            {(isAddable(cli) || cli === "antigravity") && (
              <Button size="sm" variant="outline" onClick={() => setAdding({ cli })}>
                <PlusIcon aria-hidden="true" />
                {t.addFor(cliName(cli))}
              </Button>
            )}
          </header>
          {on.length > 0 && <ul className={CARD_GRID}>{on.map(card)}</ul>}
          {off.length > 0 && (
            <button
              type="button"
              aria-expanded={!!showOff[cli]}
              onClick={() => setShowOff((v) => ({ ...v, [cli]: !v[cli] }))}
              className="flex min-h-9 w-full cursor-pointer items-center gap-1 rounded-xl border px-4 text-left text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              <ChevronRightIcon
                aria-hidden="true"
                className={cn("size-3.5 transition-transform", showOff[cli] && "rotate-90")}
              />
              {t.offGroup(off.length)}
            </button>
          )}
          {showOff[cli] && <ul className={CARD_GRID}>{off.map(card)}</ul>}
        </section>
      ))}

      <AddPlanDialog
        open={adding !== null}
        initialCli={adding?.cli ?? null}
        list={all}
        t={t}
        onOpenChange={(o) => !o && setAdding(null)}
        onFindLogins={() => void findLogins()}
        onAdded={(id, terminalError, command) => {
          setAdding(null);
          void load();
          waitFor(id);
          setNotice(
            terminalError
              ? { tone: "bad", text: t.terminalFailed(id, terminalError, command) }
              : { tone: "info", text: t.loginOpened(id) },
          );
        }}
      />
      {foundOpen && (
        <FoundDialog
          found={found}
          t={t}
          onClose={() => setFoundOpen(false)}
          onChanged={(accounts) => {
            setList(accounts);
            void discover();
          }}
          onDone={(count) => {
            setFoundOpen(false);
            setNotice({ tone: "ok", text: t.foundAdded(count) });
          }}
        />
      )}
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
      <BypassDialog
        plan={bypassing}
        t={t}
        onClose={() => setBypassing(null)}
        onOpen={(p) => {
          setBypassing(null);
          void openCli(p, true);
        }}
      />
      <RemovePlanDialog
        plan={removing}
        t={t}
        onClose={() => setRemoving(null)}
        onRemoved={(id, accounts) => {
          setList(accounts);
          setRemoving(null);
          setWaiting(({ [id]: _, ...rest }) => rest);
          setNotice({ tone: "ok", text: t.removed(id) });
          void discover();
        }}
      />
    </div>
  );
}

function CliMark({ cli, large }: { cli: string; large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md bg-accent font-semibold text-accent-foreground",
        large ? "size-7 text-sm" : "size-5.5 text-xs",
      )}
    >
      {CLI_MARK[cli] ?? cliName(cli).slice(0, 1).toUpperCase()}
    </span>
  );
}

function Stat({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={cn("font-mono text-2xl font-semibold tracking-tight", warn && "text-warning")}>{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </span>
  );
}

function SpreadLine({ label, spread, t }: { label: string; spread: Spread | null; t: T }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>{" "}
      <span className="font-medium">{spread ? t.spread(spread.lowest, spread.average) : t.unknown}</span>
    </span>
  );
}

function PlanCard({
  plan: p,
  t,
  lang,
  now,
  folder,
  busy,
  waiting,
  twins,
  onToggle,
  onEdit,
  onRelogin,
  onOpenCli,
  onOpenCliBypass,
  onRemove,
  onResume,
  desktop,
}: {
  plan: Plan;
  t: T;
  lang: Lang;
  now: number;
  folder: string;
  busy: boolean;
  waiting: boolean;
  /** Gói khác cùng tài khoản (sameAccount). */
  twins?: string[] | undefined;
  onToggle: () => void;
  onEdit: () => void;
  onRelogin: () => void;
  onOpenCli: () => void;
  onOpenCliBypass: () => void;
  onRemove: () => void;
  onResume: () => void;
  /** Dòng Claude Desktop của gói Claude (components/claude-desktop.tsx). */
  desktop?: ReactNode;
}) {
  const state = planState(p, now);
  const StateIcon = STATE_ICON[state];
  const relogin = reloginOf(p);
  const cooling = future(p.coolUntil, now);
  const session = p.usage?.session ?? null;
  const week = p.usage?.week ?? null;
  const why =
    p.usage?.reason ||
    (p.loggedIn === false ? t.why.signedOut : p.usage?.checkedAt ? t.why.noReport : t.why.notChecked);
  const models = p.usage?.models ?? [];
  const groups = p.usage?.groups ?? [];
  const resumable = cooling || state === "overLimit";
  const notes =
    resumable ||
    future(p.resumeUntil, now) ||
    !p.supported ||
    state === "noCli" ||
    state === "signedOut" ||
    waiting ||
    !!twins?.length;
  return (
    <li
      data-plan={p.id}
      data-state={state}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 text-card-foreground",
        !p.enabled && "opacity-75",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <strong className="truncate text-sm font-semibold" title={name(p)}>
            {name(p)}
          </strong>
          <span className="truncate text-xs text-muted-foreground" title={p.email ?? p.id}>
            {p.email && (
              <>
                <span>{p.email}</span>
                {" · "}
              </>
            )}
            <span className="font-mono">{p.id}</span>
          </span>
        </span>
        <Pill tone={STATE_TONE[state]}>
          <StateIcon aria-hidden="true" className="size-3.5" />
          {t.states[state]}
        </Pill>
        <RowMenu
          label={t.rowActions(name(p))}
          t={t}
          disabled={busy}
          enabled={p.enabled}
          supported={p.supported}
          canRelogin={!!relogin}
          canResume={resumable}
          folder={folder}
          onToggle={onToggle}
          onEdit={onEdit}
          onRelogin={onRelogin}
          onOpenCli={onOpenCli}
          onOpenCliBypass={onOpenCliBypass}
          canBypass={BYPASS_FLAG[p.cli] !== undefined}
          onRemove={onRemove}
          onResume={onResume}
        />
      </div>

      <div className={METER_GRID}>
        <Meter
          label={t.session}
          short={t.sessionShort}
          plan={name(p)}
          limit={session}
          stop={p.stopAtSession ?? DEFAULTS.stopAtSession}
          t={t}
          lang={lang}
          now={now}
        />
        <Meter
          label={t.week}
          short={t.week}
          plan={name(p)}
          limit={week}
          stop={p.stopAtWeek ?? DEFAULTS.stopAtWeek}
          t={t}
          lang={lang}
          now={now}
        />
        {/* Gói chưa đăng nhập hay thiếu CLI đã có dòng giải thích riêng bên dưới. */}
        {(!session || !week) && p.supported && state !== "signedOut" && state !== "noCli" && (
          <span className="col-span-4 truncate text-xs text-muted-foreground" title={why}>
            {why}
          </span>
        )}
      </div>

      {models.length > 0 && <ModelWeeks models={models} plan={name(p)} t={t} />}
      {groups.length > 0 && <GroupLimits groups={groups} plan={name(p)} t={t} />}

      {notes && (
        <div className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
          {!p.supported ? (
            <span>{t.unsupported}</span>
          ) : state === "noCli" ? (
            <span className="text-destructive">{t.noCli}</span>
          ) : state === "signedOut" && !waiting ? (
            <span className="text-destructive">{t.signedOut}</span>
          ) : null}
          {waiting && state === "signedOut" && <span>{t.loginWaiting}</span>}
          {twins && twins.length > 0 && (
            <span role="note" className="text-warning">
              {t.sameAccount(twins.join(", "))}
            </span>
          )}
          {resumable && (
            <span className="flex flex-wrap items-center gap-2">
              {cooling && p.coolUntil ? (
                <Pill tone="warn">
                  <HourglassIcon aria-hidden="true" className="size-3.5" />
                  {t.coolingUntil(clock(p.coolUntil, now, lang))}
                </Pill>
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

      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {t.meta(p.priority, p.active ?? 0, Math.max(p.maxConcurrent, 1))}
        </span>
        {state === "signedOut" && relogin && (
          <Button size="sm" disabled={busy} onClick={onRelogin}>
            {t.login}
          </Button>
        )}
        {state === "noCli" && p.supported && (
          <Button size="sm" variant="outline" render={<a href="#/setup">{t.installCli}</a>} nativeButton={false} />
        )}
        {!p.enabled && (
          <Button
            size="sm"
            variant="outline"
            aria-label={t.toggleLabel(false, name(p))}
            disabled={busy || !p.supported}
            onClick={onToggle}
          >
            {t.enable}
          </Button>
        )}
      </div>
      {desktop}
    </li>
  );
}

/** Thanh phần trăm đã dùng; có `stop` thì vẽ thêm vạch ngưỡng dừng của gói. */
function Bar({ pct, stop, label, thin }: { pct: number; stop?: number; label: string; thin?: boolean }) {
  const tone = meterTone(pct, stop ?? 100);
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: thẻ <meter> không vẽ được vạch ngưỡng dừng bên trong thanh. */}
      <span
        role="meter"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn("relative block rounded-full bg-muted", thin ? "h-1" : "h-1.5")}
      >
        <span
          data-tone={tone}
          className={cn("absolute inset-y-0 left-0 rounded-full", BAR_TONE[tone])}
          style={{ width: `${pct}%` }}
        />
        {stop !== undefined && (
          <span
            data-stop={stop}
            title={`${stop}%`}
            className="absolute -top-[3px] -bottom-[3px] w-0.5 bg-muted-foreground"
            style={{ left: `${Math.min(100, stop)}%` }}
          />
        )}
      </span>
    </>
  );
}

/**
 * Một dòng mỗi thước: nhãn, thanh, phần trăm, giờ reset. Hai thước của thẻ chung một lưới (`METER_GRID`) nên thanh phiên và
 * tuần thẳng cột dù giờ reset dài ngắn khác nhau.
 */
const METER_GRID = "grid grid-cols-[2.75rem_minmax(2.5rem,1fr)_2.25rem_auto] items-center gap-x-2 gap-y-1 text-xs";
const METER_ROW = "contents [&>*:last-child]:whitespace-nowrap";

function Meter({
  label,
  short,
  plan,
  limit,
  stop,
  t,
  lang,
  now,
}: {
  label: string;
  /** Nhãn hiện trên thẻ; `label` đầy đủ dùng cho trình đọc màn hình. */
  short: string;
  plan: string;
  limit: Limit | null;
  stop: number;
  t: T;
  lang: Lang;
  now: number;
}) {
  if (!limit) {
    return (
      <span data-usage-unknown={label} className={cn(METER_ROW, "text-muted-foreground")}>
        <span className="truncate" title={label}>
          {short}
        </span>
        <span className="col-span-3 font-medium text-foreground">{t.unknown}</span>
      </span>
    );
  }
  const pct = pctOf(limit);
  const reset = limit.resetsAt
    ? future(limit.resetsAt, now)
      ? t.resetAt(clock(limit.resetsAt, now, lang))
      : t.resetPast
    : null;
  return (
    <span className={METER_ROW}>
      <span className="truncate text-muted-foreground" title={label}>
        {short}
      </span>
      <Bar pct={pct} stop={stop} label={`${label}: ${plan}`} />
      <span className="text-right font-mono font-semibold">{pct}%</span>
      <span className="truncate text-muted-foreground" title={reset ?? undefined}>
        {reset}
      </span>
    </span>
  );
}

/** Claude: tuần theo từng model; không có ngưỡng dừng riêng nên thanh chỉ đổi màu khi gần hết. */
function ModelWeeks({ models, plan, t }: { models: ModelLimit[]; plan: string; t: T }) {
  return (
    <details data-models className="group text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none">{t.byModel}</summary>
      <div className="mt-1 flex flex-col gap-1">
        {models.map((m) => {
          const pct = pctOf(m);
          return (
            <span key={m.name} className="grid grid-cols-[4.5rem_minmax(0,1fr)_2.75rem] items-center gap-2 text-xs">
              <span className="truncate">{m.name}</span>
              <Bar pct={pct} thin label={`${t.weekOf(m.name)}: ${plan}`} />
              <span className="text-right font-mono font-semibold">{pct}%</span>
            </span>
          );
        })}
      </div>
    </details>
  );
}

/** Antigravity: mỗi nhóm model có hạn mức phiên 5 giờ và tuần riêng; nhóm tắt phiên thì ghi rõ thay vì thanh rỗng. */
function GroupLimits({ groups, plan, t }: { groups: GroupLimit[]; plan: string; t: T }) {
  const row = (g: GroupLimit, label: string, limit: Limit | null) => {
    const pct = limit ? pctOf(limit) : null;
    return (
      <span className="grid grid-cols-[4.5rem_minmax(0,1fr)_2.75rem] items-center gap-2 text-xs">
        <span className="truncate text-muted-foreground">{label}</span>
        {pct === null ? (
          <span className="col-span-2 text-muted-foreground">{t.unknown}</span>
        ) : (
          <>
            <Bar pct={pct} thin label={`${g.name} · ${label}: ${plan}`} />
            <span className="text-right font-mono font-semibold">{pct}%</span>
          </>
        )}
      </span>
    );
  };
  return (
    <details data-groups className="text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none">{t.byGroup(groups.length)}</summary>
      <div className="mt-1 flex flex-col gap-1.5">
        {groups.map((g) => (
          <div key={g.name} data-group={g.name} className="flex flex-col gap-1.5">
            <span className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <strong className="font-semibold">{g.name}</strong>
              {g.models && <span className="min-w-0 truncate text-muted-foreground">{g.models}</span>}
            </span>
            {g.sessionDisabled ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <PowerOffIcon aria-hidden="true" className="size-3.5" />
                {t.groupDisabled}
              </span>
            ) : (
              row(g, t.session, g.session)
            )}
            {row(g, t.week, g.week)}
          </div>
        ))}
      </div>
    </details>
  );
}

const MENU_ITEM =
  "flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50";

function RowMenu({
  label,
  t,
  disabled,
  enabled,
  supported,
  canRelogin,
  canResume,
  folder,
  onToggle,
  onEdit,
  onRelogin,
  onOpenCli,
  onOpenCliBypass,
  canBypass,
  onRemove,
  onResume,
}: {
  label: string;
  t: T;
  disabled: boolean;
  enabled: boolean;
  supported: boolean;
  canRelogin: boolean;
  canResume: boolean;
  folder: string;
  onToggle: () => void;
  onEdit: () => void;
  onRelogin: () => void;
  onOpenCli: () => void;
  onOpenCliBypass: () => void;
  canBypass: boolean;
  onRemove: () => void;
  onResume: () => void;
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
            <Menu.Item className={MENU_ITEM} disabled={!supported} onClick={onToggle}>
              {enabled ? t.disable : t.enable}
            </Menu.Item>
            {canResume && (
              <Menu.Item className={MENU_ITEM} onClick={onResume}>
                {t.resume}
              </Menu.Item>
            )}
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
            {canBypass && (
              <Menu.Item
                className={cn(MENU_ITEM, "text-warning data-highlighted:text-warning")}
                onClick={onOpenCliBypass}
              >
                {t.openCliBypass}
              </Menu.Item>
            )}
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

/** Hộp liệt kê đăng nhập tìm thấy trên máy; thêm lần lượt từng cái đã tích để một cái lỗi không làm mất các cái đã thêm. */
function FoundDialog({
  found,
  t,
  onClose,
  onChanged,
  onDone,
}: {
  found: FoundLogin[];
  t: T;
  onClose: () => void;
  onChanged: (accounts: Plan[]) => void;
  onDone: (count: number) => void;
}) {
  // Mặc định chỉ tích đăng nhập đã vào được và không bị nghi trùng; worker ghi lý do vào `note`.
  const [picked, setPicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(found.map((f) => [foundKey(f), f.loggedIn !== false && !f.note])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = found.filter((f) => picked[foundKey(f)]);

  async function submit() {
    setBusy(true);
    let done = 0;
    try {
      for (const f of chosen) {
        onChanged((await addFoundPlan(f)).accounts);
        done += 1;
      }
      onDone(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.foundTitle(found.length)}</DialogTitle>
          <DialogDescription>{t.foundLead}</DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {found.map((f) => {
            const key = foundKey(f);
            const title = f.configDir ? f.suggestedId : t.foundDefault(cliName(f.cli));
            return (
              <li key={key}>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 has-checked:border-primary has-checked:bg-accent">
                  <input
                    type="checkbox"
                    checked={!!picked[key]}
                    onChange={(e) => setPicked((v) => ({ ...v, [key]: e.target.checked }))}
                    className="mt-1 size-4 cursor-pointer accent-primary"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      {title}
                      <Pill>{cliName(f.cli)}</Pill>
                      {f.loggedIn === false && <Pill tone="warn">{t.foundSignedOut}</Pill>}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {[f.email, f.configDir].filter(Boolean).join(" · ")}
                    </span>
                    {f.note && <span className="text-xs text-warning">{f.note}</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t.cancel}
          </Button>
          <Button disabled={busy || chosen.length === 0} onClick={() => void submit()}>
            {busy ? t.foundAdding : t.foundAdd(chosen.length)}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** Thêm gói theo hai bước: chọn CLI bằng thẻ, rồi cách đăng nhập. Mở từ nút của khối CLI thì bắt đầu ở bước 2. */
function AddPlanDialog({
  open,
  initialCli,
  list,
  t,
  onOpenChange,
  onFindLogins,
  onAdded,
}: {
  open: boolean;
  initialCli: AddDialogCli | null;
  list: Plan[];
  t: T;
  onOpenChange: (open: boolean) => void;
  onFindLogins: () => void;
  onAdded: (id: string, terminalError: string | null, command: string) => void;
}) {
  const id = useId();
  const [cli, setCli] = useState<AddDialogCli | null>(initialCli);
  const [label, setLabel] = useState("");
  const [how, setHow] = useState<LoginWay>("plan");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallback = cli ? `${CLI_NAME[cli]} ${list.filter((p) => p.cli === cli).length + 1}` : "";

  function pick(next: AddDialogCli | null) {
    setCli(next);
    if (next && next !== "antigravity") setHow(LOGIN_WAYS[next][0] as LoginWay);
    setError(null);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `pick` chỉ đặt state; mở lại hộp thì đặt lại từ CLI của nút bấm.
  useEffect(() => {
    if (!open) return;
    pick(initialCli);
    setLabel("");
    setEmail("");
  }, [open, initialCli]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cli || cli === "antigravity") return;
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
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.addTitle}</DialogTitle>
          <DialogDescription>{cli === "antigravity" ? t.agyTitle : t.addStep(cli ? 2 : 1)}</DialogDescription>
        </DialogHeader>
        {!cli ? (
          <fieldset aria-label={t.addPickCli} className="m-0 grid min-w-0 gap-2.5 border-0 p-0 sm:grid-cols-2">
            {ADDABLE_CLIS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={CLI_NAME[c]}
                onClick={() => pick(c)}
                className="flex cursor-pointer flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left hover:border-primary hover:bg-accent"
              >
                <CliMark cli={c} large />
                <strong className="text-sm font-semibold">{CLI_NAME[c]}</strong>
                <span className="text-xs text-muted-foreground">{t.addCliHints[c]}</span>
              </button>
            ))}
            <button
              type="button"
              aria-label={CLI_NAME.antigravity}
              onClick={() => pick("antigravity")}
              className="flex cursor-pointer flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left hover:border-primary hover:bg-accent"
            >
              <CliMark cli="antigravity" large />
              <strong className="text-sm font-semibold">{CLI_NAME.antigravity}</strong>
              <span className="text-xs text-muted-foreground">{t.addAntigravityHint}</span>
            </button>
          </fieldset>
        ) : cli === "antigravity" ? (
          <div className="grid gap-y-3">
            <div className="flex items-center gap-2">
              <CliMark cli={cli} />
              <strong className="text-sm font-semibold">{CLI_NAME[cli]}</strong>
              <Button type="button" size="xs" variant="ghost" onClick={() => pick(null)}>
                {t.addChangeCli}
              </Button>
            </div>
            <ol className="m-0 grid list-decimal gap-1 pl-5 text-sm">
              {t.agySteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t.agyLimit}</p>
          </div>
        ) : (
          <form id={`${id}-form`} onSubmit={submit} className="grid gap-y-3">
            <div className="flex items-center gap-2">
              <CliMark cli={cli} />
              <strong className="text-sm font-semibold">{CLI_NAME[cli]}</strong>
              <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => pick(null)}>
                {t.addChangeCli}
              </Button>
            </div>
            <fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0">
              <legend className="mb-1 text-sm font-medium">{t.loginWay}</legend>
              {LOGIN_WAYS[cli].map((w) => (
                <div
                  key={w}
                  className="flex items-start gap-2.5 rounded-xl border px-3 py-2 has-checked:border-primary has-checked:bg-accent"
                >
                  <input
                    id={`${id}-way-${w}`}
                    type="radio"
                    name={`${id}-how`}
                    checked={how === w}
                    aria-describedby={`${id}-hint-${w}`}
                    onChange={() => setHow(w)}
                    className="mt-1 size-4 cursor-pointer accent-primary"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <label htmlFor={`${id}-way-${w}`} className="cursor-pointer text-sm font-medium">
                      {t.ways[w]}
                    </label>
                    <span id={`${id}-hint-${w}`} className="text-xs text-muted-foreground">
                      {t.wayHints[w]}
                    </span>
                  </span>
                </div>
              ))}
            </fieldset>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-label`}>{t.accountLabel}</Label>
              <Input
                id={`${id}-label`}
                value={label}
                placeholder={t.accountLabelHint(fallback)}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            {cli === "claude" && (
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-email`}>{t.email}</Label>
                <Input
                  id={`${id}-email`}
                  type="email"
                  value={email}
                  placeholder="ten@congty.vn"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            )}
          </form>
        )}
        {cli && cli !== "antigravity" && <p className="text-xs text-muted-foreground">{t.addNote}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          {cli === "antigravity" && (
            <Button type="button" onClick={onFindLogins}>
              <ScanSearchIcon aria-hidden="true" />
              {t.agyFind}
            </Button>
          )}
          {cli && cli !== "antigravity" && (
            <Button type="submit" form={`${id}-form`} disabled={busy}>
              {busy ? t.adding : t.addAndSignIn}
            </Button>
          )}
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

/** Xác nhận trước khi mở CLI bỏ hỏi quyền: người dùng tự gõ lệnh trong Terminal, nhưng CLI sẽ không hỏi trước khi sửa file. */
function BypassDialog({
  plan,
  t,
  onClose,
  onOpen,
}: {
  plan: Plan | null;
  t: T;
  onClose: () => void;
  onOpen: (plan: Plan) => void;
}) {
  return (
    <Dialog open={plan !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogTitle>{t.bypassTitle}</DialogTitle>
        <DialogDescription>{plan ? t.bypassBody(name(plan), BYPASS_FLAG[plan.cli] ?? "") : ""}</DialogDescription>
        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="destructive-solid" onClick={() => plan && onOpen(plan)}>
            {t.bypassOpen}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
