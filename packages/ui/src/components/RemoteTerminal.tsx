import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { isTerminalFinal, terminalCheckoutRef, type TerminalSession, type TerminalStepUpOperation } from "@xdev-hive/core";
import { Terminal as TerminalIcon } from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { NativeSelect } from "#ui/components/ui/native-select.tsx";
import { Toggle } from "#ui/components/ui/primitives.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "#ui/components/ui/dialog.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeProject } from "#ui/lib/scope.ts";
import { terminalSecure, type TerminalApi, type TerminalAttachment } from "#ui/lib/terminal-client.ts";

const TerminalScreen = lazy(() => import("#ui/components/TerminalScreen.tsx"));
type Target = { machineId?: string; project?: string; checkoutRef?: string; runActive?: boolean };
const OpenTerminal = createContext<((target: Target) => void) | null>(null);
// Sunken, 12px radius, 36px tall: the cosmic control shape; textareas only take the min height.
export const terminalControl = "w-full min-w-0 min-h-9 max-md:!min-h-11 rounded-xl border-0 bg-sunken px-3 py-2 text-base text-fg-primary shadow-[var(--ring-glass)] outline-none focus-visible:focus-ring md:text-sm";
/** A native select keeps the browser's picker (and its keyboard/mobile behaviour) under the cosmic skin. */
function TerminalSelect({ className = "", ...props }: Omit<ComponentProps<"select">, "size">) {
  return <NativeSelect wrapperClassName="w-full" className={`${terminalControl} h-9 appearance-none py-0 pr-9 disabled:opacity-60 ${className}`} {...props} />;
}

export function TerminalDialogContent({ className = "", ...props }: ComponentProps<typeof DialogContent>) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !node) return;
    const fit = () => {
      if (window.innerWidth < 768) {
        node.style.setProperty("height", `${viewport.height}px`, "important");
        node.style.setProperty("top", `${viewport.offsetTop}px`, "important");
      } else { node.style.removeProperty("height"); node.style.removeProperty("top"); }
    };
    fit(); viewport.addEventListener("resize", fit); viewport.addEventListener("scroll", fit);
    return () => { viewport.removeEventListener("resize", fit); viewport.removeEventListener("scroll", fit); };
  }, [node]);
  return <DialogContent {...props} ref={setNode} className={`${className} max-md:!min-h-0 max-md:!overflow-y-auto max-md:[&_button]:!min-h-11 max-md:[&_button]:!min-w-11 max-md:pt-[max(var(--space-3),env(safe-area-inset-top))] max-md:pb-[max(var(--space-3),env(safe-area-inset-bottom))]`} />;
}

export function TerminalEntry({ source, ...target }: Target & { source: "machine" | "run" | "chat" }) {
  const { client } = useHive();
  const t = useT();
  const open = useContext(OpenTerminal);
  const settings = useQuery(async () => client.desktop ? client.desktop.settings() : null, [client]);
  const machines = useQuery(async () => client.desktop && source === "run" ? client.call("machines.list", {}) : [], [client, source]);
  if (client.desktop) {
    if (!settings.data?.hubUrl) return null;
    const matches = machines.data?.filter(machine => machine.machine === settings.data?.machine) ?? [];
    const machineId = target.machineId ?? (matches.length === 1 ? matches[0]!.id : undefined);
    const url = new URL(settings.data.hubUrl);
    url.hash = `/chat?terminal=1&${new URLSearchParams({ ...(machineId ? { terminalMachine: machineId } : {}), ...(target.project ? { terminalProject: target.project } : {}), ...(target.checkoutRef ? { terminalCheckout: target.checkoutRef } : {}), ...(target.runActive ? { terminalRunActive: "1" } : {}) })}`;
    return <Button size="sm" variant="outline" className="max-md:min-h-11" asChild><a data-testid={`terminal-open-${source}`} href={url.href} target="_blank" rel="noreferrer"><TerminalIcon aria-hidden="true" />{t("terminal.openHub")}</a></Button>;
  }
  return <Button size="sm" variant="outline" className="max-md:min-h-11" data-testid={`terminal-open-${source}`} onClick={() => open?.(target)}><TerminalIcon aria-hidden="true" />{t(source === "run" ? "terminal.openRun" : "terminal.open")}</Button>;
}

/** Chat links may prefill a form, never a command, proof or automatic create. */
export function TerminalProvider({ children }: { children: ReactNode }) {
  const { client } = useHive();
  const t = useT();
  const [target, setTarget] = useState<Target | null>(null);
  const [attachment, setAttachment] = useState<TerminalAttachment | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const fromLink = () => {
      // The terminal page hosts sessions in its own frame; the dialog is only for entries on other pages.
      if (location.hash.startsWith("#/terminal") && !busy.current) { setTarget(null); setAttachment(null); return; }
      const params = new URLSearchParams(location.hash.split("?")[1]);
      if (params.get("terminal") !== "1") return;
      setTarget({ machineId: params.get("terminalMachine") ?? undefined, project: params.get("terminalProject") ?? undefined, checkoutRef: params.get("terminalCheckout") ?? undefined, runActive: params.get("terminalRunActive") === "1" });
      for (const key of [...params.keys()]) if (key.startsWith("terminal")) params.delete(key);
      history.replaceState(null, "", `${location.hash.split("?")[0]}${params.size ? `?${params}` : ""}`);
    };
    fromLink(); window.addEventListener("hashchange", fromLink);
    return () => window.removeEventListener("hashchange", fromLink);
  }, []);
  const close = () => { if (busy.current) return; setTarget(null); setAttachment(null); };
  return <OpenTerminal.Provider value={(next) => { setAttachment(null); setTarget(next); }}>
    {children}
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <TerminalDialogContent data-testid={attachment ? "terminal-dialog" : "terminal-create-dialog"} showCloseButton={!attachment} className={attachment ? "terminal-dialog !flex !max-w-6xl !flex-col !gap-2 !p-3 !h-[min(90dvh,900px)]" : "max-h-[90dvh] overflow-y-auto max-md:max-h-none max-md:[&_button]:min-h-11"}
        onEscapeKeyDown={(e) => { if (attachment || busy.current) e.preventDefault(); }} onInteractOutside={(e) => { if (attachment || busy.current) e.preventDefault(); }}>
        <DialogTitle>{t("terminal.title")}</DialogTitle>
        <DialogDescription className={attachment ? "sr-only" : "pr-6"}>{t("terminal.scope")}</DialogDescription>
        {target && !attachment ? client.terminal ? <TerminalForm key={JSON.stringify(target)} api={client.terminal} target={target} busyRef={busy} onCreated={setAttachment} /> : <p role="status">{t("errors.terminal.notHuman")}</p> : null}
        {attachment && client.terminal ? <Suspense fallback={<p role="status">{t("terminal.loading")}</p>}><TerminalScreen api={client.terminal} attachment={attachment} onDetach={close} /></Suspense> : null}
      </TerminalDialogContent>
    </Dialog>
  </OpenTerminal.Provider>;
}

/** SSO proof stays in memory while the popup reauthenticates the same cookie. */
export async function verifyTerminal(api: TerminalApi, target: { project: string; machineId: string; sessionId?: string }, operation: TerminalStepUpOperation, password: string, method: "password" | "oidc", failure: string): Promise<string> {
  const popup = method === "oidc" ? window.open("about:blank", "hive-terminal-reauth", "popup,width=480,height=720") : null;
  if (method === "oidc" && !popup) throw new Error(failure);
  try {
    const result = await api.stepUp({ ...target, operation, method, ...(method === "password" ? { password } : { returnTo: "/?terminal-reauth=1" }) });
    if (result.method === "password") return result.stepUpId;
    popup!.location.href = result.url;
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5 * 60_000;
      const timer = setInterval(() => {
        if (popup!.closed || Date.now() > deadline) { clearInterval(timer); reject(new Error(failure)); return; }
        try {
          const url = new URL(popup!.location.href);
          if (url.origin === location.origin && url.searchParams.get("terminal-reauth") === "1") { clearInterval(timer); resolve(); }
        } catch { /* Provider pages have a different origin while signing in. */ }
      }, 250);
    });
    return result.stepUpId;
  } finally { popup?.close(); }
}

export function TerminalForm({ api, target, busyRef, onCreated, initial, hideSessions }: { api: TerminalApi; target: Target; busyRef: { current: boolean }; onCreated: (a: TerminalAttachment) => void; initial?: TerminalSession; hideSessions?: boolean }) {
  const { client, projects, scope, me } = useHive();
  const t = useT();
  const [machineId, setMachine] = useState(initial?.machineId ?? target.machineId ?? "");
  const [project, setProject] = useState(initial?.project ?? target.project ?? scopeProject(scope) ?? "");
  const [checkoutRef, setCheckout] = useState(initial?.checkoutRef ?? (terminalCheckoutRef.safeParse(target.checkoutRef).success ? target.checkoutRef! : "repo"));
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<TerminalSession | null>(initial ?? null);
  const action = useAction();
  const key = useRef(crypto.randomUUID());
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const machine = machines.data?.find(m => m.id === machineId);
  const availableProjects = projects.filter(p => machine?.projects.includes(p));
  const capability = useQuery(() => machineId && project ? api.capabilities({ machineId, project }) : Promise.resolve(null), [api, machineId, project]);
  const worktrees = useQuery(() => machineId ? client.call("machines.worktrees", { machineId }) : Promise.resolve(null), [client, machineId]);
  const sessions = useQuery(() => project ? api.list(project) : Promise.resolve([]), [api, project]);
  const refs = [...new Set((worktrees.data?.report?.entries ?? []).filter(e => e.project === project && terminalCheckoutRef.safeParse(`worktree:${e.taskId}`).success).map(e => `worktree:${e.taskId}`))];
  if (target.checkoutRef && terminalCheckoutRef.safeParse(target.checkoutRef).success && !refs.includes(target.checkoutRef) && target.checkoutRef !== "repo") refs.push(target.checkoutRef);
  const secure = terminalSecure(new URL(location.href));
  const unavailable = !secure ? t("terminal.https") : !machine?.online ? t("terminal.offline") : capability.error ?? (capability.data?.unavailable ? t(`errors.terminal.${capability.data.unavailable}`) : null);
  const blocked = !machine || !project || !availableProjects.includes(project) || !!unavailable || capability.loading || !capability.data || (!selected && capability.data.busy) || !consent;
  const submit = (method: "password" | "oidc") => {
    if (blocked || action.busy || busyRef.current) return;
    busyRef.current = true;
    const secret = password; setPassword("");
    void action.run(async () => {
      const stepUpId = await verifyTerminal(api, { project, machineId, ...(selected ? { sessionId: selected.id } : {}) }, selected ? "attach" : "create", secret, method, t("terminal.ssoFailed"));
      const a = selected ? await api.attach({ sessionId: selected.id, stepUpId, lastOutputSeq: 0, takeControl: true }) : await api.create({ machineId, project, checkoutRef, mode: "shell", reason, stepUpId, idempotencyKey: key.current });
      if (!a.ticket) throw new Error(t("terminal.alreadyCreated"));
      onCreated({ ...a, osUser: capability.data?.osUser });
    }).finally(() => { busyRef.current = false; });
  };
  return <form className="flex min-w-0 flex-col gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); submit("password"); }} aria-busy={action.busy}>
    <fieldset disabled={action.busy} className="flex min-w-0 flex-col gap-3">
      <label>{t("terminal.machine")}<TerminalSelect data-testid="terminal-machine" value={machineId} onChange={e => { setMachine(e.target.value); setSelected(null); setCheckout("repo"); }}><option value="">{t("terminal.choose")}</option>{machines.data?.map(m => <option key={m.id} value={m.id}>{m.machine}</option>)}</TerminalSelect></label>
      <label>{t("terminal.project")}<TerminalSelect data-testid="terminal-project" value={project} onChange={e => { setProject(e.target.value); setSelected(null); setCheckout("repo"); }}><option value="">{t("terminal.choose")}</option>{availableProjects.map(p => <option key={p}>{p}</option>)}</TerminalSelect></label>
      <label>{t("terminal.checkout")}<TerminalSelect data-testid="terminal-checkout" disabled={!!selected} value={checkoutRef} onChange={e => setCheckout(e.target.value)}><option value="repo">{t("terminal.repo")}</option>{refs.map(ref => <option key={ref}>{ref}</option>)}</TerminalSelect></label>
      {checkoutRef !== "repo" ? <p className="text-warning">{t("terminal.worktreeHint")}</p> : null}
      {target.runActive ? <p className="text-warning">{t("terminal.runLock")}</p> : null}
      {unavailable ? <p role="status" data-testid="terminal-unavailable">{unavailable}</p> : null}
      {!selected && capability.data?.busy ? <p role="status">{t("errors.terminal.busy")}</p> : null}
      <label>{t("terminal.reason")}<input className={terminalControl} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <div className="flex items-baseline gap-2 text-fg-secondary"><p className={`min-w-0 flex-1 ${more ? "" : "truncate"}`} data-testid="terminal-audit-scope">{t("terminal.auditScope")}</p><button type="button" aria-expanded={more} className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[12px] font-semibold text-[var(--accent-violet)] max-md:min-h-11" onClick={() => setMore(!more)}>{t(more ? "terminal.less" : "terminal.more")}</button></div>
      <Toggle checked={consent} onChange={e => setConsent(e.target.checked)}>{t("terminal.consent")}</Toggle>
      <label>{t("terminal.password")}<input data-testid="terminal-step-up" className={terminalControl} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <ErrorNote error={action.error ?? machines.error} />
      <Button data-testid="terminal-confirm-open" type="submit" disabled={blocked || !password}>{t(selected ? "terminal.transfer" : "terminal.confirmOpen")}</Button>
      {me.sso?.linked ? <Button type="button" variant="outline" disabled={blocked} onClick={() => submit("oidc")}>{t("terminal.sso")}</Button> : null}
      {selected ? <Button type="button" variant="outline" onClick={() => setSelected(null)}>{t("terminal.newSession")}</Button> : null}
      {!hideSessions ? sessions.data?.map(s => <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line-default p-2"><span className="min-w-0 flex-1 break-all">{s.machineId} · {s.checkoutRef} · {t(`terminal.states.${s.state}`)}</span>{isTerminalFinal(s.state) ? <Button type="button" variant="outline" data-testid="terminal-session-audit" onClick={() => onCreated({ session: s, ticket: null })}>{t("terminal.audit")}</Button> : <><Button type="button" variant="outline" data-testid="terminal-session-attach" disabled={s.creator !== me.user?.username} title={s.creator !== me.user?.username ? t("errors.terminal.notCreator") : undefined} onClick={() => { setSelected(s); setMachine(s.machineId); setCheckout(s.checkoutRef); }}>{t("terminal.transfer")}</Button><Button type="button" variant="danger-outline" data-testid="terminal-session-stop" onClick={() => void action.run(async () => { await api.terminate(s.id); sessions.reload(); capability.reload(); })}>{t("terminal.stop")}</Button></>}</div>) : null}
    </fieldset>
  </form>;
}
