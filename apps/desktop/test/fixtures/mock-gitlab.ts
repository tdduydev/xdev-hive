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
  /** Set by tests: what GET .../merge_requests/:iid answers ("opened" when unset). */
  state?: "opened" | "closed" | "locked" | "merged";
  head_pipeline?: { id: number; status: string; web_url: string } | null;
  /** Set by tests: the MR's head commit (absent when unset). */
  sha?: string;
}

export interface MockJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  allow_failure?: boolean;
  trace: string;
}

export interface MockGitLab {
  base: string;
  mrs: MockMr[];
  /** Jobs by pipeline id. */
  jobs: Record<number, MockJob[]>;
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
    jobs: {},
    calls: [],
    reset() {
      gl.mrs = [];
      gl.jobs = {};
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
    // Group `group` (roadmap 19a): demo and two more, one in a subgroup.
    if (req.method === "GET" && p === "/api/v4/groups/group/projects") {
      const repo = (id: number, full: string) => ({
        id,
        name: full.split("/").at(-1),
        path_with_namespace: full,
        default_branch: "main",
        ssh_url_to_repo: `git@127.0.0.1:${full}.git`,
        http_url_to_repo: `${gl.base}/${full}.git`,
      });
      return send(200, [repo(42, "group/demo"), repo(43, "group/auth-service"), repo(44, "group/payments/gateway")]);
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
    const one = /^\/api\/v4\/projects\/(?:42|group%2Fdemo)\/merge_requests\/(\d+)$/.exec(p);
    if (one && req.method === "GET") {
      const mr = gl.mrs.find((m) => m.iid === Number(one[1]));
      if (!mr) return send(404, { message: "404 Not Found" });
      return send(200, { state: "opened", head_pipeline: null, ...mr });
    }
    const jobs = /^\/api\/v4\/projects\/(?:42|group%2Fdemo)\/pipelines\/(\d+)\/jobs$/.exec(p);
    if (jobs && req.method === "GET") {
      const scope = url.searchParams.getAll("scope[]");
      const list = (gl.jobs[Number(jobs[1])] ?? []).filter((j) => !scope.length || scope.includes(j.status));
      return send(200, list.map(({ trace: _trace, ...j }) => ({ ...j, web_url: `${gl.base}/group/demo/-/jobs/${j.id}` })));
    }
    const trace = /^\/api\/v4\/projects\/(?:42|group%2Fdemo)\/jobs\/(\d+)\/trace$/.exec(p);
    if (trace && req.method === "GET") {
      const job = Object.values(gl.jobs).flat().find((j) => j.id === Number(trace[1]));
      if (!job) return send(404, { message: "404 Not Found" });
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(job.trace);
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
