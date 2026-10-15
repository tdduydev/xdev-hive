import { type DocImportFile, SECRET_KIND_LABELS } from "@xdev-hive/contracts";
import { Pill } from "@xdev-hive/ui/pill";
import { ChevronRightIcon, FileTextIcon, FolderIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { cx } from "@/lib/cx.ts";

export interface TreeFolder {
  kind: "folder";
  name: string;
  path: string;
  children: TreeNode[];
  /** Mọi file con cháu, để chọn cả thư mục không phải duyệt lại cây. */
  files: DocImportFile[];
}
export interface TreeFile {
  kind: "file";
  name: string;
  file: DocImportFile;
}
export type TreeNode = TreeFolder | TreeFile;
export type FolderSelection = "all" | "some" | "none";

const KIND_LABEL: Record<DocImportFile["kind"], string> = {
  markdown: "Markdown",
  image: "Ảnh",
  office: "Văn phòng",
  other: "Khác",
};
const STATE_LABEL: Record<DocImportFile["state"], { label: string; tone: "neutral" | "ok" | "warn" | "bad" }> = {
  pending: { label: "Chờ nhập", tone: "neutral" },
  done: { label: "Đã có", tone: "ok" },
  skipped: { label: "Bỏ qua", tone: "neutral" },
  blocked_secret: { label: "Bị chặn vì bí mật", tone: "bad" },
  failed: { label: "Lỗi", tone: "bad" },
};

export function buildTree(files: readonly DocImportFile[]): TreeFolder {
  const root: TreeFolder = { kind: "folder", name: "", path: "", children: [], files: [] };
  const folders = new Map<string, TreeFolder>([["", root]]);
  const folderAt = (path: string): TreeFolder => {
    const found = folders.get(path);
    if (found) return found;
    const cut = path.lastIndexOf("/");
    const parent = folderAt(path.slice(0, Math.max(cut, 0)));
    const folder: TreeFolder = { kind: "folder", name: path.slice(cut + 1), path, children: [], files: [] };
    folders.set(path, folder);
    parent.children.push(folder);
    return folder;
  };
  for (const file of files) {
    const cut = file.path.lastIndexOf("/");
    const dir = cut < 0 ? "" : file.path.slice(0, cut);
    folderAt(dir).children.push({ kind: "file", name: file.path.slice(cut + 1), file });
    root.files.push(file);
    for (let path = dir; path; path = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "") {
      folderAt(path).files.push(file);
    }
  }
  const order = (node: TreeNode) => (node.kind === "folder" ? 0 : 1);
  const sort = (folder: TreeFolder) => {
    folder.children.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, "vi"));
    for (const child of folder.children) if (child.kind === "folder") sort(child);
  };
  sort(root);
  return root;
}

/** File chưa nhập, chưa bị bí mật chặn. File trùng key chỉ chọn được sau khi người dùng chọn cách giải quyết. */
export function isImportable(file: DocImportFile, resolved: ReadonlySet<string> = new Set()): boolean {
  if (file.state !== "pending" || file.secretScan === "found") return false;
  return file.existingKey === null || resolved.has(file.path);
}

export function folderSelection(
  folder: TreeFolder,
  selected: ReadonlySet<string>,
  importable: (file: DocImportFile) => boolean,
): FolderSelection {
  let total = 0;
  let chosen = 0;
  for (const file of folder.files) {
    if (!importable(file)) continue;
    total += 1;
    if (selected.has(file.path)) chosen += 1;
  }
  if (chosen === 0) return "none";
  return chosen === total ? "all" : "some";
}

/** Chọn cả thư mục: bỏ chọn nếu đã chọn hết, còn lại chọn mọi file nhập được trong đó. */
export function toggleFolder(
  folder: TreeFolder,
  selected: ReadonlySet<string>,
  importable: (file: DocImportFile) => boolean,
): Set<string> {
  const next = new Set(selected);
  const clear = folderSelection(folder, selected, importable) === "all";
  for (const file of folder.files) {
    if (!importable(file)) continue;
    if (clear) next.delete(file.path);
    else next.add(file.path);
  }
  return next;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Hub gửi cảnh báo thành câu tiếng Việt chứ không phải mã, nên màu theo từ khoá: bí mật là lỗi chặn, còn lại là nhắc.
 */
export function warningTone(warning: string): "bad" | "warn" | "neutral" {
  const text = warning.toLowerCase();
  if (text.includes("bí mật")) return "bad";
  if (/quá lớn|lfs|utf|trùng/.test(text)) return "warn";
  return "neutral";
}

export function findingText(finding: DocImportFile["findings"][number]): string {
  return `dòng ${finding.line} (${SECRET_KIND_LABELS[finding.kind]})`;
}

export function DocImportTree({
  root,
  selected,
  onSelectedChange,
  importable,
  disabled,
  fileExtra,
}: {
  root: TreeFolder;
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  importable: (file: DocImportFile) => boolean;
  disabled: boolean;
  /** Phần thêm cuối dòng file: giải quyết trùng key, xác nhận bí mật. */
  fileExtra?: (file: DocImportFile) => ReactNode;
}) {
  // Mở thư mục cấp một; repo hàng nghìn file không dựng hết một lần.
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(root.children.flatMap((node) => (node.kind === "folder" ? [node.path] : []))),
  );
  const toggleOpen = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const renderNodes = (nodes: TreeNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      const indent = { paddingLeft: `${depth * 1.25}rem` };
      if (node.kind === "folder") {
        const state = folderSelection(node, selected, importable);
        const expanded = open.has(node.path);
        const selectable = node.files.some(importable);
        return (
          <li key={`d:${node.path}`}>
            <div className="flex min-w-0 items-center gap-2 rounded-md py-1 hover:bg-muted/50" style={indent}>
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Thu gọn" : "Mở"} thư mục ${node.path}`}
                className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground"
                onClick={() => toggleOpen(node.path)}
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cx("size-4 transition-transform", expanded && "rotate-90")}
                />
              </button>
              <Checkbox
                aria-label={`Chọn cả thư mục ${node.path}`}
                checked={state === "all"}
                indeterminate={state === "some"}
                disabled={disabled || !selectable}
                onCheckedChange={() => onSelectedChange(toggleFolder(node, selected, importable))}
              />
              <FolderIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-sm font-medium">{node.name}</span>
              <span className="text-xs text-muted-foreground">{node.files.length} file</span>
            </div>
            {expanded && <ul className="grid">{renderNodes(node.children, depth + 1)}</ul>}
          </li>
        );
      }
      const { file } = node;
      const can = importable(file);
      const state = STATE_LABEL[file.state];
      return (
        <li key={`f:${file.path}`} className="grid gap-1 rounded-md py-1 hover:bg-muted/50" style={indent}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-8">
            <Checkbox
              aria-label={`Chọn ${file.path}`}
              checked={selected.has(file.path)}
              disabled={disabled || !can}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                if (checked) next.add(file.path);
                else next.delete(file.path);
                onSelectedChange(next);
              }}
            />
            <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm">{node.name}</span>
            <Pill small>{KIND_LABEL[file.kind]}</Pill>
            <span className="text-xs text-muted-foreground">{formatSize(file.size)}</span>
            <Pill small tone={state.tone}>
              {state.label}
            </Pill>
            {file.secretScan === "pending" && file.kind === "markdown" && (
              <span className="text-xs text-muted-foreground">Chưa quét bí mật</span>
            )}
          </div>
          {(file.warnings.length > 0 || file.findings.length > 0 || file.error) && (
            <div className="flex flex-wrap gap-1.5 pl-16">
              {file.findings.length > 0 && (
                <Pill small tone="bad">
                  Có chuỗi giống bí mật: {file.findings.map(findingText).join(", ")}
                </Pill>
              )}
              {file.warnings.map((warning) => (
                <Pill key={warning} small tone={warningTone(warning)}>
                  {warning}
                </Pill>
              ))}
              {file.error && (
                <Pill small tone="bad">
                  {file.error}
                </Pill>
              )}
            </div>
          )}
          {fileExtra && <div className="pl-16">{fileExtra(file)}</div>}
        </li>
      );
    });
  return (
    <ul aria-label="Cây file trong repo" className="grid min-w-0">
      {renderNodes(root.children, 0)}
    </ul>
  );
}
