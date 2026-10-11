import { oc } from "@orpc/contract";
import { z } from "zod";

/** Trạng thái hub. Worker Go gọi qua OpenAPI (GET /api/v1/health) trước khi mở WSS. */
export const healthOutput = z.object({
  status: z.literal("ok"),
  version: z.string(),
  time: z.iso.datetime(),
});
export type Health = z.output<typeof healthOutput>;

export const contract = {
  system: {
    health: oc
      .route({ method: "GET", path: "/v1/health", summary: "Trạng thái hub", tags: ["system"] })
      .output(healthOutput),
  },
};

export type Contract = typeof contract;
