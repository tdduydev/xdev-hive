import * as React from "react";
// Tabs of one menu entry (roadmap 49b: Cài đặt dự án, Máy & agent, Quản trị, Agent đang chạy). Each tab is a link to
// #/<page>?tab=<id>, so a tab has an address to share, and Back returns to the tab before.
import type { ReactNode } from "react";
import { cn } from "cn";

export function PageTabs<T extends string>({
  page,
  tabs,
  current,
  label,
  name,
  children,
}: {
  page: string;
  tabs: readonly T[];
  current: T;
  /** The tab bar's name for screen readers. */
  label: string;
  name: (tab: T) => string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* A single tab is no choice: the page alone then. */}
      {tabs.length > 1 ? (
        <nav aria-label={label} className="hive-page-tabs mx-auto min-w-0 w-full px-4 pt-3 md:px-6">
          <div className="flex gap-1 overflow-x-auto border-b border-line-default [scrollbar-width:none]">
            {tabs.map((tab) => {
              const on = tab === current;
              return (
                <a
                  key={tab}
                  href={`#/${page}?tab=${tab}`}
                  data-page-tab={tab}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "relative inline-flex h-10 shrink-0 items-center px-3 type-label whitespace-nowrap no-underline outline-none focus-visible:focus-ring max-md:h-11",
                    "after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:bg-primary",
                    on ? "font-semibold text-fg-strong after:opacity-100" : "text-fg-secondary after:opacity-0 hover:text-fg-strong",
                  )}
                >
                  {name(tab)}
                </a>
              );
            })}
          </div>
        </nav>
      ) : null}
      {children}
    </div>
  );
}
