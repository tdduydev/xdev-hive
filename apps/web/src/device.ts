// Signing the desktop app in through the browser (RFC 8252, loopback redirect): the app listens on
// 127.0.0.1, the person allows it on the hub's page, the hub sends a one-time code to that address,
// and the app trades it with its PKCE verifier for a machine token. Only the app that started holds
// the verifier, and the code only ever goes to a loopback address.
import { createHash, randomBytes } from "node:crypto";

interface Grant {
  userId: string;
  challenge: string;
  name: string;
  expires: number;
}

/** A code is good for this long, once. */
const CODE_MS = 2 * 60_000;
const MAX_GRANTS = 1000;

export const DEVICE_STATE = /^[\w-]{16,128}$/;
/** base64url of a SHA-256 digest. */
export const DEVICE_CHALLENGE = /^[\w-]{43}$/;

export class DeviceGrants {
  readonly #grants = new Map<string, Grant>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(grant: Omit<Grant, "expires">): string {
    const now = this.#now();
    for (const [k, g] of this.#grants) if (g.expires < now) this.#grants.delete(k);
    if (this.#grants.size >= MAX_GRANTS) this.#grants.delete(this.#grants.keys().next().value!);
    const code = randomBytes(32).toString("base64url");
    this.#grants.set(code, { ...grant, expires: now + CODE_MS });
    return code;
  }

  /** The account and machine name behind a code whose verifier matches; null otherwise. Each code works once. */
  redeem(code: string, verifier: string): { userId: string; name: string } | null {
    const grant = this.#grants.get(code);
    this.#grants.delete(code);
    if (!grant || grant.expires < this.#now()) return null;
    if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return null;
    return { userId: grant.userId, name: grant.name };
  }
}

/** The one place a code is sent: this machine's loopback address. */
export function loopbackCallback(port: number, params: Record<string, string>): string {
  return `http://127.0.0.1:${port}/callback?${new URLSearchParams(params).toString()}`;
}
