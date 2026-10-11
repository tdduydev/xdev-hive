import { request } from "node:http";

export interface ProxyResponse {
  status: number;
  body: string;
}

/** Use an absolute HTTP URL so DNS and destination checks happen in the proxy. */
export function probeProxy(target: string, proxy: { socketPath: string } | { host: string; port: number }) {
  return new Promise<ProxyResponse>((resolve, reject) => {
    const req = request({ ...proxy, path: target, headers: { host: new URL(target).host }, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("Hết thời gian chờ egress proxy.")));
    req.end();
  });
}
