export type HiveErrorCode = "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict";

export class HiveError extends Error {
  readonly code: HiveErrorCode;

  constructor(code: HiveErrorCode, message: string) {
    super(message);
    this.name = "HiveError";
    this.code = code;
  }
}

export const HTTP_STATUS: Record<HiveErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

export function toErrorPayload(err: unknown): { code: HiveErrorCode | "internal"; message: string } {
  if (err instanceof HiveError) return { code: err.code, message: err.message };
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}
