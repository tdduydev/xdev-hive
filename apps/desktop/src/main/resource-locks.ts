// Who works in which checkout of a project on this machine (spec 69 §11): a remote terminal, a run's worktree, the
// merge queue or a release in the repo. Two of them in the same checkout would edit, merge or release under each
// other, so the second is refused; different checkouts and other projects never wait on each other. Runs, merges and
// releases already track themselves (runner); they answer through a probe, and what has no tracker of its own (a
// terminal, later a gate job) takes a lock here.

export type LockKind = "run" | "merge" | "release" | "gate" | "terminal";

/** "repo", or "worktree:<task id>" for a run's worktree: the names terminal checkoutRef uses. */
export type CheckoutName = string;

type Probe = (project: string, checkout: CheckoutName) => LockKind | null;

export class ResourceLocks {
  readonly #held = new Map<string, { kind: LockKind; id: string }>();
  readonly #probes: Probe[] = [];

  /** Adds work tracked elsewhere: it answers which kind holds this checkout now, or null. */
  probe(fn: Probe): void { this.#probes.push(fn); }

  /** Who holds it, a lock taken here first. */
  holder(project: string, checkout: CheckoutName): LockKind | null {
    const own = this.#held.get(key(project, checkout));
    if (own) return own.kind;
    for (const p of this.#probes) {
      const kind = p(project, checkout);
      if (kind) return kind;
    }
    return null;
  }

  /** The lock and a release that only frees this very lock (once), or who already holds the checkout. */
  acquire(project: string, checkout: CheckoutName, kind: LockKind, id: string): { release: () => void } | { heldBy: LockKind } {
    const by = this.holder(project, checkout);
    if (by) return { heldBy: by };
    const k = key(project, checkout);
    const entry = { kind, id };
    this.#held.set(k, entry);
    return { release: () => { if (this.#held.get(k) === entry) this.#held.delete(k); } };
  }

  /** A lock of this kind is held here (the update drain waits for terminals, spec 69 §11). */
  has(kind: LockKind): boolean {
    for (const v of this.#held.values()) if (v.kind === kind) return true;
    return false;
  }
}

const key = (project: string, checkout: CheckoutName) => `${project}\0${checkout}`;
