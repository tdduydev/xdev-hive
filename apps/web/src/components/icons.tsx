import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx.ts";

// Đường vẽ chép từ <symbol> trong mockup docs/ui/m1-login-orgs.html; riêng `logout` vẽ thêm cho nút đăng xuất.
const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.8 } as const;
const round = { ...line, strokeLinecap: "round" } as const;

const paths = {
  key: (
    <>
      <circle cx="8" cy="15" r="4" {...line} />
      <path d="M11 12l9-9m-3 3 3 3m-6 0 2 2" {...round} />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" {...line} />
      <path d="m4 7 8 6 8-6" {...line} />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" {...line} />
      <path
        d="M2.5 20c.6-3.5 3.2-5.5 6.5-5.5s5.9 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .6 3.2 2.4 3.5 5.2"
        {...round}
      />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" {...line} />
      <rect x="13" y="4" width="7" height="7" rx="1.5" {...line} />
      <rect x="4" y="13" width="7" height="7" rx="1.5" {...line} />
      <rect x="13" y="13" width="7" height="7" rx="1.5" {...line} />
    </>
  ),
  board: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" {...line} />
      <path d="M9.5 4v16M14.5 4v9" {...line} />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="7" rx="1.5" {...line} />
      <rect x="4" y="13" width="16" height="7" rx="1.5" {...line} />
    </>
  ),
  book: <path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" {...line} />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" {...line} />
      <path
        d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"
        {...round}
      />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" {...round} strokeWidth={2} />,
  logout: <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 8l4 4-4 4M20 12H10" {...round} strokeLinejoin="round" />,
  github: (
    <path
      fill="currentColor"
      d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"
    />
  ),
  // Logo GitLab giữ màu thương hiệu ở cả hai chế độ sáng tối.
  gitlab: (
    <>
      <path fill="#E24329" d="M12 21.4 15.7 10H8.3z" />
      <path fill="#FC6D26" d="M12 21.4 8.3 10H3.1z" />
      <path fill="#FCA326" d="M3.1 10 2 13.4c-.1.3 0 .6.3.8L12 21.4z" />
      <path fill="#E24329" d="M3.1 10h5.2L6.1 3.2c-.1-.3-.6-.3-.7 0z" />
      <path fill="#FC6D26" d="M12 21.4 15.7 10h5.2z" />
      <path fill="#FCA326" d="m20.9 10 1.1 3.4c.1.3 0 .6-.3.8L12 21.4z" />
      <path fill="#E24329" d="M20.9 10h-5.2l2.2-6.8c.1-.3.6-.3.7 0z" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, className, ...props }: { name: IconName } & ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cx("size-4 shrink-0", className)} {...props}>
      {paths[name]}
    </svg>
  );
}

/** Logo lục giác của Hive. */
export function HiveLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cx("size-6.5 shrink-0", className)}>
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" className="fill-accent" />
      <path d="M12 7l4.33 2.5v5L12 17l-4.33-2.5v-5z" className="fill-white" />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="flex items-center gap-2.5 text-xl font-semibold text-ink">
      <HiveLogo />
      xDev Hive
    </div>
  );
}
