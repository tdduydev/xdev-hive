import { runWorker } from "@/local/worker.ts";

export type ContextPack = { markdown: string; files: string[]; tokens: number };

export async function buildContextPack(cwd: string, query: string): Promise<ContextPack> {
  const pack = await runWorker<Partial<ContextPack>>(["context-pack", "--cwd", cwd, "--query", query], {
    timeoutMs: 30_000,
  });
  return { markdown: pack.markdown ?? "", files: pack.files ?? [], tokens: pack.tokens ?? 0 };
}
