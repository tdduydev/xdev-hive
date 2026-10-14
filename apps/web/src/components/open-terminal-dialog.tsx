import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Project, TerminalMachineOption, TerminalModel } from "@xdev-hive/contracts";
import type { TerminalMode } from "@xdev-hive/contracts/worker-protocol";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { TerminalSquareIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { formatUsd } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import {
  canSubmitOpen,
  costOf,
  DEFAULT_TERMINAL_SIZE,
  expectedPermissions,
  firstSelectable,
  MODEL_LABEL,
  machineChoice,
  PERMISSIONS_LABEL,
} from "@/lib/terminal.ts";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<
  Record<
    | "button"
    | "title"
    | "description"
    | "project"
    | "machine"
    | "machineBusy"
    | "machineOnline"
    | "noMachines"
    | "account"
    | "accountAuto"
    | "accountLoggedOut"
    | "accountUsage"
    | "mode"
    | "propose"
    | "proposeHint"
    | "bypass"
    | "bypassHint"
    | "bypassWarnTitle"
    | "bypassWarn"
    | "bypassConfirm"
    | "model"
    | "sonnetHint"
    | "opusHint"
    | "cost"
    | "noCost"
    | "advisor"
    | "permissions"
    | "permFull"
    | "permWorkspace"
    | "disabled"
    | "denied"
    | "loadFailed"
    | "open"
    | "opening"
    | "cancel",
    string
  > & { costRuns: (runs: number) => string }
> = {
  vi: {
    button: "Mở terminal Leader",
    title: "Mở terminal Leader",
    description:
      "Claude CLI tương tác chạy trên máy dùng chung, trong worktree tạm của dự án. Phiên là riêng tư; bạn bật “Cho đội xem” sau.",
    project: "Dự án",
    machine: "Máy",
    machineBusy: "Đã đủ số phiên terminal. Chọn máy khác hoặc đóng phiên cũ.",
    machineOnline: "Online",
    noMachines: "Chưa có máy dùng chung nào đang online và hỗ trợ terminal cho đội của dự án này.",
    account: "Gói agent",
    accountAuto: "Tự chọn gói còn nhiều hạn mức",
    accountLoggedOut: "chưa đăng nhập",
    accountUsage: "phiên",
    mode: "Chế độ",
    propose: "Đề xuất",
    proposeHint: "Hành động của Leader thành đề xuất chờ duyệt. Bạn duyệt ngay ở khung bên phải.",
    bypass: "Bypass",
    bypassHint: "Leader gọi tool hub thẳng, không qua duyệt.",
    bypassWarnTitle: "Bypass không qua duyệt",
    bypassWarn:
      "Leader gọi tool hub bằng quyền của bạn, không qua duyệt. Mọi lần gọi được ghi nhật ký và hiện ở khung bên phải.",
    bypassConfirm: "Tôi hiểu và muốn mở ở chế độ Bypass",
    model: "Model của Leader",
    sonnetHint: "Mặc định, đủ cho phần lớn việc.",
    opusHint: "Mạnh hơn, đắt hơn.",
    cost: "Chi phí ước tính",
    noCost: "chưa đủ dữ liệu",
    advisor: "Dự án bật cố vấn: phiên Sonnet chạy kèm cố vấn",
    permissions: "Quyền trên máy",
    permFull: "Máy cho toàn quyền với dự án này: Claude chạy không hỏi quyền trong worktree tạm.",
    permWorkspace: "Máy chưa cho toàn quyền: Claude chỉ tự sửa file (Accept edits) trong worktree tạm, không push.",
    disabled: "Hub chưa bật Terminal Leader. Nhờ quản trị hub bật HIVE_REMOTE_TERMINAL.",
    denied:
      "Bạn chưa mở được terminal Leader cho dự án này. Chỉ quản trị đội hoặc BA/PO của đội sở hữu dự án mới mở được.",
    loadFailed: "Không tải được các lựa chọn của terminal.",
    open: "Mở terminal",
    opening: "Đang mở…",
    cancel: "Thôi",
    costRuns: (runs) => `TB 30 ngày, ${runs} run`,
  },
  en: {
    button: "Open Leader terminal",
    title: "Open Leader terminal",
    description:
      "An interactive Claude CLI running on a shared machine, in a temporary worktree of the project. The session is private; turn on “Share with team” later.",
    project: "Project",
    machine: "Machine",
    machineBusy: "Terminal session limit reached. Pick another machine or close an old session.",
    machineOnline: "Online",
    noMachines: "No shared machine is online and terminal-capable for this project's team.",
    account: "Agent account",
    accountAuto: "Pick the account with the most quota left",
    accountLoggedOut: "signed out",
    accountUsage: "session",
    mode: "Mode",
    propose: "Propose",
    proposeHint: "Leader actions become proposals awaiting approval. You approve them in the right panel.",
    bypass: "Bypass",
    bypassHint: "The leader calls hub tools directly, with no approval.",
    bypassWarnTitle: "Bypass skips approval",
    bypassWarn:
      "The leader calls hub tools with your permissions and no approval. Every call is logged and shown in the right panel.",
    bypassConfirm: "I understand and want to open in Bypass mode",
    model: "Leader model",
    sonnetHint: "Default, enough for most work.",
    opusHint: "Stronger, costs more.",
    cost: "Estimated cost",
    noCost: "not enough data yet",
    advisor: "The project uses an advisor: the Sonnet session runs with advisor",
    permissions: "Permissions on the machine",
    permFull:
      "The machine grants full access for this project: Claude runs without permission prompts in a temporary worktree.",
    permWorkspace:
      "The machine does not grant full access: Claude only edits files itself (Accept edits) in a temporary worktree and never pushes.",
    disabled: "The hub has not enabled Leader terminal. Ask a hub admin to set HIVE_REMOTE_TERMINAL.",
    denied: "You cannot open a Leader terminal for this project. Only team admins or BA/PO of the owning team can.",
    loadFailed: "Could not load the terminal options.",
    open: "Open terminal",
    opening: "Opening…",
    cancel: "Never mind",
    costRuns: (runs) => `30-day avg, ${runs} runs`,
  },
};

/**
 * Nút "Mở terminal Leader" và hộp thoại của nó. Hộp thoại tự hỏi `terminal.options` theo dự án đang chọn: hub chưa bật
 * hay người dùng chưa đủ quyền thì báo bằng câu dễ hiểu thay vì để form lỗi sau khi bấm mở.
 */
export function OpenTerminalButton({ projects }: { projects: readonly Project[] }) {
  const t = useT(text);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)}>
        <TerminalSquareIcon aria-hidden="true" />
        {t.button}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <OpenTerminalForm projects={projects} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function OpenTerminalForm({ projects, onDone }: { projects: readonly Project[]; onDone: () => void }) {
  const t = useT(text);
  const lang = useLang();
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const ids = { project: useId(), account: useId(), confirm: useId() };
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [pickedMachine, setPickedMachine] = useState("");
  const [accountId, setAccountId] = useState("");
  const [mode, setMode] = useState<TerminalMode>("propose");
  const [confirmed, setConfirmed] = useState(false);
  const [pickedModel, setPickedModel] = useState<TerminalModel | null>(null);

  const options = useQuery({
    ...api.terminal.options.queryOptions({ input: { projectId } }),
    enabled: projectId !== "",
    // Số phiên và máy online đổi nhanh: mỗi lần mở hộp thoại lấy bản mới.
    staleTime: 0,
    retry: false,
  });
  const open = useMutation({
    mutationFn: (input: Parameters<typeof api.terminal.open.call>[0]) => api.terminal.open.call(input),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: api.terminal.list.key() });
      onDone();
      await navigate({ to: "/leader/terminal/$id", params: { id: session.id } });
    },
  });

  const data = options.data;
  const online = data?.machines.filter((machine) => machine.online) ?? [];
  const machine: TerminalMachineOption | undefined =
    online.find((m) => m.id === pickedMachine && machineChoice(m).selectable) ?? firstSelectable(online);
  const model = pickedModel ?? data?.defaultModel ?? "sonnet";
  const account = machine?.accounts.find((a) => a.id === accountId && a.loggedIn !== false);
  const ready = !!data?.enabled && data.allowed && !!machine;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || !machine || !canSubmitOpen({ machineId: machine.id, mode, confirmed })) return;
    open.mutate({
      projectId,
      machineId: machine.id,
      ...(account ? { accountId: account.id } : {}),
      mode,
      ...(mode === "bypass" ? { confirmBypass: true } : {}),
      model,
      ...DEFAULT_TERMINAL_SIZE,
    });
  }

  let body: ReactNode;
  if (options.isPending && projectId !== "") body = <LoadingState />;
  else if (options.isError) body = <Alert variant="destructive">{apiErrorMessage(options.error)}</Alert>;
  else if (!data) body = <Alert variant="destructive">{t.loadFailed}</Alert>;
  else if (!data.enabled) body = <Alert>{t.disabled}</Alert>;
  else if (!data.allowed) body = <Alert>{t.denied}</Alert>;
  else if (online.length === 0) body = <Alert>{t.noMachines}</Alert>;
  else {
    body = (
      <>
        <fieldset className="grid min-w-0 gap-1.5">
          <legend className="mb-1 text-sm font-medium text-foreground">{t.machine}</legend>
          {online.map((m) => {
            const choice = machineChoice(m);
            return (
              <ChoiceRow
                key={m.id}
                name="machine"
                checked={machine?.id === m.id}
                disabled={!choice.selectable}
                onChange={() => {
                  setPickedMachine(m.id);
                  setAccountId("");
                }}
                title={m.name}
                badge={t.machineOnline}
                hint={choice.reason === "busy" ? t.machineBusy : undefined}
              />
            );
          })}
        </fieldset>

        {machine && (
          <div className="grid gap-1.5">
            <label htmlFor={ids.account} className="text-sm font-medium text-foreground">
              {t.account}
            </label>
            <NativeSelect id={ids.account} value={account?.id ?? ""} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{t.accountAuto}</option>
              {machine.accounts.map((a) => (
                <option key={a.id} value={a.id} disabled={a.loggedIn === false}>
                  {a.label}
                  {a.loggedIn === false
                    ? ` (${t.accountLoggedOut})`
                    : a.sessionPct !== null
                      ? ` (${t.accountUsage} ${Math.round(a.sessionPct)}%)`
                      : ""}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}

        <fieldset className="grid min-w-0 gap-1.5">
          <legend className="mb-1 text-sm font-medium text-foreground">{t.mode}</legend>
          <ChoiceRow
            name="mode"
            checked={mode === "propose"}
            onChange={() => setMode("propose")}
            title={t.propose}
            hint={t.proposeHint}
          />
          <ChoiceRow
            name="mode"
            checked={mode === "bypass"}
            onChange={() => setMode("bypass")}
            title={t.bypass}
            hint={t.bypassHint}
          />
        </fieldset>
        {mode === "bypass" && (
          <div className="grid gap-2">
            <Alert variant="destructive" className="grid-cols-[auto_1fr]">
              <TriangleAlertIcon aria-hidden="true" />
              <div className="font-medium">{t.bypassWarnTitle}</div>
              <div className="col-start-2 text-sm">{t.bypassWarn}</div>
            </Alert>
            <label htmlFor={ids.confirm} className="flex items-start gap-2 text-sm text-foreground">
              <input
                id={ids.confirm}
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              {t.bypassConfirm}
            </label>
          </div>
        )}

        <fieldset className="grid min-w-0 gap-1.5">
          <legend className="mb-1 text-sm font-medium text-foreground">{t.model}</legend>
          {(["sonnet", "opus"] as const).map((value) => {
            const cost = costOf(data, value);
            const runs = data.costs.find((c) => c.model === value)?.runs ?? 0;
            return (
              <ChoiceRow
                key={value}
                name="model"
                checked={model === value}
                onChange={() => setPickedModel(value)}
                title={MODEL_LABEL[value]}
                hint={`${value === "sonnet" ? t.sonnetHint : t.opusHint} ${t.cost}: ${
                  cost === null ? t.noCost : `${formatUsd(cost)} (${t.costRuns(runs)})`
                }`}
              />
            );
          })}
          {data.advisor && model === "sonnet" && (
            <p className="text-xs text-muted-foreground">
              {t.advisor} {data.advisor}.
            </p>
          )}
        </fieldset>

        {machine && (
          <p className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
            <strong className="font-medium text-foreground">{t.permissions}: </strong>
            {PERMISSIONS_LABEL[expectedPermissions(machine)][lang]}.{" "}
            {expectedPermissions(machine) === "full" ? t.permFull : t.permWorkspace}
          </p>
        )}
      </>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid min-w-0 gap-3.5">
      <DialogTitle>{t.title}</DialogTitle>
      <DialogDescription>{t.description}</DialogDescription>
      <div className="grid gap-1.5">
        <label htmlFor={ids.project} className="text-sm font-medium text-foreground">
          {t.project}
        </label>
        <NativeSelect
          id={ids.project}
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setPickedMachine("");
            setAccountId("");
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key} · {p.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      {body}
      {open.isError && <Alert variant="destructive">{apiErrorMessage(open.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone} disabled={open.isPending}>
          {t.cancel}
        </Button>
        <Button
          type="submit"
          variant="default"
          disabled={!ready || open.isPending || !canSubmitOpen({ machineId: machine?.id ?? "", mode, confirmed })}
        >
          {open.isPending ? t.opening : t.open}
        </Button>
      </DialogActions>
    </form>
  );
}

/** Một lựa chọn radio dạng thẻ. Bấm cả thẻ chọn được; thẻ bị khoá mờ đi và có `hint` nói vì sao. */
function ChoiceRow({
  name,
  checked,
  disabled = false,
  onChange,
  title,
  badge,
  hint,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  title: string;
  badge?: string | undefined;
  hint?: string | undefined;
}) {
  const hintId = useId();
  return (
    <label
      className={cx(
        "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2 text-sm transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
        checked && "border-primary bg-accent",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-describedby={hint ? hintId : undefined}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex flex-wrap items-center gap-2 font-medium text-foreground">
          {title}
          {badge && <span className="text-xs font-normal text-success">{badge}</span>}
        </span>
        {hint && (
          <span id={hintId} className="text-xs break-words text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
