import { sdlcMode } from "../sdlc.ts";

/**
 * Preset `small`: việc nhỏ, rõ ràng, cỡ S. Không tài liệu, không cổng: mô tả task là đề bài và hạng mục chỉ gom task, PR
 * và truy vết. Có để người dùng không bị ép viết spec cho việc năm phút (phê bình "quy trình quá nặng cho việc nhỏ").
 */
export const small = sdlcMode.parse({
  id: "small",
  name: "Việc nhỏ",
  description: "Việc nhỏ, rõ ràng: không tài liệu, không cổng duyệt, một task giao thẳng cho agent.",
  method: "hive",
  profile: "small",
  sizes: ["S"],
  phases: [{ id: "implement", name: "Triển khai", kind: "implementation" }],
  decomposition: null,
  blocking: "none",
  converge: { maxRounds: 0 },
  maxAgentRevisions: 2,
});
