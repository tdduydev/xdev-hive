import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import type { RemoteDevice, RemoteMachine } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { ChevronLeftIcon, SmartphoneIcon } from "lucide-react";
import { useState } from "react";
import { EmptyState, LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatAgo, formatDay } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { pairedDevices, rememberDevice } from "@/lib/terminal/webauthn.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  back: string;
  title: string;
  description: string;
  pairNew: string;
  allMachines: string;
  noMachines: string;
  noDevices: string;
  online: string;
  offline: string;
  offlineHint: string;
  thisDevice: string;
  synced: string;
  pairedAt: (day: string) => string;
  lastUsed: (ago: string) => string;
  neverUsed: string;
  revoke: string;
  revoking: string;
  keep: string;
  revokeTitle: (label: string) => string;
  revokeBody: (machine: string) => string;
  revokeSynced: string;
  revokeThis: string;
}> = {
  vi: {
    back: "Điều khiển từ xa",
    title: "Thiết bị đã ghép",
    description: "Chỉ thêm thiết bị mới được tại máy. Gỡ thiết bị ở đây hoặc trên máy.",
    pairNew: "Ghép thiết bị mới",
    allMachines: "Xem mọi máy",
    noMachines: "Chưa có máy cá nhân nào. Cài và chạy hive-worker trên máy để máy hiện ở đây.",
    noDevices: "Chưa ghép thiết bị nào với máy này.",
    online: "Online",
    offline: "Offline",
    offlineHint: "Máy đang offline: gỡ thiết bị cần máy online để máy xoá passkey.",
    thisDevice: "Thiết bị này",
    synced: "Passkey đồng bộ",
    pairedAt: (day) => `Ghép ngày ${day}`,
    lastUsed: (ago) => `dùng lần cuối ${ago}`,
    neverUsed: "chưa dùng",
    revoke: "Gỡ thiết bị",
    revoking: "Đang gỡ…",
    keep: "Giữ lại",
    revokeTitle: (label) => `Gỡ “${label}”?`,
    revokeBody: (machine) =>
      `Thiết bị này sẽ không mở hay điều khiển được phiên trên ${machine} nữa. Muốn dùng lại phải ghép lại tại máy.`,
    revokeSynced:
      "Đây là passkey đồng bộ (iCloud, Google): gỡ là gỡ trên mọi thiết bị dùng chung tài khoản đó, không chỉ thiết bị này.",
    revokeThis: "Đây là thiết bị bạn đang dùng.",
  },
  en: {
    back: "Remote control",
    title: "Paired devices",
    description: "New devices can only be added at the machine. Remove devices here or on the machine.",
    pairNew: "Pair a new device",
    allMachines: "Show all machines",
    noMachines: "No personal machines yet. Install and run hive-worker on a machine to see it here.",
    noDevices: "No devices paired with this machine yet.",
    online: "Online",
    offline: "Offline",
    offlineHint: "The machine is offline: removing a device needs the machine online so it can delete the passkey.",
    thisDevice: "This device",
    synced: "Synced passkey",
    pairedAt: (day) => `Paired ${day}`,
    lastUsed: (ago) => `last used ${ago}`,
    neverUsed: "never used",
    revoke: "Remove device",
    revoking: "Removing…",
    keep: "Keep",
    revokeTitle: (label) => `Remove “${label}”?`,
    revokeBody: (machine) =>
      `This device will no longer open or control sessions on ${machine}. To use it again, pair it at the machine.`,
    revokeSynced:
      "This is a synced passkey (iCloud, Google): removing it removes it on every device sharing that account, not just this one.",
    revokeThis: "This is the device you are using.",
  },
};

/**
 * Thiết bị đã ghép theo từng máy (spec 010). Ghép chỉ bắt đầu tại máy (FR-012) nên trang chỉ có gỡ; nút ghép mới dẫn tới
 * hướng dẫn quét mã QR.
 */
export function RemoteDevicesPage() {
  const t = useT(text);
  const { api } = useOrg();
  const { machine: only } = useSearch({ from: "/session/app/in-org/remote/devices" });
  const machines = useQuery(api.remote.machines.queryOptions());
  const shown = machines.data?.filter((m) => !only || m.id === only) ?? [];

  return (
    <>
      <PageHeader
        crumb={
          <Link to="/remote" className="inline-flex items-center gap-0.5 text-primary hover:text-primary/90">
            <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
            {t.back}
          </Link>
        }
        title={t.title}
        description={t.description}
        width="wide"
      >
        <Button variant="outline" className="h-11" nativeButton={false} role="link" render={<Link to="/remote/pair" />}>
          {t.pairNew}
        </Button>
      </PageHeader>
      <PageBody width="wide">
        {machines.isPending && <LoadingState />}
        {machines.isError && <LoadFailure error={machines.error} retry={machines.refetch} />}
        {machines.data?.length === 0 && <EmptyState icon={SmartphoneIcon} title={t.title} description={t.noMachines} />}
        {shown.map((machine) => (
          <MachineDevices key={machine.id} machine={machine} />
        ))}
        {only && machines.data && machines.data.length > shown.length && (
          <Link to="/remote/devices" search={{}} className="text-sm text-primary hover:text-primary/90">
            {t.allMachines}
          </Link>
        )}
      </PageBody>
    </>
  );
}

function MachineDevices({ machine }: { machine: RemoteMachine }) {
  const t = useT(text);
  const lang = useLang();
  const { api } = useOrg();
  const devices = useQuery(api.remote.devices.queryOptions({ input: { machineId: machine.id } }));
  const [target, setTarget] = useState<RemoteDevice | null>(null);
  const mine = pairedDevices()[machine.id]?.deviceId;
  const headingId = `devices-${machine.id}`;
  const now = Date.now();

  return (
    <section aria-labelledby={headingId} className="grid min-w-0 content-start gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 id={headingId} className="min-w-0 font-heading text-lg font-semibold break-words">
          {machine.name}
        </h2>
        <Pill tone={machine.online ? "ok" : "neutral"} dot>
          {machine.online ? t.online : t.offline}
        </Pill>
      </div>
      {!machine.online && <p className="text-xs text-muted-foreground">{t.offlineHint}</p>}
      {devices.isPending && <LoadingState />}
      {devices.isError && <LoadFailure error={devices.error} retry={devices.refetch} />}
      {devices.data?.length === 0 && <p className="text-sm text-muted-foreground">{t.noDevices}</p>}
      {devices.data && devices.data.length > 0 && (
        <ul className="grid min-w-0 gap-2">
          {devices.data.map((device) => (
            <li
              key={device.id}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-card p-3 text-sm"
            >
              <div className="grid min-w-0 flex-1 basis-48 gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <strong className="min-w-0 font-medium break-words">{device.label}</strong>
                  {device.id === mine && <Pill tone="sel">{t.thisDevice}</Pill>}
                  {device.synced && <Pill tone="warn">{t.synced}</Pill>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {[
                    device.createdAt && t.pairedAt(formatDay(device.createdAt, lang)),
                    device.lastUsedAt ? t.lastUsed(formatAgo(device.lastUsedAt, now, lang)) : t.neverUsed,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <Button
                variant="outline"
                className="h-11"
                disabled={!machine.online}
                aria-label={`${t.revoke}: ${device.label}`}
                onClick={() => setTarget(device)}
              >
                {t.revoke}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <RevokeDialog machine={machine} device={target} isThis={target?.id === mine} onClose={() => setTarget(null)} />
    </section>
  );
}

function RevokeDialog({
  machine,
  device,
  isThis,
  onClose,
}: {
  machine: RemoteMachine;
  device: RemoteDevice | null;
  isThis: boolean;
  onClose: () => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: (deviceId: string) => api.remote.revokeDevice.call({ machineId: machine.id, deviceId }),
    onSuccess: () => {
      if (isThis) rememberDevice(machine.id, null);
      onClose();
      return queryClient.invalidateQueries({ queryKey: api.remote.devices.key() });
    },
  });
  const close = () => {
    revoke.reset();
    onClose();
  };

  return (
    <Dialog
      open={device !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {device && (
        // Gỡ không hoàn tác được (phải ghép lại tại máy), nên hộp thoại là alertdialog.
        <DialogContent role="alertdialog">
          <DialogTitle>{t.revokeTitle(device.label)}</DialogTitle>
          <DialogDescription>{t.revokeBody(machine.name)}</DialogDescription>
          {isThis && <p className="text-sm">{t.revokeThis}</p>}
          {device.synced && <Alert>{t.revokeSynced}</Alert>}
          {revoke.isError && <Alert variant="destructive">{apiErrorMessage(revoke.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" className="h-11" onClick={close}>
              {t.keep}
            </Button>
            <Button
              variant="destructive-solid"
              className="h-11"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(device.id)}
            >
              {revoke.isPending ? t.revoking : t.revoke}
            </Button>
          </DialogActions>
        </DialogContent>
      )}
    </Dialog>
  );
}
