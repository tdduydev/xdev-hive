import { z } from "zod";

// Việc CI/CD và triển khai chạy trên worker (specs/032). File riêng để không đụng `worker-protocol.ts`. Hub chỉ giữ và
// gửi TÊN tham chiếu credential; giá trị ở kho bí mật của máy (FR-060..063). Sự kiện không có kiểu nào mang thân log
// (FR-050): log đầy đủ ở đĩa của máy đã chạy.

/** Tên tham chiếu credential, duy nhất trong tổ chức (FR-061). */
export const credentialRef = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/, "Tên credential gồm chữ thường, số, gạch ngang, tối đa 64 ký tự.");
export type CredentialRef = z.output<typeof credentialRef>;

// Worker chỉ bấm job Jenkins hoặc sync Argo CD rồi theo dõi trạng thái; hệ ngoài tự triển khai (đã bỏ ssh, kubectl, kiểm tra
// sức khoẻ khỏi phạm vi).
export const DELIVERY_JOB_KINDS = ["jenkins-job", "argocd"] as const;
export const deliveryJobKind = z.enum(DELIVERY_JOB_KINDS);
export type DeliveryJobKind = z.output<typeof deliveryJobKind>;

/** Cách triển khai worker biết chạy. */
export const DELIVERY_METHODS = DELIVERY_JOB_KINDS;
export const deliveryMethod = z.enum(DELIVERY_METHODS);
export type DeliveryMethod = z.output<typeof deliveryMethod>;

/**
 * Khả năng worker báo ở `hello` và heartbeat (FR-010). `credentials` chỉ là danh sách tên. Linux không có kho bí mật báo
 * `methods: []` (FR-102). Trường lạ được bỏ qua để bản worker mới hơn không làm hub cũ hỏng.
 */
export const deliveryCapability = z.object({
  methods: z.array(deliveryMethod).max(16).default([]),
  credentials: z.array(credentialRef).max(500).default([]),
});
export type DeliveryCapability = z.output<typeof deliveryCapability>;

/** Việc hub giao cho worker. `target` và `params` không bao giờ chứa giá trị bí mật; chỉ tên tham chiếu. */
export const deliveryJobSpec = z.object({
  jobId: z.string().uuid(),
  kind: deliveryJobKind,
  deployId: z.string().uuid().nullable().default(null),
  /** Phiên bản cấu hình đích đã khoá lúc giao (FR-021). */
  configVersion: z.number().int().nonnegative(),
  target: z.record(z.string(), z.unknown()),
  credential: credentialRef.nullable().default(null),
  params: z.record(z.string(), z.unknown()).default({}),
  timeoutSeconds: z.number().int().min(1).max(86_400).default(1800),
});
export type DeliveryJobSpec = z.output<typeof deliveryJobSpec>;

export const deliveryStepState = z.enum(["running", "succeeded", "failed", "skipped"]);
export type DeliveryStepState = z.output<typeof deliveryStepState>;

export const deliveryFinalState = z.enum(["succeeded", "failed", "canceled"]);
export type DeliveryFinalState = z.output<typeof deliveryFinalState>;

/** Thông điệp lỗi một dòng, đã che; cắt ở 200 ký tự (không gửi stderr). */
export const deliveryErrorMessage = z.string().max(200);

const eventBase = {
  jobId: z.string().uuid(),
  /** Tăng dần theo việc; hub bỏ sự kiện trùng theo `(jobId, seq)`. */
  seq: z.number().int().nonnegative(),
  at: z.string().datetime(),
};

export const deliveryEvent = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("started"), workerId: z.string().min(1).max(128) }),
  z.object({
    ...eventBase,
    type: z.literal("step"),
    name: z.string().min(1).max(120),
    state: deliveryStepState,
    exitCode: z.number().int().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("external"),
    /** Tham chiếu build, ứng dụng hay workload ở hệ ngoài. */
    ref: z.string().min(1).max(500),
    /** Đường dẫn mở ở nguồn (FR-054). */
    url: z.string().url().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("finished"),
    state: deliveryFinalState,
    error: z.object({ code: z.string().min(1).max(64), message: deliveryErrorMessage }).optional(),
  }),
]);
export type DeliveryEvent = z.output<typeof deliveryEvent>;
