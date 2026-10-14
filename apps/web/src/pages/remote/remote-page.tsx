import { useQuery } from "@tanstack/react-query";
import type { RemoteMachine } from "@xdev-hive/contracts";
import { Pill } from "@xdev-hive/ui/pill";
import { SmartphoneIcon } from "lucide-react";
import { EmptyState, LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import {
  groupSessions,
  MACHINE_KIND_TONE,
  type MachineRemoteKind,
  machineRemoteKind,
} from "@/lib/terminal/sessions.ts";
import { isLive } from "@/lib/terminal.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";
import { RemoteSessionRow } from "./session-row.tsx";

const text: Dict<
  Record<
    "title" | "description" | "machines" | "sessions" | "live" | "ended" | "emptyTitle" | "emptyBody" | "noMachines",
    string
  >
> = {
  vi: {
    title: "Điều khiển từ xa",
    description:
      "Xem và phát lại phiên CLI chạy trên máy của bạn. Bật điều khiển từ xa và ghép điện thoại làm tại máy.",
    machines: "Máy của tôi",
    sessions: "Phiên",
    live: "Đang chạy",
    ended: "Đã kết thúc",
    emptyTitle: "Chưa có phiên nào",
    emptyBody: "Chạy `hive` trên máy của bạn để mở phiên. Phiên xuất hiện ở đây và xem lại được bằng bản ghi.",
    noMachines: "Chưa có máy cá nhân nào. Cài và chạy hive-worker trên máy để máy hiện ở đây.",
  },
  en: {
    title: "Remote control",
    description:
      "View and replay the CLI sessions running on your machines. Turning remote control on and pairing a phone is done at the machine.",
    machines: "My machines",
    sessions: "Sessions",
    live: "Running",
    ended: "Ended",
    emptyTitle: "No sessions yet",
    emptyBody: "Run `hive` on your machine to open one. Sessions show up here and can be replayed from the recording.",
    noMachines: "No personal machines yet. Install and run hive-worker on a machine to see it here.",
  },
};

const KIND: Record<MachineRemoteKind, { label: Dict<string>; hint: Dict<string> }> = {
  offline: {
    label: { vi: "Offline", en: "Offline" },
    hint: {
      vi: "Máy đang offline. Mở hive-worker trên máy để xem phiên đang chạy.",
      en: "The machine is offline. Start hive-worker on it to see running sessions.",
    },
  },
  unsupported: {
    label: { vi: "Cần cập nhật worker", en: "Worker update needed" },
    hint: {
      vi: "Worker trên máy chưa hỗ trợ phiên tương tác. Chạy `hive-worker update`.",
      en: "The worker on this machine does not support interactive sessions. Run `hive-worker update`.",
    },
  },
  unreported: {
    label: { vi: "Chưa chạy hive", en: "hive not run yet" },
    hint: {
      vi: "Máy chưa báo trạng thái từ xa. Chạy `hive` trên máy một lần.",
      en: "The machine has not reported its remote state. Run `hive` on it once.",
    },
  },
  off: {
    label: { vi: "Từ xa đang tắt", en: "Remote off" },
    hint: {
      vi: "Điều khiển từ xa đang tắt. Bật tại ứng dụng desktop trên máy.",
      en: "Remote control is off. Turn it on in the desktop app on the machine.",
    },
  },
  on: {
    label: { vi: "Từ xa đang bật", en: "Remote on" },
    hint: { vi: "", en: "" },
  },
};

function MachineCard({ machine }: { machine: RemoteMachine }) {
  const lang = useLang();
  const kind = machineRemoteKind(machine);
  const view = KIND[kind];
  const running = machine.sessions.filter(isLive).length;
  return (
    <li className="grid min-w-0 gap-1.5 rounded-md border border-border bg-card p-3 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <strong className="min-w-0 font-medium break-words">{machine.name}</strong>
        <Pill tone={MACHINE_KIND_TONE[kind]} dot>
          {view.label[lang]}
        </Pill>
        {running > 0 && <Pill tone="ok">{`${running} ${lang === "en" ? "running" : "đang chạy"}`}</Pill>}
      </div>
      {view.hint[lang] && <p className="text-xs text-muted-foreground">{view.hint[lang]}</p>}
    </li>
  );
}

/**
 * Trang Điều khiển từ xa (spec 010): máy cá nhân với trạng thái từ xa, và danh sách phiên (đang chạy trước). Trang này
 * chỉ xem và phát lại; bật từ xa, ghép thiết bị, thêm thư mục làm tại máy (FR-012), nên không có nút nào ở đây.
 */
export function RemotePage() {
  const t = useT(text);
  const { api } = useOrg();
  const machines = useQuery(api.remote.machines.queryOptions());
  const sessions = useQuery({
    ...api.remote.list.queryOptions({ input: {} }),
    // Phiên đang chạy đổi trạng thái liên tục; hỏi lại để danh sách không cũ.
    refetchInterval: (q) => (q.state.data?.some(isLive) ? 10_000 : false),
  });
  const now = Date.now();
  const grouped = groupSessions(sessions.data ?? []);

  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <PageBody>
        <section aria-labelledby="remote-machines" className="grid min-w-0 content-start gap-2">
          <h2 id="remote-machines" className="font-heading text-lg font-semibold">
            {t.machines}
          </h2>
          {machines.isPending && <LoadingState />}
          {machines.isError && <LoadFailure error={machines.error} retry={machines.refetch} />}
          {machines.data?.length === 0 && <p className="text-sm text-muted-foreground">{t.noMachines}</p>}
          {machines.data && machines.data.length > 0 && (
            <ul className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {machines.data.map((machine) => (
                <MachineCard key={machine.id} machine={machine} />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="remote-sessions" className="grid min-w-0 content-start gap-3">
          <h2 id="remote-sessions" className="font-heading text-lg font-semibold">
            {t.sessions}
          </h2>
          {sessions.isPending && <LoadingState />}
          {sessions.isError && <LoadFailure error={sessions.error} retry={sessions.refetch} />}
          {sessions.data?.length === 0 && (
            <EmptyState icon={SmartphoneIcon} title={t.emptyTitle} description={t.emptyBody} compact />
          )}
          {grouped.live.length > 0 && <SessionGroup title={t.live} sessions={grouped.live} now={now} />}
          {grouped.ended.length > 0 && <SessionGroup title={t.ended} sessions={grouped.ended} now={now} />}
        </section>
      </PageBody>
    </>
  );
}

function SessionGroup({
  title,
  sessions,
  now,
}: {
  title: string;
  sessions: ReturnType<typeof groupSessions>["live"];
  now: number;
}) {
  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title} ({sessions.length})
      </h3>
      <ul className="grid min-w-0 gap-2">
        {sessions.map((session) => (
          <li key={session.id} className="min-w-0">
            <RemoteSessionRow session={session} now={now} />
          </li>
        ))}
      </ul>
    </div>
  );
}
