import { QueryClientProvider } from "@tanstack/react-query";
import { Metrics, SdlcProvider } from "@xdev-hive/sdlc-ui";
import { queryClient } from "@/lib/hub-query.tsx";
import { useDesktopSdlcEnv } from "@/lib/sdlc-env.tsx";

/** Chỉ số AI SDLC (specs/011 T082, AppSdlcMetrics.dc.html). Mục có `hub: true` nên chưa đăng nhập thì vỏ app mời kết nối. */
export function SdlcMetricsScreen() {
  return (
    <QueryClientProvider client={queryClient}>
      <SdlcProvider env={useDesktopSdlcEnv()}>
        <Metrics />
      </SdlcProvider>
    </QueryClientProvider>
  );
}
