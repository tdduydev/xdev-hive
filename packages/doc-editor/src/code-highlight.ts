import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { highlightLines } from "@xdev-hive/ui/highlight";

interface Range {
  from: number;
  to: number;
  className: string;
}

/**
 * Tô màu cú pháp cho khối code bằng decoration (lớp hljs-*, cùng bảng màu với chế độ xem). Dùng lại highlightLines của
 * packages/ui thay vì extension lowlight của Tiptap vì extension đó tự đoán ngôn ngữ khi khối không ghi ngôn ngữ, ra
 * màu lung tung cho đoạn chữ thường.
 */
export function codeHighlight(name = "codeBlock"): Plugin<DecorationSet> {
  // Node ProseMirror bất biến: khối không đổi giữ nguyên danh tính nên không phải tô lại mỗi lần gõ ở chỗ khác.
  const cache = new WeakMap<PMNode, Range[]>();
  const ranges = (node: PMNode): Range[] => {
    const cached = cache.get(node);
    if (cached) return cached;
    const out: Range[] = [];
    let offset = 0;
    for (const line of highlightLines(node.textContent, node.attrs.language as string | null)) {
      for (const span of line) {
        if (span.className) out.push({ from: offset, to: offset + span.text.length, className: span.className });
        offset += span.text.length;
      }
      offset += 1;
    }
    cache.set(node, out);
    return out;
  };
  const build = (doc: PMNode) => {
    const decorations: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== name) return true;
      for (const r of ranges(node))
        decorations.push(Decoration.inline(pos + 1 + r.from, pos + 1 + r.to, { class: r.className }));
      return false;
    });
    return DecorationSet.create(doc, decorations);
  };
  const key = new PluginKey<DecorationSet>("hiveCodeHighlight");
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, { doc }) => build(doc),
      apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
}
