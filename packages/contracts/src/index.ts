import { oc } from "@orpc/contract";
import { z } from "zod";
import { fleetContract } from "./fleet.ts";
import { docsContract, memoryContract, proposalsContract, skillsContract } from "./knowledge.ts";
import { projectsContract } from "./projects.ts";
import { runsContract } from "./runs.ts";
import { scmContract } from "./scm.ts";
import { tasksContract } from "./tasks.ts";
import { tenancyContract } from "./tenancy.ts";

export * from "./knowledge.ts";
export * from "./projects.ts";
export * from "./repo-url.ts";
export * from "./runs.ts";
export * from "./scm.ts";
export * from "./tasks.ts";
export * from "./tenancy.ts";

// Lỗi kiểm tra đầu vào được trả thẳng cho người dùng (hub) và hiện trên form (web), nên dùng tiếng Việt cho mọi
// thông báo mặc định của zod. Schema nào cần câu rõ hơn thì tự ghi message riêng.
z.config(z.locales.vi());

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
  ...tenancyContract,
  scmConnections: scmContract,
  projects: projectsContract,
  memory: memoryContract,
  docs: docsContract,
  skills: skillsContract,
  proposals: proposalsContract,
  tasks: tasksContract,
  runs: runsContract,
};

export type Contract = typeof contract;

export * from "./fleet.ts";
