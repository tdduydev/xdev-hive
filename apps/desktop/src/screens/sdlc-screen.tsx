import { QueryClientProvider } from "@tanstack/react-query";
import { ItemBoard, ItemDetail, NewItem, SdlcProvider } from "@xdev-hive/sdlc-ui";
import { useSyncExternalStore } from "react";
import { queryClient } from "@/lib/hub-query.tsx";
import { screenParam } from "@/lib/nav.ts";
import { itemHash, sdlcTabOf, useDesktopSdlcEnv } from "@/lib/sdlc-env.tsx";

export function subscribeHash(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function SdlcScreen() {
  const param = useSyncExternalStore(subscribeHash, () => screenParam(location.hash));
  const [projectKey, number, tab] = param.split("/");
  return (
    <QueryClientProvider client={queryClient}>
      <SdlcProvider env={useDesktopSdlcEnv()}>
        {!param ? (
          <ItemBoard />
        ) : param === "new" ? (
          <NewItem
            onCreated={(item) => {
              location.hash = itemHash(item.project.key, item.number);
            }}
          />
        ) : projectKey && /^\d+$/.test(number ?? "") && Number(number) > 0 ? (
          <ItemDetail
            key={`${projectKey}/${number}`}
            projectKey={projectKey}
            number={Number(number)}
            tab={sdlcTabOf(tab)}
            onTabChange={(next) => {
              location.hash = itemHash(projectKey, Number(number), next);
            }}
          />
        ) : (
          <ItemBoard />
        )}
      </SdlcProvider>
    </QueryClientProvider>
  );
}

/** Danh sách đã có giai đoạn, việc chờ và độ phủ; số liệu tổng hợp ở màn Chỉ số (sdlc-metrics-screen.tsx). */
export function SdlcProgressScreen() {
  return (
    <QueryClientProvider client={queryClient}>
      <SdlcProvider env={useDesktopSdlcEnv()}>
        <ItemBoard initialView="list" />
      </SdlcProvider>
    </QueryClientProvider>
  );
}
