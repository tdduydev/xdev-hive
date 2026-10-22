import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { RemoteMachine, RemoteStartInput } from "@xdev-hive/contracts";
import type { StartParams } from "@xdev-hive/contracts/terminal-auth";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { PlusIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { TotpCodeField, type TotpError, totpReady } from "@/components/totp-code-sheet.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.tsx";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { cliLabel } from "@/lib/run-view.ts";
import { machineRemoteKind } from "@/lib/terminal/sessions.ts";
import { markTotpUsed, remoteAuthMethod, requestRemoteAuth } from "@/lib/terminal/totp-auth.ts";
import { PasskeyError } from "@/lib/terminal/webauthn.ts";
import { clampSize } from "@/lib/terminal.ts";
import { useNow } from "@/lib/use-now.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<
  Record<
    | "button"
    | "title"
    | "description"
    | "machine"
    | "noMachines"
    | "cli"
    | "account"
    | "accountAuto"
    | "accountBusy"
    | "folder"
    | "noFolders"
    | "subdir"
    | "subdirHint"
    | "task"
    | "noTask"
    | "prompt"
    | "promptHint"
    | "confirmHint"
    | "unpaired"
    | "pairLink"
    | "totp_not_allowed"
    | "totp_off"
    | "unsupported"
    | "passkeyFailed"
    | "submit"
    | "verifying"
    | "waiting"
    | "cancel",
    string
  >
> = {
  vi: {
    button: "Mở phiên mới",
    title: "Mở phiên mới",
    description:
      "Chạy CLI trên máy của bạn trong thư mục đã cho phép tại máy. Mở xong bạn vào phiên và điều khiển ngay.",
    machine: "Máy",
    noMachines: "Chưa có máy nào đang online và bật điều khiển từ xa. Bật tại ứng dụng desktop trên máy.",
    cli: "CLI",
    account: "Tài khoản",
    accountAuto: "Tự chọn",
    accountBusy: "không dùng được",
    folder: "Thư mục",
    noFolders: "Máy chưa cho phép thư mục nào. Thêm thư mục tại máy (ứng dụng desktop) rồi mở lại.",
    subdir: "Thư mục con (không bắt buộc)",
    subdirHint: "Đường dẫn tương đối trong thư mục trên, ví dụ apps/hub.",
    task: "Task",
    noTask: "Không gắn task",
    prompt: "Lời nhắc đầu tiên (không bắt buộc)",
    promptHint: "Gửi cho CLI ngay khi mở. Lời nhắc được ký cùng yêu cầu nên hub không sửa được.",
    confirmHint: "Máy này hỏi chủ máy bấm Cho phép tại máy trước khi mở (tối đa 60 giây).",
    unpaired: "Thiết bị này chưa ghép với máy nên chưa mở phiên được.",
    pairLink: "Ghép thiết bị",
    totp_not_allowed:
      "Hub chạy HTTP nên trình duyệt không dùng được passkey, và tổ chức không cho dùng mã Authenticator. Bật HTTPS cho hub.",
    totp_off:
      "Hub chạy HTTP nên cần mã Authenticator, nhưng máy chưa bật. Bật mã Authenticator tại máy (ứng dụng desktop) rồi thử lại.",
    unsupported: "Trình duyệt này không hỗ trợ passkey.",
    passkeyFailed: "Không xác thực được bằng passkey.",
    submit: "Xác thực và mở",
    verifying: "Đang xác thực…",
    waiting: "Đang chờ máy mở phiên…",
    cancel: "Thôi",
  },
  en: {
    button: "New session",
    title: "New session",
    description:
      "Run a CLI on your machine in a folder allowed at the machine. Once it opens you go straight into the session with control.",
    machine: "Machine",
    noMachines: "No machine is online with remote control on. Turn it on in the desktop app on the machine.",
    cli: "CLI",
    account: "Account",
    accountAuto: "Automatic",
    accountBusy: "unavailable",
    folder: "Folder",
    noFolders: "The machine has not allowed any folder yet. Add one at the machine (desktop app), then try again.",
    subdir: "Subfolder (optional)",
    subdirHint: "A relative path inside the folder above, for example apps/hub.",
    task: "Task",
    noTask: "No task",
    prompt: "First prompt (optional)",
    promptHint: "Sent to the CLI as it opens. It is signed with the request, so the hub cannot change it.",
    confirmHint: "This machine asks its owner to press Allow at the machine before opening (up to 60 seconds).",
    unpaired: "This device is not paired with the machine yet, so it cannot open sessions.",
    pairLink: "Pair device",
    totp_not_allowed:
      "The hub runs on HTTP so the browser cannot use passkeys, and your organization does not allow Authenticator codes. Enable HTTPS on the hub.",
    totp_off:
      "The hub runs on HTTP so an Authenticator code is needed, but the machine has not turned it on. Turn it on at the machine (desktop app), then try again.",
    unsupported: "This browser does not support passkeys.",
    passkeyFailed: "Passkey verification failed.",
    submit: "Verify and open",
    verifying: "Verifying…",
    waiting: "Waiting for the machine to open the session…",
    cancel: "Never mind",
  },
};

const OPEN_TASK = new Set(["todo", "queued", "running", "awaiting_plan", "review"]);

/** Cỡ PTY ban đầu theo màn (xterm ~7.2 × 17 px ở cỡ chữ 12); vào phiên rồi người điều khiển fit lại bằng `resize` ký. */
function screenSize(): { cols: number; rows: number } {
  return clampSize(Math.floor((window.innerWidth - 32) / 7.2), Math.floor((window.innerHeight * 0.6) / 17));
}

const eligible = (machines: readonly RemoteMachine[]) => machines.filter((m) => machineRemoteKind(m) === "on");

/**
 * Nút "Mở phiên mới" và tấm trượt của nó (specs/010 US4, T052). Hub chỉ chuyển yêu cầu; máy kiểm chữ ký passkey trên
 * đúng các trường của form (`StartParams`), nên mọi giá trị gửi đi phải trùng từng byte với phần đã ký.
 */
export function NewSessionButton({ machines }: { machines: readonly RemoteMachine[] }) {
  const t = useT(text);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="h-11" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        {t.button}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-xl sm:border-x"
        >
          <NewSessionForm machines={machines} onDone={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}

function NewSessionForm({ machines, onDone }: { machines: readonly RemoteMachine[]; onDone: () => void }) {
  const t = useT(text);
  const me = useMe();
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const ids = { machine: useId(), cli: useId(), account: useId(), folder: useId(), subdir: useId() };
  const more = { subdirHint: useId(), task: useId(), prompt: useId(), promptHint: useId() };
  const choices = eligible(machines);
  const [machineId, setMachineId] = useState(choices[0]?.id ?? "");
  const machine = choices.find((m) => m.id === machineId) ?? choices[0];
  const remote = machine?.remote;
  const [pickedCli, setCli] = useState("");
  const cli = remote?.clis.find((c) => c === pickedCli) ?? remote?.clis[0] ?? "";
  const [accountId, setAccountId] = useState("");
  const accounts = remote?.accounts.filter((a) => a.cli === cli) ?? [];
  const account = accounts.find((a) => a.id === accountId && a.state === "ready");
  const [pickedRoot, setRoot] = useState("");
  const root = remote?.roots.find((r) => r.id === pickedRoot) ?? remote?.roots[0];
  const [subdir, setSubdir] = useState("");
  const [taskId, setTaskId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [stage, setStage] = useState<"verify" | "wait">("verify");
  const [code, setCode] = useState("");
  const now = useNow(1000);

  const tasks = useQuery({ ...api.tasks.list.queryOptions({ input: { mine: true } }), staleTime: 60_000 });
  const openTasks = (tasks.data ?? []).filter((task) => OPEN_TASK.has(task.status));
  const task = openTasks.find((x) => x.id === taskId);

  const method = machine ? remoteAuthMethod(machine) : null;
  const problem = method?.kind === "blocked" ? method.reason : null;

  const start = useMutation({
    mutationFn: async () => {
      if (!machine || !root || !method || method.kind === "blocked") throw new Error("form");
      setStage("verify");
      // Giá trị rỗng thì bỏ hẳn: máy dựng lại challenge không có trường đó, gửi chuỗi rỗng sẽ lệch chữ ký.
      const params: Omit<StartParams, "deviceId"> = {
        userId: me.id,
        cli,
        ...(account ? { accountId: account.id } : {}),
        rootId: root.id,
        ...(subdir.trim() ? { subdir: subdir.trim() } : {}),
        ...(task ? { projectId: task.projectId, taskId: task.id } : {}),
        ...(prompt.trim() ? { prompt } : {}),
        ...screenSize(),
      };
      const proof = await requestRemoteAuth({ method, machineId: machine.id, action: "start", params, code });
      setStage("wait");
      const { userId: _, ...fields } = params;
      const input: RemoteStartInput = {
        machineId: machine.id,
        ...fields,
        ...(proof.deviceId ? { deviceId: proof.deviceId } : {}),
        cli: params.cli as RemoteStartInput["cli"],
        auth: proof.auth,
      };
      try {
        const session = await api.remote.start.call(input);
        // Máy nhận mỗi mã một lần: xin quyền gõ ngay sau đó phải chờ mã mới.
        if (proof.code) markTotpUsed();
        return session;
      } catch (e) {
        if (proof.code && apiErrorCode(e) === "TOTP_REPLAY") markTotpUsed();
        throw e;
      }
    },
    onError: () => setCode(""),
    onSuccess: async (session) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: api.remote.list.key() }),
        queryClient.invalidateQueries({ queryKey: api.remote.machines.key() }),
      ]);
      onDone();
      // Mở phiên chưa cấp quyền gõ: trang phiên tự xin quyền (một lần passkey nữa) để vào là gõ được.
      await navigate({ to: "/remote/$id", params: { id: session.id }, search: { control: true } });
    },
  });

  const totp = method?.kind === "totp";
  const ready = !!machine && !!root && !!cli && !problem && (!totp || totpReady(code, now));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (ready && !start.isPending) start.mutate();
  }

  const errorCode = apiErrorCode(start.error);
  const totpError: TotpError | null =
    totp && errorCode?.startsWith("TOTP_") ? { code: errorCode, message: apiErrorMessage(start.error) } : null;
  let error: string | null = null;
  if (totpError) error = null;
  else if (start.error instanceof PasskeyError) error = start.error.message;
  else if (start.error instanceof DOMException) error = t.passkeyFailed;
  else if (start.error) error = apiErrorMessage(start.error);

  let body: ReactNode;
  if (!machine || !remote) body = <Alert>{t.noMachines}</Alert>;
  else {
    body = (
      <>
        <Field id={ids.machine} label={t.machine}>
          <NativeSelect
            id={ids.machine}
            value={machine.id}
            onChange={(e) => {
              setMachineId(e.target.value);
              setCli("");
              setAccountId("");
              setRoot("");
            }}
          >
            {choices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field id={ids.cli} label={t.cli}>
            <NativeSelect
              id={ids.cli}
              value={cli}
              onChange={(e) => {
                setCli(e.target.value);
                setAccountId("");
              }}
            >
              {remote.clis.map((c) => (
                <option key={c} value={c}>
                  {cliLabel(c)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id={ids.account} label={t.account}>
            <NativeSelect id={ids.account} value={account?.id ?? ""} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{t.accountAuto}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id} disabled={a.state !== "ready"}>
                  {a.label}
                  {a.state !== "ready" ? ` (${t.accountBusy})` : ""}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        {root ? (
          <>
            <Field id={ids.folder} label={t.folder}>
              <NativeSelect id={ids.folder} value={root.id} onChange={(e) => setRoot(e.target.value)}>
                {remote.roots.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id={ids.subdir} label={t.subdir}>
              <Input
                id={ids.subdir}
                value={subdir}
                maxLength={500}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="apps/hub"
                aria-describedby={more.subdirHint}
                onChange={(e) => setSubdir(e.target.value)}
              />
              <p id={more.subdirHint} className="text-xs text-muted-foreground">
                {t.subdirHint}
              </p>
            </Field>
          </>
        ) : (
          <Alert>{t.noFolders}</Alert>
        )}
        <Field id={more.task} label={t.task}>
          <NativeSelect id={more.task} value={task?.id ?? ""} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">{t.noTask}</option>
            {openTasks.map((x) => (
              <option key={x.id} value={x.id}>
                {x.key} · {x.title}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id={more.prompt} label={t.prompt}>
          <Textarea
            id={more.prompt}
            rows={3}
            value={prompt}
            maxLength={20_000}
            aria-describedby={more.promptHint}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <p id={more.promptHint} className="text-xs text-muted-foreground">
            {t.promptHint}
          </p>
        </Field>
        {totp && (
          <TotpCodeField value={code} onChange={setCode} error={totpError} lockedUntil={remote.totp.lockedUntil} />
        )}
        {remote.confirmOnMachine && <p className="text-xs text-muted-foreground">{t.confirmHint}</p>}
        {problem && (
          <Alert variant={problem === "unpaired" ? undefined : "destructive"}>
            {t[problem]}
            {problem === "unpaired" && (
              <>
                {" "}
                <Link
                  to="/remote/devices"
                  search={{ machine: machine.id }}
                  className="font-medium text-primary underline"
                >
                  {t.pairLink}
                </Link>
              </>
            )}
          </Alert>
        )}
      </>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid min-w-0 gap-3.5 px-4 pb-4">
      <SheetHeader className="px-0 pr-10">
        <SheetTitle>{t.title}</SheetTitle>
        <SheetDescription>{t.description}</SheetDescription>
      </SheetHeader>
      {body}
      {error && (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" className="h-11" onClick={onDone} disabled={start.isPending}>
          {t.cancel}
        </Button>
        <Button type="submit" className="h-11" disabled={!ready || start.isPending}>
          {start.isPending ? (stage === "verify" ? t.verifying : t.waiting) : t.submit}
        </Button>
      </div>
    </form>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
