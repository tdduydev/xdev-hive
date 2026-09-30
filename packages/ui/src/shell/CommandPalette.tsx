// ⌘K: go to a page, run a command, or jump to a task or doc. Matching ignores case and Vietnamese diacritics.
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { FileText, ListTodo, Search } from "lucide-react";
import { cn } from "cn";
import { useHive, useQuery } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import { scopeFilter } from "../lib/scope.ts";
import { fold } from "../lib/text.ts";

export interface PaletteCommand {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  hint?: string;
  run: () => void;
}

interface Row extends PaletteCommand {
  group: string;
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
  pages,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
  pages: PaletteCommand[];
}) {
  const { client, scope } = useHive();
  const t = useT();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const tasks = useQuery(async () => (open ? client.call("tasks.list", scopeFilter(scope)) : []), [client, scope, open]);
  const docs = useQuery(async () => (open ? client.call("docs.list", {}) : []), [client, open]);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
    }
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const needle = fold(q.trim());
    const go = (hash: string) => () => {
      window.location.hash = hash;
    };
    const taskRows: PaletteCommand[] = (tasks.data ?? []).map((task) => ({
      id: `task:${task.id}`,
      label: `${task.id} · ${task.title}`,
      icon: ListTodo,
      hint: task.project,
      run: go(`#/tasks?task=${encodeURIComponent(task.id)}`),
    }));
    const docRows: PaletteCommand[] = (docs.data ?? []).map((d) => ({
      id: `doc:${d.key}`,
      label: d.title || d.key,
      icon: FileText,
      hint: d.key,
      run: go(`#/docs?doc=${encodeURIComponent(d.key)}`),
    }));
    const groups: Array<[string, PaletteCommand[]]> = [
      [t("palette.commands"), commands],
      [t("palette.goTo"), pages],
      [t("palette.tasks"), taskRows],
      [t("palette.docs"), docRows],
    ];
    return groups.flatMap(([group, list]) =>
      list
        .filter((c) => !needle || fold(`${c.label} ${c.hint ?? ""}`).includes(needle))
        .slice(0, needle ? 8 : 4)
        .map((c) => ({ ...c, group })),
    );
  }, [q, tasks.data, docs.data, commands, pages, t]);

  const current = Math.min(sel, Math.max(rows.length - 1, 0));
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const pick = (row: Row | undefined) => {
    if (!row) return;
    onOpenChange(false);
    row.run();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-300 bg-scrim data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-label={t("palette.label")}
          className="fixed top-[72px] left-1/2 z-300 w-[600px] max-w-[calc(100%-32px)] -translate-x-1/2 overflow-hidden rounded-xl border border-line-default bg-raised shadow-e4 outline-none data-[state=open]:animate-xd-in"
        >
          <DialogPrimitive.Title className="sr-only">{t("palette.label")}</DialogPrimitive.Title>
          <div className="flex h-[50px] items-center gap-2.5 border-b border-line-subtle px-4">
            <Search className="size-[18px] shrink-0 text-fg-muted" aria-hidden="true" />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={rows[current] ? `palette-${current}` : undefined}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((n) => Math.min(n + 1, rows.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((n) => Math.max(n - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  pick(rows[current]);
                }
              }}
              placeholder={t("palette.placeholder")}
              aria-label={t("palette.placeholder")}
              className="h-full min-w-0 flex-1 bg-transparent type-body-lg text-fg-strong outline-none placeholder:text-fg-muted"
            />
            <kbd className="rounded-xs border border-line-default bg-surface px-1.5 py-0.5 font-mono text-[10px] font-medium text-fg-secondary">Esc</kbd>
          </div>
          <div ref={listRef} id="palette-list" role="listbox" className="max-h-[360px] overflow-y-auto p-1.5">
            {rows.length === 0 ? <div className="px-3 py-8 text-center type-body-sm text-fg-muted">{t("palette.empty")}</div> : null}
            {rows.map((row, i) => {
              const Icon = row.icon;
              const head = i === 0 || rows[i - 1]!.group !== row.group;
              return (
                <div key={`${row.group}-${row.id}`}>
                  {head ? <div className="px-2.5 pt-2 pb-1 type-overline text-fg-muted">{row.group}</div> : null}
                  <div
                    id={`palette-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === current}
                    onMouseMove={() => setSel(i)}
                    onClick={() => pick(row)}
                    className={cn(
                      "flex h-[34px] cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-fg-strong",
                      i === current && "bg-selected [&>svg]:text-fg-brand",
                    )}
                  >
                    <Icon className="size-[15px] shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1 truncate type-body-sm">{row.label}</span>
                    {row.hint ? <span className="max-w-[40%] shrink-0 truncate font-mono text-xs text-fg-muted">{row.hint}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 border-t border-line-subtle bg-sunken px-4 py-2 type-caption text-fg-muted">{t("palette.hint")}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
