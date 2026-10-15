// Bản giả tối thiểu của API `vscode` cho test đơn vị. Chỉ thêm thứ test cần, để lộ ngay chỗ code gọi API chưa mock.
import { vi } from "vitest";

export const Disposable = class {
  private readonly fn: () => void;
  constructor(fn: () => void) {
    this.fn = fn;
  }
  dispose() {
    this.fn();
  }
  static from(...items: { dispose(): void }[]) {
    return new Disposable(() => {
      for (const item of items) item.dispose();
    });
  }
};

export const EventEmitter = class<T> {
  private listeners = new Set<(e: T) => void>();
  event = (listener: (e: T) => void) => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(e: T) {
    for (const l of this.listeners) l(e);
  }
  dispose() {
    this.listeners.clear();
  }
};

export const Uri = {
  parse: (value: string) => ({ toString: () => value, fsPath: value }),
  file: (fsPath: string) => ({ toString: () => `file://${fsPath}`, fsPath }),
};

export const settings = new Map<string, unknown>();

export const workspace = {
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, fallback?: T) =>
      (settings.has(`${section}.${key}`) ? settings.get(`${section}.${key}`) : fallback) as T,
    inspect: (key: string) => ({ globalValue: settings.get(`${section}.${key}`) }),
  }),
  isTrusted: true,
  onDidChangeConfiguration: vi.fn(() => new Disposable(() => {})),
  workspaceFolders: undefined as unknown,
};

export const env = { language: "vi", remoteName: undefined as string | undefined, uriScheme: "vscode" };

export const outputLines: string[] = [];
export const window = {
  createOutputChannel: vi.fn(() => ({
    appendLine: (line: string) => outputLines.push(line),
    show: vi.fn(),
    dispose: vi.fn(),
  })),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
};

export const commands = {
  registerCommand: vi.fn(() => new Disposable(() => {})),
  executeCommand: vi.fn(),
};

export const version = "1.101.0";

export function createContext() {
  return {
    subscriptions: [] as { dispose(): void }[],
    extensionUri: Uri.file("/ext"),
    secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
    globalState: { get: vi.fn(), update: vi.fn() },
    workspaceState: { get: vi.fn(), update: vi.fn() },
  };
}
