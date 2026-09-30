// Mermaid diagrams (roadmap 23b): a ```mermaid block drawn as its diagram, in the design's colours and type. The
// library is big: it loads with the first diagram. Strict security (labels are text, no clicks or scripts); a diagram
// with an error shows the error and its code.
import { useEffect, useState } from "react";
import { cn } from "cn";
import { errorMessage } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useTheme } from "#ui/lib/theme.ts";

type Api = (typeof import("mermaid"))["default"];
let api: Promise<Api> | null = null;
let drawnWith: string | null = null;
let seq = 0;
// One diagram at a time: Mermaid keeps its settings and a scratch element per render.
let queue: Promise<unknown> = Promise.resolve();

/** The theme's colours, read from the tokens on <html> (they follow data-theme). */
function themeVariables(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    fontFamily: v("--font-sans"),
    fontSize: "14px",
    background: v("--bg-surface"),
    primaryColor: v("--status-info-bg"),
    primaryTextColor: v("--text-strong"),
    primaryBorderColor: v("--border-selected"),
    secondaryColor: v("--bg-subtle"),
    secondaryTextColor: v("--text-primary"),
    secondaryBorderColor: v("--border-strong"),
    tertiaryColor: v("--bg-raised"),
    tertiaryTextColor: v("--text-primary"),
    tertiaryBorderColor: v("--border-default"),
    lineColor: v("--border-control"),
    textColor: v("--text-primary"),
    mainBkg: v("--status-info-bg"),
    nodeBorder: v("--border-selected"),
    clusterBkg: v("--bg-subtle"),
    clusterBorder: v("--border-default"),
    edgeLabelBackground: v("--bg-surface"),
    noteBkgColor: v("--bg-subtle"),
    noteTextColor: v("--text-primary"),
    noteBorderColor: v("--border-default"),
    actorBkg: v("--status-info-bg"),
    actorBorder: v("--border-selected"),
    actorTextColor: v("--text-strong"),
    signalColor: v("--text-secondary"),
    signalTextColor: v("--text-primary"),
  };
}

/** The diagram's SVG, or the error Mermaid reads in `code`. */
export function renderMermaid(code: string, theme: "light" | "dark"): Promise<string> {
  const draw = async () => {
    const mermaid = await (api ??= import("mermaid").then((m) => m.default));
    if (drawnWith !== theme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", darkMode: theme === "dark", themeVariables: themeVariables() });
      drawnWith = theme;
    }
    // Checked first: a diagram that fails to render leaves Mermaid's error drawing in the page.
    await mermaid.parse(code);
    const { svg } = await mermaid.render(`hive-mermaid-${++seq}`, code);
    return svg;
  };
  const run = queue.then(draw, draw);
  queue = run.catch(() => undefined);
  return run;
}

export function MermaidDiagram({ code, delay = 0, className }: { code: string; /** Wait this long after the last change (the editor). */ delay?: number; className?: string }) {
  const t = useT();
  const { theme } = useTheme();
  const [drawn, setDrawn] = useState<{ svg: string | null; error: string | null }>({ svg: null, error: null });
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      renderMermaid(code, theme).then(
        (svg) => live && setDrawn({ svg, error: null }),
        (err) => live && setDrawn((d) => ({ svg: d.svg, error: errorMessage(err) })),
      );
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, theme, delay]);

  if (!code.trim()) return null;
  return (
    <figure className={cn("m-0 flex flex-col gap-2", className)} data-mermaid>
      {drawn.error ? (
        <div role="alert" className="flex flex-col gap-1 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-xs/5 text-danger">
          {t("mermaid.error", { message: drawn.error.split("\n")[0] ?? "" })}
          {/* Mermaid's next lines point at the place: the line, then a caret under it. */}
          {drawn.error.includes("\n") ? <pre className="m-0 overflow-x-auto font-mono text-[11px]/4">{drawn.error.split("\n").slice(1, 3).join("\n")}</pre> : null}
        </div>
      ) : null}
      {drawn.svg && !(drawn.error && delay === 0) ? (
        <div
          role="img"
          aria-label={t("mermaid.label")}
          className={cn("overflow-x-auto rounded-md border border-line-subtle bg-surface p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full", drawn.error && "opacity-50")}
          // Mermaid's own SVG, drawn with securityLevel "strict" (it sanitizes labels); the page allows no inline script.
          dangerouslySetInnerHTML={{ __html: drawn.svg }}
        />
      ) : !drawn.error ? (
        <div className="grid h-24 place-items-center rounded-md border border-dashed border-line-default text-xs text-fg-muted">{t("mermaid.loading")}</div>
      ) : null}
      {drawn.error && delay === 0 ? (
        <pre className="m-0 overflow-x-auto rounded-md border border-line-subtle bg-code px-3.5 py-3 font-mono text-xs/5 whitespace-pre-wrap text-code-fg">{code}</pre>
      ) : null}
    </figure>
  );
}
