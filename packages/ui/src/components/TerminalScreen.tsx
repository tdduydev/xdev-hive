import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { isTerminalFinal, type TerminalSession } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "#ui/components/ui/dialog.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { TerminalConnection, terminalPasteChunks, pasteDisplay, type TerminalApi, type TerminalAttachment } from "#ui/lib/terminal-client.ts";
import { TerminalDialogContent as DialogContent, terminalControl, verifyTerminal } from "#ui/components/RemoteTerminal.tsx";

type Status = TerminalSession["state"] | "connecting" | "disconnected";
const keys = ["esc", "tab", "shiftTab", "up", "down", "left", "right", "interrupt"] as const;
const keyBytes = { esc: "\x1b", tab: "\t", shiftTab: "\x1b[Z", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", interrupt: "\x03" };

export default function TerminalScreen({ api, attachment, onDetach }: { api: TerminalApi; attachment: TerminalAttachment; onDetach: () => void }) {
  const t = useT();
  const { me } = useHive();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const connection = useRef<TerminalConnection | null>(null);
  const [session, setSession] = useState(attachment.session);
  const [status, setStatus] = useState<Status>(attachment.ticket ? "connecting" : attachment.session.state);
  const [gap, setGap] = useState(false);
  const [dropped, setDropped] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  const [tabOut, setTabOut] = useState(true);
  const tabOutRef = useRef(true);
  const [reader, setReader] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [text, setText] = useState("");
  const composing = useRef(false);
  const [paste, setPaste] = useState<string | null>(null);
  const pasting = useRef(false);
  const inputRejected = useRef(false);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [verify, setVerify] = useState<"attach" | "recording" | null>(null);
  const [password, setPassword] = useState("");
  const [recording, setRecording] = useState<Awaited<ReturnType<TerminalApi["recording"]>> | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const action = useAction();
  const tick = usePoll(1000);
  const metadata = useQuery(() => api.get(session.project, session.id), [api, session.id, session.project, status === "closing" ? tick : Math.floor(tick / 5)]);
  useEffect(() => {
    if (!metadata.data) return;
    setSession(metadata.data);
    if (isTerminalFinal(metadata.data.state)) { setStatus(metadata.data.state); connection.current?.detach(); }
  }, [metadata.data]);
  const remaining = Math.max(0, Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 60_000));
  void tick;
  const writable = status === "active";
  const final = status !== "connecting" && status !== "disconnected" && isTerminalFinal(status);

  const send = (data: string) => {
    if (!connection.current?.input(data)) setDropped(true);
    else setDropped(false);
  };
  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({ fontFamily: getComputedStyle(host.current).getPropertyValue("--font-mono"), fontSize: 16, scrollback: 3000, screenReaderMode: false, disableStdin: true, logLevel: "off", cursorBlink: false,
      linkHandler: { activate: () => undefined } });
    const fit = new FitAddon();
    terminal.loadAddon(fit); terminal.open(host.current); term.current = terminal;
    terminal.parser.registerOscHandler(52, () => true);
    terminal.parser.registerOscHandler(8, () => true);
    terminal.attachCustomKeyEventHandler(e => {
      if (e.key === "Tab" && tabOutRef.current) return false;
      // Clipboard shortcuts use the browser path below; Ctrl-C without a selection interrupts the PTY.
      if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && ["c", "v"].includes(e.key.toLowerCase())) return false;
      if (e.ctrlKey && e.key.toLowerCase() === "c" && terminal.hasSelection()) return false;
      return true;
    });
    const conn = new TerminalConnection({
      output: (bytes, rendered) => terminal.write(bytes, rendered),
      gap: () => { terminal.reset(); setGap(true); conn.resize(terminal.cols, terminal.rows); },
      status: (state, reason) => {
        setStatus(old => state === "disconnected" && old !== "connecting" && old !== "disconnected" && isTerminalFinal(old) ? old : state);
        terminal.options.disableStdin = state !== "active";
        if (state === "active") conn.resize(terminal.cols, terminal.rows);
        if (reason) setSession(s => ({ ...s, lastReason: reason as TerminalSession["lastReason"] }));
      },
    });
    connection.current = conn;
    const data = terminal.onData(value => {
      if (ctrlRef.current && /^[a-zA-Z@\[\]\\^_]$/.test(value)) value = String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31);
      ctrlRef.current = false; setCtrl(false);
      inputRejected.current = !conn.input(value);
      setDropped(inputRejected.current);
    });
    const onPaste = (e: ClipboardEvent) => { e.preventDefault(); e.stopImmediatePropagation(); setPaste(e.clipboardData?.getData("text/plain") ?? ""); };
    host.current.addEventListener("paste", onPaste, true);
    const updateTheme = () => {
      const css = getComputedStyle(host.current!);
      const color = (key: string) => css.getPropertyValue(key).trim();
      terminal.options.theme = { background: color("--code-bg"), foreground: color("--code-fg"), cursor: color("--text-strong"), selectionBackground: color("--code-selection"),
        black: color("--text-primary"), red: color("--status-danger-fg"), green: color("--status-success-fg"), yellow: color("--status-warning-fg"), blue: color("--status-info-fg"), magenta: color("--syntax-keyword"), cyan: color("--syntax-type"), white: color("--text-strong"),
        brightBlack: color("--text-muted"), brightRed: color("--status-danger-fg"), brightGreen: color("--status-success-fg"), brightYellow: color("--status-warning-fg"), brightBlue: color("--status-info-fg"), brightMagenta: color("--syntax-keyword"), brightCyan: color("--syntax-type"), brightWhite: color("--text-strong") };
    };
    updateTheme();
    const theme = new MutationObserver(updateTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const resize = new ResizeObserver(() => { fit.fit(); conn.resize(terminal.cols, terminal.rows); });
    resize.observe(host.current);
    fit.fit();
    if (attachment.ticket) conn.connect(api.socket(), attachment.ticket, attachment.session.writerEpoch);
    const node = host.current;
    return () => { conn.detach(); data.dispose(); resize.disconnect(); theme.disconnect(); node.removeEventListener("paste", onPaste, true); terminal.dispose(); connection.current = null; term.current = null; };
  }, [api, attachment]);

  useEffect(() => { if (term.current?.textarea) term.current.textarea.setAttribute("aria-label", t("terminal.input")); }, [t]);

  const authenticate = (method: "password" | "oidc") => {
    const operation = verify;
    if (!operation || action.busy) return;
    const secret = password; setPassword("");
    void action.run(async () => {
      const stepUpId = await verifyTerminal(api, { project: session.project, machineId: session.machineId, sessionId: session.id }, operation, secret, method, t("terminal.ssoFailed"));
      if (operation === "recording") setRecording(await api.recording({ sessionId: session.id, stepUpId, cursor: 0 }));
      else {
        const a = await api.attach({ sessionId: session.id, stepUpId, lastOutputSeq: connection.current?.lastOutputSeq ?? 0, takeControl: true });
        setSession(a.session);
        if (!a.ticket) throw new Error(t("terminal.alreadyCreated"));
        connection.current?.connect(api.socket(), a.ticket, a.session.writerEpoch);
      }
      setVerify(null);
    });
  };
  const confirmPaste = async () => {
    const conn = connection.current, terminal = term.current;
    if (paste === null || !writable || !conn || !terminal || pasting.current) return;
    const generation = conn.generation;
    const value = paste;
    setPaste(null);
    ctrlRef.current = false; setCtrl(false);
    pasting.current = true; setPasteBusy(true);
    try {
      // A takeover/reconnect must cancel the unsent tail, even if the replacement socket is already writable.
      for (const chunk of terminalPasteChunks(value)) {
        if (connection.current !== conn || conn.generation !== generation || !conn.writable) { setDropped(true); break; }
        terminal.paste(chunk);
        if (inputRejected.current) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } finally {
      pasting.current = false; setPasteBusy(false);
    }
    if (connection.current === conn && conn.generation === generation) terminal.focus();
  };
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 text-sm max-md:pb-[env(safe-area-inset-bottom)] max-md:[&_button]:!min-h-11 max-md:[&_button]:!min-w-11">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs break-all"><span>{session.machineId} · {session.project} · {session.checkoutRef}</span><span>{attachment.osUser ? t("terminal.osUserName", { user: attachment.osUser }) : t("terminal.osUser")}</span><strong>{t("terminal.scope")}</strong><span data-testid="terminal-ttl">{t("terminal.ttl", { minutes: remaining })}</span></div>
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1 text-xs" data-testid="terminal-status" role="status" aria-live="polite">{t(`terminal.states.${status}`)}{session.lastReason ? ` · ${t(`terminal.reasons.${session.lastReason}`)}` : ""}</p>
      {status === "disconnected" ? <Button data-testid="terminal-reconnect" variant="outline" onClick={() => setVerify("attach")}>{t("terminal.reconnect")}</Button> : null}
      <Button data-testid="terminal-detach" variant="outline" onClick={onDetach}>{t("terminal.detach")}</Button>
      <Button data-testid="terminal-stop" variant="danger-outline" disabled={final || status === "closing" || action.busy} onClick={() => void action.run(async () => { const s = await api.terminate(session.id); setSession(s); setStatus(s.state); connection.current?.detach(); })}>{t("terminal.stop")}</Button>
    </div>
    {gap ? <p data-testid="terminal-audit-gap" role="status" className="text-xs text-warning">{t("terminal.gap")}</p> : null}
    {dropped ? <p role="status" className="text-xs text-warning">{t("terminal.dropped")}</p> : null}
    {remaining <= 1 && !final ? <p role="status" className="text-xs text-warning">{t("terminal.expiring")}</p> : null}
    <ErrorNote error={action.error} />
    <div data-testid="terminal-screen" ref={host} className="terminal-screen min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border border-line-default bg-code-bg p-1" />
    <div role="group" aria-label={t("terminal.keys")} className="flex shrink-0 gap-2 overflow-x-auto pb-1">
      <Button data-testid="terminal-key-ctrl" variant={ctrl ? "default" : "outline"} aria-pressed={ctrl} disabled={!writable || pasteBusy} onClick={() => { ctrlRef.current = !ctrl; setCtrl(!ctrl); term.current?.focus(); }}>{t(ctrl ? "terminal.ctrlOn" : "terminal.ctrl")}</Button>
      {keys.map(key => <Button key={key} data-testid={`terminal-key-${key}`} aria-label={t(`terminal.keyNames.${key}`)} variant="outline" disabled={!writable} onClick={() => { ctrlRef.current = false; setCtrl(false); send(keyBytes[key]); term.current?.focus(); }}>{t(`terminal.keysLabel.${key}`)}</Button>)}
    </div>
    <div className="flex max-h-[35%] shrink-0 flex-col gap-2 overflow-y-auto">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" data-testid="terminal-keyboard" disabled={!writable} onClick={() => term.current?.focus()}>{t("terminal.keyboard")}</Button>
        <Button data-testid="terminal-copy" variant="outline" onClick={() => void action.run(async () => { const selection = term.current?.getSelection() ?? ""; if (selection) { try { await navigator.clipboard.writeText(selection); } catch { setCopied(selection); } } })}>{t("terminal.copy")}</Button>
        <Button data-testid="terminal-paste" variant="outline" disabled={!writable || pasteBusy} onClick={() => void action.run(async () => { try { setPaste(await navigator.clipboard.readText()); } catch { setPaste(""); } })}>{t("terminal.paste")}</Button>
        <Button variant="outline" aria-pressed={fallback} data-testid="terminal-ime" onClick={() => setFallback(!fallback)}>{t("terminal.ime")}</Button>
        <Button variant="outline" aria-pressed={tabOut} data-testid="terminal-tab-out" onClick={() => { tabOutRef.current = !tabOut; setTabOut(!tabOut); }}>{t(tabOut ? "terminal.tabOut" : "terminal.tabSend")}</Button>
        <Button data-testid="terminal-reader" variant="outline" aria-pressed={reader} onClick={() => { setReader(!reader); if (term.current) term.current.options.screenReaderMode = !reader; }}>{t("terminal.reader")}</Button>
        <Button data-testid="terminal-transfer" variant="outline" disabled={final} onClick={() => setVerify("attach")}>{t("terminal.transfer")}</Button>
        <Button data-testid="terminal-audit" variant="outline" onClick={() => setVerify("recording")}>{t("terminal.audit")}</Button>
      </div>
      {fallback ? <div className="flex flex-col gap-2"><label>{t("terminal.imeHint")}<textarea data-testid="terminal-ime-input" className={terminalControl} rows={2} value={text} onChange={e => setText(e.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} /></label><Button disabled={!writable || !text || pasteBusy} data-testid="terminal-ime-send" onClick={() => { if (composing.current) return; setPaste(text); setText(""); }}>{t("terminal.preview")}</Button></div> : null}
    </div>
    <Dialog open={paste !== null} onOpenChange={open => { if (!open) setPaste(null); }}><DialogContent data-testid="terminal-paste-preview" className="max-h-[90dvh] overflow-y-auto"><DialogTitle>{t("terminal.preview")}</DialogTitle><DialogDescription>{t("terminal.pasteHint")}</DialogDescription><label>{t("terminal.pasteText")}<textarea className={terminalControl} data-testid="terminal-paste-input" rows={4} value={paste ?? ""} onChange={e => setPaste(e.target.value)} /></label><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sunken p-2 text-xs" data-testid="terminal-paste-visible">{pasteDisplay(paste ?? "")}</pre><p className="text-xs">{t("terminal.pasteSize", { bytes: new TextEncoder().encode(paste ?? "").length })}</p><Button data-testid="terminal-paste-confirm" disabled={!writable || !paste || new TextEncoder().encode(paste).length > 64 * 1024} onClick={() => void confirmPaste()}>{t("terminal.pasteConfirm")}</Button></DialogContent></Dialog>
    <Dialog open={verify !== null} onOpenChange={open => { if (!open && !action.busy) { setVerify(null); setPassword(""); } }}><DialogContent data-testid="terminal-verify" onEscapeKeyDown={e => { if (action.busy) e.preventDefault(); }} onInteractOutside={e => { if (action.busy) e.preventDefault(); }}><DialogTitle>{t(verify === "attach" ? "terminal.transfer" : "terminal.audit")}</DialogTitle><DialogDescription>{t(verify === "attach" ? "terminal.reconnectHint" : "terminal.auditHint")}</DialogDescription><form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); authenticate("password"); }}><label>{t("terminal.password")}<input className={terminalControl} data-testid="terminal-step-up" type="password" autoComplete="current-password" value={password} disabled={action.busy} onChange={e => setPassword(e.target.value)} /></label><ErrorNote error={action.error} /><Button data-testid="terminal-verify-confirm" disabled={action.busy || !password}>{t("terminal.verify")}</Button>{me.sso?.linked ? <Button type="button" variant="outline" disabled={action.busy} onClick={() => authenticate("oidc")}>{t("terminal.sso")}</Button> : null}</form></DialogContent></Dialog>
    <Dialog open={recording !== null || copied !== null} onOpenChange={open => { if (!open) { setRecording(null); setCopied(null); } }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogTitle>{t(copied !== null ? "terminal.copy" : "terminal.audit")}</DialogTitle><DialogDescription>{t(copied !== null ? "terminal.copyFallback" : "terminal.auditHint")}</DialogDescription>{copied !== null ? <textarea className={terminalControl} readOnly value={copied} onFocus={e => e.target.select()} /> : <div data-testid="terminal-recording">{recording?.chunks.map(chunk => <p key={chunk.seq} className="text-xs break-all">#{chunk.seq} · {chunk.bytes} B · {chunk.createdAt}</p>)}{!recording?.chunks.length ? <p>{t("terminal.noAudit")}</p> : null}{recording?.next !== null ? <p>{t("terminal.auditMore")}</p> : null}</div>}</DialogContent></Dialog>
  </div>;
}
