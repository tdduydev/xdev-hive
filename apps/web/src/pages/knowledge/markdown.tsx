import { Table, TableBody, TableHead, TableHeader, TableRow, Td } from "@xdev-hive/ui/table";
import { Fragment, type ReactNode } from "react";

/** Render untrusted knowledge as React text, never HTML; only allow web and mail links. */
function inline(source: string): ReactNode[] {
  return source.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g).map((part, index) => {
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    let node: ReactNode = part;
    if (part.startsWith("`"))
      node = <code className="rounded bg-muted px-1 font-mono text-xs">{part.slice(1, -1)}</code>;
    else if (part.startsWith("**")) node = <strong>{part.slice(2, -2)}</strong>;
    else if (part.startsWith("*")) node = <em>{part.slice(1, -1)}</em>;
    else if (link && /^(https?:\/\/|mailto:)/i.test(link[2] ?? ""))
      node = (
        <a
          className="break-all text-primary underline focus-visible:outline-2 focus-visible:outline-ring"
          href={link[2]}
          rel="noreferrer"
          target="_blank"
        >
          {link[1]}
        </a>
      );
    // biome-ignore lint/suspicious/noArrayIndexKey: Tokens are immutable text without component state.
    return <Fragment key={`${index}:${part}`}>{node}</Fragment>;
  });
}
export function Markdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    if (/^```/.test(line)) {
      const code: string[] = [];
      while (++index < lines.length && !/^```/.test(lines[index] ?? "")) code.push(lines[index] ?? "");
      blocks.push(
        <pre key={index} className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? "")) {
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim());
      const headers = cells(line).map((content, position) => ({ content, id: `header-${position}` }));
      const data: { id: string; cells: { id: string; content: string }[] }[] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|"))
        data.push({
          id: `row-${index}`,
          cells: cells(lines[index++] ?? "").map((content, position) => ({ content, id: `cell-${position}` })),
        });
      index--;
      blocks.push(
        <Table key={index}>
          <TableHeader>
            <TableRow>
              {headers.map((header) => (
                <TableHead key={header.id}>{inline(header.content)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                {row.cells.map((cell) => (
                  <Td key={cell.id}>{inline(cell.content)}</Td>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>,
      );
    } else if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) blocks.push(<hr key={index} className="border-border" />);
    else if (/^#{1,6} /.test(line)) {
      const heading = inline(line.replace(/^#{1,6} /, ""));
      blocks.push(
        line.startsWith("# ") ? (
          <h2 key={index} className="text-xl font-semibold">
            {heading}
          </h2>
        ) : (
          <h3 key={index} className="text-base font-semibold">
            {heading}
          </h3>
        ),
      );
    } else if (/^(?:[-*+] |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line);
      const items: ReactNode[] = [];
      do {
        items.push(<li key={index}>{inline((lines[index] ?? "").replace(/^(?:[-*+] |\d+\. )/, ""))}</li>);
        index++;
      } while (index < lines.length && /^(?:[-*+] |\d+\. )/.test(lines[index] ?? ""));
      index--;
      blocks.push(
        ordered ? (
          <ol key={index} className="list-decimal pl-5">
            {items}
          </ol>
        ) : (
          <ul key={index} className="list-disc pl-5">
            {items}
          </ul>
        ),
      );
    } else if (line.startsWith("> "))
      blocks.push(
        <blockquote key={index} className="border-l-2 border-border pl-3 text-muted-foreground">
          {inline(line.slice(2))}
        </blockquote>,
      );
    else
      blocks.push(
        <p key={index} className="whitespace-pre-wrap">
          {inline(line)}
        </p>,
      );
  }
  return <article className="min-w-0 space-y-3 break-words text-sm leading-relaxed">{blocks}</article>;
}
