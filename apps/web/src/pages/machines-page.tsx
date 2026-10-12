import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Machine, newerVersion, type WorkerRelease } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { Pill } from "@/components/ui/pill.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

function Loading() {
  return (
    <p aria-busy="true" className="text-muted-foreground">
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
  const [kind, setKind] = useState<"worker" | "host">("worker");
  const registration = useMutation({
    gcTime: 0,
    mutationFn: () => api.machines.createRegistration.call({ teamId, kind }),
  });
  const [copied, setCopied] = useState(false);
  const [os, setOs] = useState<"macOS" | "Linux" | "Windows">("macOS");
  const data = registration.data;
  const command = data?.command;
  // Script cài tải bản dựng sẵn, kiểm chữ ký và sha256 rồi đăng ký máy; dịch vụ cài cho user hiện tại nên không cần sudo.
  const steps: { title: string; value: string }[] = !data
    ? []
    : kind === "host"
      ? [
          { title: "Cài worker và đăng ký runner host với hub", value: data.installCommand },
          { title: "Chạy runner host", value: "hive-worker host --image <image môi trường của dự án>" },
        ]
      : [
          os === "Windows"
            ? { title: "Chạy trong PowerShell: cài worker, đăng ký máy, chạy nền", value: data.installCommandWindows }
            : { title: "Chạy trong terminal: cài worker, đăng ký máy, chạy nền", value: data.installCommand },
          { title: "Hoặc đã có hive-worker (app desktop): chỉ đăng ký máy", value: data.command },
        ];

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
        <>
          <fieldset className="grid gap-1.5 border-0 p-0">
            <legend className="mb-1 text-xs font-medium">Loại máy</legend>
            <label className="flex items-start gap-2 text-xs">
              <input type="radio" name="machine-kind" checked={kind === "worker"} onChange={() => setKind("worker")} />
              <span>
                <b className="font-medium">Máy dev</b>
                <span className="block text-muted-foreground">
                  Chạy agent bằng CLI đã đăng nhập sẵn trên máy (macOS, Linux, Windows).
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs">
              <input type="radio" name="machine-kind" checked={kind === "host"} onChange={() => setKind("host")} />
              <span>
                <b className="font-medium">Runner host (sandbox)</b>
                <span className="block text-muted-foreground">
                  Máy chủ Linux chạy mỗi run trong container gVisor cho dự án bật sandbox. Cần Docker và runsc cấu hình
                  --host-uds=open.
                </span>
              </span>
            </label>
          </fieldset>
          <Button variant="default" onClick={() => registration.mutate()}>
            Tạo mã đăng ký
          </Button>
        </>
      )}
      {registration.isPending && <Loading />}
      {registration.isError && <Alert variant="destructive">{apiErrorMessage(registration.error)}</Alert>}
      {registration.data && command && (
        <div className="grid gap-3">
          <div className="grid gap-1">
            <label htmlFor="registration-token" className="text-xs font-medium">
              Mã đăng ký dùng một lần
            </label>
            <div className="flex min-w-0 gap-2">
              <code
                id="registration-token"
                role="status"
                aria-label="Mã đăng ký dùng một lần"
                className="min-w-0 flex-1 break-all rounded-md bg-muted p-2 text-xs"
              >
                {registration.data.token}
              </code>
              <Button variant="outline" size="sm" onClick={() => copy(registration.data.token)}>
                Chép mã
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Hết hạn lúc {new Date(registration.data.expiresAt).toLocaleString("vi-VN")}.
            </p>
          </div>
          <div className="grid gap-3">
            {kind === "worker" && (
              <fieldset className="flex gap-2 border-0 p-0">
                <legend className="sr-only">Hệ điều hành</legend>
                {(["macOS", "Linux", "Windows"] as const).map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={os === item ? "default" : "outline"}
                    aria-pressed={os === item}
                    onClick={() => setOs(item)}
                  >
                    {item}
                  </Button>
                ))}
              </fieldset>
            )}
            {steps.map((step, index) => (
              <div key={step.title} className="grid gap-1">
                <b className="text-xs">
                  {index + 1}. {step.title}
                </b>
                <div className="flex min-w-0 gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md bg-muted p-2 text-xs">{step.value}</code>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Chép lệnh bước ${index + 1}`}
                    onClick={() => copy(step.value)}
                  >
                    Chép
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Máy sẽ hiện trong danh sách khi worker kết nối tới hub. Worker chỉ chạy CLI đã đăng nhập sẵn trên máy. Chạy
            lại lệnh cài không kèm mã (hoặc hive-worker update) để nâng cấp.
          </p>
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {copied
              ? "Đã chép vào bộ nhớ tạm."
              : kind === "host"
                ? "Runner host chỉ chạy trên Linux và từ chối khởi động nếu Docker chưa có runtime runsc."
                : os === "Linux"
                  ? "Linux cài systemd user service; chạy loginctl enable-linger để worker chạy cả khi chưa đăng nhập."
                  : os === "macOS"
                    ? "macOS cài LaunchAgent cho user hiện tại."
                    : "Windows tạo tác vụ Task Scheduler chạy khi đăng nhập."}
          </p>
          <DialogActions>
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
          </DialogActions>
        </div>
      )}
      {!registration.data && (
        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
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
    // Máy cập nhật xong thì nối lại với phiên bản mới; hỏi lại định kỳ để cột Worker tự đổi.
    refetchInterval: 15_000,
  });
  // Lỗi tra bản mới nhất (hub không ra được GitHub) chỉ làm mất nhãn bản cũ, không chặn trang.
  const latest = useQuery({ ...api.machines.workerRelease.queryOptions(), retry: false });
  const [updateSent, setUpdateSent] = useState<string | null>(null);
  const updateMachine = useMutation({
    mutationFn: (machine: Machine) => api.machines.update.call({ machineId: machine.id }),
    onMutate: () => setUpdateSent(null),
    onSuccess: (machine) => setUpdateSent(machine.name),
  });
  const revoke = useMutation({
    mutationFn: (machineId: string) => api.machines.revoke.call({ machineId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.machines.list.key() });
      setRevokeId(null);
    },
  });
  const members = useQuery(api.orgMembers.list.queryOptions());
  const memberName = new Map((members.data ?? []).map((member) => [member.userId, member.name]));
  const share = useMutation({
    mutationFn: ({ machineId, shared }: { machineId: string; shared: boolean }) =>
      api.machines.setShared.call({ machineId, shared }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.machines.list.key() }),
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
          <Button variant="default" onClick={() => setAdding(true)}>
            Thêm máy
          </Button>
        )}
      </PageHeader>
      <PageBody>
        {teams.isPending ? (
          <Loading />
        ) : teams.isError ? (
          <Alert variant="destructive">{apiErrorMessage(teams.error)}</Alert>
        ) : teams.data.length === 0 ? (
          <Card className="p-5 text-muted-foreground">Chưa có đội để quản lý máy.</Card>
        ) : (
          <>
            <label className="grid max-w-sm gap-1 text-xs font-medium" htmlFor="machine-team">
              Đội
              <NativeSelect
                id="machine-team"
                value={selectedTeam?.id ?? ""}
                onChange={(event) => setTeamId(event.target.value)}
              >
                {teams.data.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {machines.isPending ? (
              <Loading />
            ) : machines.isError ? (
              <Alert variant="destructive">{apiErrorMessage(machines.error)}</Alert>
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
                  <h2 className="mb-2 text-base font-semibold text-foreground">Danh sách máy</h2>
                  {runInfoError && (
                    <Alert variant="destructive">Không tải được danh sách run đang chạy của một số máy.</Alert>
                  )}
                  {updateMachine.isError && <Alert variant="destructive">{apiErrorMessage(updateMachine.error)}</Alert>}
                  {updateSent && (
                    <p role="status" className="mb-2 text-xs text-muted-foreground">
                      Đã gửi lệnh cập nhật tới {updateSent}. Máy chờ run đang chạy xong, tự cập nhật rồi nối lại.
                    </p>
                  )}
                  {machines.data.length === 0 ? (
                    <p className="py-5 text-center text-muted-foreground">Đội chưa đăng ký máy nào.</p>
                  ) : (
                    <Table>
                      <thead>
                        <tr>
                          <Th>Máy</Th>
                          <Th>Loại</Th>
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
                              <b className="font-mono text-xs">{machine.name}</b>
                            </Td>
                            <Td>
                              {/* Máy cá nhân chỉ chạy run của chủ máy; run của đội chỉ chạy trên máy dùng chung (ADR 0017). */}
                              {machine.shared ? (
                                <Pill tone="sel">Dùng chung</Pill>
                              ) : (
                                <span title="Chỉ chạy run của chủ máy, bằng CLI chủ máy đã đăng nhập">
                                  <Pill>
                                    Cá nhân ·{" "}
                                    {machine.registeredBy
                                      ? (memberName.get(machine.registeredBy) ?? machine.registeredBy)
                                      : "không rõ"}
                                  </Pill>
                                </span>
                              )}
                            </Td>
                            <Td>{machine.os}</Td>
                            <Td>
                              <div className="grid justify-items-start gap-1">
                                <MachineStatus
                                  status={machine.status}
                                  busy={activeRuns.some((run) => run.machineId === machine.id)}
                                />
                                <span className="text-xs text-muted-foreground">
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
                              <div className="mt-1 h-1 w-20 overflow-hidden rounded bg-muted">
                                <div
                                  className="h-full bg-primary"
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
                            <Td>
                              <WorkerVersion machine={machine} latest={latest.data ?? null} />
                            </Td>
                            <Td>
                              {machine.status === "paused" ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={machineAction.isPending}
                                  onClick={() => machineAction.mutate({ machineId: machine.id, paused: false })}
                                >
                                  Chạy lại
                                </Button>
                              ) : machine.status !== "revoked" ? (
                                <Button
                                  variant="outline"
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
                              {machine.status !== "revoked" && machine.kind === "worker" && (
                                <>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={share.isPending}
                                    aria-label={`${machine.shared ? "Thôi dùng chung" : "Cho đội dùng chung"} ${machine.name}`}
                                    onClick={() => share.mutate({ machineId: machine.id, shared: !machine.shared })}
                                  >
                                    {machine.shared ? "Thôi dùng chung" : "Cho đội dùng chung"}
                                  </Button>{" "}
                                </>
                              )}
                              {share.isError && <span role="alert">{apiErrorMessage(share.error)}</span>}
                              {machine.status !== "revoked" && (
                                <Button variant="outline" size="sm" onClick={() => setRevokeId(machine.id)}>
                                  Thu hồi
                                </Button>
                              )}
                              {canUpdate(machine, latest.data ?? null) && (
                                <>
                                  {" "}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={updateMachine.isPending}
                                    aria-label={`Cập nhật worker trên ${machine.name}`}
                                    onClick={() => updateMachine.mutate(machine)}
                                  >
                                    Cập nhật
                                  </Button>
                                </>
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
                    <Alert variant="destructive" key={machine.id}>
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
          {revoke.isError && <Alert variant="destructive">{apiErrorMessage(revoke.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" onClick={() => setRevokeId(null)}>
              Huỷ
            </Button>
            <Button variant="default" disabled={revoke.isPending} onClick={() => revokeId && revoke.mutate(revokeId)}>
              {revoke.isPending ? "Đang thu hồi…" : "Thu hồi máy"}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}

function outdated(machine: Machine, latest: WorkerRelease | null): boolean {
  return latest !== null && newerVersion(latest.version, machine.version);
}

/** Máy còn kết nối (kể cả đang tạm dừng) và chạy bản cũ hơn bản phát hành mới nhất. */
function canUpdate(machine: Machine, latest: WorkerRelease | null): boolean {
  return (machine.status === "online" || machine.status === "paused") && outdated(machine, latest);
}

function WorkerVersion({ machine, latest }: { machine: Machine; latest: WorkerRelease | null }) {
  if (!machine.version) return <>—</>;
  return (
    <div className="grid justify-items-start gap-1">
      <span className="font-mono text-xs">{machine.version}</span>
      {latest && outdated(machine, latest) && (
        <Pill tone="warn" small>
          Có bản {latest.version}
        </Pill>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="grid gap-1 p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <b className="text-lg text-foreground">{value}</b>
    </Card>
  );
}
