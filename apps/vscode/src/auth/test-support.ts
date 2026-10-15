import { vi } from "vitest";
import type * as vscode from "vscode";

export const orgId = "12345678-1234-1234-1234-123456789abc";
export const token = `hive_pat_${orgId}_${"a".repeat(43)}`;
export function secrets() {
  const data = new Map<string, string>();
  const listeners = new Set<(event: { key: string }) => void>();
  const change = (key: string) => {
    for (const listener of listeners) listener({ key });
  };
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key)),
    store: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
      change(key);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
      change(key);
    }),
    onDidChange: (listener: (event: { key: string }) => void) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  } satisfies vscode.SecretStorage & { data: Map<string, string> };
}
