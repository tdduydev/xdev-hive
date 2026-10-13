import { cn } from "cn";
import { Marked, type Token, type Tokens } from "marked";
import { Fragment, type ReactNode } from "react";
import { CodeBlock } from "./code-block.tsx";
import { MermaidDiagram } from "./mermaid-diagram.tsx";
import { type ProseLang, pageLang, proseText } from "./prose-text.ts";

/*
 * Chế độ xem Markdown dùng chung cho web và app desktop (cùng CSS `hive-prose` với trình soạn Tiptap). Nội dung là chữ
 * do agent hay người khác viết nên dựng thành phần tử React từ token của marked, không bao giờ chèn HTML.
 */
const marked = new Marked({ gfm: true });

export interface MarkdownProps {
  content: string;
  lang?: ProseLang;
  className?: string;
  /** Hiện số dòng ở khối code ngay từ đầu (người đọc vẫn bật tắt được). */
  lineNumbers?: boolean;
  /**
   * `open`: link web/mail mở tab mới. `text`: chỉ hiện chữ của link (cửa sổ app desktop không nên điều hướng đi đâu cả).
   */
  links?: "open" | "text";
  /** Đoạn hoặc mục thoả điều kiện được tô vàng (khối "chưa có trong code" của màn Tài liệu). */
  isPlanned?: (text: string) => boolean;
}

interface Ctx {
  lineNumbers: boolean | undefined;
  isPlanned: ((text: string) => boolean) | undefined;
  lang: ProseLang;
  links: "open" | "text";
  next: () => string;
}

const SAFE_LINK = /^(https?:\/\/|mailto:|#)/i;
const SAFE_IMAGE = /^https?:\/\//i;

function inline(tokens: Token[] | undefined, ctx: Ctx): ReactNode[] {
  return (tokens ?? []).map((token): ReactNode => {
    const key = ctx.next();
    switch (token.type) {
      case "strong":
        return <strong key={key}>{inline((token as Tokens.Strong).tokens, ctx)}</strong>;
      case "em":
        return <em key={key}>{inline((token as Tokens.Em).tokens, ctx)}</em>;
      case "del":
        return <del key={key}>{inline((token as Tokens.Del).tokens, ctx)}</del>;
      case "codespan":
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case "br":
        return <br key={key} />;
      case "link": {
        const link = token as Tokens.Link;
        const children = inline(link.tokens, ctx);
        if (ctx.links === "text" || !SAFE_LINK.test(link.href)) return <Fragment key={key}>{children}</Fragment>;
        const external = !link.href.startsWith("#");
        return (
          <a
            key={key}
            href={link.href}
            title={link.title ?? undefined}
            {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
          >
            {children}
          </a>
        );
      }
      case "image": {
        const image = token as Tokens.Image;
        // Chỉ ảnh web: đường dẫn file hay data: trong tài liệu do agent viết không đáng tin để tải.
        return SAFE_IMAGE.test(image.href) ? (
          <img
            key={key}
            src={image.href}
            alt={image.text}
            title={image.title ?? undefined}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <em key={key}>{image.text || proseText[ctx.lang].image}</em>
        );
      }
      case "checkbox":
        // Mục danh sách thưa (có dòng trống) đặt `[x] ` vào token inline của đoạn; ô tick do item() vẽ.
        return null;
      case "escape":
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens?.length ? (
          <Fragment key={key}>{inline(text.tokens, ctx)}</Fragment>
        ) : (
          <Fragment key={key}>{text.text}</Fragment>
        );
      }
      default:
        // html thô và loại lạ: hiện nguyên chữ, không dựng thành phần tử.
        return <Fragment key={key}>{"raw" in token ? String(token.raw) : ""}</Fragment>;
    }
  });
}

function plain(token: Token): string {
  return "text" in token && typeof token.text === "string" ? token.text : "raw" in token ? String(token.raw) : "";
}

function item(token: Tokens.ListItem, ctx: Ctx): ReactNode {
  const planned = ctx.isPlanned?.(token.text) ?? false;
  const body = blocks(token.tokens, ctx, true);
  return (
    <li key={ctx.next()} className={cn(token.task && "hive-task", planned && "hive-planned")}>
      {token.task && (
        <input
          type="checkbox"
          checked={token.checked ?? false}
          disabled
          readOnly
          aria-label={token.checked ? "✓" : "○"}
        />
      )}
      {token.task ? <div>{body}</div> : body}
    </li>
  );
}

/** `tight`: mục danh sách không bọc chữ trong <p> để dòng không giãn cách như đoạn văn. */
function blocks(tokens: Token[], ctx: Ctx, tight = false): ReactNode[] {
  const out: ReactNode[] = [];
  for (const token of tokens) {
    const key = ctx.next();
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "checkbox":
        // marked 17 đưa `[x] ` vào đầu tokens của mục; ô tick do item() tự vẽ.
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const H = `h${Math.min(Math.max(heading.depth, 1), 6)}` as "h1";
        out.push(<H key={key}>{inline(heading.tokens, ctx)}</H>);
        break;
      }
      case "paragraph": {
        const p = token as Tokens.Paragraph;
        const children = inline(p.tokens, ctx);
        if (tight) out.push(<Fragment key={key}>{children}</Fragment>);
        else
          out.push(
            <p key={key} className={cn(ctx.isPlanned?.(p.text) && "hive-planned")}>
              {children}
            </p>,
          );
        break;
      }
      case "text": {
        const text = token as Tokens.Text;
        out.push(
          <Fragment key={key}>
            {inline(text.tokens ?? [{ type: "text", raw: text.text, text: text.text }], ctx)}
          </Fragment>,
        );
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        const language = (code.lang ?? "").trim().split(/\s/)[0]?.toLowerCase();
        out.push(
          language === "mermaid" ? (
            <MermaidDiagram key={key} code={code.text} lang={ctx.lang} />
          ) : (
            <CodeBlock key={key} code={code.text} language={language} lineNumbers={ctx.lineNumbers} lang={ctx.lang} />
          ),
        );
        break;
      }
      case "blockquote":
        out.push(<blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, ctx)}</blockquote>);
        break;
      case "list": {
        const list = token as Tokens.List;
        const hasTask = list.items.some((i) => i.task);
        const items = list.items.map((i) => item(i, ctx));
        out.push(
          list.ordered ? (
            <ol key={key} start={list.start === "" || list.start === 1 ? undefined : list.start}>
              {items}
            </ol>
          ) : (
            <ul key={key} className={cn(hasTask && "hive-tasks")}>
              {items}
            </ul>
          ),
        );
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        out.push(
          <div key={key} className="hive-table">
            <table>
              <thead>
                <tr>
                  {table.header.map((cell, i) => (
                    <th key={ctx.next()} style={table.align[i] ? { textAlign: table.align[i] } : undefined}>
                      {inline(cell.tokens, ctx)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={ctx.next()}>
                    {row.map((cell, i) => (
                      <td key={ctx.next()} style={table.align[i] ? { textAlign: table.align[i] } : undefined}>
                        {inline(cell.tokens, ctx)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        break;
      }
      case "hr":
        out.push(<hr key={key} />);
        break;
      default:
        // html khối và loại lạ: hiện nguyên chữ trong đoạn.
        if (plain(token).trim()) out.push(<p key={key}>{plain(token)}</p>);
    }
  }
  return out;
}

export function Markdown({
  content,
  lang = pageLang(),
  className,
  lineNumbers,
  links = "open",
  isPlanned,
}: MarkdownProps) {
  let n = 0;
  const ctx: Ctx = { lang, lineNumbers, links, isPlanned, next: () => `m${n++}` };
  return (
    <article className={cn("hive-prose", className)}>
      {blocks(marked.lexer(content.replace(/\r\n/g, "\n")), ctx)}
    </article>
  );
}
