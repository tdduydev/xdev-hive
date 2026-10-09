// A hub account's role (Quản trị › Người dùng, R-72l). Four roles replace the admin / member pair, mapped onto what the hub
// already checks (the `admin` flag, the actor's role and per-project grants) so no role gives more than before:
//   owner  = admin, and the only role that may grant, take away or touch owner;
//   admin  = admin (unrestricted, as `admin: true` always was);
//   member = a person bound by the grants they hold in each project (as `admin: false` always was);
//   viewer = member, capped to reading whatever the grants say (actor role "viewer": a narrowing, never a widening).
export const HUB_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type HubRole = (typeof HUB_ROLES)[number];

export const isHubRole = (v: unknown): v is HubRole => typeof v === "string" && (HUB_ROLES as readonly string[]).includes(v);
/** The roles that are unrestricted hub admins (the `admin` column). */
export const isAdminRole = (r: HubRole): boolean => r === "owner" || r === "admin";

/** Days an account stays in the trash before the hub deletes it for good. */
export const TRASH_DAYS = 30;
export const INVITE_MAX_DAYS = 30;
export const INVITE_DEFAULT_DAYS = 7;

export type InviteState = "pending" | "used" | "expired" | "revoked";

/** A sign-up link as admins see it; the secret itself is shown once, when the link is made. */
export interface HubInvite {
  id: string;
  role: HubRole;
  /** Set when the link is for an account that already exists (a resent invitation): accepting it sets that account's password. */
  username: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  state: InviteState;
}
