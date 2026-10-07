// Remote terminal transcript filter (spec 69 §8, task 69d). Browser-safe: no Buffer, no node modules.
// The transcript is what a person may view or export later, so it is plain text with every terminal control sequence
// removed: a secret split by a colour code, a chunk boundary or a half-sent UTF-8 character must still be caught.
import { findSecret } from "./secrets.ts";

/** A line longer than this is checked and emitted in parts, so a TUI that never prints "\n" cannot grow memory. */
const MAX_LINE = 8 * 1024;
/**
 * Kept back when a long line is emitted in parts. Longer than the minimal match of every pattern in secrets.ts, so a
 * secret that starts in the emitted part is always seen whole before it leaves. A longer known value raises it.
 */
const TAIL = 1024;

const hidden = (label: string) => `(line hidden: it looked like a ${label})`;
const PEM_MARK = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g;

export type Esc = "none" | "esc" | "csi" | "string" | "stringEsc" | "intermediate";

/**
 * What the filter holds between writes, so the hub can carry it from one uploaded chunk to the next (it is stored
 * encrypted beside the chunk and never served). It may hold the start of a secret: never log or return it.
 */
export interface TerminalRedactorState {
  esc: Esc;
  line: string;
  hiding: boolean;
  privateKey: boolean;
  afterCr: boolean;
}

/**
 * Literal values as lines can hold them. A value is hidden whatever its length: a short one hides ordinary lines too,
 * which costs readability, never a leak. A value with line breaks is matched line by line, as the screen shows it.
 */
function knownPieces(known: readonly string[]): string[] {
  return [...new Set(known.flatMap((k) => k.split(/[\r\n]+/)).filter((k) => k.trim() !== ""))];
}

/**
 * Bytes from a PTY in, redacted transcript text out. Holds what it cannot judge yet (a partial UTF-8 character, an
 * unfinished escape sequence, the current line) between writes; end() flushes it. Every line that looks like it holds
 * a secret, or contains one of the known values (the profile's secret env, the machine's Hive tokens), is replaced by
 * a note, as SecretRedactor does for run logs.
 */
export class TerminalRedactor {
  #decoder = new TextDecoder("utf-8");
  #known: string[];
  #tail: number;
  #maxLine: number;
  #esc: Esc = "none";
  #line = "";
  /** Set when part of the current line already left as a "hidden" note: the rest of it is dropped up to "\n". */
  #hiding = false;
  #privateKey = false;
  #afterCr = false;
  #hidden = 0;

  constructor(known: readonly string[] = [], state?: TerminalRedactorState) {
    this.#known = knownPieces(known);
    // A known value longer than the tail could otherwise start in an emitted part and end in the next one.
    this.#tail = Math.max(TAIL, ...this.#known.map((k) => k.length));
    this.#maxLine = Math.max(MAX_LINE, this.#tail * 2);
    if (state) {
      this.#esc = state.esc;
      this.#line = state.line;
      this.#hiding = state.hiding;
      this.#privateKey = state.privateKey;
      this.#afterCr = state.afterCr;
    }
  }

  /** Lines (or parts of a long line) replaced by a note so far. */
  get hidden(): number { return this.#hidden; }

  /** Only between writes of whole characters: writeText keeps no partial UTF-8, write() may. */
  state(): TerminalRedactorState {
    return { esc: this.#esc, line: this.#line, hiding: this.#hiding, privateKey: this.#privateKey, afterCr: this.#afterCr };
  }

  #hit(text: string): string | null {
    const found = findSecret(text);
    if (found) return found;
    for (const k of this.#known) if (text.includes(k)) return "known secret";
    return null;
  }

  /**
   * Follows BEGIN/END of a private key through text seen so far; returns whether the text had a marker at all. The
   * last whole marker decides: re-reading a kept tail finds the same last marker, or none and keeps the state.
   */
  #pem(text: string): boolean {
    let last: string | undefined;
    for (const m of text.matchAll(PEM_MARK)) last = m[1];
    if (last) this.#privateKey = last === "BEGIN";
    return last !== undefined;
  }

  #note(label: string): string {
    this.#hidden++;
    return hidden(label) + "\n";
  }

  #finishLine(): string {
    const line = this.#line;
    this.#line = "";
    const inKey = this.#privateKey;
    // Even a line already hidden in part moves the key state: its BEGIN may be what made it too long to hold.
    const marked = this.#pem(line);
    if (this.#hiding) { this.#hiding = false; return ""; }
    if (inKey || marked) return this.#note("private key");
    const hit = this.#hit(line);
    return hit ? this.#note(hit) : line + "\n";
  }

  /** A line too long to hold: hide all of it if anything in it matches, else let out all but the tail. */
  #overflow(): string {
    const inKey = this.#privateKey;
    const marked = this.#pem(this.#line);
    if (this.#hiding) { this.#line = this.#line.slice(-this.#tail); return ""; }
    const hit = inKey || marked ? "private key" : this.#hit(this.#line);
    if (hit) {
      // The tail may hold the rest of the secret: drop everything up to the next newline.
      this.#hiding = true;
      this.#line = this.#line.slice(-this.#tail);
      return this.#note(hit);
    }
    const out = this.#line.slice(0, -this.#tail);
    this.#line = this.#line.slice(-this.#tail);
    return out;
  }

  #text(text: string): string {
    let out = "";
    for (const ch of text) {
      const c = ch.codePointAt(0)!;
      switch (this.#esc) {
        case "esc":
          if (ch === "[") this.#esc = "csi";
          // OSC, DCS, SOS, PM, APC: strings that end with BEL or ESC \ (OSC 52 clipboard writes among them).
          else if (ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_") this.#esc = "string";
          else if (c >= 0x20 && c <= 0x2f) this.#esc = "intermediate";
          else this.#esc = "none";
          continue;
        case "intermediate":
          if (c < 0x20 || c > 0x2f) this.#esc = "none";
          continue;
        case "csi":
          if (c >= 0x40 && c <= 0x7e) this.#esc = "none";
          continue;
        case "string":
          if (c === 0x07 || c === 0x9c) this.#esc = "none";
          else if (c === 0x1b) this.#esc = "stringEsc";
          continue;
        case "stringEsc":
          this.#esc = ch === "\\" ? "none" : "string";
          continue;
      }
      if (c === 0x1b) { this.#esc = "esc"; continue; }
      if (c === 0x9b) { this.#esc = "csi"; continue; }
      if (c === 0x90 || c === 0x9d || c === 0x98 || c === 0x9e || c === 0x9f) { this.#esc = "string"; continue; }
      if (ch === "\n" || ch === "\r") {
        // "\r\n" and a bare "\r" both end what the eye reads as a line; "\r\n" ends one line, not two, even split.
        const second = ch === "\n" && this.#afterCr;
        this.#afterCr = ch === "\r";
        if (!second) out += this.#finishLine();
        continue;
      }
      this.#afterCr = false;
      // Backspace as the shell echoes it: a typo fixed while typing a token must still match the token.
      if (c === 0x08 || c === 0x7f) { this.#line = this.#line.slice(0, -1); continue; }
      if (c < 0x20 && ch !== "\t") continue;
      if (c >= 0x80 && c < 0xa0) continue;
      this.#line += ch;
      if (this.#line.length > this.#maxLine) out += this.#overflow();
    }
    return out;
  }

  write(bytes: Uint8Array): string {
    return this.#text(this.#decoder.decode(bytes, { stream: true }));
  }

  /** Text already decoded (the hub's second pass over uploaded transcript). */
  writeText(text: string): string {
    return this.#text(text);
  }

  end(): string {
    let out = this.#text(this.#decoder.decode());
    this.#esc = "none";
    if (this.#line || this.#hiding) {
      const last = this.#finishLine();
      out += last.endsWith("\n") ? last.slice(0, -1) : last;
    }
    this.#privateKey = false;
    return out;
  }
}
