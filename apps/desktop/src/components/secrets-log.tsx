import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { formatWhen, type GrantEntry, secretsLog, secretsLogClear } from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";

// Nhật ký của máy có thể dài; màn chỉ cần các lần cấp gần nhất.
const LOG_LIMIT = 200;

const text: Dict<{
  lead: string;
  filterSecret: string;
  filterProject: string;
  allSecrets: string;
  allProjects: string;
  refresh: string;
  loading: string;
  empty: string;
  emptyFiltered: string;
  colWhen: string;
  colKind: string;
  colProject: string;
  colNames: string;
  colOutcome: string;
  kinds: { run: string; terminal: string; reveal: string; copy: string; export: string; import: string };
  outcomes: Record<"granted" | "denied" | "declined" | "timeout" | "store_error", string>;
  policies: Record<"allow" | "approve" | "deny", string>;
  deleted: string;
  leaked: string;
  leakedHint: string;
  clear: string;
  clearTitle: string;
  clearLead: string;
  clearConfirm: string;
  clearing: string;
  cancel: string;
  retry: string;
}> = {
  vi: {
    lead: "Mỗi lần agent, terminal hay bạn lấy giá trị bí mật đều được ghi lại: ghi tên, không ghi giá trị.",
    filterSecret: "Lọc theo bí mật",
    filterProject: "Lọc theo dự án",
    allSecrets: "Mọi bí mật",
    allProjects: "Mọi dự án",
    refresh: "Tải lại",
    loading: "Đang tải…",
    empty: "Chưa có lần cấp bí mật nào.",
    emptyFiltered: "Không có lần cấp nào khớp bộ lọc.",
    colWhen: "Lúc",
    colKind: "Loại",
    colProject: "Dự án",
    colNames: "Bí mật",
    colOutcome: "Kết quả",
    kinds: {
      run: "Run",
      terminal: "Terminal",
      reveal: "Hiện",
      copy: "Sao chép",
      export: "Xuất file",
      import: "Nhập file",
    },
    outcomes: {
      granted: "Đã cấp",
      denied: "Bị chặn",
      declined: "Bị từ chối",
      timeout: "Hết hạn duyệt",
      store_error: "Lỗi kho",
    },
    policies: { allow: "tự cấp", approve: "cần duyệt", deny: "chặn" },
    deleted: "đã xoá",
    leaked: "giá trị xuất hiện trong output",
    leakedHint: "Giá trị từng hiện trong output của run này và đã bị che. Cân nhắc đổi giá trị bí mật.",
    clear: "Xoá nhật ký",
    clearTitle: "Xoá toàn bộ nhật ký?",
    clearLead: "Mọi dòng nhật ký cấp bí mật trên máy này bị xoá và không khôi phục được. Bí mật và giá trị không đổi.",
    clearConfirm: "Xoá nhật ký",
    clearing: "Đang xoá…",
    cancel: "Huỷ",
    retry: "Thử lại",
  },
  en: {
    lead: "Every time an agent, a terminal or you take a secret's value it is logged: names are recorded, values never.",
    filterSecret: "Filter by secret",
    filterProject: "Filter by project",
    allSecrets: "All secrets",
    allProjects: "All projects",
    refresh: "Refresh",
    loading: "Loading…",
    empty: "No secret has been granted yet.",
    emptyFiltered: "No grants match the filter.",
    colWhen: "When",
    colKind: "Type",
    colProject: "Project",
    colNames: "Secrets",
    colOutcome: "Result",
    kinds: { run: "Run", terminal: "Terminal", reveal: "Show", copy: "Copy", export: "Export", import: "Import" },
    outcomes: {
      granted: "Granted",
      denied: "Blocked",
      declined: "Declined",
      timeout: "Approval expired",
      store_error: "Store error",
    },
    policies: { allow: "automatic", approve: "needs approval", deny: "blocked" },
    deleted: "deleted",
    leaked: "value appeared in output",
    leakedHint: "The value showed up in this run's output and was masked. Consider changing the secret's value.",
    clear: "Clear log",
    clearTitle: "Clear the whole log?",
    clearLead: "Every secret grant entry on this machine is deleted and cannot be recovered. Secrets and values stay.",
    clearConfirm: "Clear log",
    clearing: "Clearing…",
    cancel: "Cancel",
    retry: "Try again",
  },
};

interface Props {
  /** Tên các bí mật hiện có, cho bộ lọc; tên đã xoá vẫn hiện trong nhật ký nhưng không lọc theo được. */
  secretNames: readonly string[];
  /** [localId, tên] các dự án, cho bộ lọc. */
  projects: readonly (readonly [string, string])[];
  /** Dự án đang lọc ở tab danh sách, dùng làm giá trị đầu. */
  initialProject?: string | undefined;
}

/** Tab Nhật ký của màn Bí mật (FR-037, FR-044): các lần cấp, lọc theo bí mật và dự án, xoá toàn bộ có xác nhận. */
export function SecretsLog({ secretNames, projects, initialProject = "" }: Props) {
  const t = useT(text);
  const lang = useLang();
  const id = useId();
  const [name, setName] = useState("");
  const [project, setProject] = useState(initialProject);
  const [entries, setEntries] = useState<GrantEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const got = await secretsLog({
        ...(name && { name }),
        ...(project && { project }),
        limit: LOG_LIMIT,
      });
      setEntries(got.entries);
    } catch (e) {
      setError(errorText(e));
    }
  }, [name, project]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = name !== "" || project !== "";
  const outcome = (o: string) => (o in t.outcomes ? t.outcomes[o as keyof typeof t.outcomes] : o);
  const policy = (p: string) => (p in t.policies ? t.policies[p as keyof typeof t.policies] : p);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t.lead}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${id}-secret`} className="text-sm text-muted-foreground">
          {t.filterSecret}
        </Label>
        <NativeSelect
          id={`${id}-secret`}
          className="max-w-full min-w-40"
          value={name}
          onChange={(e) => setName(e.target.value)}
        >
          <NativeSelectOption value="">{t.allSecrets}</NativeSelectOption>
          {secretNames.map((n) => (
            <NativeSelectOption key={n} value={n}>
              {n}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Label htmlFor={`${id}-project`} className="text-sm text-muted-foreground">
          {t.filterProject}
        </Label>
        <NativeSelect
          id={`${id}-project`}
          className="max-w-full min-w-40"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <NativeSelectOption value="">{t.allProjects}</NativeSelectOption>
          {projects.map(([localId, label]) => (
            <NativeSelectOption key={localId} value={localId}>
              {label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCwIcon aria-hidden="true" />
          {t.refresh}
        </Button>
        <Button variant="outline" size="sm" className="ml-auto text-destructive" onClick={() => setClearing(true)}>
          <Trash2Icon aria-hidden="true" />
          {t.clear}
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive"
        >
          <p className="min-w-0 flex-1 break-words">{error}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden="true" />
            {t.retry}
          </Button>
        </div>
      )}
      {!entries && !error && <p className="text-sm text-muted-foreground">{t.loading}</p>}
      {entries && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">{filtered ? t.emptyFiltered : t.empty}</p>
      )}
      {entries && entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <Th>{t.colWhen}</Th>
                <Th>{t.colKind}</Th>
                <Th>{t.colProject}</Th>
                <Th>{t.colNames}</Th>
                <Th>{t.colOutcome}</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <Td className="text-xs whitespace-nowrap text-muted-foreground">{formatWhen(e.at, lang)}</Td>
                  <Td className="text-sm whitespace-nowrap">
                    {e.kind === "reveal" ? (e.copy ? t.kinds.copy : t.kinds.reveal) : t.kinds[e.kind]}
                  </Td>
                  <Td className="min-w-28 text-sm break-words">{e.projectName || e.project}</Td>
                  <Td className="min-w-44">
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {e.names.map((n) => (
                        <li key={n.name} className="flex flex-wrap items-center gap-1">
                          <span className={n.deleted ? "font-mono text-sm text-muted-foreground" : "font-mono text-sm"}>
                            {n.name}
                          </span>
                          {n.deleted && (
                            <Pill small tone="neutral">
                              {t.deleted}
                            </Pill>
                          )}
                          {n.leaked && (
                            <Pill small tone="bad" title={t.leakedHint}>
                              {t.leaked}
                            </Pill>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Td>
                  <Td className="text-sm">
                    <div>{outcome(e.outcome)}</div>
                    <div className="text-xs text-muted-foreground">{policy(e.policy)}</div>
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ClearDialog
        open={clearing}
        onClose={() => setClearing(false)}
        onCleared={() => {
          setClearing(false);
          void load();
        }}
      />
    </div>
  );
}

function ClearDialog({ open, onClose, onCleared }: { open: boolean; onClose: () => void; onCleared: () => void }) {
  const t = useT(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await secretsLogClear();
      onCleared();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.clearTitle}</DialogTitle>
          <DialogDescription>{t.clearLead}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm break-words text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {/* Huỷ được focus trước: Enter nhầm không xoá được nhật ký. */}
          <Button variant="outline" autoFocus disabled={busy} onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? t.clearing : t.clearConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
