export type HiveErrorCode = "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict";

/**
 * A message key of the UI catalogue ("errors.…", see packages/ui/src/i18n) with its placeholders.
 * Errors that reach a person carry one, so the interface shows them in that person's language;
 * `message` stays the text for agents (MCP), logs and older clients.
 */
export interface ErrorText {
  key: string;
  vars?: Record<string, string | number>;
}

export class HiveError extends Error {
  readonly code: HiveErrorCode;
  readonly key?: string;
  readonly vars?: Record<string, string | number>;

  constructor(code: HiveErrorCode, message: string, text?: ErrorText) {
    super(message);
    this.name = "HiveError";
    this.code = code;
    if (text) {
      this.key = text.key;
      if (text.vars) this.vars = text.vars;
    }
  }
}

export const HTTP_STATUS: Record<HiveErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

export interface ErrorPayload extends Partial<ErrorText> {
  code: HiveErrorCode | "internal";
  message: string;
}

export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof HiveError) {
    return { code: err.code, message: err.message, ...(err.key ? { key: err.key } : {}), ...(err.vars ? { vars: err.vars } : {}) };
  }
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}
