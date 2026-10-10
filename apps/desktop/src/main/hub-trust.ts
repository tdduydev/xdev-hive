import { HiveError } from "@xdev-hive/core";
import { fetchHubCa, hubFetch, httpsUpgradeUrl, pinHubCa, pinnedHubCa, caFingerprint, type HiveConfig } from "@xdev-hive/core/node";

type Hub = HiveConfig["hub"];

/** Asks the user whether `sha256` is the fingerprint of their hub's CA (shown beside the address). */
export type ConfirmCa = (hubUrl: string, sha256: string) => Promise<boolean>;

/**
 * Makes `hub.url` usable over TLS. A hub whose certificate the system already trusts (a public hostname) needs
 * nothing. One with a CA of its own (the LAN HTTPS port) is pinned: the CA already saved is kept while it still
 * verifies; otherwise the hub's /ca.crt is fetched and the user confirms its fingerprint, once. Returns the hub
 * section to save; refusing leaves the address unusable, never trusted by default.
 */
export async function trustHub(hub: Hub, confirm: ConfirmCa): Promise<Hub> {
  if (!hub.url.startsWith("https:")) return { ...hub, ca: "", caSha256: "" };
  if (hub.ca && hub.caSha256 && caFingerprint(hub.ca) === hub.caSha256) {
    pinHubCa(hub.url, hub.ca, hub.caSha256);
    return hub;
  }
  pinHubCa(hub.url, null);
  try {
    await hubFetch(`${hub.url.replace(/\/+$/, "")}/api/health`, { signal: AbortSignal.timeout(8_000) });
    return { ...hub, ca: "", caSha256: "" };
  } catch {
    // Not trusted by the system: carry on to the hub's own CA.
  }
  const { pem, sha256 } = await fetchHubCa(hub.url);
  if (!(await confirm(hub.url, sha256))) {
    throw new HiveError("bad_request", "The hub's certificate was not confirmed.", { key: "errors.hubCaRefused" });
  }
  pinHubCa(hub.url, pem, sha256);
  return { ...hub, ca: pem, caSha256: sha256 };
}

/**
 * The hub saved as http:// tells on /api/me that it has an HTTPS port: the address to move to, with the CA pinned
 * (the user confirms it when the system does not trust it already), and the token unchanged. null: nothing to do.
 */
export async function upgradeHubToHttps(hub: Hub, confirm: ConfirmCa): Promise<Hub | null> {
  if (!hub.url.startsWith("http:") || !hub.token) return null;
  let res: Response;
  try {
    res = await hubFetch(`${hub.url.replace(/\/+$/, "")}/api/me`, { headers: { authorization: `Bearer ${hub.token}`, "x-hive-agent": "desktop" }, signal: AbortSignal.timeout(8_000) });
  } catch {
    return null;
  }
  const target = httpsUpgradeUrl(hub.url, res.headers.get("x-hive-lan-https-port"));
  if (!target) return null;
  const trusted = await trustHub({ ...hub, url: target, ca: "", caSha256: "" }, confirm);
  // The token must work on the new address before the old one is given up (another hub on that port, a proxy that drops it).
  const check = await hubFetch(`${target}/api/me`, { headers: { authorization: `Bearer ${hub.token}`, "x-hive-agent": "desktop" }, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!check?.ok) {
    pinHubCa(target, null);
    return null;
  }
  return trusted;
}

export { pinnedHubCa };
