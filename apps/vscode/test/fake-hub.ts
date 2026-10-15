import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ContractRouterClient } from "@orpc/contract";
import { type Contract, contract } from "@xdev-hive/contracts";

type Routes<T> = {
  [K in keyof T]?: T[K] extends (...args: infer A) => infer R
    ? (input: A[0], request: Request) => Awaited<R> | Promise<Awaited<R>>
    : Routes<T[K]>;
};
export type FakeRoutes = Routes<ContractRouterClient<Contract>>;
export interface FakeHubOptions {
  rpc?: FakeRoutes;
  token?: string;
  stream?: (runId: string, request: Request) => Response | Promise<Response>;
  exchange?: (body: unknown) => unknown | Promise<unknown>;
}

/** Cùng envelope và schema oRPC với hub; route thiếu báo lỗi để test không vô tình nhận dữ liệu giả. */
export function createFakeHub(options: FakeHubOptions = {}) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/health") return Response.json({ ok: true });
    if (url.pathname === "/api/v1/desktop/connect/exchange" && options.exchange) {
      return Response.json(await options.exchange(await request.json()));
    }
    if (options.token && request.headers.get("authorization") !== `Bearer ${options.token}`) {
      return Response.json({ message: "Chưa đăng nhập." }, { status: 401 });
    }
    const stream = /^\/api\/v1\/runs\/([^/]+)\/stream$/.exec(url.pathname);
    if (stream?.[1] && options.stream) return options.stream(decodeURIComponent(stream[1]), request);
    if (!url.pathname.startsWith("/rpc/")) return new Response(null, { status: 404 });
    const path = url.pathname.slice(5).split("/");
    let route: unknown = options.rpc;
    let procedure: unknown = contract;
    for (const key of path) {
      route = (route as Record<string, unknown> | undefined)?.[key];
      procedure = (procedure as Record<string, unknown> | undefined)?.[key];
    }
    if (typeof route !== "function" || !procedure) return new Response(null, { status: 404 });
    const envelope = request.method === "GET" ? JSON.parse(url.searchParams.get("data") ?? "{}") : await request.json();
    const definition = (
      procedure as {
        "~orpc": {
          inputSchema?: { parseAsync(input: unknown): Promise<unknown> };
          outputSchema?: { parseAsync(input: unknown): Promise<unknown> };
        };
      }
    )["~orpc"];
    const value = definition.inputSchema ? await definition.inputSchema.parseAsync(envelope.json) : envelope.json;
    const output = await route(value, request);
    return Response.json({ json: definition.outputSchema ? await definition.outputSchema.parseAsync(output) : output });
  };
  return {
    fetch,
    requests,
    async listen() {
      const server = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const response = await fetch(`http://127.0.0.1${req.url}`, {
            method: req.method ?? "GET",
            headers: req.headers as Record<string, string>,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          });
          res.writeHead(response.status, Object.fromEntries(response.headers));
          if (response.body) {
            for await (const chunk of response.body) res.write(chunk);
          }
          res.end();
        } catch {
          res.writeHead(500);
          res.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      };
    },
  };
}
