import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@xdev-hive/ui/empty";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { bridge } from "@/bridge.ts";
import { ReviewScreen } from "@/screens/review.tsx";
import { syncTheme } from "@/theme.ts";
import type { Screen } from "../shared/index.ts";

type HostScreen = Exclude<Screen, "artifact-frame">;

// Mỗi màn nối component tại đây; khung artifact tương tác dùng entry và CSP riêng.
const screens: Partial<Record<HostScreen, ComponentType>> = { review: ReviewScreen };

function ScreenRouter({ screen, title, empty }: { screen: string; title: string; empty: string }) {
  const Component = Object.hasOwn(screens, screen) ? screens[screen as HostScreen] : undefined;
  return Component ? (
    <Component />
  ) : (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{empty}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const element = document.getElementById("root");
if (element) {
  const stopTheme = syncTheme();
  const root = createRoot(element);
  root.render(
    <ScreenRouter
      screen={document.body.dataset.screen ?? ""}
      title={element.dataset.title ?? "xDev Hive"}
      empty={element.dataset.empty ?? ""}
    />,
  );
  window.addEventListener(
    "pagehide",
    () => {
      stopTheme();
      root.unmount();
      bridge.dispose();
    },
    { once: true },
  );
}
