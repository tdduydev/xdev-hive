CREATE TABLE "auth"."jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"publicKey" text NOT NULL,
	"privateKey" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"expiresAt" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "auth"."oauthAccessToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"refreshId" text,
	"expiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" jsonb NOT NULL,
	CONSTRAINT "oauthAccessToken_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth"."oauthClient" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"clientSecret" text,
	"clientDiscoveryId" text,
	"disabled" boolean DEFAULT false,
	"skipConsent" boolean,
	"enableEndSession" boolean,
	"subjectType" text,
	"scopes" jsonb,
	"clientCredentialsScopes" jsonb DEFAULT '[]'::jsonb,
	"userId" text,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" jsonb,
	"tos" text,
	"policy" text,
	"softwareId" text,
	"softwareVersion" text,
	"softwareStatement" text,
	"redirectUris" jsonb NOT NULL,
	"postLogoutRedirectUris" jsonb,
	"backchannelLogoutUri" text,
	"backchannelLogoutSessionRequired" boolean,
	"tokenEndpointAuthMethod" text,
	"applicationType" text,
	"jwks" text,
	"jwksUri" text,
	"grantTypes" jsonb,
	"responseTypes" jsonb,
	"requirePKCE" boolean,
	"dpopBoundAccessTokens" boolean DEFAULT false,
	"referenceId" text,
	"metadata" jsonb,
	CONSTRAINT "oauthClient_clientId_unique" UNIQUE("clientId")
);
--> statement-breakpoint
CREATE TABLE "auth"."oauthClientAssertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."oauthClientResource" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"resourceId" text NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."oauthConsent" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"userId" text,
	"referenceId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"scopes" jsonb NOT NULL,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."oauthRefreshToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text NOT NULL,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"expiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone,
	"revoked" timestamp with time zone,
	"rotatedAt" timestamp with time zone,
	"rotationReplayResponse" text,
	"rotationReplayExpiresAt" timestamp with time zone,
	"authTime" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" jsonb NOT NULL,
	CONSTRAINT "oauthRefreshToken_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth"."oauthResource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"accessTokenTtl" integer,
	"refreshTokenTtl" integer,
	"signingAlgorithm" text,
	"signingKeyId" text,
	"allowedScopes" jsonb,
	"customClaims" jsonb,
	"dpopBoundAccessTokensRequired" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"policyVersion" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauthResource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "auth"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_refreshId_oauthRefreshToken_id_fk" FOREIGN KEY ("refreshId") REFERENCES "auth"."oauthRefreshToken"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthClient" ADD CONSTRAINT "oauthClient_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthClientResource" ADD CONSTRAINT "oauthClientResource_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthClientResource" ADD CONSTRAINT "oauthClientResource_resourceId_oauthResource_identifier_fk" FOREIGN KEY ("resourceId") REFERENCES "auth"."oauthResource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthConsent" ADD CONSTRAINT "oauthConsent_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthConsent" ADD CONSTRAINT "oauthConsent_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "auth"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "auth"."oauthAccessToken" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "auth"."oauthAccessToken" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "auth"."oauthAccessToken" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "auth"."oauthAccessToken" USING btree ("authorizationCodeId");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "auth"."oauthAccessToken" USING btree ("refreshId");--> statement-breakpoint
CREATE INDEX "oauthClient_userId_idx" ON "auth"."oauthClient" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauthClientResource_clientId_idx" ON "auth"."oauthClientResource" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauthClientResource_resourceId_idx" ON "auth"."oauthClientResource" USING btree ("resourceId");--> statement-breakpoint
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON "auth"."oauthClientResource" USING btree ("clientId","resourceId");--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_idx" ON "auth"."oauthConsent" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_idx" ON "auth"."oauthConsent" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "auth"."oauthRefreshToken" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "auth"."oauthRefreshToken" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_userId_idx" ON "auth"."oauthRefreshToken" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "auth"."oauthRefreshToken" USING btree ("authorizationCodeId");