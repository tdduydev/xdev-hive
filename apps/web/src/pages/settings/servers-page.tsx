import { useQuery } from "@tanstack/react-query";
import type { DeployServer } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogContent } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { EllipsisIcon, ServerIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { Icon } from "@/components/icons.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { EmptyState, LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { formatDayTime } from "@/lib/format.ts";
import { usePermissions, useTeamPermissions } from "@/lib/permissions.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";
import {
  FingerprintConfirm,
  KeyView,
  RemoveServer,
  RotateKey,
  ServerForm,
  TestResultView,
  useServerTest,
} from "./server-dialogs.tsx";

const VI = {
  title: "Máy chủ",
  lead: "Máy chủ mà hub kết nối bằng SSH để triển khai, nhóm theo đội. Hub giữ khoá riêng, bạn chỉ cài khoá công khai lên máy chủ.",
  loading: "Đang tải máy chủ",
  add: "Thêm máy chủ",
  emptyTitle: "Chưa có máy chủ nào",
  emptyTeam: "Đội này chưa có máy chủ. Thêm máy chủ rồi cài khoá công khai để hub triển khai được.",
  emptyAll: "Bạn chưa có máy chủ nào để xem. Quản trị đội thêm máy chủ ở đây.",
  colName: "Tên",
  colAddress: "Địa chỉ",
  colStatus: "Trạng thái",
  actions: "Thao tác",
  fpOk: "Đã xác nhận dấu vân tay",
  fpNone: "Chưa xác nhận dấu vân tay",
  keyPending: "Đang đổi khoá",
  lastTest: "Kiểm lần cuối",
  neverTested: "Chưa kiểm",
  test: "Kiểm kết nối",
  testing: "Đang kiểm…",
  testOf: (name: string) => `Kiểm kết nối ${name}`,
  moreFor: (name: string) => `Thao tác khác cho máy chủ ${name}`,
  showKey: "Khoá và lệnh cài",
  rotate: "Đổi khoá…",
  edit: "Sửa",
  remove: "Xoá",
  ok: "Kết nối được",
  fail: "Kết nối lỗi",
  teamAdd: (team: string) => `Thêm máy chủ cho đội ${team}`,
};

type Dlg =
  | { k: "form"; server: DeployServer | null; teamId: string }
  | { k: "key"; id: string }
  | { k: "rotate"; id: string }
  | { k: "remove"; id: string }
  | { k: "fp"; id: string; fingerprints: string[]; changed: boolean };

/** /admin/servers: máy chủ SSH của các đội, kiểm kết nối, xác nhận dấu vân tay, đổi khoá (FR-002…FR-005). */
export function ServersPage() {
  const { api } = useOrg();
  const teams = useQuery(api.teams.list.queryOptions());
  const servers = useQuery(api.servers.list.queryOptions({ input: {} }));
  const orgManage = usePermissions()("servers.manage");
  const { results, test } = useServerTest();
  const [dlg, setDlg] = useState<Dlg | null>(null);

  const serverOf = (id: string) => servers.data?.find((s) => s.id === id) ?? null;
  const close = () => setDlg(null);
  const teamList = teams.data ?? [];
  const byTeam = (teamId: string) => (servers.data ?? []).filter((s) => s.teamId === teamId);
  const dlgServer = dlg && dlg.k !== "form" ? serverOf(dlg.id) : null;

  const firstTeam = teamList[0]?.id ?? "";

  return (
    <>
      <PageHeader title={VI.title} description={VI.lead}>
        {orgManage && teamList.length > 0 && (
          <Button variant="default" size="sm" onClick={() => setDlg({ k: "form", server: null, teamId: firstTeam })}>
            <Icon name="plus" />
            {VI.add}
          </Button>
        )}
      </PageHeader>
      <PageBody>
        {servers.isPending || teams.isPending ? (
          <TableSkeleton label={VI.loading} rows={3} columns={4} />
        ) : servers.isError ? (
          <LoadFailure error={servers.error} retry={servers.refetch} />
        ) : teams.isError ? (
          <LoadFailure error={teams.error} retry={teams.refetch} />
        ) : servers.data.length === 0 && teamList.length === 0 ? (
          <EmptyState icon={ServerIcon} title={VI.emptyTitle} description={VI.emptyAll} />
        ) : (
          teamList.map((team) => (
            <TeamSection
              key={team.id}
              team={team}
              servers={byTeam(team.id)}
              results={results}
              testingId={test.isPending ? test.variables : undefined}
              onTest={(id) => test.mutate(id)}
              onAdd={() => setDlg({ k: "form", server: null, teamId: team.id })}
              onKey={(s) => setDlg({ k: "key", id: s.id })}
              onRotate={(s) => setDlg({ k: "rotate", id: s.id })}
              onEdit={(s) => setDlg({ k: "form", server: s, teamId: s.teamId })}
              onRemove={(s) => setDlg({ k: "remove", id: s.id })}
              onConfirm={(s, fingerprints, changed) => setDlg({ k: "fp", id: s.id, fingerprints, changed })}
            />
          ))
        )}
      </PageBody>
      <Dialog open={dlg !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
          {dlg?.k === "form" && (
            <ServerForm
              server={dlg.server}
              teams={teamList}
              defaultTeamId={dlg.teamId}
              onDone={close}
              onCreated={(s) => setDlg({ k: "key", id: s.id })}
            />
          )}
          {dlg?.k === "key" && dlgServer && <KeyView server={dlgServer} onDone={close} />}
          {dlg?.k === "rotate" && dlgServer && <RotateKey server={dlgServer} onDone={close} />}
          {dlg?.k === "remove" && dlgServer && <RemoveServer server={dlgServer} onDone={close} />}
          {dlg?.k === "fp" && dlgServer && (
            <FingerprintConfirm
              server={dlgServer}
              fingerprints={dlg.fingerprints}
              changed={dlg.changed}
              onDone={close}
              onConfirmed={() => {
                close();
                test.mutate(dlg.id);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function TeamSection({
  team,
  servers,
  results,
  testingId,
  onTest,
  onAdd,
  onKey,
  onRotate,
  onEdit,
  onRemove,
  onConfirm,
}: {
  team: { id: string; name: string };
  servers: DeployServer[];
  results: ReturnType<typeof useServerTest>["results"];
  testingId: string | undefined;
  onTest: (id: string) => void;
  onAdd: () => void;
  onKey: (s: DeployServer) => void;
  onRotate: (s: DeployServer) => void;
  onEdit: (s: DeployServer) => void;
  onRemove: (s: DeployServer) => void;
  onConfirm: (s: DeployServer, fingerprints: string[], changed: boolean) => void;
}) {
  const can = useTeamPermissions(team.id);
  const manage = can("servers.manage");
  if (servers.length === 0 && !manage) return null;
  return (
    <section aria-labelledby={`team-${team.id}`} className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`team-${team.id}`} className="font-heading text-base font-semibold text-foreground">
          {team.name}
        </h2>
        {manage && servers.length > 0 && (
          <Button variant="outline" size="sm" aria-label={VI.teamAdd(team.name)} onClick={onAdd}>
            <Icon name="plus" />
            {VI.add}
          </Button>
        )}
      </div>
      {servers.length === 0 ? (
        <EmptyState
          compact
          icon={ServerIcon}
          title={VI.emptyTitle}
          description={VI.emptyTeam}
          action={
            <Button variant="default" aria-label={VI.teamAdd(team.name)} onClick={onAdd}>
              <Icon name="plus" />
              {VI.add}
            </Button>
          }
        />
      ) : (
        <div className="min-w-0 overflow-x-auto rounded-xl border border-border bg-card">
          <Table className="[&_td]:align-top" style={{ minWidth: 640 }}>
            <caption className="sr-only">{`${VI.title} của đội ${team.name}`}</caption>
            <thead>
              <tr>
                <Th variant="plain">{VI.colName}</Th>
                <Th variant="plain">{VI.colAddress}</Th>
                <Th variant="plain">{VI.colStatus}</Th>
                {manage && (
                  <Th variant="plain" className="text-right">
                    {VI.actions}
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const result = results[s.id];
                return (
                  <Fragment key={s.id}>
                    <tr className={result !== undefined ? "[&>td]:border-b-0" : undefined}>
                      <Td>
                        <span className="grid gap-0.5">
                          <span className="font-medium text-foreground">{s.name}</span>
                          {s.labels.length > 0 && (
                            <span className="text-xs text-muted-foreground">{s.labels.join(", ")}</span>
                          )}
                        </span>
                      </Td>
                      <Td>
                        <span className="font-mono text-xs break-all">
                          {s.user}@{s.host}:{s.port}
                        </span>
                      </Td>
                      <Td>
                        <span className="grid justify-items-start gap-1">
                          <Pill tone={s.hostKeyFingerprints.length > 0 ? "ok" : "warn"} small>
                            {s.hostKeyFingerprints.length > 0 ? VI.fpOk : VI.fpNone}
                          </Pill>
                          {s.pendingKey && (
                            <Pill tone="warn" small>
                              {VI.keyPending}
                            </Pill>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {s.lastTest
                              ? `${VI.lastTest}: ${s.lastTest.ok ? VI.ok : VI.fail}, ${formatDayTime(s.lastTest.at)}`
                              : VI.neverTested}
                          </span>
                        </span>
                      </Td>
                      {manage && (
                        <Td className="text-right">
                          <span className="inline-flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={VI.testOf(s.name)}
                              disabled={testingId !== undefined}
                              onClick={() => onTest(s.id)}
                            >
                              {testingId === s.id ? VI.testing : VI.test}
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={<Button variant="ghost" size="icon-sm" aria-label={VI.moreFor(s.name)} />}
                              >
                                <EllipsisIcon aria-hidden="true" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="min-w-48">
                                <DropdownMenuItem onClick={() => onKey(s)}>{VI.showKey}</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onRotate(s)}>{VI.rotate}</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onEdit(s)}>{VI.edit}</DropdownMenuItem>
                                <DropdownMenuItem variant="destructive" onClick={() => onRemove(s)}>
                                  {VI.remove}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </span>
                        </Td>
                      )}
                    </tr>
                    {result !== undefined && (
                      <tr>
                        <Td colSpan={manage ? 4 : 3} className="pt-0">
                          <TestResultView
                            server={s}
                            result={result}
                            onConfirm={(fps) =>
                              onConfirm(s, fps, typeof result !== "string" && result.result === "error")
                            }
                          />
                        </Td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
    </section>
  );
}
