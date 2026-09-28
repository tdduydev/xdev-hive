import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createHttpClient, HiveApp, I18nProvider, Login, signIn, signInProviders, signOut, useT, type MessageKey } from "@xdev-hive/ui";
import "@xdev-hive/ui/globals.css";

// People sign in with username + password (HttpOnly session cookie). An API token pasted at sign-in
// (CI, recovery) is kept in localStorage as before.
const KEY = "xdev-hive.token";
const readToken = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const writeToken = (token: string | null) => {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked (private mode): the token lives only for this tab.
  }
};

// Errors are kept as message keys so they follow a language change on the sign-in page.
type Session = { kind: "checking" } | { kind: "out"; error?: MessageKey } | { kind: "cookie" } | { kind: "token"; token: string };

// The hub sends people back from a failed SSO sign-in with ?sso_error=<key>; only these keys are shown.
const SSO_ERRORS: MessageKey[] = [
  "errors.ssoState",
  "errors.ssoProvider",
  "errors.ssoToken",
  "errors.ssoClaims",
  "errors.ssoDisabled",
  "errors.ssoLinkedElsewhere",
];
function takeSsoError(): MessageKey | null {
  const params = new URLSearchParams(window.location.search);
  const key = params.get("sso_error");
  if (key === null) return null;
  params.delete("sso_error");
  const rest = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
  return (SSO_ERRORS as string[]).includes(key) ? (key as MessageKey) : "errors.ssoProvider";
}

function Root() {
  const t = useT();
  const [session, setSession] = useState<Session>(() => {
    const token = readToken();
    return token ? { kind: "token", token } : { kind: "checking" };
  });
  const [ssoError, setSsoError] = useState<MessageKey | null>(takeSsoError);
  const [sso, setSso] = useState<{ name: string } | null>(null);
  useEffect(() => {
    // A hub from before SSO has no such endpoint: no button.
    signInProviders().then(
      (p) => setSso(p.oidc),
      () => undefined,
    );
  }, []);

  // Scripts cannot read the HttpOnly cookie: ask the hub whether this browser is signed in.
  useEffect(() => {
    if (session.kind !== "checking") return;
    let alive = true;
    createHttpClient()
      .me()
      .then(
        () => alive && setSession({ kind: "cookie" }),
        () => {
          if (!alive) return;
          // Signed out: the sign-in page shows the SSO error, not the banner.
          setSession({ kind: "out", error: ssoError ?? undefined });
          setSsoError(null);
        },
      );
    return () => {
      alive = false;
    };
  }, [session.kind]);

  const client = useMemo(() => {
    if (session.kind === "cookie") {
      return createHttpClient({
        onUnauthorized: () => setSession({ kind: "out", error: "login.sessionExpired" }),
      });
    }
    if (session.kind === "token") {
      return createHttpClient({
        token: session.token,
        onUnauthorized: () => {
          writeToken(null);
          setSession({ kind: "out", error: "login.tokenInvalid" });
        },
      });
    }
    return null;
  }, [session]);

  if (session.kind === "checking") return null;
  if (!client) {
    return (
      <Login
        sso={sso ? { name: sso.name, href: "/api/auth/oidc/start" } : null}
        error={session.kind === "out" && session.error ? t(session.error) : null}
        onPassword={async (username, password) => {
          await signIn(username, password);
          setSession({ kind: "cookie" });
        }}
        onToken={(token) => {
          writeToken(token);
          setSession({ kind: "token", token });
        }}
      />
    );
  }
  return (
    <>
      {/* A failed link from the account menu comes back signed in: say why here. */}
      {ssoError ? (
        <div role="alert" className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-destructive px-4 py-2 text-sm text-white">
          {t(ssoError)}
          <button type="button" className="underline" onClick={() => setSsoError(null)}>
            {t("common.close")}
          </button>
        </div>
      ) : null}
      <HiveApp
        client={client}
        onSignOut={() => {
          const wasCookie = session.kind === "cookie";
          writeToken(null);
          setSession({ kind: "out" });
          if (wasCookie) void signOut();
        }}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <Root />
    </I18nProvider>
  </StrictMode>,
);
