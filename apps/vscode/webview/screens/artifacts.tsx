import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  ArtifactLibrary,
  type ArtifactRef,
  type ArtifactsEnv,
  ArtifactsProvider,
  ArtifactViewer,
} from "@xdev-hive/artifacts-ui";
import { useState } from "react";
import { hub } from "@/bridge.ts";
import { ArtifactFrame } from "@/screens/artifact-frame.tsx";

const english = () => document.documentElement.lang === "en";
const api = createTanstackQueryUtils(hub);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: 60_000 } } });

function SelectedArtifact({ selected }: { selected: ArtifactRef }) {
  const result = useQuery(api.artifacts.get.queryOptions({ input: { id: selected.id, version: selected.version } }));
  if (!result.data)
    return (
      <p role="status">
        {result.error
          ? english()
            ? "Could not load artifact."
            : "Không tải được artifact."
          : english()
            ? "Loading artifact…"
            : "Đang tải artifact…"}
      </p>
    );
  const { artifact, version } = result.data;
  return ["html", "react", "mermaid", "svg"].includes(artifact.type) ? (
    <ArtifactFrame id={artifact.id} version={version.version} />
  ) : (
    <ArtifactViewer artifact={artifact} version={version} />
  );
}

export function ArtifactsScreen() {
  const [selected, setSelected] = useState<ArtifactRef>();
  const env: ArtifactsEnv = {
    api,
    lang: english() ? "en" : "vi",
    theme: document.body.classList.contains("vscode-dark") ? "dark" : "light",
    errorMessage: () =>
      english()
        ? "Could not load artifact. Check your connection and sign in to xDev Hive."
        : "Không tải được artifact. Kiểm tra kết nối và đăng nhập xDev Hive.",
    link: ({ children }) => <span>{children}</span>,
    frameBase: "",
    offline: false,
    canAskLeader: false,
  };
  return (
    <QueryClientProvider client={client}>
      <ArtifactsProvider env={env}>
        {selected ? (
          <>
            <button type="button" onClick={() => setSelected(undefined)}>
              ← Artifact
            </button>
            <h2>{selected.title}</h2>
            <SelectedArtifact selected={selected} />
          </>
        ) : (
          <ArtifactLibrary onOpen={setSelected} />
        )}
      </ArtifactsProvider>
    </QueryClientProvider>
  );
}
