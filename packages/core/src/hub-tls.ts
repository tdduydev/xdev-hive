import { X509Certificate, createHash } from "node:crypto";
import https from "node:https";
import { HiveError } from "./errors.ts";
import { useHubFetch } from "./hub-client.ts";

// A hub on the LAN answers over HTTPS with a certificate of its own CA (deploy/Caddyfile.lan). A machine pins that CA
// instead of the system trusting it: the CA is kept in config.json (hub.ca) with its SHA-256 (hub.caSha256), which
// the user confirmed when the machine was paired. Only requests to that hub use it (Node's fetch takes no `ca`, so
// those go through node:https); certificate checking is never switched off.

const pinned = new Map<string, string>();

/** host:port of a URL: what a pin is for (two hubs on one host but different ports are different hubs). */
const originOf = (url: string): string => new URL(url).origin;

/** Lowercase hex SHA-256 of the certificate's DER bytes: what `openssl x509 -fingerprint -sha256` prints, without colons. */
export function caFingerprint(pem: string): string {
  return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
}

/** Reads a fingerprint typed or pasted in any common form (colons, spaces, upper case); null when it is not a SHA-256. */
export function normalizeFingerprint(text: string): string | null {
  const hex = text.replace(/^sha-?256[:= ]*/i, "").replace(/[\s:]/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** "AB:CD:…" for showing to the user, in the form openssl and browsers print. */
export const displayFingerprint = (hex: string): string => (hex.toUpperCase().match(/../g) ?? []).join(":");

/**
 * Pins `pem` for the hub at `url`; null (or an empty string) clears it. The pem must match `sha256` when that is given:
 * a config.json whose certificate and fingerprint disagree trusts nothing rather than the wrong CA.
 */
export function pinHubCa(url: string, pem: string | null | undefined, sha256?: string): void {
  let origin: string;
  try {
    origin = originOf(url);
  } catch {
    return;
  }
  if (!pem) {
    pinned.delete(origin);
    return;
  }
  if (sha256 && caFingerprint(pem) !== sha256) return;
  pinned.set(origin, pem);
}

export const pinnedHubCa = (url: string): string | undefined => {
  try {
    return pinned.get(originOf(url));
  } catch {
    return undefined;
  }
};

/** What config.json's hub section says, applied: every other pin is dropped. */
export function applyHubTls(hub: { url: string; ca?: string; caSha256?: string }): void {
  pinned.clear();
  if (hub.url.startsWith("https:") && hub.ca) pinHubCa(hub.url, hub.ca, hub.caSha256);
}

/** fetch for the hub: with its pinned CA when it has one, else the plain fetch. */
export const hubFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const ca = pinnedHubCa(url);
  if (!ca) return fetch(input, init);
  return httpsRequest(url, init ?? {}, { ca });
}) as typeof fetch;

function httpsRequest(url: string, init: RequestInit, tls: { ca?: string; rejectUnauthorized?: boolean }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body == null ? undefined : typeof init.body === "string" ? Buffer.from(init.body) : Buffer.from(new Uint8Array(init.body as ArrayBuffer));
    if (body && headers["content-length"] === undefined) headers["content-length"] = String(body.length);
    const req = https.request(url, { method: init.method ?? "GET", headers, ...tls }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, one);
        const status = res.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)), { status, statusText: res.statusMessage, headers: out }));
      });
    });
    req.on("error", reject);
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) req.destroy(signal.reason);
      else signal.addEventListener("abort", () => req.destroy(signal.reason as Error), { once: true });
    }
    req.end(body);
  });
}

/**
 * The hub's root CA as it serves it at /ca.crt, for the user to compare and confirm. This one request does not
 * verify the server (there is nothing to verify against yet); the certificate is public, and nothing is trusted
 * until the user accepts its fingerprint and it is pinned.
 */
export async function fetchHubCa(httpsUrl: string, timeoutMs = 10_000): Promise<{ pem: string; sha256: string }> {
  let res: Response;
  try {
    res = await httpsRequest(new URL("/ca.crt", httpsUrl).href, { signal: AbortSignal.timeout(timeoutMs) }, { rejectUnauthorized: false });
  } catch (err) {
    const reason = (err as { code?: string; message?: string }).code ?? (err instanceof Error ? err.message : String(err));
    throw new HiveError("unavailable", `Cannot reach the hub ${httpsUrl}: ${reason}`, { key: "errors.hubUnreachable", vars: { reason } });
  }
  const pem = await res.text();
  try {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { pem: pem.trim() + "\n", sha256: caFingerprint(pem) };
  } catch {
    throw new HiveError("bad_request", "The hub does not serve a CA certificate at /ca.crt.", { key: "errors.hubNoCa" });
  }
}

/**
 * Where a machine saved with http:// should go, from the hub's answer on /api/me (x-hive-lan-https-port): the same
 * host on the HTTPS port. null when the hub did not say, the address is already https, or it is not a LAN-style
 * address (a public hostname behind a real certificate has no use for this).
 */
export function httpsUpgradeUrl(savedUrl: string, lanHttpsPort: string | null | undefined): string | null {
  if (!lanHttpsPort || !/^\d{2,5}$/.test(lanHttpsPort)) return null;
  let u: URL;
  try {
    u = new URL(savedUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:") return null;
  u.protocol = "https:";
  u.port = lanHttpsPort;
  return u.origin;
}

// hub-client.ts stays free of Node built-ins (the interface's build reaches it); loading this module is what gives it the pins.
useHubFetch(hubFetch);
