import { describe, expect, it } from "vitest";
import { createOpenAIEmbedder, EmbedderError, vectorLiteral } from "./embedder.ts";
import { orQuery } from "./memory.ts";

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("createOpenAIEmbedder", () => {
  it("gửi đúng định dạng OpenAI và sắp vector theo index", async () => {
    const { fn, calls } = fakeFetch(200, {
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    });
    const e = createOpenAIEmbedder(
      { url: "https://api.example.com/v1", apiKey: "khoa", model: "m", dimensions: 2 },
      fn,
    );
    expect(await e.embed(["a", "b"])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(e.model).toBe("m@2");
    expect(calls[0]?.url).toBe("https://api.example.com/v1/embeddings");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer khoa");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "m",
      input: ["a", "b"],
      encoding_format: "float",
      dimensions: 2,
    });
  });

  it("không có khoá thì không gửi Authorization, không gửi dimensions", async () => {
    const { fn, calls } = fakeFetch(200, { data: [{ index: 0, embedding: [1] }] });
    const e = createOpenAIEmbedder({ url: "http://ollama:11434/v1", model: "nomic-embed-text" }, fn);
    await e.embed(["x"]);
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init.body)).dimensions).toBeUndefined();
    expect(e.model).toBe("nomic-embed-text");
  });

  it("lỗi HTTP không lộ nội dung phản hồi", async () => {
    const { fn } = fakeFetch(401, { error: { message: "Incorrect API key provided: sk-bi-mat" } });
    const e = createOpenAIEmbedder({ url: "https://api.example.com/v1", apiKey: "sk-bi-mat", model: "m" }, fn);
    const error = await e.embed(["x"]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(EmbedderError);
    expect(String((error as Error).message)).not.toContain("sk-bi-mat");
  });

  it("từ chối phản hồi sai số lượng hoặc vector hỏng", async () => {
    const short = createOpenAIEmbedder({ url: "u", model: "m" }, fakeFetch(200, { data: [] }).fn);
    await expect(short.embed(["x"])).rejects.toThrow(/số lượng/);
    const bad = createOpenAIEmbedder({ url: "u", model: "m" }, fakeFetch(200, { data: [{ embedding: ["a"] }] }).fn);
    await expect(bad.embed(["x"])).rejects.toThrow(/không hợp lệ/);
  });

  it("vectorLiteral ra dạng chữ của pgvector", () => expect(vectorLiteral([1, -0.5, 2e-3])).toBe("[1,-0.5,0.002]"));
});

describe("orQuery", () => {
  it("OR các từ, có tiền tố, chữ thường, bỏ trùng và ký tự đặc biệt", () =>
    expect(orQuery("Hàng đợi: hàng 'đợi' & pg-boss!")).toBe("'hàng':* | 'đợi':* | 'pg':* | 'boss':*"));
  it("chuẩn hoá NFD về NFC", () => expect(orQuery("đợi".normalize("NFD"))).toBe(`'${"đợi".normalize("NFC")}':*`));
  it("không có chữ thì null", () => expect(orQuery("!!! ...")).toBeNull());
});
