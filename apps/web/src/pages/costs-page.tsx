import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@xdev-hive/contracts";
import { type FormEvent, useRef, useState } from "react";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Input } from "../components/ui/input.tsx";
import { Select } from "../components/ui/select.tsx";
import { Table, Td, Th } from "../components/ui/table.tsx";
import { apiErrorMessage, formError } from "../lib/api-errors.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

type Period = 7 | 14 | 30;
type GroupBy = "cli" | "machine" | "task";

function utcDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function datesFor(period: Period) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (period - 1));
  return { from: utcDate(start), to: utcDate(end) };
}

function usd(value: number) {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function number(value: number) {
  return new Intl.NumberFormat("vi-VN").format(value);
}

function Loading() {
  return (
    <p aria-busy="true" className="text-muted-foreground">
      Đang tải…
    </p>
  );
}

export function CostsPage() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const [projectId, setProjectId] = useState("");
  const [period, setPeriod] = useState<Period>(14);
  const [groupBy, setGroupBy] = useState<GroupBy>("cli");
  const project = projects.data?.find((item) => item.id === projectId) ?? projects.data?.[0];
  const range = datesFor(period);
  const summaryInput = { projectId: project?.id ?? "00000000-0000-4000-8000-000000000000", ...range };
  const daily = useQuery({
    ...api.costs.summary.queryOptions({ input: { ...summaryInput, groupBy: "day" } }),
    enabled: Boolean(project),
  });
  const grouped = useQuery({
    ...api.costs.summary.queryOptions({ input: { ...summaryInput, groupBy } }),
    enabled: Boolean(project),
  });
  const stopped = useQuery({
    ...api.costs.budgetStopped.queryOptions({ input: { projectId: summaryInput.projectId } }),
    enabled: Boolean(project),
  });
  const chart =
    project && daily.data
      ? Array.from({ length: period }, (_, index) => {
          const date = new Date(`${range.from}T00:00:00Z`);
          date.setUTCDate(date.getUTCDate() + index);
          const key = utcDate(date);
          return { key, value: daily.data.groups.find((group) => group.key === key)?.costUsd ?? 0 };
        })
      : [];
  const max = Math.max(...chart.map((item) => item.value), 0.01);

  return (
    <>
      <PageHeader crumb="Quản trị" title="Chi phí và token" />
      <PageBody>
        {projects.isPending ? (
          <Loading />
        ) : projects.isError ? (
          <Alert>{apiErrorMessage(projects.error)}</Alert>
        ) : projects.data.length === 0 || !project ? (
          <Card className="p-5 text-muted-foreground">Chưa có dự án để tổng hợp chi phí.</Card>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
              <label className="grid gap-1 text-xs font-medium" htmlFor="cost-project">
                Dự án
                <Select
                  id="cost-project"
                  value={project?.id ?? ""}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {projects.data.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.key}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="grid gap-1 text-xs font-medium" htmlFor="cost-period">
                Khoảng thời gian
                <Select
                  id="cost-period"
                  value={period}
                  onChange={(event) => setPeriod(Number(event.target.value) as Period)}
                >
                  <option value={7}>7 ngày</option>
                  <option value={14}>14 ngày</option>
                  <option value={30}>30 ngày</option>
                </Select>
              </label>
            </div>
            {daily.isPending ? (
              <Loading />
            ) : daily.isError ? (
              <Alert>{apiErrorMessage(daily.error)}</Alert>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric label="Tổng chi phí đã báo" value={usd(daily.data.total.costUsd)} />
                  <Metric label="Run" value={number(daily.data.total.runs)} />
                  <Metric label="Token vào" value={number(daily.data.total.tokensIn)} />
                  <Metric label="Token ra" value={number(daily.data.total.tokensOut)} />
                </div>
                <Card className="grid gap-3 p-4">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">Chi phí theo ngày (USD)</h2>
                    <p className="text-xs text-muted-foreground">Ngày tính theo UTC. Chỉ biểu đồ CLI có báo cáo USD.</p>
                  </div>
                  <CostChart points={chart} max={max} />
                </Card>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2.5fr)]">
                  <Card className="grid min-w-0 gap-3 p-4">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div>
                        <h2 className="text-base font-semibold text-foreground">Chi tiết chi phí</h2>
                        <p className="text-xs text-muted-foreground">Nhóm theo CLI, máy hoặc việc.</p>
                      </div>
                      <label className="grid min-w-36 gap-1 text-xs font-medium" htmlFor="cost-group">
                        Nhóm theo
                        <Select
                          id="cost-group"
                          value={groupBy}
                          onChange={(event) => setGroupBy(event.target.value as GroupBy)}
                        >
                          <option value="cli">CLI</option>
                          <option value="machine">Máy</option>
                          <option value="task">Việc</option>
                        </Select>
                      </label>
                    </div>
                    {grouped.isPending ? (
                      <Loading />
                    ) : grouped.isError ? (
                      <Alert>{apiErrorMessage(grouped.error)}</Alert>
                    ) : grouped.data.groups.length === 0 ? (
                      <p className="py-4 text-center text-muted-foreground">Chưa có run trong khoảng thời gian này.</p>
                    ) : (
                      <Table>
                        <thead>
                          <tr>
                            <Th>{groupBy === "cli" ? "CLI" : groupBy === "machine" ? "Mã máy" : "Mã việc"}</Th>
                            <Th>Run</Th>
                            <Th>Token</Th>
                            <Th>Chi phí</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {grouped.data.groups.map((group) => (
                            <tr key={group.key ?? "unknown"}>
                              <Td>{group.key ?? "Chưa xác định"}</Td>
                              <Td>{number(group.runs)}</Td>
                              <Td>{number(group.tokensIn + group.tokensOut)}</Td>
                              <Td>{usd(group.costUsd)}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    )}
                  </Card>
                  <BudgetForm
                    key={project.id}
                    project={project}
                    onSaved={() => queryClient.invalidateQueries({ queryKey: api.projects.list.key() })}
                  />
                </div>
                <Card className="grid gap-3 p-4">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">Run bị dừng vì vượt ngân sách</h2>
                    <p className="text-xs text-muted-foreground">Giá trị đo được và trần tại thời điểm run kết thúc.</p>
                  </div>
                  {stopped.isPending ? (
                    <Loading />
                  ) : stopped.isError ? (
                    <Alert>{apiErrorMessage(stopped.error)}</Alert>
                  ) : stopped.data.length === 0 ? (
                    <p className="py-2 text-muted-foreground">Chưa có run nào bị dừng vì vượt ngân sách.</p>
                  ) : (
                    <Table>
                      <thead>
                        <tr>
                          <Th>Việc</Th>
                          <Th>Lý do</Th>
                          <Th>Đã dùng</Th>
                          <Th>Trần</Th>
                          <Th>Thời điểm</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {stopped.data.map((item) => (
                          <tr key={`${item.runId}-${item.reason}`}>
                            <Td>
                              <span className="font-mono text-xs">{item.taskKey}</span>
                              <span className="block text-xs text-muted-foreground">{item.taskTitle}</span>
                            </Td>
                            <Td>
                              {item.reason === "per_run_usd"
                                ? "Vượt trần USD/run"
                                : item.reason === "per_task_usd"
                                  ? "Vượt trần USD/việc"
                                  : "Vượt số lượt"}
                            </Td>
                            <Td>
                              {item.reason === "max_turns" ? `${number(item.measured)} lượt` : usd(item.measured)}
                            </Td>
                            <Td>{item.reason === "max_turns" ? `${number(item.limit)} lượt` : usd(item.limit)}</Td>
                            <Td>{new Date(item.stoppedAt).toLocaleString("vi-VN")}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </Card>
              </>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}

function BudgetForm({ project, onSaved }: { project: Project; onSaved: () => Promise<unknown> }) {
  const { api } = useOrg();
  const budget = project.settings.budget;
  const formRef = useRef<HTMLFormElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (input: {
      settings: { budget: { perRunUsd: number | null; perTaskUsd: number | null; maxTurns: number | null } };
    }) => api.projects.updateSettings.call({ key: project.key, ...input }),
    onSuccess: async () => {
      setFailure(null);
      await onSaved();
    },
    onError: (error) => setFailure(formError(error).message),
  });

  function save() {
    if (!formRef.current) return;
    const form = new FormData(formRef.current);
    const parse = (name: string) => {
      const value = String(form.get(name) ?? "").trim();
      return value ? Number(value) : null;
    };
    const perRunUsd = parse("perRunUsd");
    const perTaskUsd = parse("perTaskUsd");
    const maxTurns = parse("maxTurns");
    if (
      [perRunUsd, perTaskUsd].some(
        (value) => value !== null && (!Number.isFinite(value) || value <= 0 || value > 100_000),
      ) ||
      (maxTurns !== null && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 10_000))
    ) {
      setFailure("Giá trị ngân sách nằm ngoài giới hạn cho phép.");
      return;
    }
    update.mutate({ settings: { budget: { perRunUsd, perTaskUsd, maxTurns } } });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save();
  }

  return (
    <Card className="grid gap-3 p-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Ngân sách dự án</h2>
        <p className="text-xs text-muted-foreground">Để trống trường nào thì trường đó không giới hạn.</p>
      </div>
      <form ref={formRef} className="grid gap-3 sm:grid-cols-3" onSubmit={submit}>
        <label className="grid gap-1 text-xs" htmlFor="budget-run">
          USD mỗi run
          <Input
            id="budget-run"
            name="perRunUsd"
            type="number"
            min="0.000001"
            max="100000"
            step="0.01"
            defaultValue={budget?.perRunUsd ?? ""}
            placeholder="—"
          />
        </label>
        <label className="grid gap-1 text-xs" htmlFor="budget-task">
          USD mỗi việc
          <Input
            id="budget-task"
            name="perTaskUsd"
            type="number"
            min="0.000001"
            max="100000"
            step="0.01"
            defaultValue={budget?.perTaskUsd ?? ""}
            placeholder="—"
          />
        </label>
        <label className="grid gap-1 text-xs" htmlFor="budget-turns">
          Lượt agent tối đa
          <Input
            id="budget-turns"
            name="maxTurns"
            type="number"
            min="1"
            max="10000"
            step="1"
            defaultValue={budget?.maxTurns ?? ""}
            placeholder="—"
          />
        </label>
        {failure && (
          <div className="sm:col-span-3">
            <Alert>{failure}</Alert>
          </div>
        )}
        <div className="sm:col-span-3">
          <Button type="button" variant="default" disabled={update.isPending} onClick={save}>
            {update.isPending ? "Đang lưu…" : "Lưu ngân sách"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="grid min-w-0 content-start gap-1 p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <b className="break-words text-base text-foreground">{value}</b>
    </Card>
  );
}

function CostChart({ points, max }: { points: Array<{ key: string; value: number }>; max: number }) {
  if (!points.length) return <p className="text-muted-foreground">Không có dữ liệu biểu đồ.</p>;
  const width = 600;
  const height = 180;
  const barGap = 3;
  const barWidth = Math.max(1, (width - (points.length - 1) * barGap) / points.length);
  const bars = points.map((point, index) => {
    const barHeight = point.value === 0 ? 1 : Math.max(2, (point.value / max) * (height - 24));
    return { ...point, x: index * (barWidth + barGap), y: height - barHeight, barHeight };
  });
  return (
    <div className="grid gap-1">
      <svg
        role="img"
        aria-label={`Chi phí theo ngày trong ${points.length} ngày`}
        viewBox={`0 0 ${width} ${height}`}
        className="h-44 w-full overflow-visible"
      >
        <title>Chi phí theo ngày</title>
        <line x1="0" x2={width} y1={height - 1} y2={height - 1} stroke="currentColor" className="text-border" />
        {bars.map((bar) => (
          <rect
            key={bar.key}
            x={bar.x}
            y={bar.y}
            width={barWidth}
            height={bar.barHeight}
            rx="2"
            className="fill-primary"
          >
            <title>
              {bar.key}: {usd(bar.value)}
            </title>
          </rect>
        ))}
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{points[0]?.key}</span>
        <span>{points.at(-1)?.key}</span>
      </div>
    </div>
  );
}
