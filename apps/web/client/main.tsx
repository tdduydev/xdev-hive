import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createHttpClient, HiveApp, Login } from "@xdev-hive/ui";
import "@xdev-hive/ui/globals.css";

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

function Root() {
  const [token, setToken] = useState<string | null>(readToken);
  const [error, setError] = useState<string | null>(null);
  const signOut = () => {
    writeToken(null);
    setToken(null);
  };
  const client = useMemo(
    () =>
      token
        ? createHttpClient({
            token,
            onUnauthorized: () => {
              signOut();
              setError("Token không hợp lệ hoặc đã bị thu hồi.");
            },
          })
        : null,
    [token],
  );
  if (!client) {
    return (
      <Login
        error={error}
        onSubmit={(t) => {
          writeToken(t);
          setError(null);
          setToken(t);
        }}
      />
    );
  }
  return <HiveApp client={client} onSignOut={signOut} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
