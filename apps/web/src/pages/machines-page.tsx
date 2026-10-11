import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { Select } from "../components/ui/select.tsx";
import { Table, Td, Th } from "../components/ui/table.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

function Loading() {
  return (
    <p aria-busy="true" className="text-muted">
      Đang tải…
    </p>
  );
}

function MachineStatus({ status, busy }: { status: "online" | "offline" | "paused" | "revoked"; busy: boolean }) {
  const tone = status === "paused" ? "warn" : status === "online" ? (busy ? "sel" : "ok") : "neutral";
  const label =
    status === "online"
      ? busy
        ? "Đang chạy"
        : "Sẵn sàng"
      : status === "offline"
        ? "Mất kết nối"
        : status === "paused"
          ? "Tạm dừng"
          : "Đã thu hồi";
  return <Pill tone={tone}>{label}</Pill>;
}

function RegistrationDialog({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const { api } = useOrg();
  const registration = useMutation({
    gcTime: 0,
    mutationFn: () => api.machines.createRegistration.call({ teamId }),
  });
  const [copied, setCopied] = useState(false);
  const [os, setOs] = useState<"macOS" | "Linux" | "Windows">("macOS");
  const command = registration.data?.command;
  const hubUrl = command?.match(/--hub\s+(\S+)/)?.[1]?.replace(/\/$/, "");
  const commands =
    command && hubUrl
      ? {
          macOS: ["brew install xdev/tap/hive-worker", command, "hive-worker service install"],
          Linux: [`curl -fsSL ${hubUrl}/install.sh | sh`, command, "sudo hive-worker service install"],
          Windows: [`irm ${hubUrl}/install.ps1 | iex`, command, "hive-worker service install"],
        }
      : null;
  const steps = commands?.[os] ?? [];
  const stepTitles = ["Cài worker", "Đăng ký máy với hub", "Chạy worker như dịch vụ hệ thống"];

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <DialogContent>
      <DialogTitle>Thêm máy</DialogTitle>
      <DialogDescription>
        Mã đăng ký chỉ dùng một lần và hết hạn sau một giờ. Hãy hoàn tất cài đặt trước khi đóng cửa sổ này.
      </DialogDescription>
      {registration.isIdle && (
        <Button variant="primary" onClick={() => registration.mutate()}>
          Tạo mã đăng ký
        </Button>
      )}
      {registration.isPending && <Loading />}
      {registration.isError && <Alert>{apiErrorMessage(registration.error)}</Alert>}
      {registration.data && commands && (
        <div className="grid gap-3">
          <div className="grid gap-1">
            <label htmlFor="registration-token" className="text-sm font-medium">
              Mã đăng ký dùng một lần
            </label>
            <div className="flex min-w-0 gap-2">
              <code
                id="registration-token"
                role="status"
                aria-label="Mã đăng ký dùng một lần"
                className="min-w-0 flex-1 break-all rounded-md bg-subtle p-2 text-sm"
              >
                {registration.data.token}
              </code>
              <Button size="sm" onClick={() => copy(registration.data.token)}>
                Chép mã
              </Button>
            </div>
            <p className="text-xs text-muted">
              Hết hạn lúc {new Date(registration.data.expiresAt).toLocaleString("vi-VN")}.
            </p>
          </div>
          <div className="grid gap-3">
            <fieldset className="flex gap-2 border-0 p-0">
              <legend className="sr-only">Hệ điều hành</legend>
              {(["macOS", "Linux", "Windows"] as const).map((item) => (
                <Button
                  key={item}
                  size="sm"
                  variant={os === item ? "primary" : "default"}
                  aria-pressed={os === item}
                  onClick={() => setOs(item)}
                >
                  {item}
                </Button>
              ))}
            </fieldset>
            {steps.map((value, index) => (
              <div key={stepTitles[index]} className="grid gap-1">
                <b className="text-sm">
                  {index + 1}. {stepTitles[index]}
                </b>
                <div className="flex min-w-0 gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md bg-subtle p-2 text-xs">{value}</code>
                  <Button size="sm" aria-label={`Chép lệnh bước ${index + 1}`} onClick={() => copy(value)}>
                    Chép
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted">
            Máy sẽ hiện trong danh sách khi worker kết nối tới hub. Worker chỉ chạy CLI đã đăng nhập sẵn trên máy.
          </p>
          <p aria-live="polite" className="text-sm text-muted">
            {copied
              ? "Đã chép vào bộ nhớ tạm."
              : "Linux cài systemd user service, macOS cài LaunchAgent, Windows tạo tác vụ khi đăng nhập."}
          </p>
          <DialogActions>
            <Button onClick={onClose}>Đóng</Button>
          </DialogActions>
        </div>
      )}
      {!registration.data && (
        <DialogActions>
          <Button onClick={onClose}>Đóng</Button>
        </DialogActions>
      )}
    </DialogContent>
  );
}

export function MachinesPage() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const teams = useQuery(api.teams.list.queryOptions());
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const [teamId, setTeamId] = useState("");
  const [adding, setAdding] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const selectedTeam = teams.data?.find((team) => team.id === teamId) ?? teams.data?.[0];
  const teamProjects = projects.data?.filter((project) => project.teamId === selectedTeam?.id) ?? [];
  const taskQueries = useQueries({
    queries: teamProjects.map((project) =>
      api.tasks.list.queryOptions({ input: { projectId: project.id, status: "running" } }),
    ),
  });
  const runningTasks = taskQueries.flatMap((query) => query.data ?? []);
  const runQueries = useQueries({
    queries: runningTasks.map((task) => api.runs.list.queryOptions({ input: { taskId: task.id } })),
  });
  const runInfoPending =
    projects.isPending || taskQueries.some((query) => query.isPending) || runQueries.some((query) => query.isPending);
  const runInfoError =
    projects.isError || taskQueries.some((query) => query.isError) || runQueries.some((query) => query.isError);
  const taskKeys = new Map(runningTasks.map((task) => [task.id, task.key]));
  const machines = useQuery({
    ...api.machines.list.queryOptions({
      input: { teamId: selectedTeam?.id ?? "00000000-0000-4000-8000-000000000000" },
    }),
    enabled: Boolean(selectedTeam),
  });
  const revoke = useMutation({
    mutationFn: (machineId: string) => api.machines.revoke.call({ machineId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.machines.list.key() });
      setRevokeId(null);
    },
  });
  const machineAction = useMutation({
    mutationFn: ({ machineId, paused }: { machineId: string; paused: boolean }) =>
      paused ? api.machines.pause.call({ machineId }) : api.machines.resume.call({ machineId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.machines.list.key() }),
  });
  const activeRuns = runQueries
    .flatMap((query) => query.data ?? [])
    .filter((run) =>
      ["leased", "preparing", "running", "awaiting_input", "verifying", "cancelling"].includes(run.state),
    );

  return (
    <>
      <PageHeader crumb="Vận hành" title="Máy">
        {selectedTeam && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            Thêm máy
          </Button>
        )}
      </PageHeader>
      <PageBody>
        {teams.isPending ? (
          <Loading />
        ) : teams.isError ? (
          <Alert>{apiErrorMessage(teams.error)}</Alert>
        ) : teams.data.length === 0 ? (
          <Card className="p-5 text-muted">Chưa có đội để quản lý máy.</Card>
        ) : (
          <>
            <label className="grid max-w-sm gap-1 text-sm font-medium" htmlFor="machine-team">
              Đội
              <Select
                id="machine-team"
                value={selectedTeam?.id ?? ""}
                onChange={(event) => setTeamId(event.target.value)}
              >
                {teams.data.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </Select>
            </label>
            {machines.isPending ? (
              <Loading />
            ) : machines.isError ? (
              <Alert>{apiErrorMessage(machines.error)}</Alert>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric
                    label="Máy trực tuyến"
                    value={`${machines.data.filter((machine) => machine.status === "online").length} / ${machines.data.length}`}
                  />
                  <Metric
                    label="Chỗ chạy còn trống"
                    value={machines.data
                      .filter((machine) => machine.status === "online")
                      .reduce(
                        (sum, machine) =>
                          sum +
                          Math.max(
                            0,
                            machine.capacity - activeRuns.filter((run) => run.machineId === machine.id).length,
                          ),
                        0,
                      )}
                  />
                  <Metric label="CLI khả dụng" value={new Set(machines.data.flatMap((machine) => machine.clis)).size} />
                  <Metric label="Run đang chạy" value={activeRuns.length} />
                </div>
                <Card className="p-3 sm:p-4">
                  <h2 className="mb-2 text-lg font-semibold text-ink">Danh sách máy</h2>
                  {runInfoError && <Alert>Không tải được danh sách run đang chạy của một số máy.</Alert>}
                  {machines.data.length === 0 ? (
                    <p className="py-5 text-center text-muted">Đội chưa đăng ký máy nào.</p>
                  ) : (
                    <Table>
                      <thead>
                        <tr>
                          <Th>Máy</Th>
                          <Th>Hệ điều hành</Th>
                          <Th>Trạng thái</Th>
                          <Th>CLI</Th>
                          <Th>Sức chứa</Th>
                          <Th>Run</Th>
                          <Th>Worker</Th>
                          <Th>Thao tác</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {machines.data.map((machine) => (
                          <tr key={machine.id}>
                            <Td>
                              <b className="font-mono text-sm">{machine.name}</b>
                            </Td>
                            <Td>{machine.os}</Td>
                            <Td>
                              <div className="grid justify-items-start gap-1">
                                <MachineStatus
                                  status={machine.status}
                                  busy={activeRuns.some((run) => run.machineId === machine.id)}
                                />
                                <span className="text-xs text-muted">
                                  {machine.lastSeenAt
                                    ? `Nhịp ${new Date(machine.lastSeenAt).toLocaleString("vi-VN")}`
                                    : "Chưa kết nối"}
                                </span>
                              </div>
                            </Td>
                            <Td>
                              <div className="flex flex-wrap gap-1">
                                {machine.clis.length ? machine.clis.map((cli) => <Pill key={cli}>{cli}</Pill>) : "—"}
                              </div>
                            </Td>
                            <Td>
                              {Math.min(
                                activeRuns.filter((run) => run.machineId === machine.id).length,
                                machine.capacity,
                              )}{" "}
                              / {machine.capacity}
                              <div className="mt-1 h-1 w-20 overflow-hidden rounded bg-subtle">
                                <div
                                  className="h-full bg-accent"
                                  style={{
                                    width: `${machine.capacity ? (Math.min(activeRuns.filter((run) => run.machineId === machine.id).length, machine.capacity) / machine.capacity) * 100 : 0}%`,
                                  }}
                                />
                              </div>
                            </Td>
                            <Td>
                              {runInfoPending
                                ? "Đang tải…"
                                : activeRuns
                                    .filter((run) => run.machineId === machine.id)
                                    .map((run) => (run.taskId ? taskKeys.get(run.taskId) : "leader"))
                                    .filter(Boolean)
                                    .join(", ") || "—"}
                            </Td>
                            <Td>{machine.version || "—"}</Td>
                            <Td>
                              {machine.status === "paused" ? (
                                <Button
                                  size="sm"
                                  disabled={machineAction.isPending}
                                  onClick={() => machineAction.mutate({ machineId: machine.id, paused: false })}
                                >
                                  Chạy lại
                                </Button>
                              ) : machine.status !== "revoked" ? (
                                <Button
                                  size="sm"
                                  disabled={machineAction.isPending}
                                  onClick={() => machineAction.mutate({ machineId: machine.id, paused: true })}
                                >
                                  Tạm dừng
                                </Button>
                              ) : null}
                              {machineAction.isError && (
                                <span role="alert">{apiErrorMessage(machineAction.error)}</span>
                              )}{" "}
                              {machine.status !== "revoked" && (
                                <Button size="sm" onClick={() => setRevokeId(machine.id)}>
                                  Thu hồi
                                </Button>
                              )}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </Card>
                {machines.data
                  .filter((machine) => machine.status === "offline")
                  .map((machine) => (
                    <Alert key={machine.id}>
                      Máy {machine.name} mất kết nối. Run đang chờ sẽ được giao lại khi có máy phù hợp.
                    </Alert>
                  ))}
              </>
            )}
          </>
        )}
      </PageBody>
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && selectedTeam && <RegistrationDialog teamId={selectedTeam.id} onClose={() => setAdding(false)} />}
      </Dialog>
      <Dialog
        open={revokeId !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeId(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Thu hồi máy?</DialogTitle>
          <DialogDescription>
            Máy sẽ không thể kết nối lại bằng thông tin hiện tại. Bạn cần đăng ký lại để sử dụng máy.
          </DialogDescription>
          {revoke.isError && <Alert>{apiErrorMessage(revoke.error)}</Alert>}
          <DialogActions>
            <Button onClick={() => setRevokeId(null)}>Huỷ</Button>
            <Button variant="primary" disabled={revoke.isPending} onClick={() => revokeId && revoke.mutate(revokeId)}>
              {revoke.isPending ? "Đang thu hồi…" : "Thu hồi máy"}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="grid gap-1 p-3">
      <span className="text-xs text-muted">{label}</span>
      <b className="text-2xl text-ink">{value}</b>
    </Card>
  );
}
