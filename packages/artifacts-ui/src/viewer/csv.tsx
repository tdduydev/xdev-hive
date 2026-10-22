import { CSV_MAX_ROWS, csvChartData, parseCsv } from "@xdev-hive/artifacts-runtime";
import { Button } from "@xdev-hive/ui/button";
import { useMemo, useState } from "react";
import { useText } from "../env.tsx";
import { FramedArtifact, type FrameViewerProps } from "./frame.tsx";

/**
 * Bảng dựng ngay trong trang bằng chữ React (ô CSV không bao giờ thành HTML); biểu đồ vẽ trong khung cách ly vì dùng
 * thư viện của khung (recharts). Không có cột số thì không có tab biểu đồ.
 */
export function CsvViewer({ content, ...frame }: { content: string } & FrameViewerProps) {
  const t = useText();
  const parsed = useMemo(() => parseCsv(content), [content]);
  const chartable = useMemo(() => csvChartData(parsed) !== null, [parsed]);
  const [view, setView] = useState<"table" | "chart">("table");
  if (parsed.header.length === 0) return <p className="text-sm text-muted-foreground">{t.csvEmpty}</p>;
  const shown = chartable ? view : "table";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {chartable && (
        <fieldset aria-label={t.csvView} className="m-0 flex gap-2 border-0 p-0">
          <Button variant="outline" size="sm" aria-pressed={shown === "table"} onClick={() => setView("table")}>
            {t.csvTable}
          </Button>
          <Button variant="outline" size="sm" aria-pressed={shown === "chart"} onClick={() => setView("chart")}>
            {t.csvChart}
          </Button>
        </fieldset>
      )}
      {shown === "chart" ? (
        <FramedArtifact {...frame} />
      ) : (
        <>
          <div className="max-h-[70vh] overflow-auto rounded-md border">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  {parsed.header.map((name, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cột có thể trùng tên, thứ tự cột cố định.
                    <th key={i} scope="col" className="border-b px-3 py-1.5 text-left font-medium">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.rows.map((row, r) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: dòng CSV không có khoá riêng.
                  <tr key={r} className="odd:bg-muted/40">
                    {row.map((cell, c) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: ô theo vị trí cột.
                      <td key={c} className="border-b px-3 py-1.5 align-top">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {parsed.truncated && <p className="text-sm text-muted-foreground">{t.csvTruncated(CSV_MAX_ROWS)}</p>}
        </>
      )}
    </div>
  );
}
