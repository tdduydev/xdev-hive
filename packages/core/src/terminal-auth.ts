// Remote terminal, the person's side of 69c: what a step-up binds to and what the browser socket's first frame
// carries. Browser-safe, so the terminal page (69f) builds the same requests the hub checks.
import { z } from "zod";
import { PROJECT_NAME } from "./keys.ts";
import { terminalSessionId } from "./terminal.ts";

/** The operations a fresh proof unlocks; everything else (list, get, terminate) needs none, so a stop never waits on one. */
export const TERMINAL_STEPUP_OPERATIONS = ["create", "attach", "recording"] as const;
export type TerminalStepUpOperation = (typeof TERMINAL_STEPUP_OPERATIONS)[number];
export const TERMINAL_STEPUP_METHODS = ["password", "oidc"] as const;
export type TerminalStepUpMethod = (typeof TERMINAL_STEPUP_METHODS)[number];

export const TERMINAL_STEPUP_PATH = "/api/terminal/step-up";
export const TERMINAL_SOCKET_PATH = "/api/terminal/socket";
export const TERMINAL_MACHINE_SOCKET_PATH = "/api/terminal/machine-socket";

/**
 * Prefixed like the hub's other secrets, so the secret filter (secrets.ts) hides one that lands in a log or a memory.
 * 32 random bytes in base64url after the prefix.
 */
export const TERMINAL_STEPUP_PREFIX = "hivestep_";
export const TERMINAL_TICKET_PREFIX = "hivetkt_";
export const terminalStepUpId = z.string().regex(/^hivestep_[A-Za-z0-9_-]{43}$/);
export const terminalTicket = z.string().regex(/^hivetkt_[A-Za-z0-9_-]{43}$/);

/**
 * POST /api/terminal/step-up. The proof binds to the operation and its target: machine and project for create, the
 * session too for attach and recording. A password never travels anywhere else and is never stored.
 */
export const terminalStepUpInput = z
  .strictObject({
    method: z.enum(TERMINAL_STEPUP_METHODS),
    operation: z.enum(TERMINAL_STEPUP_OPERATIONS),
    project: z.string().regex(PROJECT_NAME),
    machineId: z.string().min(1).max(200),
    sessionId: terminalSessionId.optional(),
    password: z.string().min(1).max(1024).optional(),
    /** Where the provider sends the person back (oidc): a path on the hub. */
    returnTo: z.string().max(1000).optional(),
  })
  .refine((s) => (s.operation === "create") === (s.sessionId === undefined), "sessionId is for attach and recording, and only them")
  .refine((s) => (s.method === "password") === (s.password !== undefined), "password goes with method password, and only it");
export type TerminalStepUpInput = z.output<typeof terminalStepUpInput>;

/** What the step-up answers: the proof id to send as stepUpId, or (oidc) where to reauthenticate first. */
export type TerminalStepUpResult =
  | { method: "password"; stepUpId: string; expiresAt: string }
  /** The id works only after the provider confirmed a fresh sign-in and sent the browser back. */
  | { method: "oidc"; stepUpId: string; url: string };

/** The browser socket's first frame, within TERMINAL_LIMITS.firstFrameMs. Never the query string, never a header. */
export const terminalAuthFrameSchema = z.strictObject({ type: z.literal("auth"), ticket: terminalTicket });

/**
 * Close codes of the browser socket before any terminal byte flows. 4401: the ticket is gone (expired, used, another
 * browser), get a new one through terminal.attach; 4403: the person may not use this session now; 4408: no ticket in
 * time; 1013: the hub has no relay yet (69e).
 */
export const TERMINAL_CLOSE = { ticket: 4401, denied: 4403, timeout: 4408, protocol: 1002, unavailable: 1013 } as const;
