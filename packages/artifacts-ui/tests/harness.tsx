import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Contract } from "@xdev-hive/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactDetail, ArtifactLibrary, type ArtifactsEnv, ArtifactsProvider } from "../src/index.ts";
import { detail, NOW } from "./browser-fixtures.ts";

const client: ContractRouterClient<Contract> = createORPCClient(new RPCLink({ url: `${location.origin}/rpc` }));
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness() {
  const params = new URLSearchParams(location.search);
  const [selected, setSelected] = useState<{ id: string; version?: number | undefined } | null>(
    params.get("id") ? { id: params.get("id") ?? "", version: Number(params.get("v")) || undefined } : null,
  );
  const offline = params.has("offline");
  const env: ArtifactsEnv = {
    api: createTanstackQueryUtils(client),
    lang: "vi",
    theme: "light",
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    link: ({ to, className, children }) => (
      <a
        className={className}
        href={to.kind === "artifact" ? `/?id=${to.id}${to.version ? `&v=${to.version}` : ""}` : "/"}
        onClick={
          to.kind === "library"
            ? (event) => {
                event.preventDefault();
                setSelected(null);
              }
            : undefined
        }
      >
        {children}
      </a>
    ),
    frameBase: location.origin,
    offline,
    ...(offline && {
      offlineCache: {
        get: async (id: string, version?: number) => ({ ...detail(id, version), cachedAt: NOW }),
        put: () => {},
        frameUrl: () => "",
      },
    }),
    canAskLeader: false,
  };
  return (
    <QueryClientProvider client={queryClient}>
      <ArtifactsProvider env={env}>
        <main className="mx-auto min-w-0 max-w-6xl p-4">
          {selected ? (
            <ArtifactDetail
              id={selected.id}
              version={selected.version}
              onVersionChange={(version) => setSelected({ id: selected.id, version })}
            />
          ) : (
            <ArtifactLibrary onOpen={(ref) => setSelected({ id: ref.id, version: ref.version })} />
          )}
        </main>
      </ArtifactsProvider>
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Không tìm thấy vùng dựng màn kiểm thử.");
createRoot(root).render(<Harness />);
