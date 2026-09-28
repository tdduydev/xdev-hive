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
}

export interface MockGitHub {
  base: string;
  pulls: MockPull[];
  /** Plays a plan without draft pull requests (private repositories on GitHub Free). */
  noDrafts: boolean;
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
    calls: [],
    reset() {
      gh.pulls = [];
      gh.noDrafts = false;
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
