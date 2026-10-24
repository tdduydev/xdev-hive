import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeployEnvironment, EnvironmentRunner, RunnerCandidate } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { DialogActions, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { type FormEvent, useState } from "react";
import { LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { DEPLOY_METHOD_LABEL } from "@/lib/delivery-text.ts";
import { useOrg } from "@/shell/org-context.ts";

const VI = {
  title: (env: string) => `Máy chạy deploy của ${env}`,
  lead: "Máy trong mạng nội bộ bấm job Jenkins hoặc sync Argo CD bằng credential trong kho của máy. Log nằm trên máy đó.",
  mode: "Ai chạy",
  modeWorker: "Máy chạy deploy của đội",
  modeWorkerHint: "Hub chỉ giao việc. Cần ít nhất một máy trực tuyến có đủ credential của đích.",
  modeLegacy: "Hub tự gọi (cách cũ)",
  modeLegacyHint: "Chỉ chạy khi hub được phép gọi ra ngoài. Để chuyển dần các môi trường cũ.",
  requireLabel: "Chỉ máy có nhãn deploy-runner",
  chosen: "Máy đã chọn, theo thứ tự ưu tiên",
  chosenEmpty: "Chưa chọn máy nào: máy nào của đội đủ điều kiện cũng được.",
  candidates: "Máy của đội",
  candidatesEmpty: "Đội chưa có máy nào trực tuyến. Bật worker trên một máy của đội.",
  loading: "Đang tải máy chạy",
  online: "Trực tuyến",
  offline: "Đang tắt",
  labeled: "deploy-runner",
  notReported: "Máy chưa báo khả năng chạy deploy (worker cũ).",
  methods: (list: string) => `Chạy được: ${list}`,
  credentials: (list: string) => `Credential: ${list}`,
  noCredentials: "Chưa có credential nào trong kho của máy.",
  add: "Chọn",
  addOf: (name: string) => `Chọn máy ${name}`,
  up: (name: string) => `Đưa máy ${name} lên trước`,
  down: (name: string) => `Đưa máy ${name} xuống sau`,
  remove: (name: string) => `Bỏ máy ${name}`,
  unknownMachine: "Máy không còn trong đội",
  cancel: "Huỷ",
  save: "Lưu",
  saving: "Đang lưu…",
};

/** Tóm tắt cột "Máy chạy" ở bảng môi trường. */
export function runnerSummary(runner: EnvironmentRunner): string {
  if (runner.mode === "legacy") return VI.modeLegacy;
  const picked = runner.machines.length === 0 ? "máy nào của đội cũng được" : `${runner.machines.length} máy đã chọn`;
  return `${VI.modeWorker}: ${picked}${runner.requireLabel ? ", cần nhãn deploy-runner" : ""}`;
}

function CandidateInfo({ c }: { c: RunnerCandidate }) {
  return (
    <span className="grid gap-0.5 text-xs text-muted-foreground">
      {c.reportedAt === null ? (
        <span>{VI.notReported}</span>
      ) : (
        <>
          <span>{VI.methods(c.methods.map((m) => DEPLOY_METHOD_LABEL[m]).join(", ") || "-")}</span>
          <span className="font-mono break-all">
            {c.credentials.length > 0 ? VI.credentials(c.credentials.join(", ")) : VI.noCredentials}
          </span>
        </>
      )}
    </span>
  );
}

function MachineHead({ c, name }: { c: RunnerCandidate | undefined; name: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-foreground">{name}</span>
      {c && (
        <Pill tone={c.online ? "ok" : "neutral"} small dot>
          {c.online ? VI.online : VI.offline}
        </Pill>
      )}
      {c?.labeled && (
        <Pill tone="neutral" small>
          {VI.labeled}
        </Pill>
      )}
    </span>
  );
}

/** Chọn ai chạy lần triển khai của môi trường (specs/032 FR-012, FR-013). */
export function RunnerForm({ environment, onDone }: { environment: DeployEnvironment; onDone: () => void }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const candidates = useQuery(api.environments.runnerCandidates.queryOptions({ input: { id: environment.id } }));
  const [mode, setMode] = useState(environment.runner.mode);
  const [machines, setMachines] = useState(environment.runner.machines);
  const [requireLabel, setRequireLabel] = useState(environment.runner.requireLabel);
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (runner: EnvironmentRunner) => api.environments.setRunner.call({ id: environment.id, runner }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.environments.key() });
      onDone();
    },
    onError: (error) => setFailure(apiErrorMessage(error)),
  });

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setFailure(null);
    save.mutate({ mode, machines, requireLabel });
  }

  function move(index: number, by: -1 | 1) {
    const next = [...machines];
    const a = next[index];
    const b = next[index + by];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[index + by] = a;
    setMachines(next);
  }

  const byId = new Map((candidates.data ?? []).map((c) => [c.machineId, c]));
  const free = (candidates.data ?? []).filter((c) => !machines.includes(c.machineId));
  const busy = save.isPending;

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{VI.title(environment.name)}</DialogTitle>
      <DialogDescription>{VI.lead}</DialogDescription>

      <fieldset className="grid gap-1">
        <legend className="text-sm font-medium text-foreground">{VI.mode}</legend>
        {(
          [
            ["worker", VI.modeWorker, VI.modeWorkerHint],
            ["legacy", VI.modeLegacy, VI.modeLegacyHint],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className="flex items-start gap-2 py-1 text-sm">
            <input
              type="radio"
              name="runner-mode"
              className="mt-0.5 size-4 accent-primary"
              checked={mode === value}
              disabled={busy}
              onChange={() => setMode(value)}
            />
            <span className="grid gap-0.5">
              <span className="text-foreground">{label}</span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === "worker" && (
        <>
          <label className="flex min-h-9 items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={requireLabel}
              disabled={busy}
              onChange={(e) => setRequireLabel(e.target.checked)}
            />
            {VI.requireLabel}
          </label>

          <section aria-label={VI.chosen} className="grid gap-2">
            <h3 className="text-sm font-medium text-foreground">{VI.chosen}</h3>
            {machines.length === 0 ? (
              <p className="text-xs text-muted-foreground">{VI.chosenEmpty}</p>
            ) : (
              <ol className="grid gap-2">
                {machines.map((machineId, i) => {
                  const c = byId.get(machineId);
                  const name = c?.name ?? VI.unknownMachine;
                  return (
                    <li
                      key={machineId}
                      className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border p-2.5"
                    >
                      <span className="grid min-w-0 gap-1">
                        <MachineHead c={c} name={`${i + 1}. ${name}`} />
                        {c && <CandidateInfo c={c} />}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={VI.up(name)}
                          disabled={i === 0 || busy}
                          onClick={() => move(i, -1)}
                        >
                          Lên
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={VI.down(name)}
                          disabled={i === machines.length - 1 || busy}
                          onClick={() => move(i, 1)}
                        >
                          Xuống
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={VI.remove(name)}
                          disabled={busy}
                          onClick={() => setMachines(machines.filter((m) => m !== machineId))}
                        >
                          Bỏ
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section aria-label={VI.candidates} className="grid gap-2">
            <h3 className="text-sm font-medium text-foreground">{VI.candidates}</h3>
            {candidates.isPending ? (
              <TableSkeleton label={VI.loading} rows={2} columns={2} />
            ) : candidates.isError ? (
              <LoadFailure error={candidates.error} retry={candidates.refetch} />
            ) : candidates.data.length === 0 ? (
              <p className="text-xs text-muted-foreground">{VI.candidatesEmpty}</p>
            ) : free.length === 0 ? null : (
              <ul className="grid gap-2">
                {free.map((c) => (
                  <li
                    key={c.machineId}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border p-2.5"
                  >
                    <span className="grid min-w-0 gap-1">
                      <MachineHead c={c} name={c.name} />
                      <CandidateInfo c={c} />
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={VI.addOf(c.name)}
                      disabled={busy || machines.length >= 20}
                      onClick={() => setMachines([...machines, c.machineId])}
                    >
                      {VI.add}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

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
