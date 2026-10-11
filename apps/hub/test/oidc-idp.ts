// IdP OIDC giả lập cho test: discovery, authorize (trả code ngay, không có màn đăng nhập), token (ký ID token RS256),
// JWKS. Tự dựng bằng node:crypto để không thêm thư viện chỉ cho test; đủ để Better Auth đi hết luồng code + PKCE.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface IdpUser {
  sub: string;
  email: string;
  name: string;
}

interface Grant {
  user: IdpUser;
  clientId: string;
  redirectUri: string;
  nonce: string | undefined;
  codeChallenge: string | undefined;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export interface MockIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Người sẽ "đăng nhập" ở lần authorize kế tiếp. */
  signInAs(user: IdpUser): void;
  close(): Promise<void>;
}

export async function startMockIdp(clientId = "hive-test", clientSecret = "idp-secret-0123456789"): Promise<MockIdp> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(8).toString("hex");
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const grants = new Map<string, Grant>();
  let next: IdpUser | undefined;
  let issuer = "";

  const idToken = (g: Grant) => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const payload = b64url(
      JSON.stringify({
        iss: issuer,
        aud: g.clientId,
        sub: g.user.sub,
        email: g.user.email,
        email_verified: true,
        name: g.user.name,
        iat: now,
        exp: now + 300,
        ...(g.nonce ? { nonce: g.nonce } : {}),
      }),
    );
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      const redirectUri = q.get("redirect_uri") ?? "";
      if (q.get("client_id") !== clientId || !next) return json(400, { error: "invalid_request" });
      const code = randomBytes(16).toString("hex");
      grants.set(code, {
        user: next,
        clientId,
        redirectUri,
        nonce: q.get("nonce") ?? undefined,
        codeChallenge: q.get("code_challenge") ?? undefined,
      });
      const to = new URL(redirectUri);
      to.searchParams.set("code", code);
      to.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { location: to.toString() }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const basic = req.headers.authorization?.startsWith("Basic ")
        ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent)
        : [form.get("client_id"), form.get("client_secret")];
      if (basic[0] !== clientId || basic[1] !== clientSecret) return json(401, { error: "invalid_client" });
      const code = form.get("code") ?? "";
      const g = grants.get(code);
      grants.delete(code);
      if (!g || g.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
      if (g.codeChallenge) {
        const verifier = form.get("code_verifier") ?? "";
        if (b64url(createHash("sha256").update(verifier).digest()) !== g.codeChallenge)
          return json(400, { error: "invalid_grant", error_description: "PKCE" });
      }
      return json(200, {
        access_token: randomBytes(16).toString("hex"),
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken(g),
      });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    signInAs(user) {
      next = user;
    },
    close: () => new Promise<void>((ok, fail) => server.close((e) => (e ? fail(e) : ok()))),
  };
}
