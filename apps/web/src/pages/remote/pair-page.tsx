import { ORPCError } from "@orpc/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type RemoteDevice, type RemoteMachine, remoteErrors } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Pill } from "@xdev-hive/ui/pill";
import { ChevronLeftIcon, LockIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { EmptyState, LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { meQuery } from "@/lib/me.ts";
import {
  createPasskey,
  PasskeyError,
  pairProof,
  pairSecretBytes,
  passkeySupport,
  readPairLink,
  rememberDevice,
  scrubPairSecret,
  suggestDeviceLabel,
} from "@/lib/terminal/webauthn.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  back: string;
  title: string;
  description: string;
  steps: [string, string, string];
  machine: string;
  signedInAs: (email: string) => string;
  deviceName: string;
  deviceHint: string;
  submit: string;
  creating: string;
  waiting: string;
  retry: string;
  done: (label: string, machine: string) => string;
  doneHint: string;
  toDevices: string;
  toRemote: string;
  badLinkTitle: string;
  badLinkBody: string;
  notYoursHint: string;
  httpsTitle: string;
  httpsBody: string;
  httpsTotp: string;
  unsupportedTitle: string;
  unsupportedBody: string;
  passkeyFailed: string;
}> = {
  vi: {
    back: "Điều khiển từ xa",
    title: "Ghép điện thoại với máy",
    description: "Thiết bị đã ghép mở và điều khiển được phiên CLI trên máy bằng passkey của chính thiết bị.",
    steps: [
      "Trên máy, mở app desktop → Điều khiển từ xa → Ghép điện thoại, hoặc chạy `hive remote pair`.",
      "Quét mã QR bằng điện thoại này (đã đăng nhập hub).",
      "Xác thực Face ID / vân tay để tạo passkey, rồi bấm Cho phép trên máy.",
    ],
    machine: "Máy",
    signedInAs: (email) => `Đang đăng nhập: ${email}`,
    deviceName: "Tên thiết bị",
    deviceHint: "Tên hiện trong danh sách thiết bị trên máy và trên web.",
    submit: "Tạo passkey và ghép",
    creating: "Đang chờ xác thực passkey trên thiết bị…",
    waiting: "Đang chờ chủ máy bấm Cho phép tại máy (tối đa 60 giây)…",
    retry: "Thử lại",
    done: (label, machine) => `Đã ghép “${label}” với máy ${machine}.`,
    doneHint: "Từ giờ thiết bị này mở được phiên trên máy, mỗi lần đều hỏi Face ID, vân tay hoặc mã máy.",
    toDevices: "Xem thiết bị đã ghép",
    toRemote: "Về Điều khiển từ xa",
    badLinkTitle: "Link ghép không đủ",
    badLinkBody:
      "Link thiếu tên máy, mã ghép hoặc bí mật trong phần sau dấu #. Quét lại mã QR trên máy; mã chỉ dùng một lần và hết hạn sau 10 phút.",
    notYoursHint: "Kiểm tra bạn đang đăng nhập đúng tài khoản và đúng tổ chức của chủ máy.",
    httpsTitle: "Cần hub chạy HTTPS",
    httpsBody:
      "Trình duyệt chỉ tạo passkey trên trang HTTPS. Hub này đang chạy HTTP nên không ghép được điện thoại. Nhờ quản trị bật HTTPS cho hub rồi quét lại mã QR.",
    httpsTotp:
      "Nếu tổ chức cho phép, chủ máy có thể bật mã Authenticator (TOTP) tại máy để dùng tạm trong mạng nội bộ.",
    unsupportedTitle: "Trình duyệt không hỗ trợ passkey",
    unsupportedBody: "Mở link bằng Safari, Chrome hoặc Edge bản mới trên điện thoại rồi thử lại.",
    passkeyFailed: "Không tạo được passkey trên thiết bị này.",
  },
  en: {
    back: "Remote control",
    title: "Pair this phone with a machine",
    description: "A paired device can open and control CLI sessions on the machine with its own passkey.",
    steps: [
      "On the machine, open the desktop app → Remote control → Pair phone, or run `hive remote pair`.",
      "Scan the QR code with this phone (signed in to the hub).",
      "Confirm with Face ID / fingerprint to create a passkey, then tap Allow on the machine.",
    ],
    machine: "Machine",
    signedInAs: (email) => `Signed in as ${email}`,
    deviceName: "Device name",
    deviceHint: "Shown in the device list on the machine and on the web.",
    submit: "Create passkey and pair",
    creating: "Waiting for passkey confirmation on this device…",
    waiting: "Waiting for the owner to tap Allow at the machine (up to 60 seconds)…",
    retry: "Try again",
    done: (label, machine) => `Paired “${label}” with ${machine}.`,
    doneHint:
      "This device can now open sessions on the machine; each time it asks for Face ID, fingerprint or passcode.",
    toDevices: "See paired devices",
    toRemote: "Back to Remote control",
    badLinkTitle: "Incomplete pairing link",
    badLinkBody:
      "The link is missing the machine name, pairing code or the secret after #. Scan the QR code on the machine again; it works once and expires after 10 minutes.",
    notYoursHint: "Check that you are signed in with the right account and organization of the machine owner.",
    httpsTitle: "The hub needs HTTPS",
    httpsBody:
      "Browsers only create passkeys on HTTPS pages. This hub runs on HTTP, so a phone cannot be paired. Ask an admin to enable HTTPS for the hub, then scan the QR code again.",
    httpsTotp:
      "If the organization allows it, the owner can turn on the Authenticator code (TOTP) at the machine for use on an internal network.",
    unsupportedTitle: "This browser does not support passkeys",
    unsupportedBody: "Open the link in a recent Safari, Chrome or Edge on your phone and try again.",
    passkeyFailed: "Could not create a passkey on this device.",
  },
};

type Phase = "idle" | "creating" | "waiting";

/** Machine trong hello là tên máy; máy cũ có thể đặt id làm tên, nên khớp cả hai. */
const findMachine = (machines: readonly RemoteMachine[], name: string) =>
  machines.find((m) => m.name === name) ?? machines.find((m) => m.id === name);

function Back() {
  const t = useT(text);
  return (
    <Link to="/remote" className="inline-flex items-center gap-0.5 text-primary hover:text-primary/90">
      <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
      {t.back}
    </Link>
  );
}

function Steps() {
  const t = useT(text);
  return (
    <ol className="grid list-decimal gap-1.5 ps-5 text-sm text-muted-foreground">
      {t.steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

/** Trang báo cần HTTPS: không có secure context thì không có WebAuthn, mọi nút ghép đều vô ích. */
export function HttpsRequired() {
  const t = useT(text);
  return (
    <EmptyState
      icon={LockIcon}
      title={t.httpsTitle}
      description={
        <span className="grid gap-2">
          <span>{t.httpsBody}</span>
          <span>{t.httpsTotp}</span>
        </span>
      }
    />
  );
}

/**
 * Trang mở từ mã QR của máy (`/remote/pair?m=&p=#s=`). Bí mật ghép chỉ sống trong bộ nhớ trang: đọc từ fragment rồi xoá
 * khỏi thanh địa chỉ ngay, tag tính tại đây nên hub không biết bí mật và không thay được khoá công khai (FR-014).
 */
export function RemotePairPage() {
  const t = useT(text);
  // Đọc trong lúc render (không tác dụng phụ) để StrictMode gọi hai lần vẫn thấy cùng giá trị; xoá URL ở effect.
  const [link] = useState(() => readPairLink(window.location.href, sessionStorage));
  const [support] = useState(passkeySupport);
  useEffect(() => scrubPairSecret(link.pairId), [link.pairId]);

  const complete = link.machine && link.pairId && link.secret;
  return (
    <>
      <PageHeader crumb={<Back />} title={t.title} description={t.description} width="form" />
      <PageBody width="form">
        {support === "insecure" ? (
          <HttpsRequired />
        ) : support === "unsupported" ? (
          <EmptyState icon={LockIcon} title={t.unsupportedTitle} description={t.unsupportedBody} />
        ) : !complete ? (
          <section aria-labelledby="pair-bad-link" className="grid gap-3 rounded-md border border-border bg-card p-4">
            <h2 id="pair-bad-link" className="font-heading text-base font-semibold">
              {t.badLinkTitle}
            </h2>
            <p className="text-sm text-muted-foreground">{t.badLinkBody}</p>
            <Steps />
          </section>
        ) : (
          <PairForm machineName={link.machine} pairId={link.pairId} secret={link.secret ?? ""} />
        )}
      </PageBody>
    </>
  );
}

function PairForm({ machineName, pairId, secret }: { machineName: string; pairId: string; secret: string }) {
  const t = useT(text);
  const { api } = useOrg();
  const me = useQuery(meQuery);
  const machines = useQuery(api.remote.machines.queryOptions());
  const nameId = useId();
  const hintId = useId();
  const [label, setLabel] = useState(() => suggestDeviceLabel(navigator.userAgent));
  const [phase, setPhase] = useState<Phase>("idle");
  const [paired, setPaired] = useState<RemoteDevice | null>(null);

  const pair = useMutation({
    mutationFn: async (machine: RemoteMachine) => {
      const bytes = pairSecretBytes(secret);
      if (!bytes) throw new Error(t.badLinkBody);
      setPhase("creating");
      const options = await api.remote.pairOptions.call({ machineId: machine.id, pairId });
      const passkey = await createPasskey(options.publicKey);
      const proof = await pairProof({ secret: bytes, pairId, userId: options.userId, passkey });
      setPhase("waiting");
      const device = await api.remote.pairComplete.call({ machineId: machine.id, label: label.trim(), ...proof });
      rememberDevice(machine.id, { deviceId: device.id, credentialId: passkey.credentialId });
      return device;
    },
    onSuccess: setPaired,
    onSettled: () => setPhase("idle"),
  });

  if (machines.isPending) return <LoadingState />;
  if (machines.isError) return <LoadFailure error={machines.error} retry={machines.refetch} />;
  const machine = findMachine(machines.data, machineName);

  if (!machine) {
    return (
      <div className="grid gap-3">
        <Alert variant="destructive">{remoteErrors.MACHINE_NOT_YOURS}</Alert>
        <p className="text-sm text-muted-foreground">
          {t.notYoursHint}
          {me.data && ` ${t.signedInAs(me.data.email)}.`}
        </p>
      </div>
    );
  }

  if (paired) {
    return (
      <div className="grid gap-3">
        <Alert role="status">{t.done(paired.label, machine.name)}</Alert>
        <p className="text-sm text-muted-foreground">{t.doneHint}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            className="h-11"
            nativeButton={false}
            role="link"
            render={<Link to="/remote/devices" search={{ machine: machine.id }} />}
          >
            {t.toDevices}
          </Button>
          <Button variant="outline" className="h-11" nativeButton={false} role="link" render={<Link to="/remote" />}>
            {t.toRemote}
          </Button>
        </div>
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pair.isPending && label.trim()) pair.mutate(machine);
  };

  return (
    <form
      onSubmit={submit}
      className="grid gap-4 rounded-md border border-border bg-card p-4"
      aria-busy={pair.isPending}
    >
      <Steps />
      <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t.machine}:</span>
        <strong className="min-w-0 font-medium break-words">{machine.name}</strong>
        {!machine.online && <Pill tone="neutral">Offline</Pill>}
      </p>
      <div className="grid gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium">
          {t.deviceName}
        </label>
        <Input
          id={nameId}
          name="device-name"
          autoComplete="off"
          maxLength={80}
          required
          value={label}
          aria-describedby={hintId}
          disabled={pair.isPending}
          onChange={(event) => setLabel(event.target.value)}
          className="h-11"
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {t.deviceHint}
        </p>
      </div>
      {pair.isError && <Alert variant="destructive">{pairErrorMessage(pair.error, t.passkeyFailed)}</Alert>}
      <Button type="submit" className="h-11 w-full" disabled={pair.isPending || !label.trim()}>
        {pair.isError ? t.retry : t.submit}
      </Button>
      {phase !== "idle" && (
        <p role="status" className="text-sm text-muted-foreground">
          {phase === "creating" ? t.creating : t.waiting}
        </p>
      )}
    </form>
  );
}

/** Lỗi của hub đã có câu tiếng Việt (`remoteErrors`); lỗi passkey có câu riêng; lỗi lạ của trình duyệt thì nói chung. */
function pairErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ORPCError) return apiErrorMessage(error);
  if (error instanceof PasskeyError) return error.message;
  if (error instanceof Error && error.name === "InvalidStateError") return remoteErrors.PAIR_EXPIRED;
  return fallback;
}
