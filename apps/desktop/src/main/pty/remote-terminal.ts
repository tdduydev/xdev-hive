// The remote terminal on this machine (spec 69), off unless the person at the machine wrote its local policy file
// (readLocalPolicy: 0600, theirs, enabled true, project roots). The hub cannot switch it on: it only sees the
// capability the heartbeat reports from that file and the recorder's readiness, and the socket is opened from here.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { TERMINAL_PROTOCOL, type TerminalCapability } from "@xdev-hive/core";
import { loadTerminalKey, TerminalRecorder, terminalRecorderReady } from "@xdev-hive/core/node";
import { MachineSocket } from "#desktop/main/pty/machine-socket.ts";
import { MachineTerminalAgent } from "#desktop/main/pty/relay-agent.ts";
import { PtySupervisor, readLocalPolicy, type LocalPolicy } from "#desktop/main/pty/supervisor.ts";
import type { ResourceLocks } from "#desktop/main/resource-locks.ts";

export interface RemoteTerminalOptions {
  dataDir: string;
  hub: () => { url: string; token: string } | null;
  /** The runner's hub label, as its heartbeat sends it. */
  label: () => string;
  /** Projects this app knows; the policy may name only some of them. */
  projects: () => string[];
  locks: ResourceLocks;
  draining: () => boolean;
  /** Literal secrets the transcript must never show (the hub token, profile secrets). */
  known: () => string[];
  log: (line: string) => void;
}

export class RemoteTerminal {
  readonly policyFile: string;
  readonly #spool: string;
  readonly #keyFile: string;
  readonly #o: RemoteTerminalOptions;
  #master: Buffer | null = null;
  #agent: MachineTerminalAgent | null = null;
  #socket: MachineSocket | null = null;

  constructor(o: RemoteTerminalOptions) {
    this.#o = o;
    this.policyFile = path.join(o.dataDir, "remote-terminal.json");
    this.#spool = path.join(o.dataDir, "terminal-spool");
    // Beside the spool, not in it: whoever copies the spool does not get the key with it.
    this.#keyFile = path.join(o.dataDir, "terminal.key");
  }

  get busy(): boolean { return !!this.#agent?.busy; }

  #policy(): LocalPolicy | null {
    try { return readLocalPolicy(this.policyFile); } catch { return null; }
  }

  #auditReady(): boolean {
    try {
      mkdirSync(this.#spool, { recursive: true, mode: 0o700 });
      this.#master ??= loadTerminalKey(this.#keyFile);
      return terminalRecorderReady(this.#spool, this.#master) === null;
    } catch {
      return false;
    }
  }

  /** What the heartbeat says; also starts the relay once the local policy allows it and stops it when it no longer does. */
  capability(): TerminalCapability {
    const policy = this.#policy();
    const known = new Set(this.#o.projects());
    const platforms = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? [process.platform] : [];
    const auditReady = !!policy && this.#auditReady();
    const enabled = !!policy && !!this.#o.hub();
    if (enabled && auditReady) this.#start();
    else if (!policy) this.#stop();
    return {
      protocol: TERMINAL_PROTOCOL, enabled, projects: policy ? Object.keys(policy.projects).filter((p) => known.has(p)) : [], platforms, auditReady,
      // The app runs in the person's desktop session; a headless Linux helper would say false here.
      guiReady: true,
    };
  }

  #start(): void {
    if (this.#agent) return;
    const agent = new MachineTerminalAgent({
      pty: (cb) => new PtySupervisor({ policyFile: this.policyFile, audit: cb.audit, output: cb.output, exit: cb.exit }),
      recorder: (sessionId) => TerminalRecorder.open({ root: this.#spool, sessionId, master: this.#master!, known: this.#o.known() }),
      locks: this.#o.locks,
      draining: this.#o.draining,
      log: this.#o.log,
    });
    const socket = new MachineSocket({
      hubUrl: this.#o.hub()!.url, token: () => this.#o.hub()?.token ?? "", label: this.#o.label, agent, log: this.#o.log,
    });
    this.#agent = agent;
    this.#socket = socket;
    socket.start();
    this.#o.log("remote terminal: local policy on; relay connecting");
  }

  #stop(): void {
    if (!this.#agent) return;
    const agent = this.#agent;
    this.#socket?.stop();
    this.#agent = null;
    this.#socket = null;
    void agent.stopAll("localOptOut").finally(() => agent.dispose());
    this.#o.log("remote terminal: local policy off; relay stopped");
  }

  /** Quit, or the person's local stop: every shell ends here, the hub hears why when it is back. */
  async stop(): Promise<void> {
    const agent = this.#agent;
    const socket = this.#socket;
    this.#agent = null;
    this.#socket = null;
    // Shells first, socket after: the reports of why they ended still reach the hub.
    if (agent) {
      await agent.stopAll("emergencyStop");
      agent.dispose();
    }
    socket?.stop();
  }
}
