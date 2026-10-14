import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { type BundledLanguage, bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";

/** Một đoạn chữ có màu cho giao diện sáng và tối; màu nằm trong biến CSS để đổi giao diện không phải tô lại. */
export interface CodeToken {
  content: string;
  light: string | undefined;
  dark: string | undefined;
}

/** Loại ra khỏi tô màu (vẫn hiện chữ thường) khi tệp quá lớn: tô màu đồng bộ trên luồng chính làm treo giao diện. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

// Bộ máy regex bằng JS thay vì Oniguruma (WASM): CSP của app desktop không có `wasm-unsafe-eval`.
let core: Promise<HighlighterCore> | null = null;
const highlighter = () =>
  (core ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [bundledThemes["github-light"](), bundledThemes["github-dark"]()],
    langs: [],
  }));

export function isKnownLanguage(language: string): language is BundledLanguage {
  return Object.hasOwn(bundledLanguages, language);
}

/**
 * Trả token theo dòng; ngữ pháp của ngôn ngữ chỉ tải lần đầu gặp vì bộ đầy đủ của shiki vài MB. `null` khi không tô được
 * (ngôn ngữ lạ, tệp quá lớn, ngữ pháp lỗi) để người gọi hiện chữ thường.
 */
export async function highlight(code: string, language: string): Promise<CodeToken[][] | null> {
  const lang = language.toLowerCase();
  if (code.length > MAX_HIGHLIGHT_CHARS || !isKnownLanguage(lang)) return null;
  try {
    const h = await highlighter();
    if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(bundledLanguages[lang]());
    const { tokens } = h.codeToTokens(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    return tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        light: token.htmlStyle?.["--shiki-light"],
        dark: token.htmlStyle?.["--shiki-dark"],
      })),
    );
  } catch {
    return null;
  }
}
