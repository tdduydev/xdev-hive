// Trang đọc (docs/design/2026-09-redesign, xDev Hive Web Admin: Tài liệu → Mở trang đọc; roadmap 22j): one page to read,
// with its table of contents, the pages under it, the page before and after it, and what links to it.
// #/read?doc=<key>.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Brain, Pencil } from "lucide-react";
import { cn } from "cn";
import { docLinkRefs, resolveDocLink } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { useDocAssets } from "#ui/components/DocAssets.tsx";
import { DocMarkdown, docHref, type DocContext } from "#ui/components/DocMarkdown.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { formatTime, useHashParam, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { buildTree, docHeadings, trail, type TreeNode } from "#ui/lib/doctree.ts";
import { docOwner } from "#ui/lib/scope.ts";
import { ChildPages } from "./Docs.tsx";

export function DocReaderPage() {
  const { client } = useHive();
  const t = useT();
  const [key] = useHashParam("doc");
  const list = useQuery(() => client.call("docs.list", {}), [client]);
  const doc = useQuery(async () => (key ? client.call("docs.get", { key }) : null), [client, key]);
  const links = useQuery(async () => (key ? client.call("docs.links", { key }).catch(() => null) : null), [client, key, doc.data?.version]);
  const files = useDocAssets(key ?? "");
  const titles = useMemo(() => new Map((list.data ?? []).map((d) => [d.key, d.title])), [list.data]);
  const owner = key ? docOwner(key) : null;
  const tree = useMemo(() => buildTree((list.data ?? []).filter((d) => docOwner(d.key) === owner), [], t("docs.skillsFolder")), [list.data, owner, t]);
  const path = useMemo(() => (key ? trail(tree, key) : []), [tree, key]);
  const node = path.at(-1);
  const siblings = (path.length > 1 ? path.at(-2)!.children : tree).filter((n) => n.doc);
  const at = siblings.findIndex((n) => n.key === key);
  const prev = at > 0 ? siblings[at - 1] : undefined;
  const next = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : undefined;
  const current = doc.data ?? null;
  const headings = useMemo(() => docHeadings(current?.content ?? ""), [current?.content]);
  const context: DocContext | undefined = key ? { key, titles, href: (k) => docHref(k, "read") } : undefined;
  const space = owner ?? t("inbox.shared");
  const broken = useMemo(() => {
    if (!key || !current) return 0;
    const exists = (k: string) => titles.has(k);
    return docLinkRefs(current.content).filter((r) => resolveDocLink(r.target, key, exists)?.exists === false).length;
  }, [current, key, titles]);
  const images = (files.data ?? []).filter((f) => f.type.startsWith("image/")).length;

  // The heading being read, for the table of contents.
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => {
      let id: string | null = headings[0]?.id ?? null;
      for (const h of headings) {
        const target = document.getElementById(h.id);
        if (target && target.offsetTop - el.offsetTop <= el.scrollTop + 40) id = h.id;
      }
      setActive(id);
    };
    on();
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, [headings]);
  useEffect(() => {
    box.current?.scrollTo({ top: 0 });
  }, [key]);

  const jump = (id: string) => {
    const el = box.current;
    const target = document.getElementById(id);
    if (el && target) el.scrollTo({ top: target.offsetTop - el.offsetTop - 16, behavior: "smooth" });
  };

  if (!key) return <div className="grid h-full place-items-center p-6 text-[13px] text-fg-muted">{t("docs.pick")}</div>;
  const chip = "inline-flex h-5 items-center rounded-xs px-[7px] text-[11px]/none font-semibold whitespace-nowrap";
  const groups: Array<{ title: string; empty: string; items: Array<{ key: string; href: string; title: string; space?: string; snippet?: string; broken?: boolean }> }> = [
    {
      title: t("docs.linksOut"),
      empty: t("docs.linksOutNone"),
      items: (links.data?.out ?? []).map((l) => ({
        key: l.key,
        href: l.exists ? docHref(l.key, "read") : "",
        title: l.title ?? l.target,
        space: docOwner(l.key) !== owner ? (docOwner(l.key) ?? t("inbox.shared")) : undefined,
        broken: !l.exists,
      })),
    },
    {
      title: t("docs.linksBack"),
      empty: t("docs.linksBackNone"),
      items: (links.data?.back ?? []).map((b) => ({
        key: b.key,
        href: docHref(b.key, "read"),
        title: b.title,
        space: docOwner(b.key) !== owner ? (docOwner(b.key) ?? t("inbox.shared")) : undefined,
        snippet: b.snippet || undefined,
      })),
    },
    {
      title: t("docs.siblings"),
      empty: t("docs.siblingsNone"),
      items: siblings
        .filter((n) => n.key !== key)
        .slice(0, 8)
        .map((n) => ({ key: n.key, href: docHref(n.key, "read"), title: n.title })),
    },
  ];
  const memory = links.data?.memory ?? [];

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface">
      <div className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-2 border-b border-line-subtle px-4 py-2">
        <nav aria-label={t("docs.breadcrumb")} className="flex min-w-0 flex-1 items-center gap-1 text-xs/none">
          <span className="shrink-0 font-mono font-medium text-fg-muted">{space}</span>
          {path.slice(0, -1).map((n) => (
            <span key={n.key} className="flex min-w-0 items-center gap-1">
              <span className="text-fg-disabled">/</span>
              {n.doc ? (
                <a href={docHref(n.key, "read")} className="max-w-[180px] truncate text-fg-secondary hover:text-fg-strong hover:underline">
                  {n.title}
                </a>
              ) : (
                <span className="max-w-[180px] truncate text-fg-secondary">{n.title}</span>
              )}
            </span>
          ))}
          <span className="text-fg-disabled">/</span>
          <span className="min-w-0 truncate font-semibold text-fg-strong">{current?.title ?? key}</span>
        </nav>
        <Button size="sm" variant="outline" asChild>
          <a href={docHref(key, "docs")}>
            <Pencil />
            {t("docs.openEditor")}
          </a>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label={t("docs.toc")} className="hidden w-[210px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line-subtle bg-subtle px-3 py-5 lg:flex">
          <span className="px-2 pb-1.5 type-caption text-fg-muted">{t("docs.toc")}</span>
          {headings.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => jump(h.id)}
              aria-current={active === h.id ? "location" : undefined}
              className={cn(
                "cursor-pointer truncate rounded-sm py-1 pr-2 text-left text-[13px]/5 outline-none hover:bg-hover focus-visible:focus-ring",
                h.depth === 3 ? "pl-5" : "pl-2",
                active === h.id ? "bg-surface font-semibold text-fg-strong shadow-e1" : "text-fg-secondary",
              )}
            >
              {h.text}
            </button>
          ))}
          {!headings.length ? <span className="px-2 text-xs text-fg-muted">{t("docs.tocNone")}</span> : null}
        </nav>
        <div ref={box} className="min-w-0 flex-1 overflow-y-auto">
          <article data-reader className="mx-auto flex max-w-[760px] flex-col gap-6 px-[clamp(16px,4vw,48px)] pt-8 pb-16">
            <ErrorNote error={doc.error ?? list.error} />
            {current ? (
              <>
                <header className="flex flex-col gap-2.5">
                  <h1 className="m-0 font-display text-[30px]/[38px] font-semibold tracking-[-0.015em] text-fg-strong">{current.title}</h1>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={cn(chip, "bg-sunken font-mono text-fg-secondary")}>v{current.version}</span>
                    {current.includeInAgents ? <span className={cn(chip, "bg-info-soft text-info")}>{t("docs.inAgents")}</span> : null}
                    {current.paths?.length ? <span className={cn(chip, "bg-warning-soft font-mono text-warning")}>{t("docs.appliesTo", { paths: current.paths.join(", ") })}</span> : null}
                    {images ? <span className={cn(chip, "bg-sunken text-fg-secondary")}>{t("docs.imagesChip", { count: images })}</span> : null}
                    {broken ? <span className={cn(chip, "bg-danger-soft text-danger")}>{t("docs.brokenChip", { count: broken })}</span> : null}
                    <span className={cn(chip, "bg-sunken text-fg-secondary")}>{t("docs.backlinksChip", { count: links.data?.back.length ?? 0 })}</span>
                    <span className="text-xs text-fg-muted">{t("docs.byline", { version: current.version, when: formatTime(current.updatedAt), who: current.updatedBy })}</span>
                  </div>
                </header>
                {current.content.trim() ? <DocMarkdown text={current.content} doc={context} headingIds /> : node?.children.length ? null : <p className="m-0 text-[15px] text-fg-muted">{t("docs.empty")}</p>}
                {node && node.children.some((c) => c.doc) ? <ChildPages nodes={node.children.filter((c) => c.doc)} /> : null}
                {prev || next ? (
                  <div className="grid grid-cols-2 gap-3 border-t border-line-subtle pt-5">
                    {prev ? <Pager node={prev} dir="prev" /> : <span />}
                    {next ? <Pager node={next} dir="next" /> : null}
                  </div>
                ) : null}
              </>
            ) : !doc.loading ? (
              <p className="m-0 text-[15px] text-fg-muted">{t("docs.readerMissing", { key })}</p>
            ) : null}
          </article>
        </div>
        <aside aria-label={t("docs.linksPanel")} className="hidden w-[270px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-line-subtle px-4 py-5 xl:flex">
          {groups.map((g) => (
            <section key={g.title} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-1.5 pb-1">
                <span className="type-caption text-fg-muted">{g.title}</span>
                <span className="ml-auto font-mono text-[11px] text-fg-muted">{g.items.length}</span>
              </div>
              {g.items.map((it) =>
                it.broken ? (
                  <span key={it.key} title={t("docs.brokenLink", { target: it.key })} className="flex flex-col gap-0.5 rounded-sm px-1.5 py-1.5">
                    <span className="truncate font-mono text-[13px] text-danger line-through">{it.title}</span>
                    <span className="truncate text-[11px] text-fg-muted">{t("docs.missingPage")}</span>
                  </span>
                ) : (
                  <a key={it.key} href={it.href} title={it.key} className="flex flex-col gap-0.5 rounded-sm px-1.5 py-1.5 outline-none hover:bg-hover focus-visible:focus-ring">
                    <span className="flex items-baseline gap-1.5">
                      <span className="min-w-0 truncate text-[13px] font-medium text-fg-strong">{it.title}</span>
                      {it.space ? <span className="shrink-0 font-mono text-[11px] text-fg-muted">{it.space}</span> : null}
                    </span>
                    {it.snippet ? <span className="line-clamp-2 text-xs/[17px] text-fg-muted">{it.snippet}</span> : null}
                  </a>
                ),
              )}
              {!g.items.length ? <span className="px-1.5 text-xs text-fg-muted">{g.empty}</span> : null}
            </section>
          ))}
          {memory.length ? (
            <section className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-1.5 pb-1">
                <span className="type-caption text-fg-muted">{t("docs.memoryMentions")}</span>
                <span className="ml-auto font-mono text-[11px] text-fg-muted">{memory.length}</span>
              </div>
              {memory.map((m) => (
                <a key={m.id} href="#/memory" className="flex gap-2 rounded-sm px-1.5 py-1.5 outline-none hover:bg-hover focus-visible:focus-ring">
                  <Brain className="mt-0.5 size-3.5 shrink-0 text-fg-muted" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono text-[11px] text-fg-muted">#{m.id}</span>
                    <span className="line-clamp-2 text-xs/[17px] text-fg-secondary">{m.content}</span>
                  </span>
                </a>
              ))}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function Pager({ node, dir }: { node: TreeNode; dir: "prev" | "next" }) {
  const t = useT();
  return (
    <a
      href={docHref(node.key, "read")}
      className={cn(
        "flex flex-col gap-1 rounded-md border border-line-subtle px-3.5 py-2.5 outline-none hover:border-line-default hover:bg-hover focus-visible:focus-ring",
        dir === "next" && "col-start-2 items-end text-right",
      )}
    >
      <span className="flex items-center gap-1 text-[11px] font-semibold text-fg-muted">
        {dir === "prev" ? <ArrowLeft className="size-3" /> : null}
        {dir === "prev" ? t("docs.prevPage") : t("docs.nextPage")}
        {dir === "next" ? <ArrowRight className="size-3" /> : null}
      </span>
      <span className="truncate text-[13px] font-medium text-fg-strong">{node.title}</span>
    </a>
  );
}
