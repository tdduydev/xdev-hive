import { randomBytes } from "node:crypto";

export function createCsp(cspSource: string): { nonce: string; policy: string } {
  const nonce = randomBytes(24).toString("base64");
  return {
    nonce,
    policy: [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' ${cspSource}`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `img-src ${cspSource} data: blob:`,
      `font-src ${cspSource}`,
      "connect-src 'none'",
      "frame-src 'none'",
    ].join("; "),
  };
}
