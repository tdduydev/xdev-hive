// Invisible characters that make text read one way to a person and another way to an agent.
// Bidi controls reorder what an editor shows (Trojan Source); tag characters and variation selectors
// carry text a model decodes but nobody sees; zero-width characters hide or split words.
// Browser-safe, so editors can find and remove them before saving.
import { HiveError } from "./errors.ts";

export const HIDDEN_KINDS = ["bidi", "tag", "selector", "zeroWidth"] as const;
export type HiddenKind = (typeof HIDDEN_KINDS)[number];

const KINDS: Array<[HiddenKind, RegExp]> = [
  ["bidi", /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u],
  ["tag", /[\u{E0000}-\u{E007F}]/u],
  ["selector", /[\u{E0100}-\u{E01EF}]/u],
  ["zeroWidth", /[\u180E\u200B-\u200D\u2060-\u2064\uFEFF]/u],
];
const HIDDEN = /[\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

// Emoji use two of these on purpose: a zero-width joiner inside a sequence (woman + ZWJ + laptop),
// and tag characters in subdivision flags (black flag + g b s c t + cancel tag = Scotland).
const EMOJI_JOINER = /(?<=[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F])\u200D(?=\p{Extended_Pictographic})/gu;
const FLAG_TAGS = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,6}\u{E007F}/gu;

export interface HiddenChar {
  kind: HiddenKind;
  /** e.g. U+200B */
  code: string;
  /** 1-based; the column counts code points. */
  line: number;
  column: number;
}

function allowed(text: string): Set<number> {
  const ok = new Set<number>();
  for (const m of text.matchAll(EMOJI_JOINER)) ok.add(m.index);
  // U+1F3F4 and every tag take two UTF-16 units.
  for (const m of text.matchAll(FLAG_TAGS)) for (let i = m.index + 2; i < m.index + m[0].length; i += 2) ok.add(i);
  return ok;
}

const codeOf = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/** The hidden characters in text (at most `limit`), in order. */
export function findHidden(text: string, limit = 50): HiddenChar[] {
  const ok = allowed(text);
  const found: HiddenChar[] = [];
  let line = 1;
  let lineStart = 0;
  for (const m of text.matchAll(HIDDEN)) {
    if (ok.has(m.index)) continue;
    for (let nl = text.indexOf("\n", lineStart); nl !== -1 && nl < m.index; nl = text.indexOf("\n", lineStart)) {
      line += 1;
      lineStart = nl + 1;
    }
    const kind = KINDS.find(([, re]) => re.test(m[0]))![0];
    found.push({ kind, code: codeOf(m[0]), line, column: [...text.slice(lineStart, m.index)].length + 1 });
    if (found.length >= limit) break;
  }
  return found;
}

/** Text without its hidden characters; emoji keep theirs. */
export function stripHidden(text: string): string {
  const ok = allowed(text);
  return text.replace(HIDDEN, (ch: string, index: number) => (ok.has(index) ? ch : ""));
}

/** Docs, proposals and memory reach every agent, so text with hidden characters is refused. */
export function assertNoHidden(text: string, field: string): void {
  const [hit] = findHidden(text, 1);
  if (!hit) return;
  throw new HiveError(
    "bad_request",
    `${field} has a hidden character (${hit.code}, ${hit.kind}) at line ${hit.line}, column ${hit.column}. ` +
      "An agent would read text that people reviewing it cannot see. Remove it and save again.",
    { key: `errors.hidden.${hit.kind}`, vars: { code: hit.code, line: hit.line, column: hit.column } },
  );
}
