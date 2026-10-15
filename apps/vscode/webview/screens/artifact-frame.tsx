import { useState } from "react";
import { bridge } from "@/bridge.ts";

export function ArtifactFrame({ id, version }: { id: string; version: number }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const english = document.documentElement.lang === "en";
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const response = await bridge.fetch(
              new Request("https://hive.invalid/rpc/artifacts/openFrame", {
                method: "POST",
                body: JSON.stringify({ id, version }),
              }),
            );
            if (!response.ok || (await response.json()) !== true) throw new Error();
          } catch {
            setError(english ? "Could not open artifact." : "Không mở được artifact.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {english ? "Open interactive artifact" : "Mở artifact tương tác"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
