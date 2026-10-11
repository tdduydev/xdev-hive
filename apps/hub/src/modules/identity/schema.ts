// Bảng của Better Auth, giữ đúng tên bảng và cột (camelCase) mà Better Auth dùng mặc định.
// Test identity.db.test.ts so với getSchema() của Better Auth để bắt lệch khi nâng cấp.
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const auth = pgSchema("auth");
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const user = auth.table("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: ts("createdAt").notNull().defaultNow(),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

export const session = auth.table("session", {
  id: text("id").primaryKey(),
  expiresAt: ts("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: ts("createdAt").notNull().defaultNow(),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = auth.table("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: ts("accessTokenExpiresAt"),
  refreshTokenExpiresAt: ts("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: ts("createdAt").notNull().defaultNow(),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

export const verification = auth.table("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expiresAt").notNull(),
  createdAt: ts("createdAt").notNull().defaultNow(),
  updatedAt: ts("updatedAt").notNull().defaultNow(),
});

export const ssoProvider = auth.table(
  "ssoProvider",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    oidcConfig: text("oidcConfig"),
    samlConfig: text("samlConfig"),
    userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
    providerId: text("providerId").notNull().unique(),
    organizationId: text("organizationId"),
    domain: text("domain").notNull(),
    // Hub tự khai cột này (plugin chỉ khai khi bật domainVerification, xem auth.ts).
    domainVerified: boolean("domainVerified").notNull().default(false),
  },
  // Plugin tìm nhà cung cấp theo tên miền của email: hai tổ chức cùng khai một tên miền thì người của tổ chức này có
  // thể bị chuyển sang IdP của tổ chức kia.
  (t) => [uniqueIndex("ssoProvider_domain_uidx").on(sql`lower(${t.domain})`)],
);

// Bảng của plugin jwt, oauth-provider (qua mcp) và cimd: hub làm authorization server OAuth 2.1 cho client MCP.
// Mảng chuỗi lưu jsonb vì Better Auth dùng jsonb cho kiểu string[] trên Postgres.

export const jwks = auth.table("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: ts("createdAt").notNull(),
  expiresAt: ts("expiresAt"),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = auth.table(
  "oauthClient",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId").notNull().unique(),
    clientSecret: text("clientSecret"),
    clientDiscoveryId: text("clientDiscoveryId"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skipConsent"),
    enableEndSession: boolean("enableEndSession"),
    subjectType: text("subjectType"),
    scopes: jsonb("scopes").$type<string[]>(),
    clientCredentialsScopes: jsonb("clientCredentialsScopes").$type<string[]>().default([]),
    userId: text("userId").references(() => user.id),
    createdAt: ts("createdAt"),
    updatedAt: ts("updatedAt"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: jsonb("contacts").$type<string[]>(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("softwareId"),
    softwareVersion: text("softwareVersion"),
    softwareStatement: text("softwareStatement"),
    redirectUris: jsonb("redirectUris").$type<string[]>().notNull(),
    postLogoutRedirectUris: jsonb("postLogoutRedirectUris").$type<string[]>(),
    backchannelLogoutUri: text("backchannelLogoutUri"),
    backchannelLogoutSessionRequired: boolean("backchannelLogoutSessionRequired"),
    tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
    applicationType: text("applicationType"),
    jwks: text("jwks"),
    jwksUri: text("jwksUri"),
    grantTypes: jsonb("grantTypes").$type<string[]>(),
    responseTypes: jsonb("responseTypes").$type<string[]>(),
    requirePKCE: boolean("requirePKCE"),
    dpopBoundAccessTokens: boolean("dpopBoundAccessTokens").default(false),
    referenceId: text("referenceId"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauthClient_userId_idx").on(t.userId)],
);

export const oauthResource = auth.table("oauthResource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("accessTokenTtl"),
  refreshTokenTtl: integer("refreshTokenTtl"),
  signingAlgorithm: text("signingAlgorithm"),
  signingKeyId: text("signingKeyId"),
  allowedScopes: jsonb("allowedScopes").$type<string[]>(),
  customClaims: jsonb("customClaims"),
  dpopBoundAccessTokensRequired: boolean("dpopBoundAccessTokensRequired").default(false),
  disabled: boolean("disabled").default(false),
  createdAt: ts("createdAt"),
  updatedAt: ts("updatedAt"),
  policyVersion: integer("policyVersion").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResource = auth.table(
  "oauthClientResource",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resourceId")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: ts("createdAt"),
  },
  (t) => [
    index("oauthClientResource_clientId_idx").on(t.clientId),
    index("oauthClientResource_resourceId_idx").on(t.resourceId),
    uniqueIndex("oauthClientResource_clientId_resourceId_uidx").on(t.clientId, t.resourceId),
  ],
);

export const oauthRefreshToken = auth.table(
  "oauthRefreshToken",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text("sessionId").references(() => session.id, { onDelete: "set null" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: jsonb("resources").$type<string[]>(),
    requestedUserInfoClaims: jsonb("requestedUserInfoClaims").$type<string[]>(),
    expiresAt: ts("expiresAt"),
    createdAt: ts("createdAt"),
    revoked: ts("revoked"),
    rotatedAt: ts("rotatedAt"),
    rotationReplayResponse: text("rotationReplayResponse"),
    rotationReplayExpiresAt: ts("rotationReplayExpiresAt"),
    authTime: ts("authTime"),
    confirmation: jsonb("confirmation"),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
  },
  (t) => [
    index("oauthRefreshToken_clientId_idx").on(t.clientId),
    index("oauthRefreshToken_sessionId_idx").on(t.sessionId),
    index("oauthRefreshToken_userId_idx").on(t.userId),
    index("oauthRefreshToken_authorizationCodeId_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = auth.table(
  "oauthAccessToken",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text("sessionId").references(() => session.id, { onDelete: "set null" }),
    userId: text("userId").references(() => user.id),
    referenceId: text("referenceId"),
    authorizationCodeId: text("authorizationCodeId"),
    resources: jsonb("resources").$type<string[]>(),
    requestedUserInfoClaims: jsonb("requestedUserInfoClaims").$type<string[]>(),
    refreshId: text("refreshId").references(() => oauthRefreshToken.id),
    expiresAt: ts("expiresAt"),
    createdAt: ts("createdAt"),
    revoked: ts("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
  },
  (t) => [
    index("oauthAccessToken_clientId_idx").on(t.clientId),
    index("oauthAccessToken_sessionId_idx").on(t.sessionId),
    index("oauthAccessToken_userId_idx").on(t.userId),
    index("oauthAccessToken_authorizationCodeId_idx").on(t.authorizationCodeId),
    index("oauthAccessToken_refreshId_idx").on(t.refreshId),
  ],
);

export const oauthConsent = auth.table(
  "oauthConsent",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId),
    userId: text("userId").references(() => user.id),
    referenceId: text("referenceId"),
    resources: jsonb("resources").$type<string[]>(),
    requestedUserInfoClaims: jsonb("requestedUserInfoClaims").$type<string[]>(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    createdAt: ts("createdAt"),
    updatedAt: ts("updatedAt"),
  },
  (t) => [index("oauthConsent_clientId_idx").on(t.clientId), index("oauthConsent_userId_idx").on(t.userId)],
);

export const oauthClientAssertion = auth.table("oauthClientAssertion", {
  id: text("id").primaryKey(),
  expiresAt: ts("expiresAt").notNull(),
});
