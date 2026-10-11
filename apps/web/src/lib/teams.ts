import { initials } from "./people.ts";

/** Màu đội: ba màu đầu lấy từ mockup, các màu sau chọn đủ tương phản với chữ trắng. */
export const TEAM_COLORS = ["#7B61FF", "#0F9D8E", "#E0567A", "#2F6FDE", "#A16207", "#5B6472"] as const;

/** Màu cho đội mới tạo, xoay vòng theo số đội đã có để các đội cạnh nhau khác màu. */
export const nextTeamColor = (teamCount: number): string => TEAM_COLORS[teamCount % TEAM_COLORS.length] ?? "#7B61FF";

/** Màu hiển thị của đội. Đội chưa có màu lấy theo mã đội, để màu không đổi giữa các lần tải. */
export function teamColor(team: { id: string; color: string | null }): string {
  if (team.color) return team.color;
  let hash = 0;
  for (const ch of team.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TEAM_COLORS[hash % TEAM_COLORS.length] ?? "#7B61FF";
}

/** Chữ trên ô màu của đội như mockup: "Thanh toán" → "TT", tên một chữ lấy hai ký tự đầu ("CRM" → "CR"). */
export function teamInitials(name: string): string {
  const words = name.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (words.length !== 1) return initials(name);
  return Array.from(words[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
