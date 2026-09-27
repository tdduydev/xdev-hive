import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createHttpClient, HiveApp, I18nProvider, Login, signIn, signOut, useT, type MessageKey } from "@xdev-hive/ui";
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

function Root() {
  const t = useT();
  const [session, setSession] = useState<Session>(() => {
    const token = readToken();
    return token ? { kind: "token", token } : { kind: "checking" };
  });

  // Scripts cannot read the HttpOnly cookie: ask the hub whether this browser is signed in.
  useEffect(() => {
    if (session.kind !== "checking") return;
    let alive = true;
    createHttpClient()
      .me()
      .then(
        () => alive && setSession({ kind: "cookie" }),
        () => alive && setSession({ kind: "out" }),
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
    <HiveApp
      client={client}
      onSignOut={() => {
        const wasCookie = session.kind === "cookie";
        writeToken(null);
        setSession({ kind: "out" });
        if (wasCookie) void signOut();
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <Root />
    </I18nProvider>
  </StrictMode>,
);
