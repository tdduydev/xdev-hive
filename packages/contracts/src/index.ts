import { oc } from "@orpc/contract";
import { z } from "zod";
import { fleetContract } from "./fleet.ts";

/** Trạng thái hub. Worker Go gọi qua OpenAPI (GET /api/v1/health) trước khi mở WSS. */
export const healthOutput = z.object({
  status: z.literal("ok"),
  version: z.string(),
  time: z.iso.datetime(),
});
export type Health = z.output<typeof healthOutput>;

/** Người đang đăng nhập. */
export const meOutput = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  image: z.string().nullable(),
});
export type Me = z.output<typeof meOutput>;

export const contract = {
  system: {
    health: oc
      .route({ method: "GET", path: "/v1/health", summary: "Trạng thái hub", tags: ["system"] })
      .output(healthOutput),
  },
  me: {
    get: oc
      .route({ method: "GET", path: "/v1/me", summary: "Người đang đăng nhập", tags: ["identity"] })
      .errors({ UNAUTHORIZED: { message: "Chưa đăng nhập." } })
      .output(meOutput),
  },
  ...fleetContract,
};

export type Contract = typeof contract;

export * from "./fleet.ts";
