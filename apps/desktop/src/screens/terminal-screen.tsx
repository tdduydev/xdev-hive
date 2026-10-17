import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { FolderGitIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { TerminalPane } from "@/components/terminal-pane.tsx";
import { folderKey, folderName, pickFolder, shortPath } from "@/lib/folder.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { type LocalProject, localProjects } from "@/lib/local-projects.ts";
import { inFolder, selectFolder, useTerminals } from "@/lib/pty.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  projects: string;
  others: string;
  pick: string;
  pickTitle: string;
  choose: string;
  noProjects: string;
  tabs: (n: number) => string;
}> = {
  vi: {
    projects: "Dự án",
    others: "Thư mục khác",
    pick: "Thư mục khác…",
    pickTitle: "Chọn thư mục để mở terminal",
    choose: "Chọn một dự án bên trái để mở terminal trong thư mục của nó.",
    noProjects: "Chưa có dự án nào trên máy. Gắn dự án ở màn Dự án trên máy, hoặc chọn thư mục khác.",
    tabs: (n) => `${n} tab`,
  },
  en: {
    projects: "Projects",
    others: "Other folders",
    pick: "Other folder…",
    pickTitle: "Choose a folder to open a terminal in",
    choose: "Pick a project on the left to open a terminal in its folder.",
    noProjects: "No projects on this machine yet. Link one in Projects on this machine, or pick another folder.",
    tabs: (n) => `${n} ${n === 1 ? "tab" : "tabs"}`,
  },
};

function FolderButton({
  name,
  folder,
  count,
  selected,
  icon: Icon,
}: {
  name: string;
  folder: string;
  count: number;
  selected: boolean;
  icon: typeof FolderIcon;
}) {
  const t = useT(text);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => selectFolder(folder)}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted",
        selected && "bg-muted",
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-sm", selected && "font-semibold")}>{name}</span>{" "}
        <span className="truncate font-mono text-xs text-muted-foreground">{shortPath(folder)}</span>
      </span>{" "}
      {count > 0 && <Pill>{t.tabs(count)}</Pill>}
    </button>
  );
}

/**
 * Terminal theo dự án (spec 021): cột trái là dự án trên máy và thư mục đang có tab, cột phải là terminal của dự án
 * đang chọn. Kho terminal nằm ngoài React (lib/pty.ts) nên rời màn rồi quay lại, CLI vẫn chạy và tab còn nguyên.
 */
export function TerminalScreen() {
  const t = useT(text);
  const { sessions, active, folder } = useTerminals();
  const [projects, setProjects] = useState<LocalProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localProjects().then(
      (r) => setProjects(r.projects.filter((p) => p.exists)),
      (e) => {
        setProjects([]);
        setError(errorText(e));
      },
    );
  }, []);

  const selected = folder ?? sessions.find((s) => s.key === active)?.folder ?? null;
  const known = new Set((projects ?? []).map((p) => folderKey(p.folder)));
  // Thư mục không phải dự án trên máy mà có tab (mở từ Agent trên máy) hay vừa chọn bằng "Thư mục khác…".
  const others = new Map<string, string>();
  for (const f of [...sessions.map((s) => s.folder), ...(selected ? [selected] : [])]) {
    if (!known.has(folderKey(f))) others.set(folderKey(f), f);
  }
  const count = (f: string) => sessions.filter((s) => inFolder(s, f)).length;
  const isSelected = (f: string) => selected !== null && folderKey(f) === folderKey(selected);

  async function pick() {
    try {
      const picked = await pickFolder(t.pickTitle);
      if (picked) selectFolder(picked);
    } catch {
      /* Ngoài Tauri không có bộ chọn thư mục. */
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <nav aria-label={t.projects} className="flex w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
        {projects?.map((p) => (
          <FolderButton
            key={p.folder}
            name={p.name}
            folder={p.folder}
            count={count(p.folder)}
            selected={isSelected(p.folder)}
            icon={FolderGitIcon}
          />
        ))}
        {projects?.length === 0 && others.size === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{error ?? t.noProjects}</p>
        )}
        {others.size > 0 && <p className="mt-2 px-2 text-xs font-medium text-muted-foreground uppercase">{t.others}</p>}
        {[...others.values()].map((f) => (
          <FolderButton
            key={f}
            name={folderName(f)}
            folder={f}
            count={count(f)}
            selected={isSelected(f)}
            icon={FolderIcon}
          />
        ))}
        <Button variant="ghost" size="sm" className="mt-1 justify-start" onClick={() => void pick()}>
          <FolderOpenIcon aria-hidden="true" />
          {t.pick}
        </Button>
      </nav>
      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <TerminalPane folder={selected} onPickFolder={() => void pick()} />
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.choose}</p>
        )}
      </section>
    </div>
  );
}
