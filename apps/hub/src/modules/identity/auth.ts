import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import type pg from "pg";

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface AuthOptions {
  /** Pool của role hive_auth; search_path của role trỏ vào schema auth. */
  pool: pg.Pool;
  baseURL: string;
  secret: string;
  trustedOrigins?: string[];
  github?: OAuthApp | undefined;
  gitlab?: (OAuthApp & { issuer?: string | undefined }) | undefined;
  /** Cho tự đăng ký bằng email. Tắt mặc định: người mới vào bằng lời mời (M1c) hoặc SSO. */
  allowEmailSignUp?: boolean;
}

export function authConfig(o: AuthOptions) {
  return {
    database: o.pool,
    baseURL: o.baseURL,
    basePath: "/api/auth",
    secret: o.secret,
    trustedOrigins: o.trustedOrigins ?? [],
    emailAndPassword: { enabled: true, disableSignUp: !o.allowEmailSignUp, minPasswordLength: 10 },
    socialProviders: {
      ...(o.github ? { github: { clientId: o.github.clientId, clientSecret: o.github.clientSecret } } : {}),
      ...(o.gitlab
        ? { gitlab: { clientId: o.gitlab.clientId, clientSecret: o.gitlab.clientSecret, issuer: o.gitlab.issuer } }
        : {}),
    },
    plugins: [sso()],
    telemetry: { enabled: false },
  } satisfies Parameters<typeof betterAuth>[0];
}

export function createAuth(o: AuthOptions) {
  return betterAuth(authConfig(o));
}
export type Auth = ReturnType<typeof createAuth>;
