// Text embeddings for memory search, from an OpenAI-compatible /embeddings endpoint: Ollama next to the
// hub (bge-m3), or an API. Browser-safe: fetch only.

export interface Embedder {
  /** Vectors are kept per model: another model indexes everything again. */
  readonly model: string;
  /** Unit-length vectors, one per text, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface OpenAiEmbedderOptions {
  /** Base URL that has /embeddings, e.g. http://ollama:11434/v1 */
  url: string;
  model: string;
  /** Bearer key for an API; Ollama needs none. */
  key?: string;
  timeoutMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum);
  if (len > 0) for (let i = 0; i < v.length; i++) v[i]! /= len;
  return v;
}

/** Cosine similarity of two unit vectors (0 when their sizes differ). */
export function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** Reciprocal rank fusion of ranked id lists: an id high in either list, or in both, comes first. */
export function fuseRanks(lists: number[][], k = 60): number[] {
  const score = new Map<number, number>();
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...score].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
}

/**
 * Errors say only what went wrong in general ("HTTP 500", "timeout", "network error", "bad response"):
 * they end up in the admin view, and the endpoint's own message could carry its URL or key.
 */
export function openAiEmbedder(opts: OpenAiEmbedderOptions): Embedder {
  const url = `${opts.url.replace(/\/+$/, "")}/embeddings`;
  const fetchImpl = opts.fetch ?? fetch;
  return {
    model: opts.model,
    async embed(texts) {
      if (!texts.length) return [];
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
          body: JSON.stringify({ model: opts.model, input: texts }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
      } catch (err) {
        throw new Error((err as Error).name === "TimeoutError" ? "timeout" : "network error");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let json: { data?: Array<{ index?: number; embedding?: unknown }> };
      try {
        json = (await res.json()) as typeof json;
      } catch {
        throw new Error("bad response");
      }
      const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== texts.length || data.some((d) => !Array.isArray(d.embedding) || !d.embedding.length)) throw new Error("bad response");
      return data.map((d) => normalize(Float32Array.from(d.embedding as number[])));
    },
  };
}
