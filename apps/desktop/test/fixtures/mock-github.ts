// Tiny stand-in for GitHub Enterprise Server's REST v3 and GraphQL: only what xDev Hive uses. Test/smoke use only.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockPull {
  number: number;
  html_url: string;
  node_id: string;
  title: string;
  body: string;
  draft: boolean;
  head: { ref: string };
  base: { ref: string };
  labels: string[];
  /** Set by tests: what GET .../pulls/:n answers ("open", not merged, sha "c0ffee" when unset). */
  state?: "open" | "closed";
  merged?: boolean;
  sha?: string;
}

export interface MockCheck {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  app?: { slug: string; name: string };
  output?: { title: string | null; summary: string | null; text: string | null };
  /** An Actions job's log, served through a redirect like GitHub's. */
  log?: string;
}

export interface MockGitHub {
  base: string;
  pulls: MockPull[];
  /** Plays a plan without draft pull requests (private repositories on GitHub Free). */
  noDrafts: boolean;
  /** Check runs and commit statuses by commit sha. */
  checks: Record<string, MockCheck[]>;
  statuses: Record<string, Array<{ id?: number; context: string; state: string; description?: string }>>;
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

/** Serves repository `duy/demo` (default branch main) to requests carrying `Bearer <token>`. */
export async function startMockGitHub(token: string): Promise<MockGitHub> {
  const gh: MockGitHub = {
    base: "",
    pulls: [],
    noDrafts: false,
    checks: {},
    statuses: {},
    calls: [],
    reset() {
      gh.pulls = [];
      gh.noDrafts = false;
      gh.checks = {};
      gh.statuses = {};
      gh.calls = [];
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url!, "http://mock");
    gh.calls.push({ method: req.method!, path: url.pathname + url.search, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    // Where a job log redirects to: a short-lived download that needs no token.
    const blob = /^\/logs\/(\d+)$/.exec(url.pathname);
    if (blob) {
      const check = Object.values(gh.checks).flat().find((c) => c.id === Number(blob[1]));
      res.writeHead(check?.log === undefined ? 404 : 200, { "content-type": "text/plain" });
      return res.end(check?.log ?? "");
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Bad credentials" });
    const p = url.pathname;
    if (req.method === "GET" && p === "/api/v3/user") return send(200, { login: "duy", name: "Duy" });
    if (req.method === "GET" && p === "/api/v3/repos/duy/demo") {
      return send(200, { full_name: "duy/demo", default_branch: "main", owner: { login: "duy" }, html_url: `${gh.base}/duy/demo` });
    }
    if (p === "/api/v3/repos/duy/demo/pulls" && req.method === "GET") {
      const head = url.searchParams.get("head") ?? "";
      return send(200, gh.pulls.filter((x) => `duy:${x.head.ref}` === head));
    }
    if (p === "/api/v3/repos/duy/demo/pulls" && req.method === "POST") {
      if (body.draft && gh.noDrafts) {
        return send(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "Draft pull requests are not supported in this repository." }] });
      }
      const number = gh.pulls.length + 1;
      const pr: MockPull = {
        number,
        html_url: `${gh.base}/duy/demo/pull/${number}`,
        node_id: `PR_${number}`,
        title: body.title,
        body: body.body,
        draft: Boolean(body.draft),
        head: { ref: body.head },
        base: { ref: body.base },
        labels: [],
      };
      gh.pulls.push(pr);
      return send(201, pr);
    }
    const one = /^\/api\/v3\/repos\/duy\/demo\/pulls\/(\d+)$/.exec(p);
    if (one && req.method === "GET") {
      const pr = gh.pulls.find((x) => x.number === Number(one[1]));
      if (!pr) return send(404, { message: "Not Found" });
      const { sha = "c0ffee", ...rest } = pr;
      return send(200, { state: "open", merged: false, ...rest, head: { ...pr.head, sha } });
    }
    const runs = /^\/api\/v3\/repos\/duy\/demo\/commits\/(\w+)\/check-runs$/.exec(p);
    if (runs && req.method === "GET") {
      const list = gh.checks[runs[1]!] ?? [];
      return send(200, { total_count: list.length, check_runs: list.map((c, i) => ({ ...c, html_url: `${gh.base}/duy/demo/runs/${i + 1}` })) });
    }
    const status = /^\/api\/v3\/repos\/duy\/demo\/commits\/(\w+)\/status$/.exec(p);
    if (status && req.method === "GET") {
      const list = gh.statuses[status[1]!] ?? [];
      return send(200, { state: "pending", total_count: list.length, statuses: list.map((s) => ({ description: null, ...s, target_url: null })) });
    }
    const jobLog = /^\/api\/v3\/repos\/duy\/demo\/actions\/jobs\/(\d+)\/logs$/.exec(p);
    if (jobLog && req.method === "GET") {
      res.writeHead(302, { location: `${gh.base}/logs/${jobLog[1]}` });
      return res.end();
    }
    if (one && req.method === "PATCH") {
      const pr = gh.pulls.find((x) => x.number === Number(one[1]));
      if (!pr) return send(404, { message: "Not Found" });
      Object.assign(pr, body);
      return send(200, pr);
    }
    const labels = /^\/api\/v3\/repos\/duy\/demo\/issues\/(\d+)\/labels$/.exec(p);
    if (labels && req.method === "POST") {
      const pr = gh.pulls.find((x) => x.number === Number(labels[1]));
      if (!pr) return send(404, { message: "Not Found" });
      pr.labels = [...new Set([...pr.labels, ...body.labels])];
      return send(200, pr.labels.map((name) => ({ name })));
    }
    if (p === "/api/graphql" && req.method === "POST") {
      const pr = gh.pulls.find((x) => x.node_id === body.variables?.id);
      if (!pr) return send(200, { errors: [{ message: "Could not resolve to a node" }] });
      pr.draft = String(body.query).includes("convertPullRequestToDraft");
      return send(200, { data: { pr: { pullRequest: { isDraft: pr.draft } } } });
    }
    send(404, { message: "Not Found" });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  gh.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return gh;
}
