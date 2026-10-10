// Spec 79a: only a person signed in on the hub's page administers it, so the tests' "admin" is a session, not a token.
import type { UserStore } from "#web/users.ts";

const PREFIX = "session:";

/**
 * A hub admin account with a live browser session; the result goes where a test passes a credential, and authHeaders
 * turns it into the cookie and CSRF header the page sends.
 */
export function adminSession(users: UserStore, username = "root"): string {
  const existing = users.list().find((u) => u.username === username);
  const user = existing ?? users.create({ username, admin: true, password: "Correct-horse-79a!", mustChange: false }).user;
  return `${PREFIX}${users.startSession(user.id).token}`;
}

export const isSession = (credential: string): boolean => credential.startsWith(PREFIX);

/** The headers of a call: a session's cookie and the page's CSRF header, or a bearer token. */
export function authHeaders(credential: string): Record<string, string> {
  return isSession(credential)
    ? { cookie: `hive_session=${encodeURIComponent(credential.slice(PREFIX.length))}`, "x-hive-csrf": "1" }
    : { authorization: `Bearer ${credential}` };
}
