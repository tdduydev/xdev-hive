import type { EmbeddingsConfig } from "../platform/index.ts";

/**
 * Tạo embedding cho memory. Tuỳ chọn: hub không cấu hình embedder thì chỉ tìm theo từ. Thay được bằng bản khác (mô
 * hình nội bộ, bản giả trong test) mà không đụng tới phần lưu trữ.
 */
export interface Embedder {
  /** Lưu kèm vector; chỉ so vector cùng mô hình vì mô hình khác cho không gian (và số chiều) khác. */
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export class EmbedderError extends Error {
  override readonly name = "EmbedderError";
}

const TIMEOUT_MS = 15_000;

/** Gọi API `POST <url>/embeddings` theo định dạng của OpenAI; Ollama, vLLM, LiteLLM cũng nói định dạng này. */
export function createOpenAIEmbedder(cfg: EmbeddingsConfig, fetchImpl: typeof fetch = fetch): Embedder {
  return {
    model: cfg.dimensions ? `${cfg.model}@${cfg.dimensions}` : cfg.model,
    async embed(texts, signal) {
      if (texts.length === 0) return [];
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      const body: Record<string, unknown> = { model: cfg.model, input: texts, encoding_format: "float" };
      if (cfg.dimensions) body.dimensions = cfg.dimensions;
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.url}/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        throw new EmbedderError(`Không gọi được API embeddings: ${(error as Error).message}`, { cause: error });
      }
      if (!res.ok) {
        // Không đưa nguyên body vào lỗi: có server lặp lại header (kể cả khoá) trong thông báo lỗi.
        throw new EmbedderError(`API embeddings trả lỗi HTTP ${res.status}.`);
      }
      const json = (await res.json()) as { data?: Array<{ index?: number; embedding?: unknown }> };
      const data = json.data ?? [];
      if (data.length !== texts.length) throw new EmbedderError("API embeddings trả sai số lượng vector.");
      const out = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
      for (const v of out) {
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x)))
          throw new EmbedderError("API embeddings trả vector không hợp lệ.");
      }
      return out as number[][];
    },
  };
}

/** Dạng chữ của pgvector (`[1,2,3]`); truyền như tham số rồi ép `::vector` trong SQL. */
export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
