// The only way out of a run's container network: an HTTP proxy that lets through the hosts in
// HIVE_EGRESS_ALLOW and nothing else. HTTPS goes through CONNECT (the proxy never sees inside it);
// plain HTTP is forwarded. Every refusal is logged as "denied <host>:<port>" for the run's log.
//   HIVE_EGRESS_ALLOW="api.anthropic.com,.openai.com,hive.example.com:8443" node egress.mjs
// An entry that starts with "." allows the domain and its subdomains; "host:port" allows that port only,
// any other entry ports 80 and 443. Listens on HIVE_EGRESS_PORT (3128). No dependencies.
import { createServer, request } from "node:http";
import { connect } from "node:net";

const entries = (process.env.HIVE_EGRESS_ALLOW ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)
  .map((e) => {
    const m = /^(.*?)(?::(\d+))?$/.exec(e);
    return { host: m[1], port: m[2] ? Number(m[2]) : null };
  });

export function allowed(host, port) {
  const h = String(host).toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return entries.some((e) => {
    const nameOk = e.host.startsWith(".") ? h === e.host.slice(1) || h.endsWith(e.host) : h === e.host;
    return nameOk && (e.port === null ? port === 443 || port === 80 : port === e.port);
  });
}

const deny = (where, why = "denied") => console.log(`${why} ${where}`);

const server = createServer((req, res) => {
  // A peer that resets must not take the proxy down with it.
  req.on("error", () => undefined);
  res.on("error", () => undefined);
  // Absolute-form request of plain HTTP: http://host[:port]/path
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const port = Number(url.port || 80);
  if (url.protocol !== "http:" || !allowed(url.hostname, port)) {
    deny(`${url.hostname}:${port}`);
    res.writeHead(403, { "content-type": "text/plain" }).end(`xDev Hive: ${url.hostname} is not allowed from this run\n`);
    return;
  }
  const out = request({ host: url.hostname, port, method: req.method, path: `${url.pathname}${url.search}`, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  out.on("error", () => res.writeHead(502).end());
  req.pipe(out);
});

server.on("clientError", (_err, socket) => socket.destroy());

server.on("connect", (req, client, head) => {
  // Before anything else: a client that resets (a refused one often does) must not crash the proxy.
  client.on("error", () => client.destroy());
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? "");
  const host = m?.[1] ?? "";
  const port = Number(m?.[2] ?? 0);
  if (!m || !allowed(host, port)) {
    deny(`${host || req.url}:${port}`);
    client.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nxDev Hive: this host is not allowed from this run\n");
    return;
  }
  const upstream = connect(port, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => {
    if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
});

if (process.env.HIVE_EGRESS_NO_LISTEN !== "1") {
  const port = Number(process.env.HIVE_EGRESS_PORT ?? 3128);
  server.listen(port, "0.0.0.0", () => console.log(`egress proxy on ${port}, ${entries.length} allowed`));
}
export { server };
