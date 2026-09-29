// Small helpers of the Tasks page.

/**
 * Who holds a task, split for display: an agent's lease is `<profile>.<machine>`, and a hub appends `@<token>`
 * (`codex-1.duy-mbp@duy-mbp` → codex-1 on duy-mbp). A person's name has no machine.
 */
export function ownerLabel(owner: string): { who: string; machine: string | null } {
  const base = owner.split("@")[0]!;
  const dot = base.indexOf(".");
  return dot > 0 && dot < base.length - 1 ? { who: base.slice(0, dot), machine: base.slice(dot + 1) } : { who: base, machine: null };
}
