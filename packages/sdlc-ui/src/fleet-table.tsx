import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SdlcFleetMachine } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { useSdlcEnv } from "./env.tsx";
import { formatWhen } from "./format.ts";

const text = {
  vi: {
    empty: "Chưa có máy AI SDLC. Thêm máy dùng chung có nhãn sdlc để agent soạn tài liệu.",
    labelsOnly: "Chỉ nhận run có nhãn",
    notReported: "Máy chưa báo gói",
    noAccounts: "Chưa có gói agent",
    reset: "Dùng lại lúc",
    enable: "Bật",
    disable: "Tắt",
    session: "Phiên",
    week: "Tuần",
    online: "Trực tuyến",
    offline: "Ngoại tuyến",
    paused: "Tạm dừng",
    revoked: "Đã thu hồi",
    idle: "Chưa có run đang chạy",
    loggedOut: "Chưa đăng nhập",
    unknown: "Chưa rõ đăng nhập",
  },
  en: {
    empty: "No AI SDLC machines. Add a shared machine labelled sdlc to draft documents.",
    labelsOnly: "Labelled runs only",
    notReported: "No account report yet",
    noAccounts: "No agent accounts",
    reset: "Available again at",
    enable: "Enable",
    disable: "Disable",
    session: "Session",
    week: "Week",
    online: "Online",
    offline: "Offline",
    paused: "Paused",
    revoked: "Revoked",
    idle: "No active runs",
    loggedOut: "Logged out",
    unknown: "Login unknown",
  },
};

/** Thẻ theo máy giữ run và quota dễ đọc ở 360 px. */
export function FleetTable({ machines }: { machines: SdlcFleetMachine[] }) {
  const { api, lang, link, errorMessage } = useSdlcEnv();
  const t = text[lang];
  const client = useQueryClient();
  const setAccount = useMutation(
    api.machines.setAccount.mutationOptions({
      onSuccess: () => {
        void client.invalidateQueries({ queryKey: api.machines.key() });
      },
    }),
  );
  if (!machines.length) return <p className="text-sm text-muted-foreground">{t.empty}</p>;
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      {setAccount.error && <Alert variant="destructive">{errorMessage(setAccount.error)}</Alert>}
      {machines.map((m) => (
        <section
          key={m.id}
          aria-label={m.name}
          className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-sm"
        >
          <header className="flex flex-wrap justify-between gap-2">
            <strong className="break-all font-mono">{m.name}</strong>
            <span>
              {t[m.status]} · {m.slotsUsed}/{m.capacity}
            </span>
          </header>
          <p className="text-muted-foreground">
            {m.teamName} · {m.os} · {m.clis.join(", ")} · v{m.version}
          </p>
          <p className="flex flex-wrap gap-2">
            {m.labels?.map((label) => (
              <span key={label} className="rounded bg-muted px-2 font-mono">
                {label}
              </span>
            ))}
            {m.labelsOnly && <span>{t.labelsOnly}</span>}
          </p>
          <ul className="flex flex-col gap-1">
            {m.runs.map((run) => (
              <li key={run.runId}>
                {link({
                  to: { kind: "run", id: run.runId },
                  className: "break-words underline",
                  children: `${run.projectKey} · ${run.item ? `${run.item.ref} · ${run.item.title}` : run.kind}${run.step ? ` · ${run.step}` : ""}`,
                })}
              </li>
            ))}
          </ul>
          {!m.runs.length && <p className="text-muted-foreground">{t.idle}</p>}
          {m.accounts == null ? (
            <p>{t.notReported}</p>
          ) : !m.accounts.length ? (
            <p>{t.noAccounts}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {m.accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                  <div className="min-w-0">
                    <strong className="break-all">
                      {a.cli} · {a.label}
                    </strong>
                    <p className="text-xs text-muted-foreground">
                      {t.session}: {a.sessionPct ?? "—"}% · {t.week}: {a.weekPct ?? "—"}%
                      {a.loggedIn === false ? ` · ${t.loggedOut}` : a.loggedIn === null ? ` · ${t.unknown}` : ""}
                    </p>
                    {a.resetsAt && (
                      <p className="text-xs">
                        {t.reset} {formatWhen(a.resetsAt, lang)}
                      </p>
                    )}
                  </div>
                  {m.canSetAccounts && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={setAccount.isPending || m.status !== "online"}
                      onClick={() => setAccount.mutate({ machineId: m.id, accountId: a.id, enabled: !a.enabled })}
                      aria-label={`${a.enabled ? t.disable : t.enable} ${a.label}`}
                    >
                      {a.enabled ? t.disable : t.enable}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {m.quotaResetsAt && (
            <p>
              {t.reset} {formatWhen(m.quotaResetsAt, lang)}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
