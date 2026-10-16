import { cn } from "cn";
import type { ComponentProps } from "react";

/* Rộng:cao 7:8 để clip-path cắt ra lục giác đều như ô của logo. */
const SIZE = {
  sm: "h-[25px] w-[22px] text-[10px]",
  md: "h-8 w-7 text-2xs",
  lg: "h-[50px] w-11 text-[15px]",
} as const;

const TONE = {
  /** Agent, máy dùng chung: ô navy như logo. */
  navy: "bg-sidebar-accent text-sidebar-active-icon",
  /** Tổ chức trên sidebar navy. */
  sky: "bg-sidebar-primary text-sidebar-primary-foreground",
  accent: "bg-accent text-accent-foreground",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  muted: "bg-muted text-muted-foreground",
} as const;

export type HexAvatarTone = keyof typeof TONE;

/**
 * Ô lục giác (ô tổ ong của logo) đánh dấu agent và máy. Người vẫn dùng avatar tròn, để nhìn hình là biết việc do người
 * hay do agent làm. Đặt cạnh tên thì truyền `aria-hidden`: chữ viết tắt chỉ lặp lại tên.
 */
export function HexAvatar({
  size = "md",
  tone = "navy",
  className,
  ...props
}: ComponentProps<"span"> & { size?: keyof typeof SIZE; tone?: HexAvatarTone }) {
  return (
    <span
      data-slot="hex-avatar"
      className={cn(
        "inline-grid shrink-0 place-items-center leading-none font-semibold [clip-path:polygon(50%_0,100%_25%,100%_75%,50%_100%,0_75%,0_25%)] [&>svg]:size-[45%]",
        SIZE[size],
        TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

/** "sdlc-box-01" → "SB", "dev-ha" → "DH": chữ đầu của phần đầu và phần chữ cuối, bỏ số thứ tự máy. */
export function hexInitials(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words = parts.filter((p) => /^\p{L}/u.test(p));
  const first = words[0] ?? parts[0] ?? "?";
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return `${first.charAt(0)}${last?.charAt(0) ?? ""}`.toUpperCase();
}

const AGENT: Record<string, { mark: string; tone: HexAvatarTone }> = {
  claude: { mark: "CC", tone: "navy" },
  codex: { mark: "CX", tone: "success" },
  gemini: { mark: "GM", tone: "warning" },
  antigravity: { mark: "AG", tone: "accent" },
};

/** Ô của agent CLI: mỗi CLI một chữ và một màu cố định để nhận ra trong bảng dài. */
export function agentHex(cli: string): { mark: string; tone: HexAvatarTone } {
  return AGENT[cli] ?? { mark: hexInitials(cli), tone: "muted" };
}

/**
 * Ô của máy: máy dùng chung navy, máy cá nhân đang nhận việc xanh lá, tạm dừng cam, mất kết nối hay đã thu hồi xám.
 * Màu chỉ phụ trợ, trạng thái vẫn có chữ ở cột hoặc nhãn cạnh bên.
 */
export function machineHex(machine: { name: string; status: string; shared: boolean }): {
  mark: string;
  tone: HexAvatarTone;
} {
  const tone: HexAvatarTone =
    machine.status === "paused"
      ? "warning"
      : machine.status !== "online"
        ? "muted"
        : machine.shared
          ? "navy"
          : "success";
  return { mark: hexInitials(machine.name), tone };
}
