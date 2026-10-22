import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DeployServer, ServerTestResult } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { DialogActions, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { type FormEvent, useState } from "react";
import { CopyField } from "@/components/copy-field.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { useOrg } from "@/shell/org-context.ts";

const VI = {
  addTitle: "Thêm máy chủ",
  editTitle: "Sửa máy chủ",
  formLead:
    "Hub kết nối vào máy chủ bằng SSH để triển khai. Sau khi thêm, hub sinh một khoá và đưa lệnh để bạn cài khoá lên máy chủ.",
  team: "Đội",
  teamNone: "Chọn đội",
  name: "Tên",
  namePh: "vd. app-staging",
  host: "Địa chỉ",
  hostPh: "server.example.com",
  port: "Cổng SSH",
  user: "User SSH",
  userPh: "deploy",
  labels: "Nhãn",
  labelsHint: "Cách nhau bằng dấu phẩy, vd. staging, docker.",
  hostChangeHint: "Đổi địa chỉ hoặc cổng thì phải kiểm kết nối và xác nhận lại dấu vân tay.",
  cancel: "Huỷ",
  close: "Đóng",
  save: "Lưu",
  saving: "Đang lưu…",
  required: "Không được để trống.",
  portBad: "Cổng là số từ 1 đến 65535.",
  keyTitle: (name: string) => `Khoá SSH của ${name}`,
  keyLead:
    "Cài khoá công khai này vào authorized_keys của user SSH trên máy chủ. Chạy lệnh dưới đây trên máy chủ rồi bấm Kiểm kết nối.",
  publicKey: "Khoá công khai",
  copyPublicKey: "khoá công khai",
  installCommand: "Lệnh cài khoá",
  copyInstall: "lệnh cài khoá",
  fpTitle: (name: string) => `Xác nhận dấu vân tay của ${name}`,
  fpLead:
    "Hub chưa chạy lệnh nào. So dấu vân tay dưới đây với dấu vân tay thật của máy chủ (chạy ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub trên máy chủ) rồi xác nhận.",
  fpConfirm: "Xác nhận dấu vân tay này",
  fpConfirming: "Đang xác nhận…",
  fpChangedLead:
    "Host key của máy chủ đã khác với dấu vân tay đã xác nhận. Chỉ xác nhận lại khi bạn biết máy chủ vừa được cài lại.",
  rotateTitle: (name: string) => `Đổi khoá của ${name}`,
  rotateStep1: "Bước 1 trên 2: sinh khoá mới",
  rotateStep1Lead: "Hub sinh một khoá mới. Khoá cũ vẫn dùng được cho tới khi bạn xác nhận ở bước 2.",
  rotateGen: "Sinh khoá mới",
  rotateGenerating: "Đang sinh…",
  rotateStep2: "Bước 2 trên 2: cài khoá mới rồi thay",
  rotateStep2Lead:
    "Cài khoá mới lên máy chủ (thêm vào authorized_keys, chưa xoá khoá cũ). Hub sẽ kiểm bằng khoá mới, thành công mới thay khoá cũ.",
  rotateConfirm: "Kiểm khoá mới và thay",
  rotateConfirming: "Đang kiểm…",
  removeTitle: (name: string) => `Xoá máy chủ ${name}?`,
  removeLead: "Hub xoá máy chủ và khoá của nó. Đích triển khai đang dùng máy chủ này sẽ không chạy được nữa.",
  remove: "Xoá máy chủ",
  removing: "Đang xoá…",
  testOk: "Kết nối được",
  testKeyPending: "bằng khoá mới",
  errNetwork: "Hub không kết nối được máy chủ. Kiểm tra địa chỉ, cổng và tường lửa giữa hub và máy chủ.",
  errAuth: "Máy chủ không nhận khoá SSH của hub. Kiểm tra khoá công khai trong authorized_keys và user SSH.",
  errHostKey:
    "Host key của máy chủ đã đổi. Hub dừng, không chạy lệnh nào. Quản trị kiểm máy chủ rồi xác nhận lại dấu vân tay.",
  unconfirmed: "Chưa xác nhận dấu vân tay của máy chủ. Hub chưa chạy lệnh nào.",
  confirmFp: "Xác nhận dấu vân tay",
  confirmFpFor: (name: string) => `Xác nhận dấu vân tay của ${name}`,
  fingerprint: "Dấu vân tay",
};

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

// ---- Kiểm kết nối ---------------------------------------------------------------------------------------------------

export type TestState = ServerTestResult | string;

/** Kết quả nút Kiểm kết nối theo từng máy chủ; lỗi gọi hub hiện bằng một câu tiếng Việt, không làm mất dòng. */
export function useServerTest() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [results, setResults] = useState<Record<string, TestState>>({});
  const test = useMutation({
    mutationFn: (id: string) => api.servers.test.call({ id }),
    onSuccess: async (result, id) => {
      setResults((r) => ({ ...r, [id]: result }));
      await queryClient.invalidateQueries({ queryKey: api.servers.key() });
    },
    onError: (error, id) => setResults((r) => ({ ...r, [id]: apiErrorMessage(error) })),
  });
  return { results, test };
}

export function TestResultView({
  server,
  result,
  onConfirm,
}: {
  server: DeployServer;
  result: TestState;
  onConfirm: (fingerprints: string[]) => void;
}) {
  if (typeof result === "string")
    return (
      <p role="alert" className="pt-2 text-xs text-destructive">
        Kiểm kết nối {server.name}: {result}
      </p>
    );
  if (result.result === "ok") {
    const facts = [
      result.os,
      result.docker && `Docker ${result.docker}`,
      result.compose && `Compose ${result.compose}`,
      result.diskFreeBytes !== null && `Trống ${formatBytes(result.diskFreeBytes)}`,
    ].filter((x): x is string => typeof x === "string" && x !== "");
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-muted-foreground">
        <span className="sr-only">Kiểm kết nối {server.name}:</span>
        <Pill tone="ok" small>
          {VI.testOk}
        </Pill>
        {result.key === "pending" && <span>{VI.testKeyPending}</span>}
        {facts.map((f) => (
          <span key={f}>{f}</span>
        ))}
        <span className="font-mono break-all">{result.fingerprint}</span>
      </div>
    );
  }
  if (result.result === "hostkey_unconfirmed")
    return (
      <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-destructive">
        <span>{VI.unconfirmed}</span>
        <Button
          variant="outline"
          size="sm"
          aria-label={VI.confirmFpFor(server.name)}
          onClick={() => onConfirm(result.fingerprints)}
        >
          {VI.confirmFp}
        </Button>
      </div>
    );
  const sentence = result.kind === "network" ? VI.errNetwork : result.kind === "auth" ? VI.errAuth : VI.errHostKey;
  return (
    <div role="alert" className="grid justify-items-start gap-1 pt-2 text-xs text-destructive">
      <span>{sentence}</span>
      {result.fingerprint && <span className="font-mono break-all">{result.fingerprint}</span>}
      {result.kind === "hostkey_changed" && result.fingerprint && (
        <Button
          variant="outline"
          size="sm"
          aria-label={VI.confirmFpFor(server.name)}
          onClick={() => onConfirm([result.fingerprint as string])}
        >
          {VI.confirmFp}
        </Button>
      )}
    </div>
  );
}

// ---- Thêm, sửa ------------------------------------------------------------------------------------------------------

type FieldErrors = Partial<Record<"teamId" | "name" | "host" | "port" | "user" | "labels", string>>;

function splitLabels(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((l) => l.trim())
        .filter((l) => l !== ""),
    ),
  ];
}

export function ServerForm({
  server,
  teams,
  defaultTeamId,
  onDone,
  onCreated,
}: {
  server: DeployServer | null;
  teams: { id: string; name: string }[];
  defaultTeamId: string;
  onDone: () => void;
  onCreated: (server: DeployServer) => void;
}) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (v: { teamId: string; name: string; host: string; port: number; user: string; labels: string[] }) =>
      server
        ? api.servers.update.call({
            id: server.id,
            name: v.name,
            host: v.host,
            port: v.port,
            user: v.user,
            labels: v.labels,
          })
        : api.servers.create.call(v),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: api.servers.key() });
      if (server) onDone();
      else onCreated(saved);
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (
        field === "teamId" ||
        field === "name" ||
        field === "host" ||
        field === "port" ||
        field === "user" ||
        field === "labels"
      )
        setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = new FormData(ev.currentTarget);
    const get = (key: string) => String(form.get(key) ?? "").trim();
    const teamId = server?.teamId ?? get("teamId");
    const name = get("name");
    const host = get("host");
    const user = get("user");
    const port = Number(get("port"));
    const next: FieldErrors = {};
    if (!teamId) next.teamId = VI.required;
    if (!name) next.name = VI.required;
    if (!host) next.host = VI.required;
    if (!user) next.user = VI.required;
    if (!Number.isInteger(port) || port < 1 || port > 65535) next.port = VI.portBad;
    setFailure(null);
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate({ teamId, name, host, port, user, labels: splitLabels(get("labels")) });
  }

  const busy = save.isPending;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{server ? VI.editTitle : VI.addTitle}</DialogTitle>
      <DialogDescription>{VI.formLead}</DialogDescription>
      {!server && (
        <Field invalid={errors.teamId !== undefined}>
          <FieldLabel>{VI.team}</FieldLabel>
          <NativeSelect
            name="teamId"
            aria-label={VI.team}
            defaultValue={defaultTeamId}
            disabled={busy}
            className="w-full"
          >
            <NativeSelectOption value="">{VI.teamNone}</NativeSelectOption>
            {teams.map((t) => (
              <NativeSelectOption key={t.id} value={t.id}>
                {t.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {errors.teamId && <FieldError>{errors.teamId}</FieldError>}
        </Field>
      )}
      <Field invalid={errors.name !== undefined}>
        <FieldLabel>{VI.name}</FieldLabel>
        <Input
          name="name"
          defaultValue={server?.name}
          placeholder={VI.namePh}
          disabled={busy}
          autoComplete="off"
          autoFocus
        />
        {errors.name && <FieldError>{errors.name}</FieldError>}
      </Field>
      <Field invalid={errors.host !== undefined}>
        <FieldLabel>{VI.host}</FieldLabel>
        <Input
          name="host"
          defaultValue={server?.host}
          placeholder={VI.hostPh}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        {errors.host ? (
          <FieldError>{errors.host}</FieldError>
        ) : server ? (
          <FieldHint>{VI.hostChangeHint}</FieldHint>
        ) : null}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field invalid={errors.port !== undefined}>
          <FieldLabel>{VI.port}</FieldLabel>
          <Input
            name="port"
            defaultValue={server?.port ?? 22}
            inputMode="numeric"
            disabled={busy}
            autoComplete="off"
            className="font-mono"
          />
          {errors.port && <FieldError>{errors.port}</FieldError>}
        </Field>
        <Field invalid={errors.user !== undefined}>
          <FieldLabel>{VI.user}</FieldLabel>
          <Input
            name="user"
            defaultValue={server?.user}
            placeholder={VI.userPh}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          {errors.user && <FieldError>{errors.user}</FieldError>}
        </Field>
      </div>
      <Field invalid={errors.labels !== undefined}>
        <FieldLabel>{VI.labels}</FieldLabel>
        <Input name="labels" defaultValue={server?.labels.join(", ")} disabled={busy} autoComplete="off" />
        {errors.labels ? <FieldError>{errors.labels}</FieldError> : <FieldHint>{VI.labelsHint}</FieldHint>}
      </Field>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {VI.cancel}
        </Button>
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? VI.saving : VI.save}
        </Button>
      </DialogActions>
    </form>
  );
}

// ---- Khoá công khai và lệnh cài -------------------------------------------------------------------------------------

export function KeyView({ server, onDone }: { server: DeployServer; onDone: () => void }) {
  return (
    <div className="grid gap-3.5">
      <DialogTitle>{VI.keyTitle(server.name)}</DialogTitle>
      <DialogDescription>{VI.keyLead}</DialogDescription>
      <Field>
        <FieldLabel>{VI.publicKey}</FieldLabel>
        <CopyField value={server.publicKey} copyLabel={VI.copyPublicKey} />
      </Field>
      <Field>
        <FieldLabel>{VI.installCommand}</FieldLabel>
        <CopyField value={server.installCommand} copyLabel={VI.copyInstall} />
      </Field>
      <DialogActions>
        <Button variant="default" onClick={onDone}>
          {VI.close}
        </Button>
      </DialogActions>
    </div>
  );
}

// ---- Xác nhận dấu vân tay -------------------------------------------------------------------------------------------

export function FingerprintConfirm({
  server,
  fingerprints,
  changed,
  onConfirmed,
  onDone,
}: {
  server: DeployServer;
  fingerprints: string[];
  changed: boolean;
  onConfirmed: () => void;
  onDone: () => void;
}) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const confirm = useMutation({
    mutationFn: (fingerprint: string) => api.servers.confirmHostKey.call({ id: server.id, fingerprint }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.servers.key() });
      onConfirmed();
    },
    onError: (error) => setFailure(apiErrorMessage(error)),
  });
  return (
    <div className="grid gap-3.5">
      <DialogTitle>{VI.fpTitle(server.name)}</DialogTitle>
      <DialogDescription>{changed ? VI.fpChangedLead : VI.fpLead}</DialogDescription>
      <ul className="grid gap-2">
        {fingerprints.map((fp) => (
          <li key={fp} className="grid gap-2 rounded-lg border border-border p-3">
            <span className="text-xs text-muted-foreground">{VI.fingerprint}</span>
            <code className="font-mono text-sm break-all">{fp}</code>
            <div>
              <Button variant="default" size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate(fp)}>
                {confirm.isPending ? VI.fpConfirming : VI.fpConfirm}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {VI.cancel}
        </Button>
      </DialogActions>
    </div>
  );
}

// ---- Đổi khoá, hai bước ---------------------------------------------------------------------------------------------

/** Không giữ trạng thái bước: bước suy ra từ `server.pendingKey`, nên mở lại hộp thoại vẫn đúng bước. */
export function RotateKey({ server, onDone }: { server: DeployServer; onDone: () => void }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.servers.key() });
  const generate = useMutation({
    mutationFn: () => api.servers.rotateKey.call({ id: server.id }),
    onSuccess: refresh,
    onError: (error) => setFailure(apiErrorMessage(error)),
  });
  const confirm = useMutation({
    mutationFn: () => api.servers.confirmRotation.call({ id: server.id }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: (error) => setFailure(apiErrorMessage(error)),
  });
  const pending = server.pendingKey;
  return (
    <div className="grid gap-3.5">
      <DialogTitle>{VI.rotateTitle(server.name)}</DialogTitle>
      <DialogDescription>{pending ? VI.rotateStep2Lead : VI.rotateStep1Lead}</DialogDescription>
      <p className="text-sm font-medium text-foreground">{pending ? VI.rotateStep2 : VI.rotateStep1}</p>
      {pending && (
        <>
          <Field>
            <FieldLabel>{VI.publicKey}</FieldLabel>
            <CopyField value={pending.publicKey} copyLabel="khoá công khai mới" />
          </Field>
          <Field>
            <FieldLabel>{VI.installCommand}</FieldLabel>
            <CopyField value={pending.installCommand} copyLabel="lệnh cài khoá mới" />
          </Field>
        </>
      )}
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {VI.close}
        </Button>
        {pending ? (
          <Button
            variant="default"
            disabled={confirm.isPending}
            onClick={() => {
              setFailure(null);
              confirm.mutate();
            }}
          >
            {confirm.isPending ? VI.rotateConfirming : VI.rotateConfirm}
          </Button>
        ) : (
          <Button
            variant="default"
            disabled={generate.isPending}
            onClick={() => {
              setFailure(null);
              generate.mutate();
            }}
          >
            {generate.isPending ? VI.rotateGenerating : VI.rotateGen}
          </Button>
        )}
      </DialogActions>
    </div>
  );
}

// ---- Xoá ------------------------------------------------------------------------------------------------------------

export function RemoveServer({ server, onDone }: { server: DeployServer; onDone: () => void }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => api.servers.remove.call({ id: server.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.servers.key() });
      onDone();
    },
    onError: (error) => setFailure(apiErrorMessage(error)),
  });
  return (
    <div className="grid gap-3.5">
      <DialogTitle>{VI.removeTitle(server.name)}</DialogTitle>
      <DialogDescription>{VI.removeLead}</DialogDescription>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {VI.cancel}
        </Button>
        <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? VI.removing : VI.remove}
        </Button>
      </DialogActions>
    </div>
  );
}
