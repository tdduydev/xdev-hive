import { Tabs } from "@base-ui/react/tabs";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type Machine, newerVersion, type Run, type RunListItem, type WorkerRelease } from "@xdev-hive/contracts";
import type { RunState } from "@xdev-hive/contracts/run-states";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { EllipsisIcon, MonitorIcon, NetworkIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { DataTable } from "@/components/data-table/data-table.tsx";
import { Icon } from "@/components/icons.tsx";
import { DangerZone } from "@/components/page/danger-zone.tsx";
import { FilterBar } from "@/components/page/filter-bar.tsx";
import { PageSection } from "@/components/page/page-section.tsx";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import { RadioCards } from "@/components/page/settings.tsx";
import { StatCard, StatGrid } from "@/components/page/stat-card.tsx";
import { DescriptionList } from "@/components/ui/description-list.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import {
  EmptyState,
  LoadFailure,
  LoadingState,
  SectionsSkeleton,
  TableSkeleton,
} from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatAgo, formatDay, formatDayTime } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { hasSharedMachine, shareCandidate } from "@/lib/onboarding.ts";
import { teamRoleLookup } from "@/lib/projects.ts";
import type { MachineTab } from "@/lib/route-search.ts";
import { CLI_LABEL, RUN_STATE_LABEL, runStateTone, shortId } from "@/lib/run-view.ts";
import { useNow } from "@/lib/use-now.ts";
import { MachineAccountsPanel } from "@/pages/machine-accounts.tsx";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { DetailHeader, PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

type Status = Machine["status"];
type Os = "macOS" | "Linux" | "Windows";

const text: Dict<{
  title: string;
  description: string;
  loading: string;
  team: string;
  filterLabel: string;
  noTeams: string;
  noTeamsHint: string;
  createTeam: string;
  add: string;
  emptyTitle: string;
  emptyLead: string;
  emptySteps: string[];
  emptyMember: string;
  register: string;
  noSharedTitle: string;
  noSharedLead: string;
  noSharedMember: string;
  share: string;
  unshare: string;
  shareLabel: (name: string) => string;
  shareRow: (name: string) => string;
  unshareRow: (name: string) => string;
  accounts: string;
  accountsLabel: (name: string) => string;
  more: (name: string) => string;
  statOnline: string;
  statOnlineHint: string;
  statFree: string;
  statFreeHint: string;
  statClis: string;
  statRunning: string;
  statRunningHint: string;
  search: string;
  searchRuns: string;
  machine: string;
  status: string;
  runs: string;
  cli: string;
  worker: string;
  actions: string;
  states: Record<Status | "busy", string>;
  seen: (ago: string) => string;
  never: string;
  shared: string;
  personal: (owner: string) => string;
  unknownOwner: string;
  personalHint: string;
  kinds: Record<Machine["kind"], string>;
  newer: (version: string) => string;
  update: string;
  updateWorker: string;
  updateLabel: (name: string) => string;
  updateSent: (name: string) => string;
  pause: string;
  resume: string;
  revoke: string;
  revokeMachine: string;
  revokeTitle: (name: string) => string;
  revokeLead: string;
  revoking: string;
  cancel: string;
  runInfoError: string;
  offline: (name: string) => string;
  revoked: string;
  back: string;
  tabsLabel: string;
  overview: string;
  runsTab: string;
  notFound: string;
  backToList: string;
  info: string;
  infoHint: string;
  infoName: string;
  infoKind: string;
  infoScope: string;
  infoOs: string;
  infoClis: string;
  infoCapacity: string;
  capacity: (n: number) => string;
  infoLastSeen: string;
  infoRegistered: string;
  infoLabels: string;
  workerVersion: (version: string) => string;
  nowRunning: string;
  nowRunningHint: (used: number, capacity: number) => string;
  idle: string;
  danger: string;
  dangerLead: string;
  run: string;
  task: string;
  started: string;
  noRuns: string;
  noRunsHint: string;
  runsPage: (n: number) => string;
  prevRuns: string;
  nextRuns: string;
  openRun: (row: RunListItem) => string;
  runStates: Record<RunState, string>;
  dialogTitle: string;
  dialogLead: string;
  kindLabel: string;
  kindWorkerHint: string;
  kindHostHint: string;
  createCode: string;
  creating: string;
  tokenLabel: string;
  copyToken: string;
  expires: (at: string) => string;
  osLabel: string;
  stepHost: string;
  stepHostRun: string;
  hostImage: string;
  stepWindows: string;
  stepTerminal: string;
  stepRegister: string;
  copyStep: (n: number) => string;
  copy: string;
  close: string;
  afterInstall: string;
  copied: string;
  hostNote: string;
  linuxNote: string;
  macNote: string;
  windowsNote: string;
}> = {
  vi: {
    title: "Máy",
    description: "Máy chạy agent của từng đội: trạng thái, chỗ chạy còn trống, phiên bản worker và gói agent.",
    loading: "Đang tải máy…",
    team: "Đội",
    filterLabel: "Chọn đội",
    noTeams: "Chưa có đội để quản lý máy",
    noTeamsHint: "Máy thuộc về một đội. Tạo đội trước, rồi đăng ký máy cho đội đó.",
    createTeam: "Tới trang Đội",
    add: "Thêm máy",
    emptyTitle: "Đội chưa đăng ký máy nào",
    emptyLead: "Agent chạy trên máy của đội bạn, bằng CLI (Claude Code, Codex, Gemini) đã đăng nhập sẵn trên máy đó.",
    emptySteps: [
      "Bấm “Đăng ký máy” để lấy lệnh cài kèm mã dùng một lần, rồi chạy lệnh trên máy dev hoặc máy chủ của đội.",
      "Máy mới là máy cá nhân: chỉ chạy run của người đăng ký.",
      "Bật “Cho đội dùng chung” ở một máy để chạy Leader, AI duyệt tài liệu và việc từ webhook.",
    ],
    emptyMember: "Nhờ quản trị đội đăng ký máy cho đội.",
    register: "Đăng ký máy",
    noSharedTitle: "Đội chưa có máy dùng chung",
    noSharedLead:
      "Run của đội chỉ chạy trên máy dùng chung: Leader, AI duyệt tài liệu và việc từ webhook sẽ chờ cho tới khi có một máy dùng chung. Máy cá nhân chỉ chạy run của chủ máy.",
    noSharedMember: "Nhờ quản trị đội bật “Cho đội dùng chung” ở một máy.",
    share: "Cho đội dùng chung",
    unshare: "Thôi dùng chung",
    shareLabel: (name) => `Cho đội dùng chung máy ${name}`,
    shareRow: (name) => `Cho đội dùng chung ${name}`,
    unshareRow: (name) => `Thôi dùng chung ${name}`,
    accounts: "Gói agent",
    accountsLabel: (name) => `Gói agent của ${name}`,
    more: (name) => `Thao tác khác cho ${name}`,
    statOnline: "Máy trực tuyến",
    statOnlineHint: "đang nối với hub",
    statFree: "Chỗ chạy còn trống",
    statFreeHint: "trên máy trực tuyến",
    statClis: "CLI khả dụng",
    statRunning: "Run đang chạy",
    statRunningHint: "trên máy của đội",
    search: "Tìm tên máy, hệ điều hành…",
    searchRuns: "Tìm việc, mã việc…",
    machine: "Máy",
    status: "Trạng thái",
    runs: "Run",
    cli: "CLI",
    worker: "Worker",
    actions: "Thao tác",
    states: {
      online: "Sẵn sàng",
      busy: "Đang chạy",
      offline: "Mất kết nối",
      paused: "Tạm dừng",
      revoked: "Đã thu hồi",
    },
    seen: (ago) => `Nhịp ${ago}`,
    never: "Chưa kết nối",
    shared: "Dùng chung",
    personal: (owner) => `Cá nhân · ${owner}`,
    unknownOwner: "không rõ",
    personalHint: "Chỉ chạy run của chủ máy, bằng CLI chủ máy đã đăng nhập",
    kinds: { worker: "Máy dev", host: "Runner host" },
    newer: (version) => `Có bản ${version}`,
    update: "Cập nhật",
    updateWorker: "Cập nhật worker",
    updateLabel: (name) => `Cập nhật worker trên ${name}`,
    updateSent: (name) => `Đã gửi lệnh cập nhật tới ${name}. Máy chờ run đang chạy xong, tự cập nhật rồi nối lại.`,
    pause: "Tạm dừng",
    resume: "Chạy lại",
    revoke: "Thu hồi",
    revokeMachine: "Thu hồi máy",
    revokeTitle: (name) => `Thu hồi máy ${name}?`,
    revokeLead: "Máy sẽ không thể kết nối lại bằng thông tin hiện tại. Bạn cần đăng ký lại để sử dụng máy.",
    revoking: "Đang thu hồi…",
    cancel: "Huỷ",
    runInfoError: "Không tải được danh sách run đang chạy của một số máy.",
    offline: (name) => `Máy ${name} mất kết nối. Run đang chờ sẽ được giao lại khi có máy phù hợp.`,
    revoked: "Máy đã bị thu hồi. Đăng ký lại máy để dùng tiếp.",
    back: "Máy",
    tabsLabel: "Các phần của máy",
    overview: "Tổng quan",
    runsTab: "Lượt chạy",
    notFound: "Không tìm thấy máy này, hoặc bạn không quản trị đội của máy.",
    backToList: "Về danh sách máy",
    info: "Thông tin máy",
    infoHint: "Worker tự báo hệ điều hành, CLI và phiên bản mỗi lần nối với hub.",
    infoName: "Tên",
    infoKind: "Loại máy",
    infoScope: "Phạm vi",
    infoOs: "Hệ điều hành",
    infoClis: "CLI",
    infoCapacity: "Sức chứa",
    capacity: (n) => `${n} run cùng lúc`,
    infoLastSeen: "Nhịp gần nhất",
    infoRegistered: "Đăng ký",
    infoLabels: "Nhãn",
    workerVersion: (version) => `Worker ${version}`,
    nowRunning: "Đang chạy",
    nowRunningHint: (used, capacity) => `${used} / ${capacity} chỗ đang dùng.`,
    idle: "Máy đang rảnh.",
    danger: "Vùng nguy hiểm",
    dangerLead: "Thu hồi máy bỏ quyền kết nối của worker. Muốn dùng lại phải đăng ký lại máy.",
    run: "Run",
    task: "Việc",
    started: "Bắt đầu",
    noRuns: "Máy chưa chạy run nào",
    noRunsHint: "Run giao cho máy này sẽ hiện ở đây, mới nhất trước.",
    runsPage: (n) => `Trang ${n} của lượt chạy`,
    prevRuns: "Trang trước của lượt chạy",
    nextRuns: "Trang sau của lượt chạy",
    openRun: (row) => `Mở run ${shortId(row.id)} của ${row.taskKey}`,
    runStates: RUN_STATE_LABEL,
    dialogTitle: "Thêm máy",
    dialogLead: "Mã đăng ký chỉ dùng một lần và hết hạn sau một giờ. Hãy hoàn tất cài đặt trước khi đóng cửa sổ này.",
    kindLabel: "Loại máy",
    kindWorkerHint: "Chạy agent bằng CLI đã đăng nhập sẵn trên máy (macOS, Linux, Windows).",
    kindHostHint:
      "Máy chủ Linux chạy mỗi run trong container gVisor cho dự án bật sandbox. Cần Docker và runsc cấu hình --host-uds=open.",
    createCode: "Tạo mã đăng ký",
    creating: "Đang tạo mã…",
    tokenLabel: "Mã đăng ký dùng một lần",
    copyToken: "Chép mã",
    expires: (at) => `Hết hạn lúc ${at}.`,
    osLabel: "Hệ điều hành",
    stepHost: "Cài worker và đăng ký runner host với hub",
    stepHostRun: "Chạy runner host",
    hostImage: "<image môi trường của dự án>",
    stepWindows: "Chạy trong PowerShell: cài worker, đăng ký máy, chạy nền",
    stepTerminal: "Chạy trong terminal: cài worker, đăng ký máy, chạy nền",
    stepRegister: "Hoặc đã có hive-worker (app desktop): chỉ đăng ký máy",
    copyStep: (n) => `Chép lệnh bước ${n}`,
    copy: "Chép",
    close: "Đóng",
    afterInstall:
      "Máy sẽ hiện trong danh sách khi worker kết nối tới hub. Worker chỉ chạy CLI đã đăng nhập sẵn trên máy. Chạy lại lệnh cài không kèm mã (hoặc hive-worker update) để nâng cấp.",
    copied: "Đã chép vào bộ nhớ tạm.",
    hostNote: "Runner host chỉ chạy trên Linux và từ chối khởi động nếu Docker chưa có runtime runsc.",
    linuxNote: "Linux cài systemd user service; chạy loginctl enable-linger để worker chạy cả khi chưa đăng nhập.",
    macNote: "macOS cài LaunchAgent cho user hiện tại.",
    windowsNote: "Windows tạo tác vụ Task Scheduler chạy khi đăng nhập.",
  },
  en: {
    title: "Machines",
    description: "Machines that run agents for each team: status, free slots, worker version and agent accounts.",
    loading: "Loading machines…",
    team: "Team",
    filterLabel: "Choose a team",
    noTeams: "No team to manage machines for",
    noTeamsHint: "Machines belong to a team. Create a team first, then register machines for it.",
    createTeam: "Go to Teams",
    add: "Add machine",
    emptyTitle: "This team has no machines yet",
    emptyLead: "Agents run on your team’s machines, using CLIs (Claude Code, Codex, Gemini) already signed in there.",
    emptySteps: [
      "Click “Register a machine” to get an install command with a one-time code, then run it on a dev machine or team server.",
      "A new machine is personal: it only runs the registering person’s runs.",
      "Turn on “Share with team” on one machine to run the Leader, AI doc reviews and webhook tasks.",
    ],
    emptyMember: "Ask a team admin to register a machine for the team.",
    register: "Register a machine",
    noSharedTitle: "No shared machine in this team",
    noSharedLead:
      "Team runs only run on shared machines: the Leader, AI doc reviews and webhook tasks wait until one exists. Personal machines only run their owner’s runs.",
    noSharedMember: "Ask a team admin to turn on “Share with team” for a machine.",
    share: "Share with team",
    unshare: "Stop sharing",
    shareLabel: (name) => `Share machine ${name} with the team`,
    shareRow: (name) => `Share ${name} with the team`,
    unshareRow: (name) => `Stop sharing ${name}`,
    accounts: "Agent accounts",
    accountsLabel: (name) => `Agent accounts of ${name}`,
    more: (name) => `More actions for ${name}`,
    statOnline: "Machines online",
    statOnlineHint: "connected to the hub",
    statFree: "Free run slots",
    statFreeHint: "on online machines",
    statClis: "CLIs available",
    statRunning: "Runs in progress",
    statRunningHint: "on this team’s machines",
    search: "Search machine name, OS…",
    searchRuns: "Search task, task key…",
    machine: "Machine",
    status: "Status",
    runs: "Runs",
    cli: "CLI",
    worker: "Worker",
    actions: "Actions",
    states: {
      online: "Ready",
      busy: "Running",
      offline: "Disconnected",
      paused: "Paused",
      revoked: "Revoked",
    },
    seen: (ago) => `Seen ${ago}`,
    never: "Never connected",
    shared: "Shared",
    personal: (owner) => `Personal · ${owner}`,
    unknownOwner: "unknown",
    personalHint: "Only runs its owner’s runs, with the CLIs the owner signed in to",
    kinds: { worker: "Dev machine", host: "Runner host" },
    newer: (version) => `${version} available`,
    update: "Update",
    updateWorker: "Update worker",
    updateLabel: (name) => `Update worker on ${name}`,
    updateSent: (name) =>
      `Update sent to ${name}. The machine waits for its runs to finish, updates itself, then reconnects.`,
    pause: "Pause",
    resume: "Resume",
    revoke: "Revoke",
    revokeMachine: "Revoke machine",
    revokeTitle: (name) => `Revoke machine ${name}?`,
    revokeLead: "The machine can no longer connect with its current credentials. Register it again to use it.",
    revoking: "Revoking…",
    cancel: "Cancel",
    runInfoError: "Could not load the running runs of some machines.",
    offline: (name) => `Machine ${name} is disconnected. Waiting runs go to another suitable machine.`,
    revoked: "This machine was revoked. Register it again to keep using it.",
    back: "Machines",
    tabsLabel: "Machine sections",
    overview: "Overview",
    runsTab: "Runs",
    notFound: "This machine was not found, or you do not manage its team.",
    backToList: "Back to machines",
    info: "Machine details",
    infoHint: "The worker reports its OS, CLIs and version each time it connects to the hub.",
    infoName: "Name",
    infoKind: "Kind",
    infoScope: "Scope",
    infoOs: "Operating system",
    infoClis: "CLIs",
    infoCapacity: "Capacity",
    capacity: (n) => `${n} run${n === 1 ? "" : "s"} at a time`,
    infoLastSeen: "Last heartbeat",
    infoRegistered: "Registered",
    infoLabels: "Labels",
    workerVersion: (version) => `Worker ${version}`,
    nowRunning: "Running now",
    nowRunningHint: (used, capacity) => `${used} / ${capacity} slots in use.`,
    idle: "The machine is idle.",
    danger: "Danger zone",
    dangerLead: "Revoking removes the worker’s right to connect. Register the machine again to reuse it.",
    run: "Run",
    task: "Task",
    started: "Started",
    noRuns: "No runs on this machine yet",
    noRunsHint: "Runs assigned to this machine appear here, newest first.",
    runsPage: (n) => `Page ${n} of runs`,
    prevRuns: "Previous page of runs",
    nextRuns: "Next page of runs",
    openRun: (row) => `Open run ${shortId(row.id)} for ${row.taskKey}`,
    runStates: {
      queued: "Queued",
      planning: "Planning",
      awaiting_plan: "Plan awaiting review",
      leased: "Leased",
      preparing: "Preparing",
      running: "Running",
      awaiting_input: "Awaiting input",
      verifying: "Verifying",
      succeeded: "Succeeded",
      no_changes: "No changes",
      needs_review: "Needs review",
      failed: "Failed",
      lost: "Machine lost",
      cancelling: "Cancelling",
      cancelled: "Cancelled",
    },
    dialogTitle: "Add machine",
    dialogLead:
      "The registration code works once and expires in one hour. Finish the install before closing this window.",
    kindLabel: "Machine kind",
    kindWorkerHint: "Runs agents with the CLIs already signed in on the machine (macOS, Linux, Windows).",
    kindHostHint:
      "A Linux server that runs each run in a gVisor container for projects with sandbox on. Needs Docker and runsc with --host-uds=open.",
    createCode: "Create registration code",
    creating: "Creating code…",
    tokenLabel: "One-time registration code",
    copyToken: "Copy code",
    expires: (at) => `Expires at ${at}.`,
    osLabel: "Operating system",
    stepHost: "Install the worker and register the runner host with the hub",
    stepHostRun: "Start the runner host",
    hostImage: "<project environment image>",
    stepWindows: "Run in PowerShell: install the worker, register, run in the background",
    stepTerminal: "Run in a terminal: install the worker, register, run in the background",
    stepRegister: "Or, if hive-worker is already installed (desktop app): register only",
    copyStep: (n) => `Copy step ${n} command`,
    copy: "Copy",
    close: "Close",
    afterInstall:
      "The machine appears in the list once the worker connects to the hub. The worker only runs CLIs already signed in on the machine. Run the install command again without a code (or hive-worker update) to upgrade.",
    copied: "Copied to the clipboard.",
    hostNote: "A runner host only runs on Linux and refuses to start if Docker has no runsc runtime.",
    linuxNote:
      "Linux installs a systemd user service; run loginctl enable-linger so the worker runs while you are signed out.",
    macNote: "macOS installs a LaunchAgent for the current user.",
    windowsNote: "Windows creates a Task Scheduler task that runs at sign-in.",
  },
};

/** Trạng thái run còn giữ chỗ trên máy (kể cả chờ người trả lời), để tính sức chứa đang dùng. */
const ACTIVE_RUN: readonly RunState[] = ["leased", "preparing", "running", "awaiting_input", "verifying", "cancelling"];
const isActiveRun = (run: { state: RunState }) => ACTIVE_RUN.includes(run.state);

const OS_NAME: Record<string, string> = { darwin: "macOS", linux: "Linux", windows: "Windows" };
const osName = (os: string) => OS_NAME[os] ?? os;

const UNKNOWN_TEAM = "00000000-0000-4000-8000-000000000000";
const RUNS_PAGE = 20;

function outdated(machine: Machine, latest: WorkerRelease | null): boolean {
  return latest !== null && newerVersion(latest.version, machine.version);
}

/** Máy còn kết nối (kể cả đang tạm dừng) và chạy bản cũ hơn bản phát hành mới nhất. */
function canUpdate(machine: Machine, latest: WorkerRelease | null): boolean {
  return (machine.status === "online" || machine.status === "paused") && outdated(machine, latest);
}

function MachineStatus({ status, busy }: { status: Status; busy: boolean }) {
  const t = useT(text);
  const tone =
    status === "paused"
      ? "warn"
      : status === "offline"
        ? "bad"
        : status === "online"
          ? busy
            ? "sel"
            : "ok"
          : "neutral";
  return (
    <Pill tone={tone} dot>
      {status === "online" && busy ? t.states.busy : t.states[status]}
    </Pill>
  );
}

/** Máy cá nhân chỉ chạy run của chủ máy; run của đội chỉ chạy trên máy dùng chung (ADR 0017). */
function ScopePill({ machine, owner, small = false }: { machine: Machine; owner: string | null; small?: boolean }) {
  const t = useT(text);
  return machine.shared ? (
    <Pill tone="sel" small={small}>
      {t.shared}
    </Pill>
  ) : (
    <span title={t.personalHint}>
      <Pill small={small}>{t.personal(owner ?? t.unknownOwner)}</Pill>
    </span>
  );
}

/** Thao tác trên máy dùng chung cho danh sách và trang chi tiết: cùng lời nhắc, cùng cách làm mới danh sách. */
function useMachineActions() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.machines.list.key() });
  const [updateSent, setUpdateSent] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (machine: Machine) => api.machines.update.call({ machineId: machine.id }),
    onMutate: () => setUpdateSent(null),
    onSuccess: (machine) => setUpdateSent(machine.name),
  });
  const pause = useMutation({
    mutationFn: ({ machineId, paused }: { machineId: string; paused: boolean }) =>
      paused ? api.machines.pause.call({ machineId }) : api.machines.resume.call({ machineId }),
    onSuccess: refresh,
  });
  const share = useMutation({
    mutationFn: ({ machineId, shared }: { machineId: string; shared: boolean }) =>
      api.machines.setShared.call({ machineId, shared }),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (machineId: string) => api.machines.revoke.call({ machineId }),
    onSuccess: refresh,
  });
  const failed = [update, pause, share].find((mutation) => mutation.isError);
  return { update, pause, share, revoke, updateSent, error: failed ? failed.error : null };
}
type MachineActions = ReturnType<typeof useMachineActions>;

/** Kết quả thao tác hiện một chỗ trên bảng, không nhét vào ô của dòng. */
function ActionFeedback({ actions }: { actions: MachineActions }) {
  const t = useT(text);
  return (
    <>
      {actions.error !== null && <Alert variant="destructive">{apiErrorMessage(actions.error)}</Alert>}
      {actions.updateSent && (
        <p role="status" className="text-sm text-muted-foreground">
          {t.updateSent(actions.updateSent)}
        </p>
      )}
    </>
  );
}

function RevokeDialog({
  machine,
  actions,
  onClose,
  onDone,
}: {
  machine: Machine | null;
  actions: MachineActions;
  onClose: () => void;
  onDone?: () => void;
}) {
  const t = useT(text);
  const { revoke } = actions;
  return (
    <Dialog
      open={machine !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {machine && (
        <DialogContent>
          <DialogTitle>{t.revokeTitle(machine.name)}</DialogTitle>
          <DialogDescription>{t.revokeLead}</DialogDescription>
          {revoke.isError && <Alert variant="destructive">{apiErrorMessage(revoke.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive-solid"
              disabled={revoke.isPending}
              onClick={() =>
                revoke.mutate(machine.id, {
                  onSuccess: () => {
                    onClose();
                    onDone?.();
                  },
                })
              }
            >
              {revoke.isPending ? t.revoking : t.revokeMachine}
            </Button>
          </DialogActions>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** Run đang chạy của các máy trong đội: hub chưa có truy vấn theo đội nên đi từ việc đang chạy của từng dự án. */
function useTeamActiveRuns(teamId: string | undefined) {
  const { api } = useOrg();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const teamProjects = projects.data?.filter((project) => project.teamId === teamId) ?? [];
  const taskQueries = useQueries({
    queries: teamProjects.map((project) =>
      api.tasks.list.queryOptions({ input: { projectId: project.id, status: "running" } }),
    ),
  });
  const runningTasks = taskQueries.flatMap((query) => query.data ?? []);
  const runQueries = useQueries({
    queries: runningTasks.map((task) => api.runs.list.queryOptions({ input: { taskId: task.id } })),
  });
  const taskKeys = new Map(runningTasks.map((task) => [task.id, task.key]));
  const runs = runQueries.flatMap((query) => query.data ?? []).filter(isActiveRun);
  const byMachine = new Map<string, Run[]>();
  for (const run of runs) {
    if (run.machineId) byMachine.set(run.machineId, [...(byMachine.get(run.machineId) ?? []), run]);
  }
  return {
    runs,
    of: (machineId: string) => byMachine.get(machineId) ?? [],
    keyOf: (run: Run) => (run.taskId ? taskKeys.get(run.taskId) : "leader"),
    pending:
      projects.isPending || taskQueries.some((query) => query.isPending) || runQueries.some((query) => query.isPending),
    error: projects.isError || taskQueries.some((query) => query.isError) || runQueries.some((query) => query.isError),
  };
}

function useOwnerName() {
  const { api } = useOrg();
  const members = useQuery(api.orgMembers.list.queryOptions());
  const names = new Map((members.data ?? []).map((member) => [member.userId, member.name]));
  return {
    members,
    owner: (machine: Machine) =>
      machine.registeredBy ? (names.get(machine.registeredBy) ?? machine.registeredBy) : null,
  };
}

export function MachinesPage() {
  const t = useT(text);
  const lang = useLang();
  const { api, org } = useOrg();
  const me = useMe();
  const navigate = useNavigate();
  const { them } = useSearch({ from: "/session/app/in-org/machines" });
  const teams = useQuery(api.teams.list.queryOptions());
  const [teamId, setTeamId] = useState("");
  const [adding, setAddingState] = useState(Boolean(them));
  function setAdding(open: boolean) {
    setAddingState(open);
    // Đóng hộp thoại thì bỏ ?them để tải lại trang không mở lại nó.
    if (!open && them) void navigate({ to: "/machines", search: {}, replace: true });
  }
  const [revoking, setRevoking] = useState<Machine | null>(null);
  const [labelling, setLabelling] = useState<Machine | null>(null);
  const selectedTeam = teams.data?.find((team) => team.id === teamId) ?? teams.data?.[0];
  const active = useTeamActiveRuns(selectedTeam?.id);
  const machines = useQuery({
    ...api.machines.list.queryOptions({ input: { teamId: selectedTeam?.id ?? UNKNOWN_TEAM } }),
    enabled: Boolean(selectedTeam),
    // Máy cập nhật xong thì nối lại với phiên bản mới; hỏi lại định kỳ để cột Worker tự đổi.
    refetchInterval: 15_000,
  });
  // Lỗi tra bản mới nhất (hub không ra được GitHub) chỉ làm mất nhãn bản cũ, không chặn trang.
  const latest = useQuery({ ...api.machines.workerRelease.queryOptions(), retry: false });
  const actions = useMachineActions();
  const { members, owner } = useOwnerName();
  const now = useNow(30_000);
  const teamAdmin = selectedTeam ? teamRoleLookup(org.role, members.data, me.id)(selectedTeam.id) === "admin" : false;
  const open = (machine: Machine, tab?: MachineTab) =>
    navigate({ to: "/machines/$machineId", params: { machineId: machine.id }, search: tab ? { tab } : {} });

  let body: ReactNode;
  if (teams.isPending) body = <TableSkeleton label={t.loading} columns={5} />;
  else if (teams.isError) body = <LoadFailure error={teams.error} retry={teams.refetch} />;
  else if (teams.data.length === 0)
    body = (
      <EmptyState
        icon={NetworkIcon}
        title={t.noTeams}
        description={t.noTeamsHint}
        action={
          <Button variant="outline" nativeButton={false} render={<Link to="/admin/teams" />}>
            {t.createTeam}
          </Button>
        }
      />
    );
  else {
    const list = machines.data ?? [];
    const busyOf = (machine: Machine) => Math.min(active.of(machine.id).length, machine.capacity);
    const online = list.filter((machine) => machine.status === "online");
    body = (
      <>
        {teams.data.length > 1 && (
          <FilterBar label={t.filterLabel}>
            <label className="flex items-center gap-2 text-sm font-medium" htmlFor="machine-team">
              {t.team}
              <NativeSelect
                id="machine-team"
                className="w-56"
                value={selectedTeam?.id ?? ""}
                onChange={(event) => setTeamId(event.target.value)}
              >
                {teams.data.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </FilterBar>
        )}
        {machines.isPending ? (
          <TableSkeleton label={t.loading} columns={5} />
        ) : machines.isError ? (
          <LoadFailure error={machines.error} retry={machines.refetch} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={MonitorIcon}
            title={t.emptyTitle}
            description={
              teamAdmin ? (
                <>
                  {t.emptyLead}
                  <ol className="mt-3 grid list-decimal gap-1 pl-5 text-left">
                    {t.emptySteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </>
              ) : (
                <>
                  {t.emptyLead} {t.emptyMember}
                </>
              )
            }
            action={
              teamAdmin && (
                <Button variant="default" onClick={() => setAdding(true)}>
                  <Icon name="plus" />
                  {t.register}
                </Button>
              )
            }
          />
        ) : (
          <>
            {!hasSharedMachine(list) && (
              <NoSharedMachine
                machine={teamAdmin ? shareCandidate(list) : null}
                canShare={teamAdmin}
                busy={actions.share.isPending}
                onShare={(machine) => actions.share.mutate({ machineId: machine.id, shared: true })}
              />
            )}
            <StatGrid columns={4}>
              <StatCard label={t.statOnline} value={`${online.length} / ${list.length}`} hint={t.statOnlineHint} />
              <StatCard
                label={t.statFree}
                value={online.reduce((sum, machine) => sum + Math.max(0, machine.capacity - busyOf(machine)), 0)}
                hint={t.statFreeHint}
              />
              <StatCard
                label={t.statClis}
                value={new Set(list.flatMap((machine) => machine.clis)).size}
                hint={[...new Set(list.flatMap((machine) => machine.clis))]
                  .map((cli) => CLI_LABEL[cli] ?? cli)
                  .join(", ")}
              />
              <StatCard label={t.statRunning} value={active.runs.length} hint={t.statRunningHint} />
            </StatGrid>
            {active.error && <Alert variant="destructive">{t.runInfoError}</Alert>}
            <ActionFeedback actions={actions} />
            <DataTable
              rows={list}
              rowLabel={(machine) => machine.name}
              placeholder={t.search}
              onRowClick={(machine) => void open(machine)}
              minWidth={760}
              facets={[
                {
                  key: "status",
                  label: t.status,
                  value: (machine) => machine.status,
                  options: (["online", "offline", "paused", "revoked"] as const).map((status) => ({
                    value: status,
                    label: t.states[status],
                  })),
                },
              ]}
              columns={[
                {
                  key: "machine",
                  label: t.machine,
                  value: (machine) => `${machine.name} ${osName(machine.os)}`,
                  sortable: true,
                  hideable: false,
                  pin: "start",
                  cell: (machine) => (
                    <span className="grid min-w-0 justify-items-start gap-1">
                      <Link
                        to="/machines/$machineId"
                        params={{ machineId: machine.id }}
                        className="font-mono text-sm font-medium whitespace-nowrap text-foreground hover:underline"
                      >
                        {machine.name}
                      </Link>
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <ScopePill machine={machine} owner={owner(machine)} small />
                        {(machine.labels ?? []).map((label) => (
                          <span key={label} className="rounded bg-muted px-1 font-mono">
                            {label}
                          </span>
                        ))}
                        {machine.labelsOnly && (
                          <span>{lang === "vi" ? "Chỉ nhận run có nhãn" : "Labelled runs only"}</span>
                        )}
                        <span className="whitespace-nowrap">
                          {osName(machine.os)}
                          {machine.kind === "host" && ` · ${t.kinds.host}`}
                        </span>
                      </span>
                    </span>
                  ),
                },
                {
                  key: "status",
                  label: t.status,
                  value: (machine) => t.states[machine.status],
                  sortable: true,
                  cell: (machine) => (
                    <span className="grid justify-items-start gap-1">
                      <MachineStatus status={machine.status} busy={active.of(machine.id).length > 0} />
                      <span
                        className="text-xs whitespace-nowrap text-muted-foreground"
                        title={machine.lastSeenAt ? formatDayTime(machine.lastSeenAt) : undefined}
                      >
                        {machine.lastSeenAt ? t.seen(formatAgo(machine.lastSeenAt, now, lang)) : t.never}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "runs",
                  label: t.runs,
                  value: (machine) => busyOf(machine),
                  sortable: true,
                  align: "end",
                  cell: (machine) => {
                    const keys = active.of(machine.id).map(active.keyOf).filter(Boolean).join(", ");
                    return (
                      <span className="grid justify-items-end gap-0.5">
                        <span className="tabular-nums">
                          {busyOf(machine)} / {machine.capacity}
                        </span>
                        {(active.pending || keys) && (
                          <span className="max-w-40 truncate font-mono text-xs text-muted-foreground" title={keys}>
                            {active.pending ? "…" : keys}
                          </span>
                        )}
                      </span>
                    );
                  },
                },
                {
                  key: "cli",
                  label: t.cli,
                  value: (machine) => machine.clis.join(" "),
                  hidden: true,
                  cell: (machine) =>
                    machine.clis.length ? (
                      <span className="flex flex-wrap gap-1">
                        {machine.clis.map((cli) => (
                          <Pill key={cli} small>
                            {CLI_LABEL[cli] ?? cli}
                          </Pill>
                        ))}
                      </span>
                    ) : (
                      "—"
                    ),
                },
                {
                  key: "worker",
                  label: t.worker,
                  value: (machine) => machine.version,
                  cell: (machine) => (
                    <WorkerVersion
                      machine={machine}
                      latest={latest.data ?? null}
                      busy={actions.update.isPending}
                      onUpdate={() => actions.update.mutate(machine)}
                    />
                  ),
                },
                {
                  key: "actions",
                  label: t.actions,
                  value: () => null,
                  hideable: false,
                  align: "end",
                  pin: "end",
                  cell: (machine) =>
                    machine.status !== "revoked" && (
                      <span className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={actions.pause.isPending}
                          onClick={() =>
                            actions.pause.mutate({ machineId: machine.id, paused: machine.status !== "paused" })
                          }
                        >
                          {machine.status === "paused" ? t.resume : t.pause}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setRevoking(machine)}
                        >
                          {t.revoke}
                        </Button>
                        {machine.kind === "worker" && (
                          <RowMenu
                            machine={machine}
                            actions={actions}
                            onAccounts={teamAdmin ? () => void open(machine, "goi-agent") : undefined}
                            onLabels={teamAdmin ? () => setLabelling(machine) : undefined}
                          />
                        )}
                      </span>
                    ),
                },
              ]}
            />
          </>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader title={t.title} description={t.description}>
        {selectedTeam && (
          <Button variant="default" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            {t.add}
          </Button>
        )}
      </PageHeader>
      <PageBody>{body}</PageBody>
      <Dialog open={adding && Boolean(selectedTeam)} onOpenChange={setAdding}>
        {adding && selectedTeam && <RegistrationDialog teamId={selectedTeam.id} onClose={() => setAdding(false)} />}
      </Dialog>
      <Dialog
        open={!!labelling}
        onOpenChange={(open) => {
          if (!open) setLabelling(null);
        }}
      >
        {labelling && <MachineLabelsDialog machine={labelling} onClose={() => setLabelling(null)} />}
      </Dialog>
      <RevokeDialog machine={revoking} actions={actions} onClose={() => setRevoking(null)} />
    </>
  );
}

/** Menu ⋯ của dòng: thao tác ít dùng hơn Tạm dừng/Thu hồi. */
function RowMenu({
  machine,
  actions,
  onAccounts,
  onLabels,
}: {
  machine: Machine;
  actions: MachineActions;
  onAccounts: (() => void) | undefined;
  onLabels: (() => void) | undefined;
}) {
  const t = useT(text);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t.more(machine.name)} />}>
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem
          disabled={actions.share.isPending}
          aria-label={machine.shared ? t.unshareRow(machine.name) : t.shareRow(machine.name)}
          onClick={() => actions.share.mutate({ machineId: machine.id, shared: !machine.shared })}
        >
          {machine.shared ? t.unshare : t.share}
        </DropdownMenuItem>
        {onLabels && (
          <DropdownMenuItem aria-label={`${t.infoLabels} · ${machine.name}`} onClick={onLabels}>
            {t.infoLabels}
          </DropdownMenuItem>
        )}
        {/* Gói agent chỉ quản trị đội xem và điều khiển được (ADR 0017). */}
        {onAccounts && (
          <DropdownMenuItem aria-label={t.accountsLabel(machine.name)} onClick={onAccounts}>
            {t.accounts}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkerVersion({
  machine,
  latest,
  busy,
  onUpdate,
}: {
  machine: Machine;
  latest: WorkerRelease | null;
  busy: boolean;
  onUpdate: () => void;
}) {
  const t = useT(text);
  if (!machine.version) return <>—</>;
  return (
    <span className="grid justify-items-start gap-1">
      <span className="font-mono text-xs">{machine.version}</span>
      {latest && outdated(machine, latest) && (
        <span className="flex flex-wrap items-center gap-1">
          <Pill tone="warn" small>
            {t.newer(latest.version)}
          </Pill>
          {canUpdate(machine, latest) && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              aria-label={t.updateLabel(machine.name)}
              onClick={onUpdate}
            >
              {t.update}
            </Button>
          )}
        </span>
      )}
    </span>
  );
}

/** Cảnh báo khi đội không có máy dùng chung; `machine` là máy gợi ý bật, null khi người xem không bật được. */
function NoSharedMachine({
  machine,
  canShare,
  busy,
  onShare,
}: {
  machine: Machine | null;
  canShare: boolean;
  busy: boolean;
  onShare: (machine: Machine) => void;
}) {
  const t = useT(text);
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-3 text-sm text-warning sm:flex sm:items-center sm:gap-4"
    >
      <div className="grid min-w-0 flex-1 gap-1">
        <h2 id={headingId} className="font-semibold">
          {t.noSharedTitle}
        </h2>
        <p className="text-foreground">{t.noSharedLead}</p>
        {!canShare && <p className="text-foreground">{t.noSharedMember}</p>}
      </div>
      {machine && (
        <Button
          variant="default"
          className="justify-self-start"
          disabled={busy}
          aria-label={t.shareLabel(machine.name)}
          onClick={() => onShare(machine)}
        >
          {t.share} · <span className="font-mono">{machine.name}</span>
        </Button>
      )}
    </section>
  );
}

/**
 * /machines/$machineId: trang của một máy (admin-layout.md § Decisions 3). Hub chưa có machines.get nên tìm máy trong
 * danh sách máy của từng đội; các truy vấn này trùng khoá với trang danh sách nên quay lại không phải tải lại.
 */
export function MachineDetailPage() {
  const t = useT(text);
  const lang = useLang();
  const { api, org } = useOrg();
  const me = useMe();
  const navigate = useNavigate();
  const { machineId } = useParams({ from: "/session/app/in-org/machines/$machineId" });
  const { tab = "tong-quan" } = useSearch({ from: "/session/app/in-org/machines/$machineId" });
  const teams = useQuery(api.teams.list.queryOptions());
  const lists = useQueries({
    queries: (teams.data ?? []).map((team) => ({
      ...api.machines.list.queryOptions({ input: { teamId: team.id } }),
      refetchInterval: 15_000,
    })),
  });
  const latest = useQuery({ ...api.machines.workerRelease.queryOptions(), retry: false });
  const actions = useMachineActions();
  const { members, owner } = useOwnerName();
  const now = useNow(30_000);
  const [revoking, setRevoking] = useState<Machine | null>(null);
  const machine = lists.flatMap((list) => list.data ?? []).find((item) => item.id === machineId);
  const failed = lists.find((list) => list.isError);
  const runs = useMachineRuns(machineId, undefined);

  if (!machine) {
    const loading = teams.isPending || (!failed && lists.some((list) => list.isPending));
    return (
      <>
        <PageHeader title={t.title} width="wide" />
        <PageBody width="wide">
          {loading ? (
            <SectionsSkeleton label={t.loading} />
          ) : teams.isError ? (
            <LoadFailure error={teams.error} retry={teams.refetch} />
          ) : failed ? (
            <LoadFailure error={failed.error} retry={() => Promise.all(lists.map((list) => list.refetch()))} />
          ) : (
            <>
              <Alert variant="destructive">{t.notFound}</Alert>
              <Link to="/machines" className="w-fit text-primary hover:text-primary/90">
                {t.backToList}
              </Link>
            </>
          )}
        </PageBody>
      </>
    );
  }

  const teamAdmin = teamRoleLookup(org.role, members.data, me.id)(machine.teamId) === "admin";
  const live = machine.status !== "revoked";
  const showAccounts = teamAdmin && live && machine.kind === "worker";
  const current: MachineTab | "tong-quan" = tab === "goi-agent" && !showAccounts ? "tong-quan" : tab;
  const release = latest.data ?? null;
  return (
    <>
      <DetailHeader
        back={{ to: "/machines", label: t.back }}
        title={machine.name}
        leading={
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
            <MonitorIcon aria-hidden="true" className="size-5" />
          </span>
        }
        status={<MachineStatus status={machine.status} busy={Boolean(runs.data?.items.some(isActiveRun))} />}
        meta={
          <>
            <span>{osName(machine.os)}</span>
            {machine.version && <span className="font-mono">{t.workerVersion(machine.version)}</span>}
            <span title={machine.lastSeenAt ? formatDayTime(machine.lastSeenAt) : undefined}>
              {machine.lastSeenAt ? t.seen(formatAgo(machine.lastSeenAt, now, lang)) : t.never}
            </span>
            <ScopePill machine={machine} owner={owner(machine)} small />
          </>
        }
      >
        {live && (
          <>
            <Button
              variant="outline"
              disabled={actions.pause.isPending}
              onClick={() => actions.pause.mutate({ machineId: machine.id, paused: machine.status !== "paused" })}
            >
              {machine.status === "paused" ? t.resume : t.pause}
            </Button>
            {canUpdate(machine, release) && (
              <Button
                variant="default"
                disabled={actions.update.isPending}
                aria-label={t.updateLabel(machine.name)}
                onClick={() => actions.update.mutate(machine)}
              >
                {t.updateWorker}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={t.more(machine.name)}
                    title={t.more(machine.name)}
                  />
                }
              >
                <EllipsisIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {machine.kind === "worker" && (
                  <>
                    <DropdownMenuItem
                      disabled={actions.share.isPending}
                      onClick={() => actions.share.mutate({ machineId: machine.id, shared: !machine.shared })}
                    >
                      {machine.shared ? t.unshare : t.share}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem variant="destructive" onClick={() => setRevoking(machine)}>
                  {t.revokeMachine}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </DetailHeader>
      <Tabs.Root
        value={current}
        onValueChange={(value: MachineTab | "tong-quan") =>
          navigate({
            to: "/machines/$machineId",
            params: { machineId },
            search: value === "tong-quan" ? {} : { tab: value },
            replace: true,
          })
        }
      >
        <PageTabList label={t.tabsLabel}>
          <PageTab value="tong-quan">{t.overview}</PageTab>
          {showAccounts && (
            <PageTab value="goi-agent" count={machine.accounts?.length}>
              {t.accounts}
            </PageTab>
          )}
          <PageTab value="luot-chay">{t.runsTab}</PageTab>
        </PageTabList>
        <PageBody width="wide">
          <ActionFeedback actions={actions} />
          <Tabs.Panel value="tong-quan" className="grid min-w-0 gap-6">
            <MachineOverview
              machine={machine}
              owner={owner(machine)}
              latest={release}
              onRevoke={() => setRevoking(machine)}
            />
          </Tabs.Panel>
          {showAccounts && (
            <Tabs.Panel value="goi-agent" className="grid min-w-0">
              <MachineAccountsPanel machine={machine} />
            </Tabs.Panel>
          )}
          <Tabs.Panel value="luot-chay" className="grid min-w-0">
            <MachineRuns machineId={machine.id} />
          </Tabs.Panel>
        </PageBody>
      </Tabs.Root>
      <RevokeDialog machine={revoking} actions={actions} onClose={() => setRevoking(null)} />
    </>
  );
}

function useMachineRuns(machineId: string, cursor: string | undefined) {
  const { api } = useOrg();
  return useQuery({
    ...api.runs.search.queryOptions({
      input: { machineId, limit: RUNS_PAGE, ...(cursor ? { cursor } : {}) },
    }),
    refetchInterval: 15_000,
  });
}

function MachineOverview({
  machine,
  owner,
  latest,
  onRevoke,
}: {
  machine: Machine;
  owner: string | null;
  latest: WorkerRelease | null;
  onRevoke: () => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const now = useNow(30_000);
  // Trang đầu của tab Lượt chạy, cùng khoá truy vấn: run đang giữ chỗ luôn nằm trong các run mới nhất.
  const runs = useMachineRuns(machine.id, undefined);
  const running = runs.data?.items.filter(isActiveRun) ?? [];
  return (
    <>
      {machine.status === "offline" && <Alert variant="destructive">{t.offline(machine.name)}</Alert>}
      {machine.status === "revoked" && (
        <p role="note" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t.revoked}
        </p>
      )}
      <div className="grid min-w-0 gap-6 xl:grid-cols-2">
        <PageSection title={t.info} description={t.infoHint} className="content-start">
          <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            <DescriptionList
              items={[
                { term: t.infoName, detail: machine.name, mono: true },
                { term: t.infoKind, detail: t.kinds[machine.kind] },
                { term: t.infoScope, detail: <ScopePill machine={machine} owner={owner} /> },
                { term: t.infoOs, detail: osName(machine.os) },
                {
                  term: t.worker,
                  detail: (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs">{machine.version || "—"}</span>
                      {latest && outdated(machine, latest) && (
                        <Pill tone="warn" small>
                          {t.newer(latest.version)}
                        </Pill>
                      )}
                    </span>
                  ),
                },
                {
                  term: t.infoClis,
                  detail: machine.clis.length ? machine.clis.map((cli) => CLI_LABEL[cli] ?? cli).join(", ") : "—",
                },
                { term: t.infoCapacity, detail: t.capacity(machine.capacity) },
                ...(machine.labels?.length
                  ? [{ term: t.infoLabels, detail: machine.labels.join(", "), mono: true }]
                  : []),
                {
                  term: t.infoLastSeen,
                  detail: machine.lastSeenAt ? (
                    <span title={formatDayTime(machine.lastSeenAt)}>{formatAgo(machine.lastSeenAt, now, lang)}</span>
                  ) : (
                    t.never
                  ),
                },
                { term: t.infoRegistered, detail: formatDay(machine.createdAt) },
              ]}
            />
          </div>
        </PageSection>
        <PageSection
          className="content-start"
          title={t.nowRunning}
          description={t.nowRunningHint(Math.min(running.length, machine.capacity), machine.capacity)}
        >
          {runs.isPending ? (
            <TableSkeleton rows={2} columns={3} label={t.loading} />
          ) : runs.isError ? (
            <LoadFailure error={runs.error} retry={runs.refetch} />
          ) : running.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.idle}</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl bg-card ring-1 ring-foreground/10">
              {running.map((run) => (
                <li key={run.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="grid min-w-0 flex-1">
                    <Link
                      to="/runs/$id"
                      params={{ id: run.id }}
                      className="truncate font-medium text-foreground hover:underline"
                    >
                      {run.taskTitle}
                    </Link>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {run.taskKey} · {run.cli ? (CLI_LABEL[run.cli] ?? run.cli) : "—"}
                    </span>
                  </span>
                  <Pill tone={runStateTone(run.state)} dot>
                    {t.runStates[run.state]}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
        </PageSection>
      </div>
      {machine.status !== "revoked" && (
        <DangerZone title={t.danger} description={t.dangerLead}>
          <Button variant="destructive" onClick={onRevoke}>
            {t.revokeMachine}
          </Button>
        </DangerZone>
      )}
    </>
  );
}

/** Tab Lượt chạy: run của máy, mới nhất trước, phân trang bằng con trỏ của hub (một bộ phân trang). */
function MachineRuns({ machineId }: { machineId: string }) {
  const t = useT(text);
  const navigate = useNavigate();
  // Con trỏ của từng trang đã đi qua, để nút Trang trước quay về đúng trang.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = cursors.length - 1;
  const runs = useMachineRuns(machineId, cursors[page]);
  if (runs.isPending) return <TableSkeleton label={t.loading} columns={5} />;
  if (runs.isError) return <LoadFailure error={runs.error} retry={runs.refetch} />;
  if (page === 0 && runs.data.items.length === 0)
    return <EmptyState icon={MonitorIcon} title={t.noRuns} description={t.noRunsHint} />;
  const next = runs.data.nextCursor;
  return (
    <DataTable
      rows={runs.data.items}
      rowLabel={(row) => `${shortId(row.id)} ${row.taskKey}`}
      placeholder={t.searchRuns}
      minWidth={680}
      onRowClick={(row) => void navigate({ to: "/runs/$id", params: { id: row.id } })}
      serverPaging={{
        label: t.runsPage(page + 1),
        hasPrevious: page > 0,
        hasNext: next !== null,
        onPrevious: () => setCursors((list) => list.slice(0, -1)),
        onNext: () => {
          if (next) setCursors((list) => [...list, next]);
        },
        previousLabel: t.prevRuns,
        nextLabel: t.nextRuns,
      }}
      columns={[
        {
          key: "run",
          label: t.run,
          value: (row) => row.id,
          hideable: false,
          pin: "start",
          cell: (row) => (
            <Link
              to="/runs/$id"
              params={{ id: row.id }}
              className="font-mono text-xs text-primary hover:underline"
              aria-label={t.openRun(row)}
            >
              {shortId(row.id)}
            </Link>
          ),
        },
        {
          key: "task",
          label: t.task,
          value: (row) => `${row.taskTitle} ${row.taskKey}`,
          sortable: true,
          cell: (row) => (
            <span className="grid min-w-0">
              <span className="truncate font-medium">{row.taskTitle}</span>
              <span className="font-mono text-xs text-muted-foreground">{row.taskKey}</span>
            </span>
          ),
        },
        {
          key: "state",
          label: t.status,
          value: (row) => t.runStates[row.state],
          sortable: true,
          cell: (row) => (
            <Pill tone={runStateTone(row.state)} dot>
              {t.runStates[row.state]}
            </Pill>
          ),
        },
        {
          key: "cli",
          label: "Agent",
          value: (row) => (row.cli ? (CLI_LABEL[row.cli] ?? row.cli) : "—"),
          sortable: true,
        },
        {
          key: "started",
          label: t.started,
          value: (row) => (row.startedAt ? Date.parse(row.startedAt) : null),
          sortable: true,
          align: "end",
          className: "whitespace-nowrap text-muted-foreground",
          cell: (row) => (row.startedAt ? formatDayTime(row.startedAt) : "—"),
        },
      ]}
    />
  );
}

export function RegistrationDialog({
  teamId,
  onClose,
  sdlc = false,
}: {
  teamId: string;
  onClose: () => void;
  sdlc?: boolean;
}) {
  const t = useT(text);
  const lang = useLang();
  const { api } = useOrg();
  const [kind, setKind] = useState<Machine["kind"]>("worker");
  const labelsId = useId();
  const [labels, setLabels] = useState(sdlc ? "sdlc" : "");
  const [labelsOnly, setLabelsOnly] = useState(sdlc);
  const registration = useMutation({
    gcTime: 0,
    mutationFn: () =>
      api.machines.createRegistration.call({
        teamId,
        kind,
        labels: labels.split(/[\s,]+/).filter(Boolean),
        shared: sdlc,
        labelsOnly,
      }),
  });
  const [copied, setCopied] = useState(false);
  const [os, setOs] = useState<Os>("macOS");
  const data = registration.data;
  // Script cài tải bản dựng sẵn, kiểm chữ ký và sha256 rồi đăng ký máy; dịch vụ cài cho user hiện tại nên không cần sudo.
  const steps: { title: string; value: string }[] = !data
    ? []
    : kind === "host"
      ? [
          { title: t.stepHost, value: data.installCommand },
          { title: t.stepHostRun, value: `hive-worker host --image ${t.hostImage}` },
        ]
      : [
          os === "Windows"
            ? { title: t.stepWindows, value: data.installCommandWindows }
            : { title: t.stepTerminal, value: data.installCommand },
          ...(sdlc && kind === "worker" ? [] : [{ title: t.stepRegister, value: data.command }]),
        ];

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col">
      <DialogTitle>{t.dialogTitle}</DialogTitle>
      <DialogDescription>{t.dialogLead}</DialogDescription>
      <div className="-mx-1 grid min-h-0 gap-3 overflow-y-auto overscroll-contain px-1">
        {!data && (
          <>
            <div className="grid gap-1.5">
              <span aria-hidden="true" className="text-xs font-medium">
                {t.kindLabel}
              </span>
              <RadioCards
                name="machine-kind"
                label={t.kindLabel}
                value={kind}
                onChange={setKind}
                disabled={registration.isPending}
                options={[
                  { value: "worker", title: t.kinds.worker, description: t.kindWorkerHint },
                  { value: "host", title: `${t.kinds.host} (sandbox)`, description: t.kindHostHint },
                ]}
              />
            </div>
            <label htmlFor={labelsId} className="grid gap-1 text-sm">
              {lang === "vi" ? "Nhãn máy" : "Machine labels"}
              <Input
                id={labelsId}
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                disabled={registration.isPending}
                placeholder="sdlc, docs"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={labelsOnly}
                disabled={registration.isPending}
                onChange={(e) => setLabelsOnly(e.target.checked)}
              />
              {lang === "vi" ? "Chỉ nhận run có nhãn" : "Labelled runs only"}
            </label>
            {registration.isPending && <LoadingState label={t.creating} />}
            {registration.isError && <Alert variant="destructive">{apiErrorMessage(registration.error)}</Alert>}
          </>
        )}
        {data && (
          <>
            <div className="grid gap-1">
              <span className="text-xs font-medium">{t.tokenLabel}</span>
              <div className="flex min-w-0 gap-2">
                <code
                  role="status"
                  aria-label={t.tokenLabel}
                  className="min-w-0 flex-1 break-all rounded-md bg-muted p-2 text-xs"
                >
                  {data.token}
                </code>
                <Button variant="outline" size="sm" onClick={() => copy(data.token)}>
                  {t.copyToken}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t.expires(new Date(data.expiresAt).toLocaleString(lang === "en" ? "en-GB" : "vi-VN"))}
              </p>
            </div>
            {kind === "worker" && (
              <SegmentedControl
                label={t.osLabel}
                value={os}
                onChange={setOs}
                size="sm"
                options={(["macOS", "Linux", "Windows"] as const).map((item) => ({ value: item, label: item }))}
              />
            )}
            {steps.map((step, index) => (
              <div key={step.title} className="grid gap-1">
                <b className="text-xs font-medium">
                  {index + 1}. {step.title}
                </b>
                <div className="flex min-w-0 gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md bg-muted p-2 text-xs">{step.value}</code>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t.copyStep(index + 1)}
                    onClick={() => copy(step.value)}
                  >
                    {t.copy}
                  </Button>
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">{t.afterInstall}</p>
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {copied
                ? t.copied
                : kind === "host"
                  ? t.hostNote
                  : os === "Linux"
                    ? t.linuxNote
                    : os === "macOS"
                      ? t.macNote
                      : t.windowsNote}
            </p>
          </>
        )}
      </div>
      <DialogActions>
        <Button variant="outline" onClick={onClose}>
          {t.close}
        </Button>
        {!data && (
          <Button variant="default" disabled={registration.isPending} onClick={() => registration.mutate()}>
            {registration.isPending ? t.creating : t.createCode}
          </Button>
        )}
      </DialogActions>
    </DialogContent>
  );
}

export function MachineLabelsDialog({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const { api } = useOrg();
  const lang = useLang();
  const client = useQueryClient();
  const labelsId = useId();
  const [labels, setLabels] = useState((machine.labels ?? []).join(", "));
  const [labelsOnly, setLabelsOnly] = useState(machine.labelsOnly ?? false);
  const save = useMutation(
    api.machines.setLabels.mutationOptions({
      onSuccess: () => {
        void client.invalidateQueries({ queryKey: api.machines.key() });
        onClose();
      },
    }),
  );
  return (
    <DialogContent>
      <DialogTitle>
        {lang === "vi" ? "Nhãn máy" : "Machine labels"} · {machine.name}
      </DialogTitle>
      <DialogDescription>
        {lang === "vi" ? "Nhãn áp dụng từ lần giao run tiếp theo." : "Labels apply to the next run assignment."}
      </DialogDescription>
      <label htmlFor={labelsId} className="grid gap-1 text-sm">
        {lang === "vi" ? "Nhãn" : "Labels"}
        <Input id={labelsId} value={labels} onChange={(e) => setLabels(e.target.value)} disabled={save.isPending} />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={labelsOnly}
          onChange={(e) => setLabelsOnly(e.target.checked)}
          disabled={save.isPending}
        />
        {lang === "vi" ? "Chỉ nhận run có nhãn" : "Labelled runs only"}
      </label>
      {save.error && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" disabled={save.isPending} onClick={onClose}>
          {lang === "vi" ? "Huỷ" : "Cancel"}
        </Button>
        <Button
          disabled={save.isPending}
          onClick={() =>
            save.mutate({ machineId: machine.id, labels: labels.split(/[\s,]+/).filter(Boolean), labelsOnly })
          }
        >
          {lang === "vi" ? "Lưu nhãn" : "Save labels"}
        </Button>
      </DialogActions>
    </DialogContent>
  );
}
