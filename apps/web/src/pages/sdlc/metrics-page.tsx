import { Metrics } from "@xdev-hive/sdlc-ui";
import { SdlcPage } from "@/pages/sdlc/sdlc-pages.tsx";

/** Chỉ số AI SDLC (specs/011 T082, AppSdlcMetrics.dc.html). Hub tính, sdlc-ui vẽ; web chỉ cấp route và quyền. */
export function SdlcMetricsPage() {
  return (
    <SdlcPage>
      <Metrics />
    </SdlcPage>
  );
}
