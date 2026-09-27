import { useEffect, useState } from "react";
import type { Machine, QuotaCooldown } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, STATUS_TONE } from "../components/common.tsx";
import { formatTime, useAction, useHive, useQuery } from "../hooks.ts";

const ROLE_LABEL: Record<Machine["runs"][number]["role"], string> = { plan: "lập kế hoạch", implement: "làm task", review: "review" };
const REFRESH_MS = 15_000;

const CODE = "rounded bg-muted px-1 py-0.5 font-mono text-xs";

export function MachinesPage() {
  const { client } = useHive();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  const machines = useQuery(() => client.call("machines.list", {}), [client, tick]);
  const cooldowns = useQuery(() => client.call("cooldowns.list", {}), [client, tick]);
  const reload = () => setTick((n) => n + 1);

  return (
    <Page>
      <PageHeader
        title="Máy & run"
        subtitle="App desktop ở chế độ hub báo lên mỗi 30 giây: run đang chạy hoặc đang chờ, và gói sub đang nghỉ vì hết quota."
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Máy</h2>
        <ErrorNote error={machines.error} />
        {machines.data?.length === 0 ? <Empty>Chưa có máy nào báo lên. Mở app desktop ở chế độ Hub dùng chung.</Empty> : null}
        {machines.data?.some((m) => m.duplicate) ? (
          <Notice tone="warn">
            <p>
              Có hai app đang báo lên cùng tên máy và cùng token, nên chúng giữ chung lease task và có thể nhận trùng. Đổi <code className={CODE}>machine</code>{" "}
              trong <code className={`${CODE} break-all`}>~/.xdev-hive/config.json</code> trên một máy, hoặc cấp cho mỗi máy một token riêng.
            </p>
          </Notice>
        ) : null}
        {machines.data?.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Máy</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {machines.data.map((m) => (
                  <MachineRow key={m.id} machine={m} onChanged={reload} />
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Quota đang nghỉ</h2>
        <ErrorNote error={cooldowns.error} />
        {cooldowns.data?.length === 0 ? (
          <Empty>Không có tài khoản nào đang nghỉ. Chỉ profile có điền "Tài khoản" mới chia sẻ quota qua hub.</Empty>
        ) : null}
        {cooldowns.data?.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tài khoản</TableHead>
                  <TableHead>Nghỉ đến</TableHead>
                  <TableHead>Lý do</TableHead>
                  <TableHead>Báo từ</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {cooldowns.data.map((c) => (
                  <CooldownRow key={c.account} cooldown={c} onChanged={reload} />
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>
    </Page>
  );
}

function MachineRow({ machine: m, onChanged }: { machine: Machine; onChanged: () => void }) {
  const { client, me } = useHive();
  const action = useAction();
  const running = m.runs.filter((r) => r.status === "running");
  const queued = m.runs.length - running.length;
  return (
    <TableRow>
      <TableCell className="align-top whitespace-normal">
        <div className="flex min-w-40 flex-col gap-0.5">
          <span className="font-mono font-semibold break-all">{m.machine}</span>
          <span className="font-mono text-xs break-all text-muted-foreground">{m.id}</span>
          {m.version ? <span className="text-xs text-muted-foreground">v{m.version}</span> : null}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col items-start gap-1">
          <Badge tone={m.duplicate ? "danger" : m.online ? "ok" : "neutral"}>
            {m.duplicate ? "Trùng tên máy" : m.online ? "Đang hoạt động" : "Mất kết nối"}
          </Badge>
          <span className="text-xs text-muted-foreground">lần cuối {formatTime(m.lastSeen)}</span>
        </div>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex min-w-56 flex-col gap-2">
          {running.length === 0 && queued === 0 ? <span className="text-muted-foreground">Rảnh</span> : null}
          {running.map((r) => (
            <div key={r.runId} className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge tone={STATUS_TONE[r.status]}>đang chạy</Badge>
                <span className="font-mono text-xs">{r.taskId}</span>
                <span className="min-w-0 break-words">{r.taskTitle}</span>
              </div>
              <div className="text-xs break-words text-muted-foreground">
                {r.project} · {r.profileId ?? "?"} · {ROLE_LABEL[r.role]} · từ {formatTime(r.since)}
              </div>
            </div>
          ))}
          {queued > 0 ? <div className="text-muted-foreground">+ {queued} run đang chờ</div> : null}
          {!m.online && m.runs.length > 0 ? <div className="text-xs text-muted-foreground">Số liệu từ lần báo cuối, có thể đã cũ.</div> : null}
          <ErrorNote error={action.error} />
        </div>
      </TableCell>
      <TableCell className="text-right align-top">
        {me.role === "admin" && !m.online ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await client.call("machines.remove", { id: m.id });
                onChanged();
              })
            }
          >
            Xoá
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function CooldownRow({ cooldown: c, onChanged }: { cooldown: QuotaCooldown; onChanged: () => void }) {
  const { client, me } = useHive();
  const action = useAction();
  return (
    <TableRow>
      <TableCell className="align-top font-mono text-xs">{c.account}</TableCell>
      <TableCell className="align-top text-muted-foreground">{formatTime(c.until)}</TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex max-w-80 min-w-48 flex-col gap-2">
          <span className="whitespace-pre-wrap wrap-anywhere">{c.reason || <span className="text-muted-foreground">—</span>}</span>
          <ErrorNote error={action.error} />
        </div>
      </TableCell>
      <TableCell className="align-top font-mono text-xs text-muted-foreground">{c.reportedBy}</TableCell>
      <TableCell className="text-right align-top">
        {me.role !== "viewer" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={action.busy}
            title="Mọi máy dùng tài khoản này sẽ thử lại ở lần heartbeat kế tiếp"
            onClick={() =>
              void action.run(async () => {
                await client.call("cooldowns.clear", { account: c.account });
                onChanged();
              })
            }
          >
            Hết nghỉ
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
