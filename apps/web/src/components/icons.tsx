import type { ComponentProps, ReactNode } from "react";
import { cx } from "@/lib/cx.ts";

// Đường vẽ chép từ <symbol> trong mockup docs/ui/m1-login-orgs.html; riêng `logout` vẽ thêm cho nút đăng xuất.
const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.8 } as const;
const round = { ...line, strokeLinecap: "round" } as const;

/** Biểu tượng chép từ thiết kế Sidebar.dc.html (khung 16px), phóng lên khung 24px giữ nét như các biểu tượng khác. */
function from16(d: ReactNode) {
  return (
    <g
      transform="scale(1.5)"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {d}
    </g>
  );
}

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
  columns: from16(
    <>
      <rect x="2.5" y="2.5" width="4" height="11" rx="1" />
      <rect x="9.5" y="2.5" width="4" height="7" rx="1" />
    </>,
  ),
  play: from16(<path d="M5 3.5v9l7-4.5z" />),
  folder: from16(<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />),
  monitor: from16(
    <>
      <rect x="2.5" y="3" width="11" height="7.5" rx="1" />
      <path d="M6 13.5h4M8 10.5v3" />
    </>,
  ),
  network: from16(
    <>
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="12" cy="4" r="1.5" />
      <circle cx="8" cy="12" r="1.5" />
      <path d="M5.2 5 7 10.6M10.8 5 9 10.6" />
    </>,
  ),
  bell: from16(<path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3zM6.5 14h3" />),
  chart: from16(<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" />),
  chat: from16(<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2zM5 6.5h6M5 8.5h3.5" />),
  lock: from16(
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>,
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

/**
 * Logo xDev Hive theo theme. Dùng nguyên file SVG của design system, không vẽ lại chữ X bằng font.
 * Hai ảnh cùng có mặt, CSS ẩn một ảnh theo prefers-color-scheme (cùng cơ chế với token màu).
 */
export function Brand({ className }: { className?: string }) {
  return (
    // Bọc trong span: Card của shadcn bỏ padding trên khi con đầu tiên là <img>.
    <span className="inline-flex">
      <img src="/xdev-hive-light.svg" alt="xDev Hive" className={cx("h-10 w-auto dark:hidden", className)} />
      <img src="/xdev-hive-dark.svg" alt="xDev Hive" className={cx("hidden h-10 w-auto dark:block", className)} />
    </span>
  );
}
