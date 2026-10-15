import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ARTIFACT_TYPE_ICON, ArtifactDetail, ArtifactLibrary, useArtifactsEnv } from "@xdev-hive/artifacts-ui";
import { Alert } from "@xdev-hive/ui/alert";
import { useSyncExternalStore } from "react";
import { cacheList, latestPerArtifact } from "@/lib/artifact-cache.ts";
import { DesktopArtifacts } from "@/lib/artifacts-env.tsx";
import { queryClient } from "@/lib/hub-query.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { screenParam } from "@/lib/nav.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{ cached: string; cachedEmpty: string; loading: string; version: (n: number) => string }> = {
  vi: {
    cached: "Đang offline: danh sách dưới đây là các artifact đã mở trên máy này, đọc được không cần hub.",
    cachedEmpty: "Chưa có artifact nào được lưu trên máy này. Kết nối hub và mở một artifact để đọc offline.",
    loading: "Đang tải…",
    version: (n) => `Bản v${n}`,
  },
  en: {
    cached: "Offline: these are the artifacts already opened on this machine, readable without the hub.",
    cachedEmpty: "No artifact is saved on this machine yet. Connect to the hub and open one to read it offline.",
    loading: "Loading…",
    version: (n) => `Version v${n}`,
  },
};

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/** `#/artifacts/<id>[/<phiên bản>]`; phiên bản hỏng thì mở bản mới nhất thay vì báo lỗi. */
export function artifactRoute(param: string): { id: string; version: number | undefined } | null {
  const [id, raw] = param.split("/");
  if (!id) return null;
  const version = Number(raw);
  return { id, version: Number.isInteger(version) && version >= 1 ? version : undefined };
}

/**
 * Màn Artifact của app (spec 012 T041): thư viện và chi tiết từ `packages/artifacts-ui`, dùng chung với web. Mất hub thì
 * đọc từ bộ đệm T040: chi tiết do `ArtifactDetail` lấy qua `offlineCache`, danh sách dựng từ những bản đã đệm.
 */
export function ArtifactsScreen() {
  const route = artifactRoute(useSyncExternalStore(subscribe, () => screenParam(location.hash)));
  return (
    <QueryClientProvider client={queryClient}>
      <DesktopArtifacts>
        <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4">
          {route ? (
            <ArtifactDetail
              id={route.id}
              version={route.version}
              // Đổi phiên bản đổi hash để tải lại cửa sổ hay chép đường dẫn vẫn mở đúng bản đang xem.
              onVersionChange={(next) => location.replace(`#/artifacts/${encodeURIComponent(route.id)}/${next}`)}
            />
          ) : (
            <Library />
          )}
        </div>
      </DesktopArtifacts>
    </QueryClientProvider>
  );
}

function Library() {
  const env = useArtifactsEnv();
  return env.offline ? <CachedList /> : <ArtifactLibrary />;
}

function CachedList() {
  const t = useT(text);
  const env = useArtifactsEnv();
  const cached = useQuery({ queryKey: ["desktop", "artifact-cache-list"], queryFn: cacheList });
  if (cached.isPending)
    return (
      <p role="status" className="text-muted-foreground">
        {t.loading}
      </p>
    );
  if (cached.isError) return <Alert variant="destructive">{errorText(cached.error)}</Alert>;
  const items = latestPerArtifact(cached.data);
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="rounded-md bg-warning-soft p-3 text-sm text-warning">
        {t.cached}
      </p>
      {items.length === 0 && <p className="text-muted-foreground">{t.cachedEmpty}</p>}
      <ul className="m-0 flex list-none flex-col divide-y rounded-lg border p-0">
        {items.map(({ artifact, version }) => {
          const Icon = ARTIFACT_TYPE_ICON[artifact.type];
          return (
            <li key={artifact.id}>
              {env.link({
                to: { kind: "artifact", id: artifact.id, version },
                className: "flex min-w-0 items-center gap-3 px-3 py-2.5 hover:bg-muted",
                children: (
                  <>
                    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium">{artifact.title}</span>
                    <span className="text-xs text-muted-foreground">{t.version(version)}</span>
                  </>
                ),
              })}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
