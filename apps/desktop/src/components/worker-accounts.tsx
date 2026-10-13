import { Pill } from "@xdev-hive/ui/pill";
import { useCallback, useEffect, useState } from "react";
import { type CliProfile, cliProfiles, setCliProfile } from "@/lib/agent.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  title: string;
  lead: string;
  loading: string;
  empty: string;
  loggedIn: string;
  notLoggedIn: string;
  unsupported: string;
  meta: (priority: number, runs: number) => string;
  toggle: (label: string) => string;
  defaultLogin: string;
}> = {
  vi: {
    title: "Tài khoản CLI của worker",
    lead: "Worker chia run của bạn trên máy này cho các tài khoản đang bật: ưu tiên cao trước, đủ số run thì sang tài khoản khác, tài khoản hết lượt dùng được nghỉ một lúc. Tài khoản đã đăng nhập ở app cũ được mang sang tự động.",
    loading: "Đang đọc tài khoản…",
    empty: "Chưa có tài khoản nào: worker dùng đăng nhập mặc định của từng CLI.",
    loggedIn: "Đã đăng nhập",
    notLoggedIn: "Chưa đăng nhập",
    unsupported: "Worker chưa chạy CLI này",
    meta: (priority, runs) => `ưu tiên ${priority} · tối đa ${runs} run cùng lúc`,
    toggle: (label) => `Dùng tài khoản ${label}`,
    defaultLogin: "đăng nhập mặc định",
  },
  en: {
    title: "Worker CLI accounts",
    lead: "The worker spreads your runs on this machine over the enabled accounts: higher priority first, the next account when one is full, and an account that hit its usage limit rests for a while. Accounts signed in on the old app are brought over automatically.",
    loading: "Reading accounts…",
    empty: "No accounts yet: the worker uses each CLI's default sign-in.",
    loggedIn: "Signed in",
    notLoggedIn: "Not signed in",
    unsupported: "Worker does not run this CLI",
    meta: (priority, runs) => `priority ${priority} · up to ${runs} runs at once`,
    toggle: (label) => `Use account ${label}`,
    defaultLogin: "default sign-in",
  },
};

const CLI_NAME: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  antigravity: "Antigravity",
};

/** Danh sách tài khoản CLI worker dùng cho run trên máy này, bật tắt từng tài khoản (spec 008 US13, FR-029). */
export function WorkerAccounts() {
  const t = useT(text);
  const [list, setList] = useState<CliProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList((await cliProfiles()).accounts);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(a: CliProfile) {
    setBusy(a.id);
    try {
      setList((await setCliProfile(a.id, !a.enabled)).accounts);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-labelledby="worker-accounts"
      className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <h2 id="worker-accounts" className="text-sm font-semibold">
        {t.title}
      </h2>
      <p className="text-[13px] text-muted-foreground">{t.lead}</p>
      {error && <p className="text-[13px] text-destructive">{error}</p>}
      {!list && !error && <p className="text-[13px] text-muted-foreground">{t.loading}</p>}
      {list?.length === 0 && <p className="text-[13px] text-muted-foreground">{t.empty}</p>}
      {list && list.length > 0 && (
        <ul className="m-0 flex list-none flex-col divide-y p-0">
          {list.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
              <input
                type="checkbox"
                aria-label={t.toggle(a.label || a.id)}
                checked={a.enabled}
                disabled={!a.supported || busy === a.id}
                onChange={() => void toggle(a)}
                className="size-4 cursor-pointer accent-primary"
              />
              <span className="flex min-w-0 flex-1 flex-col leading-snug">
                <span className="flex flex-wrap items-center gap-1.5">
                  <strong className="text-[13.5px] font-medium">{a.label || a.id}</strong>
                  <span className="text-xs text-muted-foreground">{CLI_NAME[a.cli] ?? a.cli}</span>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {[a.email, a.configDir || t.defaultLogin, t.meta(a.priority, Math.max(a.maxConcurrent, 1))]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {!a.supported ? (
                <Pill tone="neutral">{t.unsupported}</Pill>
              ) : a.loggedIn === false ? (
                <Pill tone="warn">{t.notLoggedIn}</Pill>
              ) : (
                <Pill tone="ok" dot>
                  {t.loggedIn}
                </Pill>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
