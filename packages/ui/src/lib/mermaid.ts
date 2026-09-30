// Mermaid blocks in a page's Markdown (roadmap 23b): found in the tree react-markdown renders from.
type Hast = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Hast[] };

/** The code of a ```mermaid block (a <pre> holding <code class="language-mermaid">), or null for any other. */
export function mermaidSource(pre: Hast | undefined): string | null {
  const code = pre?.children?.find((c) => c.type === "element");
  const classes = code?.tagName === "code" ? code.properties?.className : undefined;
  if (!Array.isArray(classes) || !classes.includes("language-mermaid")) return null;
  const text = (n: Hast): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(text).join(""));
  return text(code!).replace(/\n$/, "");
}
