/**
 * xterm.js giả cho test (jsdom không có canvas): ghi lại thứ được vẽ và cho test gõ phím vào. Dùng bằng
 * `vi.mock("@xterm/xterm", () => import("@/test-fake-xterm.ts"))`.
 */
export const terms: Terminal[] = [];

export class Terminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  written: (string | Uint8Array)[] = [];
  focused = 0;
  type: (data: string) => void = () => {};
  unicode = { activeVersion: "6" };
  constructor(options: Record<string, unknown>) {
    this.options = options;
    terms.push(this);
  }
  loadAddon() {}
  open() {}
  focus() {
    this.focused++;
  }
  dispose() {}
  write(data: string | Uint8Array) {
    this.written.push(data);
  }
  onData(handler: (data: string) => void) {
    this.type = handler;
    return { dispose() {} };
  }
  onResize() {
    return { dispose() {} };
  }
}

/** Mọi thứ terminal đã vẽ, ghép thành chữ. */
export const screenText = (term: Terminal) =>
  term.written.map((w) => (typeof w === "string" ? w : new TextDecoder().decode(w))).join("");
