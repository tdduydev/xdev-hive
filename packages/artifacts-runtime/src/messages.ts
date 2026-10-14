import { z } from "zod";

/** Chữ lỗi tối đa mỗi tin (FR-074). Bootstrap cắt đúng ngưỡng này, trang cha kiểm lại bằng schema. */
export const MAX_FRAME_TEXT = 2000;
/** Trần chiều cao khung báo lên; trang cha còn giới hạn riêng theo khung bên cạnh. */
export const MAX_FRAME_HEIGHT = 100_000;

/**
 * Tin `postMessage` từ khung lên trang cha. Dùng `strictObject`: tin thừa trường coi như tin lạ và bị bỏ (FR-074), để trang
 * trong khung không nhét được gì ngoài các trường trang cha biết hiển thị bằng text.
 */
export const frameMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("resize"), height: z.number().finite().min(0).max(MAX_FRAME_HEIGHT) }),
  z.strictObject({
    type: z.literal("error"),
    kind: z.enum(["runtime", "promise", "compile"]),
    message: z.string().max(MAX_FRAME_TEXT),
  }),
  z.strictObject({
    type: z.literal("console"),
    level: z.enum(["error", "warn"]),
    message: z.string().max(MAX_FRAME_TEXT),
  }),
]);

export type FrameMessage = z.infer<typeof frameMessageSchema>;

/** Trả `null` cho mọi thứ không đúng schema; người gọi phải tự kiểm `event.source` trước. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  const parsed = frameMessageSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
