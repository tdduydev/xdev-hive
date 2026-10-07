import type { UpdateStatus } from "#desktop/main/updater.ts";

export interface IdleUpdateHost {
  status(): UpdateStatus;
  enabled(): boolean;
  drain(value: boolean): void;
  /** Running work, including its final commit/report. Queued work survives the restart. */
  work(): { busy: boolean; deadline: number };
  install(): Promise<void>;
  log(line: string): void;
  now?: () => number;
}

/** A temporary intake hold, independent of the person's saved runner settings. */
export class IdleUpdate {
  #host: IdleUpdateHost;
  #version: string | null = null;
  #deadline: number | null = null;
  #retryAt = 0;
  #installing = false;
  #stopped = false;

  constructor(host: IdleUpdateHost) { this.#host = host; }

  status(): { idleState: "waiting" | "retry" | null; idleDeadline: number | null } {
    return { idleState: this.#deadline !== null ? "waiting" : this.#retryAt ? "retry" : null, idleDeadline: this.#deadline ?? (this.#retryAt || null) };
  }

  stop(): void {
    this.#stopped = true;
    this.#host.drain(true);
  }

  async tick(): Promise<void> {
    if (this.#stopped || this.#installing) return;
    const s = this.#host.status();
    if (s.state === "installing") {
      this.#host.drain(true);
      return;
    }
    const now = (this.#host.now ?? Date.now)();
    const eligible = s.supported && s.state === "ready" && this.#host.enabled();
    if (!eligible || this.#version !== s.version) {
      if (this.#deadline !== null) this.#host.log("idle update: cancelled wait (setting or offer changed)");
      this.#deadline = null;
      this.#retryAt = 0;
      this.#version = s.version;
      if (!eligible) this.#host.drain(false);
    }
    if (!eligible || now < this.#retryAt) return;
    if (this.#deadline === null) {
      this.#retryAt = 0;
      // Hold intake before reading work, so a heartbeat or tick cannot slip a new run in.
      this.#host.drain(true);
      this.#deadline = Math.max(now + 1000, this.#host.work().deadline);
      this.#host.log(`idle update: waiting for work before ${s.version}, deadline ${new Date(this.#deadline).toISOString()}`);
    }
    if (now >= this.#deadline) {
      this.#host.log(`idle update: deadline exceeded; keep old build, retry in 5 minutes`);
      this.#deadline = null;
      this.#retryAt = now + 5 * 60_000;
      this.#host.drain(false);
      return;
    }
    if (this.#host.work().busy) return;
    this.#installing = true;
    try {
      this.#host.log(`idle update: work finished; install ${s.version}`);
      await this.#host.install();
    } catch (err) {
      this.#host.log(`idle update: install failed; keep old build: ${err instanceof Error ? err.message : String(err)}`);
      this.#deadline = null;
      this.#retryAt = now + 5 * 60_000;
      this.#host.drain(false);
    } finally {
      this.#installing = false;
    }
  }
}
