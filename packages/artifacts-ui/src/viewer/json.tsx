import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useText } from "../env.tsx";
import { CodeViewer } from "./code.tsx";

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

function parse(content: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Độ sâu mở sẵn: đủ thấy cấu trúc mà không dội cả tài liệu lớn ra màn hình. */
const OPEN_DEPTH = 2;

function Primitive({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="break-words text-success">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="text-info">{String(value)}</span>;
  return <span className="text-warning">{String(value)}</span>;
}

function Node({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const t = useText();
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const label = name === null ? null : <span className="text-muted-foreground">{name}: </span>;
  if (value === null || typeof value !== "object")
    return (
      <div className="pl-4">
        {label}
        <Primitive value={value} />
      </div>
    );
  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0)
    return (
      <div className="pl-4">
        {label}
        <span className="text-muted-foreground">{isArray ? t.jsonEmptyArray : t.jsonEmptyObject}</span>
      </div>
    );
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="pl-4">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? t.jsonCollapse : t.jsonExpand} ${name ?? "root"}`}
        className="-ml-4 inline-flex items-center gap-0.5 text-left"
        onClick={() => setOpen(!open)}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
        <span className="text-muted-foreground">{isArray ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open && entries.map(([key, child]) => <Node key={key} name={key} value={child} depth={depth + 1} />)}
    </div>
  );
}

/**
 * Cây JSON thu/mở được. Khoá và giá trị là chữ React (không `innerHTML`) nên không có đường thành HTML; JSON hỏng thì
 * hiện nguồn kèm lý do để vẫn đọc và sửa được.
 */
export function JsonViewer({ content }: { content: string }) {
  const t = useText();
  const parsed = useMemo(() => parse(content), [content]);
  if (!parsed.ok)
    return (
      <div className="flex flex-col gap-2">
        <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {t.jsonInvalid(parsed.message)}
        </p>
        <CodeViewer content={content} language={null} />
      </div>
    );
  return (
    <div className="min-w-0 overflow-x-auto rounded-md bg-muted p-3 font-mono text-[0.8125rem] leading-relaxed">
      <div className="-ml-4">
        <Node name={null} value={parsed.value} depth={0} />
      </div>
    </div>
  );
}
