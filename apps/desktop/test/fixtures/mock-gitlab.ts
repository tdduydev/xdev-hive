// Tiny stand-in for GitLab's REST v4: only the endpoints xDev Hive uses. Test/smoke use only.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockMr {
  iid: number;
  web_url: string;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  labels?: string;
  add_labels?: string;
  remove_source_branch?: boolean;
}

export interface MockGitLab {
  base: string;
  mrs: MockMr[];
  calls: Array<{ method: string; path: string; body: any }>;
  reset(): void;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

/** Serves project `group/demo` (id 42, default branch main) to requests carrying `token`. */
export async function startMockGitLab(token: string): Promise<MockGitLab> {
  const gl: MockGitLab = {
    base: "",
    mrs: [],
    calls: [],
    reset() {
      gl.mrs = [];
      gl.calls = [];
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url!, "http://mock");
    gl.calls.push({ method: req.method!, path: url.pathname, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.headers["private-token"] !== token) return send(401, { message: "401 Unauthorized" });
    const p = url.pathname;
    if (req.method === "GET" && p === "/api/v4/user") return send(200, { username: "duy", name: "Duy" });
    if (req.method === "GET" && p === "/api/v4/projects/group%2Fdemo") {
      return send(200, { id: 42, path_with_namespace: "group/demo", default_branch: "main", web_url: `${gl.base}/group/demo` });
    }
    if (p === "/api/v4/projects/42/merge_requests" && req.method === "GET") {
      return send(200, gl.mrs.filter((m) => m.source_branch === url.searchParams.get("source_branch")));
    }
    if (p === "/api/v4/projects/42/merge_requests" && req.method === "POST") {
      const iid = gl.mrs.length + 1;
      const mr = { ...body, iid, web_url: `${gl.base}/group/demo/-/merge_requests/${iid}` };
      gl.mrs.push(mr);
      return send(201, mr);
    }
    const put = /^\/api\/v4\/projects\/42\/merge_requests\/(\d+)$/.exec(p);
    if (put && req.method === "PUT") {
      const mr = gl.mrs.find((m) => m.iid === Number(put[1]));
      if (!mr) return send(404, { message: "404 Not Found" });
      Object.assign(mr, body);
      return send(200, mr);
    }
    send(404, { message: "404 Not Found" });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  gl.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return gl;
}
