import { createServer } from "node:http";
import { t } from "@/lib/i18n.ts";
import "@/auth/strings.ts";

export async function listen(state: string, timeoutMs = 300_000) {
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  let finished = false;
  const code = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Trình duyệt có thể lỗi trước khi bên gọi bắt đầu chờ callback.
  void code.catch(() => {});
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (finished) {
      response.writeHead(410).end();
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400).end(t("auth.state"));
      return;
    }
    const value = url.searchParams.get("code");
    const error = url.searchParams.has("error") || !value;
    response.writeHead(error ? 400 : 200).end(t(error ? "auth.cancelled" : "auth.done"));
    finish(error ? new Error(t("auth.cancelled")) : undefined, value ?? undefined);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", no);
      yes();
    });
  });
  const timer = setTimeout(() => finish(new Error(t("auth.timeout"))), timeoutMs);
  function finish(error?: Error, value?: string) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    if (error) reject(error);
    else resolve(value ?? "");
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error(t("auth.failed"));
  return { port: address.port, code, dispose: () => finish(new Error(t("auth.cancelled"))) };
}
