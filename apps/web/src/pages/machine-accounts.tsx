import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountLogin, Machine, MachineAccounts } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Pill } from "@xdev-hive/ui/pill";
import { type ReactNode, useEffect, useState } from "react";
import { CopyField } from "@/components/copy-field.tsx";
import { PageSection } from "@/components/page/page-section.tsx";
import { type RadioCardOption, RadioCards } from "@/components/page/settings.tsx";
import { LoadFailure, LoadingState, SectionsSkeleton } from "@/components/ui/query-state.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

type LoginCli = AccountLogin["cli"];
type AccountLoginHow = AccountLogin["how"];
type WorkerAccountSummary = NonNullable<MachineAccounts["accounts"]>[number];

type Reason = NonNullable<MachineAccounts["reason"]>;
type HowOption = RadioCardOption<Exclude<AccountLoginHow, "device">>;
type Ended = "error" | "expired" | "cancelled";

const text: Dict<{
  /** Lời nhắc khi quản trị không điều khiển được gói từ web; khớp `machineAccounts.reason`. */
  reason: Record<Reason, string>;
  title: string;
  lead: string;
  dialogLead: string;
  loading: string;
  notReported: string;
  noAccounts: string;
  listLabel: string;
  reportedAt: (at: string) => string;
  loggedIn: string;
  loggedOut: string;
  unknown: string;
  inUse: (n: number) => string;
  useAccount: (name: string) => string;
  session: string;
  week: string;
  left: (n: number) => string;
  noData: string;
  resets: (at: string) => string;
  add: string;
  resume: string;
  pending: (label: string) => string;
  finish: string;
  steps: string[];
  stepsLabel: string;
  label: string;
  labelPlaceholder: string;
  next: string;
  how: HowOption[];
  howClaude: string;
  howCodex: string;
  device: string;
  deviceHint: string;
  tokenWarning: string;
  back: string;
  starting: string;
  start: string;
  ended: Record<Ended, string>;
  loadingSession: string;
  retry: string;
  done: string;
  account: string;
  another: string;
  pasteToken: string;
  pasteCode: string;
  waitMachine: string;
  openTitle: string;
  openWithCode: string;
  open: string;
  copyUrl: string;
  sending: string;
  send: string;
  tokenNote: string;
  waitDevice: string;
  waitProcess: string;
  expires: (at: string) => string;
  cancel: string;
  code: string;
  copyCode: string;
  copied: string;
  copy: string;
}> = {
  vi: {
    reason: {
      personal: "Máy cá nhân: chủ máy quản lý gói tại máy.",
      offline: "Máy đang mất kết nối.",
      old_worker: "Cập nhật worker để điều khiển gói từ web.",
    },
    title: "Gói agent",
    lead: "Gói CLI đã đăng nhập trên máy và quota còn lại. Đăng nhập chạy ngay trên máy: hub chỉ chuyển đường dẫn và mã bạn dán, không lưu token.",
    dialogLead: "Đăng nhập chạy ngay trên máy: hub chỉ chuyển đường dẫn và mã bạn dán, không lưu token.",
    loading: "Đang tải…",
    notReported: "Máy chưa báo gói.",
    noAccounts: "Máy chưa có gói nào.",
    listLabel: "Danh sách gói",
    reportedAt: (at) => `Máy báo lúc ${at}.`,
    loggedIn: "Đã đăng nhập",
    loggedOut: "Chưa đăng nhập",
    unknown: "Không rõ",
    inUse: (n) => `${n} run đang dùng`,
    useAccount: (name) => `Dùng gói ${name}`,
    session: "Phiên 5 giờ",
    week: "Tuần",
    left: (n) => `còn ${n}%`,
    noData: "Chưa có số liệu",
    resets: (at) => `Làm mới ${at}`,
    add: "Thêm gói",
    resume: "Tiếp tục đăng nhập",
    pending: (label) => `Đang đăng nhập gói ${label}: mở lại để làm tiếp bước đang dở.`,
    finish: "Xong",
    steps: ["Chọn gói", "Cách đăng nhập", "Đăng nhập", "Xong"],
    stepsLabel: "Các bước thêm gói",
    label: "Tên gói",
    labelPlaceholder: "vd. claude-max-team",
    next: "Tiếp tục",
    how: [
      {
        value: "plan",
        title: "Theo gói Pro/Max",
        description: "Đăng nhập bằng tài khoản Claude có gói Pro hoặc Max (mặc định).",
      },
      { value: "sso", title: "SSO", description: "Đăng nhập bằng SSO của công ty." },
      {
        value: "console",
        title: "Console API",
        description: "Tính tiền theo API của Anthropic Console, không dùng gói Pro/Max.",
      },
      {
        value: "token",
        title: "Dán token từ claude setup-token",
        description: "Chạy claude setup-token trên máy bạn, rồi dán token vào đây.",
      },
    ],
    howClaude: "Cách đăng nhập Claude Code",
    howCodex: "Cách đăng nhập Codex",
    device: "Mã thiết bị",
    deviceHint: "Mở trang đăng nhập rồi nhập mã thiết bị.",
    tokenWarning:
      "Token từ claude setup-token có hiệu lực 1 năm và không thu hồi được từ máy. Ai có token đều dùng được gói của bạn, nên chỉ dán vào ô đăng nhập ở bước sau, không gửi qua chat hay email.",
    back: "Quay lại",
    starting: "Đang bắt đầu…",
    start: "Bắt đầu đăng nhập",
    ended: {
      error: "Đăng nhập không thành công.",
      expired: "Phiên đăng nhập đã hết hạn. Mỗi phiên chỉ kéo dài 10 phút.",
      cancelled: "Đã huỷ phiên đăng nhập.",
    },
    loadingSession: "Đang tải phiên đăng nhập…",
    retry: "Thử lại",
    done: "Đã đăng nhập",
    account: "gói",
    another: "Thêm gói khác",
    pasteToken: "Dán token",
    pasteCode: "Dán mã xác nhận",
    waitMachine: "Đang chờ máy mở phiên đăng nhập…",
    openTitle: "Mở trang đăng nhập",
    openWithCode: "Mở trang đăng nhập và nhập mã bên dưới",
    open: "Mở trang đăng nhập",
    copyUrl: "đường dẫn đăng nhập",
    sending: "Đang gửi…",
    send: "Gửi",
    tokenNote: "Token chỉ đi qua hub tới máy, hub không lưu. Ô nhập được xoá ngay sau khi gửi.",
    waitDevice: "Nhập mã ở trang đăng nhập; máy tự nhận khi bạn xác nhận xong…",
    waitProcess: "Đang chờ máy xử lý…",
    expires: (at) => `Hết hạn lúc ${at}.`,
    cancel: "Huỷ",
    code: "Mã thiết bị",
    copyCode: "Chép mã thiết bị",
    copied: "Đã chép",
    copy: "Chép",
  },
  en: {
    reason: {
      personal: "Personal machine: its owner manages accounts on the machine.",
      offline: "The machine is disconnected.",
      old_worker: "Update the worker to manage accounts from the web.",
    },
    title: "Agent accounts",
    lead: "CLI accounts signed in on the machine and their remaining quota. Sign-in runs on the machine: the hub only relays the link and the code you paste, and never stores tokens.",
    dialogLead:
      "Sign-in runs on the machine: the hub only relays the link and the code you paste, and never stores tokens.",
    loading: "Loading…",
    notReported: "The machine has not reported its accounts yet.",
    noAccounts: "The machine has no accounts yet.",
    listLabel: "Accounts",
    reportedAt: (at) => `Reported at ${at}.`,
    loggedIn: "Signed in",
    loggedOut: "Signed out",
    unknown: "Unknown",
    inUse: (n) => `${n} run${n === 1 ? "" : "s"} using it`,
    useAccount: (name) => `Use account ${name}`,
    session: "5-hour session",
    week: "Week",
    left: (n) => `${n}% left`,
    noData: "No data yet",
    resets: (at) => `Resets ${at}`,
    add: "Add account",
    resume: "Continue sign-in",
    pending: (label) => `Signing in account ${label}: reopen to continue where you left off.`,
    finish: "Done",
    steps: ["Account", "Sign-in method", "Sign in", "Done"],
    stepsLabel: "Steps to add an account",
    label: "Account name",
    labelPlaceholder: "e.g. claude-max-team",
    next: "Continue",
    how: [
      {
        value: "plan",
        title: "Pro/Max plan",
        description: "Sign in with a Claude account on a Pro or Max plan (default).",
      },
      { value: "sso", title: "SSO", description: "Sign in with your company SSO." },
      {
        value: "console",
        title: "Console API",
        description: "Billed through the Anthropic Console API, not a Pro/Max plan.",
      },
      {
        value: "token",
        title: "Paste a claude setup-token token",
        description: "Run claude setup-token on your computer, then paste the token here.",
      },
    ],
    howClaude: "How to sign in to Claude Code",
    howCodex: "How to sign in to Codex",
    device: "Device code",
    deviceHint: "Open the sign-in page, then enter the device code.",
    tokenWarning:
      "A claude setup-token token lasts one year and cannot be revoked from the machine. Anyone holding it can use your plan, so paste it only into the sign-in field in the next step, never in chat or email.",
    back: "Back",
    starting: "Starting…",
    start: "Start sign-in",
    ended: {
      error: "Sign-in failed.",
      expired: "The sign-in session expired. Each session lasts 10 minutes.",
      cancelled: "Sign-in cancelled.",
    },
    loadingSession: "Loading sign-in session…",
    retry: "Try again",
    done: "Signed in",
    account: "account",
    another: "Add another account",
    pasteToken: "Paste token",
    pasteCode: "Paste the confirmation code",
    waitMachine: "Waiting for the machine to open a sign-in session…",
    openTitle: "Open the sign-in page",
    openWithCode: "Open the sign-in page and enter the code below",
    open: "Open sign-in page",
    copyUrl: "sign-in link",
    sending: "Sending…",
    send: "Send",
    tokenNote:
      "The token only passes through the hub to the machine; the hub does not store it. The field is cleared once sent.",
    waitDevice: "Enter the code on the sign-in page; the machine picks it up once you confirm…",
    waitProcess: "Waiting for the machine…",
    expires: (at) => `Expires at ${at}.`,
    cancel: "Cancel",
    code: "Device code",
    copyCode: "Copy device code",
    copied: "Copied",
    copy: "Copy",
  },
};

const CLI_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
const cliName = (cli: string) => CLI_NAME[cli] ?? cli;

const ACTIVE = ["starting", "waiting"] as const;
const isActive = (login: AccountLogin) => (ACTIVE as readonly string[]).includes(login.status);

/** Định dạng ngày giờ theo ngôn ngữ giao diện. */
function useLocale() {
  return useLang() === "en" ? "en-GB" : "vi-VN";
}

/** Nút của từng bước dính đáy thân hộp thoại: luồng 4 bước có thể cao hơn màn hình mà nút vẫn bấm được. */
const STEP_ACTIONS = "sticky bottom-0 bg-popover pt-2";

/**
 * Tab Gói agent của trang máy (T063): danh sách gói, bật/tắt từng gói, và nút mở hộp thoại thêm gói bằng đăng nhập từ
 * web. Danh sách nằm trên trang để đọc quota không phải mở hộp thoại; chỉ luồng đăng nhập nhiều bước ở trong hộp thoại.
 */
export function MachineAccountsPanel({ machine }: { machine: Machine }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const accounts = useQuery({
    ...api.machines.accounts.list.queryOptions({ input: { machineId: machine.id } }),
    // Quota đổi theo heartbeat của worker; hỏi lại để thanh quota không đứng yên khi trang mở lâu.
    refetchInterval: 15_000,
    // Quay lại tab phải thấy phiên đăng nhập đang dở ngay, không đợi hết staleTime mặc định của app.
    staleTime: 0,
  });
  const toggle = useMutation({
    mutationFn: ({ accountId, enabled }: { accountId: string; enabled: boolean }) =>
      api.machines.setAccount.call({ machineId: machine.id, accountId, enabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.machines.accounts.list.key() });
      await queryClient.invalidateQueries({ queryKey: api.machines.list.key() });
    },
  });

  if (accounts.isPending) return <SectionsSkeleton sections={1} label={t.loading} />;
  if (accounts.isError) return <LoadFailure error={accounts.error} retry={accounts.refetch} />;
  const data = accounts.data;
  const pending = data.login && isActive(data.login) ? data.login : null;
  return (
    <PageSection
      title={t.title}
      description={t.lead}
      actions={
        data.remote && (
          <Button variant={pending ? "outline" : "default"} onClick={() => setAdding(true)}>
            {pending ? t.resume : t.add}
          </Button>
        )
      }
    >
      {data.reason && (
        <p role="status" className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-foreground">
          {t.reason[data.reason]}
        </p>
      )}
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          {t.pending(pending.label)}
        </p>
      )}
      {toggle.isError && <Alert variant="destructive">{apiErrorMessage(toggle.error)}</Alert>}
      <AccountList
        data={data}
        pendingId={toggle.isPending ? toggle.variables.accountId : null}
        onToggle={(accountId, enabled) => toggle.mutate({ accountId, enabled })}
      />
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl">
            <DialogTitle className="pr-8">
              {t.add} · <span className="font-mono">{machine.name}</span>
            </DialogTitle>
            <DialogDescription>{t.dialogLead}</DialogDescription>
            <div className="-mx-1 grid min-h-0 gap-3 overflow-y-auto overscroll-contain px-1">
              <AddAccount machine={machine} data={data} onClose={() => setAdding(false)} />
            </div>
          </DialogContent>
        )}
      </Dialog>
    </PageSection>
  );
}

function AccountList({
  data,
  pendingId,
  onToggle,
}: {
  data: MachineAccounts | undefined;
  pendingId: string | null;
  onToggle: (accountId: string, enabled: boolean) => void;
}) {
  const t = useT(text);
  const locale = useLocale();
  if (!data) return null;
  // Máy cá nhân của người khác không báo gói; lời nhắc ở trên đã đủ, khỏi nói thêm "chưa báo".
  if (data.accounts === null) {
    return data.reason === "personal" ? null : <p className="text-muted-foreground">{t.notReported}</p>;
  }
  if (data.accounts.length === 0) return <p className="text-muted-foreground">{t.noAccounts}</p>;
  return (
    <section aria-label={t.listLabel} className="grid gap-2">
      <ul className="grid gap-3 lg:grid-cols-2">
        {data.accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            canToggle={data.remote}
            busy={pendingId === account.id}
            onToggle={(enabled) => onToggle(account.id, enabled)}
          />
        ))}
      </ul>
      {data.accountsAt && (
        <p className="text-xs text-muted-foreground">
          {t.reportedAt(new Date(data.accountsAt).toLocaleString(locale))}
        </p>
      )}
    </section>
  );
}

function AccountRow({
  account,
  canToggle,
  busy,
  onToggle,
}: {
  account: WorkerAccountSummary;
  canToggle: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const t = useT(text);
  const login =
    account.loggedIn === true
      ? (["ok", t.loggedIn] as const)
      : account.loggedIn === false
        ? (["warn", t.loggedOut] as const)
        : (["neutral", t.unknown] as const);
  return (
    <li className="grid content-start gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <b className="break-words font-medium text-foreground">{account.label || account.id}</b>
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill>{cliName(account.cli)}</Pill>
            <Pill tone={login[0]}>{login[1]}</Pill>
            {account.inUse > 0 && <Pill tone="sel">{t.inUse(account.inUse)}</Pill>}
          </div>
        </div>
        <Switch
          checked={account.enabled}
          disabled={!canToggle || busy}
          onCheckedChange={onToggle}
          aria-label={t.useAccount(account.label || account.id)}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Quota label={t.session} percent={account.sessionPct} resetsAt={account.resetsAt} />
        <Quota label={t.week} percent={account.weekPct} resetsAt={null} />
      </div>
    </li>
  );
}

/** Thanh còn lại của quota (như hộp Tài khoản AI ở app desktop): dưới 30% đổi sang màu cảnh báo. */
function Quota({ label, percent, resetsAt }: { label: string; percent: number | null; resetsAt: string | null }) {
  const t = useT(text);
  const locale = useLocale();
  const left = percent === null ? null : Math.max(0, Math.round(100 - percent));
  return (
    <div className="grid gap-1 text-xs">
      <span className="flex justify-between text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{left === null ? "—" : t.left(left)}</span>
      </span>
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cx("h-full", left !== null && left < 30 ? "bg-warning" : "bg-primary")}
          style={{ width: `${left ?? 0}%` }}
        />
      </div>
      <span className="text-muted-foreground">
        {left === null
          ? t.noData
          : resetsAt
            ? t.resets(
                new Date(resetsAt).toLocaleString(locale, {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              )
            : " "}
      </span>
    </div>
  );
}

interface Draft {
  cli: LoginCli;
  label: string;
  how: AccountLoginHow;
}

function AddAccount({ machine, data, onClose }: { machine: Machine; data: MachineAccounts; onClose: () => void }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState<Draft>({ cli: "claude", label: "", how: "plan" });
  const [requestId, setRequestId] = useState<string | null>(null);
  // Phiên vừa kết thúc/đóng: list.login có thể còn trong cache một nhịp, không để nó mở lại bước cũ.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const resumed = data?.login && isActive(data.login) && data.login.requestId !== dismissed ? data.login : null;
  const sessionId = requestId ?? resumed?.requestId ?? null;

  const start = useMutation({
    mutationFn: () =>
      api.machines.accounts.loginStart.call({ machineId: machine.id, ...draft, label: draft.label.trim() }),
    onSuccess: (login) => {
      queryClient.setQueryData(
        api.machines.accounts.loginGet.queryOptions({ input: { machineId: machine.id, requestId: login.requestId } })
          .queryKey,
        login,
      );
      setRequestId(login.requestId);
      // Tab dưới hộp thoại báo "phiên đang dở" và mở lại đúng bước nếu người dùng đóng hộp thoại giữa chừng.
      void queryClient.invalidateQueries({ queryKey: api.machines.accounts.list.key() });
    },
  });
  // Chỉ đọc cache mà LoginSession đang hỏi lại, để thanh bước sang "Xong" cùng lúc với nội dung.
  const live = useQuery({
    ...api.machines.accounts.loginGet.queryOptions({ input: { machineId: machine.id, requestId: sessionId ?? "" } }),
    enabled: false,
  });

  function reset(nextStep: 1 | 2) {
    setDismissed(sessionId);
    setRequestId(null);
    setStep(nextStep);
    start.reset();
    void queryClient.invalidateQueries({ queryKey: api.machines.accounts.list.key() });
  }

  if (!data.remote && !sessionId) return null;

  const stage = sessionId ? (live.data?.status === "done" ? 3 : 2) : step - 1;
  return (
    <>
      <Stepper current={stage} />
      {sessionId ? (
        <LoginSession
          key={sessionId}
          machineId={machine.id}
          requestId={sessionId}
          onRetry={() => reset(2)}
          onAnother={() => {
            setDraft((d) => ({ ...d, label: "" }));
            reset(1);
          }}
          onClose={onClose}
        />
      ) : step === 1 ? (
        <ChooseStep draft={draft} onChange={setDraft} onNext={() => setStep(2)} />
      ) : (
        <HowStep
          draft={draft}
          onChange={setDraft}
          onBack={() => setStep(1)}
          onStart={() => start.mutate()}
          pending={start.isPending}
          error={start.isError ? apiErrorMessage(start.error) : null}
        />
      )}
    </>
  );
}

function Stepper({ current }: { current: number }) {
  const t = useT(text);
  return (
    <ol aria-label={t.stepsLabel} className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {t.steps.map((name, index) => (
        <li
          key={name}
          aria-current={index === current ? "step" : undefined}
          className={cx(
            "flex items-center gap-1.5",
            index === current ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              "grid size-5 place-items-center rounded-full border text-2xs",
              index === current
                ? "border-transparent bg-primary text-primary-foreground"
                : index < current
                  ? "border-transparent bg-success-soft text-success"
                  : "border-border",
            )}
          >
            {index + 1}
          </span>
          {name}
        </li>
      ))}
    </ol>
  );
}

/** Nhãn hiện trên nhóm radio: RadioCards dùng chung chỉ đặt tên cho trình đọc màn hình. */
function Choice({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span aria-hidden="true" className="text-xs font-medium">
        {legend}
      </span>
      {children}
    </div>
  );
}

function ChooseStep({
  draft,
  onChange,
  onNext,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onNext: () => void;
}) {
  const t = useT(text);
  const label = draft.label.trim();
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (label) onNext();
      }}
    >
      <Choice legend="CLI">
        <RadioCards
          name="account-cli"
          label="CLI"
          value={draft.cli}
          columns={2}
          options={[
            { value: "claude", title: "Claude Code" },
            { value: "codex", title: "Codex" },
          ]}
          // Codex chỉ có mã thiết bị; Claude mặc định theo gói Pro/Max.
          onChange={(cli) => onChange({ ...draft, cli, how: cli === "codex" ? "device" : "plan" })}
        />
      </Choice>
      <label className="grid gap-1 text-xs font-medium" htmlFor="account-label">
        {t.label}
        <Input
          id="account-label"
          value={draft.label}
          maxLength={80}
          placeholder={t.labelPlaceholder}
          autoComplete="off"
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
        />
      </label>
      <DialogActions className={STEP_ACTIONS}>
        <Button type="submit" variant="default" disabled={!label}>
          {t.next}
        </Button>
      </DialogActions>
    </form>
  );
}

function HowStep({
  draft,
  onChange,
  onBack,
  onStart,
  pending,
  error,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onBack: () => void;
  onStart: () => void;
  pending: boolean;
  error: string | null;
}) {
  const t = useT(text);
  return (
    <div className="grid gap-3">
      {draft.cli === "claude" ? (
        <Choice legend={t.howClaude}>
          <RadioCards
            name="account-how"
            label={t.howClaude}
            value={draft.how as Exclude<AccountLoginHow, "device">}
            options={t.how}
            onChange={(how) => onChange({ ...draft, how })}
          />
        </Choice>
      ) : (
        <Choice legend={t.howCodex}>
          <RadioCards
            name="account-how"
            label={t.howCodex}
            value="device"
            options={[{ value: "device", title: t.device, description: t.deviceHint }]}
            onChange={() => {}}
          />
        </Choice>
      )}
      {draft.how === "token" && (
        <p
          role="note"
          className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-foreground"
        >
          {t.tokenWarning}
        </p>
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
      <DialogActions className={STEP_ACTIONS}>
        <Button variant="outline" onClick={onBack} disabled={pending}>
          {t.back}
        </Button>
        <Button variant="default" onClick={onStart} disabled={pending}>
          {pending ? t.starting : t.start}
        </Button>
      </DialogActions>
    </div>
  );
}

function LoginSession({
  machineId,
  requestId,
  onRetry,
  onAnother,
  onClose,
}: {
  machineId: string;
  requestId: string;
  onRetry: () => void;
  onAnother: () => void;
  onClose: () => void;
}) {
  const t = useT(text);
  const locale = useLocale();
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const options = api.machines.accounts.loginGet.queryOptions({ input: { machineId, requestId } });
  const session = useQuery({
    ...options,
    // Worker báo URL và mã qua heartbeat nên phải hỏi lại đều tay tới khi phiên kết thúc.
    refetchInterval: (query) => (query.state.data && !isActive(query.state.data) ? false : 1500),
  });
  const login = session.data;
  const [pasted, setPasted] = useState("");
  const input = useMutation({
    mutationFn: (text: string) => api.machines.accounts.loginInput.call({ machineId, requestId, text }),
    // Mã và token chỉ nằm trong ô nhập; xoá ngay khi gửi để không còn trong DOM dù gửi lỗi.
    onMutate: () => setPasted(""),
    onSuccess: (next) => queryClient.setQueryData(options.queryKey, next),
  });
  const cancel = useMutation({
    mutationFn: () => api.machines.accounts.loginCancel.call({ machineId, requestId }),
    onSuccess: (next) => queryClient.setQueryData(options.queryKey, next),
  });
  const status = login?.status;
  useEffect(() => {
    if (status !== "done") return;
    // Gói mới vào danh sách của máy qua heartbeat kế; làm mới ngay để người dùng thấy nó.
    void queryClient.invalidateQueries({ queryKey: api.machines.accounts.list.key() });
    void queryClient.invalidateQueries({ queryKey: api.machines.list.key() });
  }, [status, queryClient, api]);

  if (session.isPending) return <LoadingState label={t.loadingSession} />;
  if (session.isError || !login) {
    return (
      <div className="grid gap-3">
        <Alert variant="destructive">{session.isError ? apiErrorMessage(session.error) : t.ended.error}</Alert>
        <DialogActions className={STEP_ACTIONS}>
          <Button variant="default" onClick={onRetry}>
            {t.retry}
          </Button>
        </DialogActions>
      </div>
    );
  }
  if (login.status === "done") {
    return (
      <div className="grid gap-3">
        <p role="status" className="rounded-lg border border-transparent bg-success-soft px-3 py-2 text-success">
          <b className="font-medium">{t.done}</b>
          {login.accountId && (
            <>
              {" "}
              · {t.account} <span className="font-mono">{login.accountId}</span>
            </>
          )}
        </p>
        <DialogActions className={STEP_ACTIONS}>
          <Button variant="outline" onClick={onAnother}>
            {t.another}
          </Button>
          <Button variant="default" onClick={onClose}>
            {t.finish}
          </Button>
        </DialogActions>
      </div>
    );
  }
  if (login.status === "error" || login.status === "expired" || login.status === "cancelled") {
    return (
      <div className="grid gap-3">
        <Alert variant="destructive">{login.error || t.ended[login.status]}</Alert>
        <DialogActions className={STEP_ACTIONS}>
          <Button variant="default" onClick={onRetry}>
            {t.retry}
          </Button>
        </DialogActions>
      </div>
    );
  }

  const isToken = login.how === "token";
  const pasteLabel = isToken ? t.pasteToken : t.pasteCode;
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        {cliName(login.cli)} · <b className="font-medium text-foreground">{login.label}</b>
      </p>
      {login.status === "starting" ? (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          {t.waitMachine}
        </p>
      ) : (
        <>
          {login.url && (
            <div className="grid gap-1.5">
              <b className="text-xs font-medium">{login.code ? t.openWithCode : t.openTitle}</b>
              <Button
                variant="default"
                className="justify-self-start"
                nativeButton={false}
                role="link"
                render={<a href={login.url} target="_blank" rel="noopener noreferrer" />}
              >
                {t.open}
              </Button>
              <CopyField value={login.url} copyLabel={t.copyUrl} />
            </div>
          )}
          {login.code && <DeviceCode code={login.code} />}
          {login.needsInput ? (
            <form
              className="grid gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (pasted.trim()) input.mutate(pasted);
              }}
            >
              <label className="text-xs font-medium" htmlFor="login-paste">
                {pasteLabel}
              </label>
              <div className="flex min-w-0 gap-2">
                <Input
                  id="login-paste"
                  type={isToken ? "password" : "text"}
                  value={pasted}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 font-mono text-xs"
                  onChange={(event) => setPasted(event.target.value)}
                />
                <Button type="submit" variant="default" disabled={!pasted.trim() || input.isPending}>
                  {input.isPending ? t.sending : t.send}
                </Button>
              </div>
              {isToken && <p className="text-xs text-muted-foreground">{t.tokenNote}</p>}
            </form>
          ) : (
            <p role="status" aria-busy="true" className="text-muted-foreground">
              {login.code ? t.waitDevice : t.waitProcess}
            </p>
          )}
        </>
      )}
      {input.isError && <Alert variant="destructive">{apiErrorMessage(input.error)}</Alert>}
      {cancel.isError && <Alert variant="destructive">{apiErrorMessage(cancel.error)}</Alert>}
      <p className="text-xs text-muted-foreground">
        {t.expires(new Date(login.expiresAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }))}
      </p>
      <DialogActions className={STEP_ACTIONS}>
        <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          {t.cancel}
        </Button>
      </DialogActions>
    </div>
  );
}

function DeviceCode({ code }: { code: string }) {
  const t = useT(text);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard bị chặn thì người dùng đọc mã trên màn hình và gõ tay.
      setCopied(false);
    }
  }
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium">{t.code}</span>
      <div className="flex min-w-0 items-center gap-2">
        <output
          aria-label={t.code}
          className="min-w-0 flex-1 break-all rounded-lg bg-muted px-3 py-2 text-center font-mono text-2xl font-semibold tracking-widest text-foreground"
        >
          {code}
        </output>
        <Button variant="outline" onClick={copy} aria-label={t.copyCode}>
          {copied ? t.copied : t.copy}
        </Button>
      </div>
    </div>
  );
}
