import { oc } from "@orpc/contract";
import { z } from "zod";

/** Định danh dùng trong đường dẫn và trong lệnh của agent, nên chỉ cho ký tự an toàn với URL và shell. */
export const slug = z
  .string()
  .min(2, "Định danh cần ít nhất 2 ký tự.")
  .max(40, "Định danh dài tối đa 40 ký tự.")
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Định danh chỉ gồm chữ thường, số và gạch ngang, không bắt đầu hay kết thúc bằng gạch ngang.",
  );

const name = z.string().trim().min(1, "Tên không được để trống.").max(120, "Tên dài tối đa 120 ký tự.");
const emailDomain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
    "Tên miền không hợp lệ.",
  );
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Màu phải ở dạng #RRGGBB.");
const id = z.uuid("Mã không hợp lệ.");
const userId = z.string().min(1, "Thiếu mã người dùng.");

export const orgRole = z.enum(["owner", "admin", "member"]);
export const teamRole = z.enum(["admin", "member", "viewer"]);
export const memberStatus = z.enum(["active", "pending", "blocked"]);
export type OrgRole = z.output<typeof orgRole>;
export type TeamRole = z.output<typeof teamRole>;
export type MemberStatus = z.output<typeof memberStatus>;

// `code` ổn định để client phân biệt lý do (vd. LAST_OWNER) mà không phải đọc message.
const reason = z.object({ code: z.string() }).optional();
const errors = {
  UNAUTHORIZED: { message: "Chưa đăng nhập." },
  // Không khai báo data: lỗi kiểm tra đầu vào của oRPC mang danh sách issues.
  BAD_REQUEST: { message: "Dữ liệu gửi lên không hợp lệ." },
  FORBIDDEN: { message: "Bạn không có quyền làm việc này.", data: reason },
  NOT_FOUND: { message: "Không tìm thấy.", data: reason },
  CONFLICT: { message: "Dữ liệu bị trùng hoặc xung đột.", data: reason },
};

export const org = z.object({
  id,
  slug: z.string(),
  name: z.string(),
  emailDomain: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const myOrg = org.extend({ role: orgRole });
export const team = z.object({
  id,
  slug: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const teamWithCounts = team.extend({ systemCount: z.number().int(), memberCount: z.number().int() });
export const system = z.object({
  id,
  teamId: id,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
const person = { userId: z.string(), name: z.string(), email: z.string(), image: z.string().nullable() };
export const teamMember = z.object({ ...person, teamId: id, role: teamRole });
export const orgMember = z.object({
  ...person,
  role: orgRole,
  status: memberStatus,
  joinedAt: z.iso.datetime(),
  teams: z.array(z.object({ teamId: id, name: z.string(), role: teamRole })),
});
export type Org = z.output<typeof org>;
export type MyOrg = z.output<typeof myOrg>;
export type Team = z.output<typeof team>;
export type TeamWithCounts = z.output<typeof teamWithCounts>;
export type System = z.output<typeof system>;
export type TeamMember = z.output<typeof teamMember>;
export type OrgMember = z.output<typeof orgMember>;

const ORG_HEADER = "Tổ chức lấy từ header `x-hive-org`.";
const route = (method: "GET" | "POST" | "PATCH" | "DELETE", path: `/v1/${string}`, summary: string, tag: string) =>
  oc.route({ method, path, summary, tags: [tag], description: ORG_HEADER }).errors(errors);

export const tenancyContract = {
  orgs: {
    mine: oc
      .route({ method: "GET", path: "/v1/orgs/mine", summary: "Tổ chức của tôi", tags: ["orgs"] })
      .errors(errors)
      .output(z.object({ orgs: z.array(myOrg), canCreateOrg: z.boolean() })),
    create: oc
      .route({ method: "POST", path: "/v1/orgs", summary: "Tạo tổ chức, người tạo là chủ sở hữu", tags: ["orgs"] })
      .errors(errors)
      .input(z.object({ name, slug, emailDomain: emailDomain.optional() }))
      .output(myOrg),
    get: oc
      .route({ method: "GET", path: "/v1/orgs/{orgId}", summary: "Thông tin tổ chức", tags: ["orgs"] })
      .errors(errors)
      .input(z.object({ orgId: id }))
      .output(myOrg),
    update: oc
      .route({ method: "PATCH", path: "/v1/orgs/{orgId}", summary: "Sửa tổ chức (quản trị)", tags: ["orgs"] })
      .errors(errors)
      .input(z.object({ orgId: id, name: name.optional(), slug: slug.optional(), emailDomain: emailDomain.nullish() }))
      .output(myOrg),
  },
  teams: {
    list: route("GET", "/v1/teams", "Danh sách đội kèm số hệ thống, số người", "teams").output(z.array(teamWithCounts)),
    create: route("POST", "/v1/teams", "Tạo đội (quản trị tổ chức)", "teams")
      .input(z.object({ name, slug, color: color.optional(), adminUserId: userId.optional() }))
      .output(team),
    update: route("PATCH", "/v1/teams/{teamId}", "Sửa đội (quản trị đội)", "teams")
      .input(z.object({ teamId: id, name: name.optional(), slug: slug.optional(), color: color.nullish() }))
      .output(team),
    remove: route("DELETE", "/v1/teams/{teamId}", "Xoá đội cùng hệ thống của đội (chủ sở hữu)", "teams")
      .input(z.object({ teamId: id }))
      .output(z.object({ ok: z.literal(true) })),
  },
  teamMembers: {
    list: route("GET", "/v1/teams/{teamId}/members", "Thành viên của đội", "teams")
      .input(z.object({ teamId: id }))
      .output(z.array(teamMember)),
    add: route("POST", "/v1/teams/{teamId}/members", "Thêm người vào đội (quản trị đội)", "teams")
      .input(z.object({ teamId: id, userId, role: teamRole }))
      .output(teamMember),
    setRole: route("PATCH", "/v1/teams/{teamId}/members/{userId}", "Đổi vai trò trong đội (quản trị đội)", "teams")
      .input(z.object({ teamId: id, userId, role: teamRole }))
      .output(teamMember),
    remove: route("DELETE", "/v1/teams/{teamId}/members/{userId}", "Gỡ người khỏi đội (quản trị đội)", "teams")
      .input(z.object({ teamId: id, userId }))
      .output(z.object({ ok: z.literal(true) })),
  },
  systems: {
    list: route("GET", "/v1/systems", "Hệ thống của tổ chức, lọc theo đội", "systems")
      .input(z.object({ teamId: id.optional() }))
      .output(z.array(system)),
    create: route("POST", "/v1/systems", "Thêm hệ thống vào đội (quản trị đội)", "systems")
      .input(z.object({ teamId: id, name, slug, description: z.string().max(2000).optional() }))
      .output(system),
    update: route("PATCH", "/v1/systems/{systemId}", "Sửa hệ thống (quản trị đội)", "systems")
      .input(
        z.object({
          systemId: id,
          name: name.optional(),
          slug: slug.optional(),
          description: z.string().max(2000).nullish(),
        }),
      )
      .output(system),
    remove: route("DELETE", "/v1/systems/{systemId}", "Xoá hệ thống (quản trị đội)", "systems")
      .input(z.object({ systemId: id }))
      .output(z.object({ ok: z.literal(true) })),
  },
  orgMembers: {
    list: route("GET", "/v1/members", "Thành viên tổ chức kèm vai trò và đội", "members").output(z.array(orgMember)),
    setRole: route("PATCH", "/v1/members/{userId}/role", "Đổi vai trò tổ chức (chủ sở hữu)", "members")
      .input(z.object({ userId, role: orgRole }))
      .output(z.object({ userId: z.string(), role: orgRole, status: memberStatus })),
    setStatus: route("PATCH", "/v1/members/{userId}/status", "Duyệt hoặc khoá thành viên (quản trị)", "members")
      .input(z.object({ userId, status: z.enum(["active", "blocked"]) }))
      .output(z.object({ userId: z.string(), role: orgRole, status: memberStatus })),
  },
};
