// Remote terminal transcript filter (spec 69 §8, task 69d). Browser-safe: no Buffer, no node modules.
// The transcript is what a person may view or export later, so it is plain text with every terminal control sequence
// removed: a secret split by a colour code, a chunk boundary or a half-sent UTF-8 character must still be caught.
import { findSecret } from "./secrets.ts";

/** A line longer than this is checked and emitted in parts, so a TUI that never prints "\n" cannot grow memory. */
const MAX_LINE = 8 * 1024;
/**
 * Kept back when a long line is emitted in parts. Longer than the minimal match of every pattern in secrets.ts and
 * than any known secret we accept, so a secret that starts in the emitted part is always seen whole before it leaves.
 */
const TAIL = 1024;
/** Known values shorter than this would hide ordinary words; longer ones could straddle TAIL. */
export const KNOWN_SECRET_MIN = 8;
export const KNOWN_SECRET_MAX = 512;

const hidden = (label: string) => `(line hidden: it looked like a ${label})`;

type Esc = "none" | "esc" | "csi" | "string" | "stringEsc" | "intermediate";

/**
 * Bytes from a PTY in, redacted transcript text out. Holds what it cannot judge yet (a partial UTF-8 character, an
 * unfinished escape sequence, the current line) between writes; end() flushes it. Every line that looks like it holds
 * a secret, or contains one of the known values (the profile's secret env, the machine's Hive tokens), is replaced by
 * a note, as SecretRedactor does for run logs.
 */
export class TerminalRedactor {
  #decoder = new TextDecoder("utf-8");
  #known: string[];
  #esc: Esc = "none";
  #line = "";
  /** Set when part of the current line already left as a "hidden" note: the rest of it is dropped up to "\n". */
  #hiding = false;
  #privateKey = false;
  #afterCr = false;

  constructor(known: readonly string[] = []) {
    // Longest first is not needed for a yes/no test; dedupe keeps the per-line cost down.
    this.#known = [...new Set(known.filter((k) => k.length >= KNOWN_SECRET_MIN && k.length <= KNOWN_SECRET_MAX))];
  }

  #hit(text: string): string | null {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return "private key";
    const found = findSecret(text);
    if (found) return found;
    for (const k of this.#known) if (text.includes(k)) return "known secret";
    return null;
  }

  #finishLine(): string {
    const line = this.#line;
    this.#line = "";
    if (this.#hiding) { this.#hiding = false; return ""; }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) this.#privateKey = true;
    if (this.#privateKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) this.#privateKey = false;
      return hidden("private key") + "\n";
    }
    const hit = this.#hit(line);
    return (hit ? hidden(hit) : line) + "\n";
  }

  /** A line too long to hold: hide all of it if anything in it matches, else let out all but the tail. */
  #overflow(): string {
    if (this.#hiding) { this.#line = this.#line.slice(-TAIL); return ""; }
    const hit = this.#privateKey ? "private key" : this.#hit(this.#line);
    if (hit) {
      // The tail may hold the rest of the secret: drop everything up to the next newline.
      this.#hiding = true;
      this.#line = this.#line.slice(-TAIL);
      return hidden(hit) + "\n";
    }
    const out = this.#line.slice(0, -TAIL);
    this.#line = this.#line.slice(-TAIL);
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
      if (this.#line.length > MAX_LINE) out += this.#overflow();
    }
    return out;
  }

  write(bytes: Uint8Array): string {
    return this.#text(this.#decoder.decode(bytes, { stream: true }));
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
