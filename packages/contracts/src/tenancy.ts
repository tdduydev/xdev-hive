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
/**
 * Thứ hạng `viewer < ba < member < admin` nằm ở hub (specs/011 D27): `ba` là BA/PO, soạn và duyệt tài liệu AI SDLC
 * nhưng không tạo task, không chạy run, nên mọi chỗ đòi `member` vẫn từ chối `ba`.
 */
export const teamRole = z.enum(["admin", "member", "viewer", "ba"]);
export const memberStatus = z.enum(["active", "pending", "blocked"]);
/** Người đăng nhập SSO lần đầu: vào hàng chờ duyệt, hay thành thành viên ngay (chưa thuộc đội nào). */
export const ssoJoin = z.enum(["pending", "member"]);
export const invitationStatus = z.enum(["pending", "accepted", "expired"]);
export type OrgRole = z.output<typeof orgRole>;
export type TeamRole = z.output<typeof teamRole>;
export type MemberStatus = z.output<typeof memberStatus>;
export type SsoJoin = z.output<typeof ssoJoin>;
export type InvitationStatus = z.output<typeof invitationStatus>;

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
  providers: z.array(z.string()).optional(),
  /** Latest creation/refresh of retained Better Auth sessions; null when none remain. */
  lastSeenAt: z.iso.datetime().nullable().optional(),
  teams: z.array(z.object({ teamId: id, name: z.string(), role: teamRole })),
});
const email = z.email("Email không hợp lệ.").trim().toLowerCase();
// Mã mời là chuỗi base64url sinh ngẫu nhiên; giới hạn độ dài để không băm chuỗi tuỳ ý quá lớn.
const inviteToken = z.string().min(16, "Mã mời không hợp lệ.").max(128, "Mã mời không hợp lệ.");

export const invitation = z.object({
  id,
  email: z.string(),
  orgRole,
  teamId: id.nullable(),
  teamName: z.string().nullable(),
  teamRole: teamRole.nullable(),
  status: invitationStatus,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
});
/** Lời mời vừa tạo kèm link. Link chứa mã gốc, chỉ trả đúng một lần lúc tạo; hub chỉ giữ bản băm. */
export const createdInvitation = z.object({ id, email: z.string(), link: z.url(), expiresAt: z.iso.datetime() });
export const invitationPreview = z.object({
  orgName: z.string(),
  email: z.string(),
  status: invitationStatus,
  expiresAt: z.iso.datetime(),
});
export const ssoSettings = z.object({
  /** Cố định theo tổ chức, nên callback URL dán vào nhà cung cấp không đổi khi cấu hình lại. */
  providerId: z.string(),
  callbackUrl: z.url(),
  join: ssoJoin,
  provider: z
    .object({
      issuer: z.string(),
      domain: z.string(),
      /**
       * Tên miền đã được xác minh là của tổ chức. Chưa xác minh thì SSO không tự tạo tài khoản và không tự xếp người vào
       * tổ chức: người mới phải được mời như với GitHub/GitLab.
       */
      domainVerified: z.boolean(),
      clientIdLastFour: z.string().nullable(),
    })
    .nullable(),
  /**
   * Bản ghi TXT đang chờ để chứng minh tổ chức giữ tên miền. `verified`: DNS đã khớp nhưng cấu hình SSO chưa dùng tên
   * miền này (chưa cấu hình, hoặc đang khai tên miền khác); lưu cấu hình với tên miền đó thì nhận xác minh luôn.
   */
  domainVerification: z
    .object({
      domain: z.string(),
      /** Tên bản ghi TXT đầy đủ, vd. `_xdev-hive-verification.congty.vn`. */
      recordName: z.string(),
      recordValue: z.string(),
      expiresAt: z.iso.datetime(),
      verified: z.boolean(),
    })
    .nullable(),
});
/** Trạng thái dựng hub, đọc được khi chưa đăng nhập. */
export const hubSetup = z.object({
  /**
   * Hub chưa có tổ chức nào: trang đăng nhập hiện form tạo tài khoản người quản trị đầu tiên. Không nói email nào được
   * tạo (HIVE_ORG_CREATORS); hub tự từ chối email ngoài danh sách bằng cùng mã lỗi như mọi trường hợp khác.
   */
  firstAdminSignUp: z.boolean(),
  /**
   * Cách đăng nhập ngoài email + mật khẩu mà hub đã cấu hình. Trang đăng nhập chỉ hiện nút của cách đã bật; `sso` là
   * có ít nhất một tổ chức đã khai nhà cung cấp SSO, không nói tên miền nào.
   */
  loginMethods: z.object({ sso: z.boolean(), github: z.boolean(), gitlab: z.boolean() }),
});
export type Org = z.output<typeof org>;
export type MyOrg = z.output<typeof myOrg>;
export type Team = z.output<typeof team>;
export type TeamWithCounts = z.output<typeof teamWithCounts>;
export type System = z.output<typeof system>;
export type TeamMember = z.output<typeof teamMember>;
export type OrgMember = z.output<typeof orgMember>;
export type Invitation = z.output<typeof invitation>;
export type CreatedInvitation = z.output<typeof createdInvitation>;
export type InvitationPreview = z.output<typeof invitationPreview>;
export type SsoSettings = z.output<typeof ssoSettings>;
export type HubSetup = z.output<typeof hubSetup>;

const ORG_HEADER = "Tổ chức lấy từ header `x-hive-org`.";
const route = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: `/v1/${string}`,
  summary: string,
  tag: string,
) => oc.route({ method, path, summary, tags: [tag], description: ORG_HEADER }).errors(errors);

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
  hubSetup: {
    get: oc
      .route({
        method: "GET",
        path: "/v1/setup",
        summary: "Trạng thái dựng hub (không cần đăng nhập)",
        tags: ["orgs"],
      })
      .errors(errors)
      .output(hubSetup),
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
    approve: route("POST", "/v1/members/{userId}/approve", "Duyệt người đang chờ (quản trị)", "members")
      .input(z.object({ userId }))
      .output(z.object({ userId: z.string(), role: orgRole, status: memberStatus })),
    deny: route(
      "POST",
      "/v1/members/{userId}/deny",
      "Từ chối người đang chờ, chuyển sang bị khoá (quản trị)",
      "members",
    )
      .input(z.object({ userId }))
      .output(z.object({ userId: z.string(), role: orgRole, status: memberStatus })),
  },
  invitations: {
    create: route(
      "POST",
      "/v1/invitations",
      "Mời người vào tổ chức (quản trị; mời làm quản trị cần chủ sở hữu)",
      "invitations",
    )
      .input(
        z
          .object({
            emails: z.array(email).min(1, "Cần ít nhất một email.").max(50, "Mời tối đa 50 email mỗi lần."),
            orgRole: z.enum(["admin", "member"]).default("member"),
            teamId: id.optional(),
            teamRole: teamRole.optional(),
          })
          .refine((v) => !v.teamRole || v.teamId, {
            message: "Chọn đội trước khi chọn vai trò đội.",
            path: ["teamRole"],
          }),
      )
      .output(z.object({ invitations: z.array(createdInvitation) })),
    list: route("GET", "/v1/invitations", "Lời mời của tổ chức (quản trị)", "invitations").output(z.array(invitation)),
    revoke: route("DELETE", "/v1/invitations/{invitationId}", "Thu hồi lời mời chưa dùng (quản trị)", "invitations")
      .input(z.object({ invitationId: id }))
      .output(z.object({ ok: z.literal(true) })),
    // Mã đi trong body chứ không trong query: query string hay bị ghi vào log của proxy.
    preview: oc
      .route({
        method: "POST",
        path: "/v1/invitations/preview",
        summary: "Xem lời mời theo mã (không cần đăng nhập)",
        tags: ["invitations"],
      })
      .errors(errors)
      .input(z.object({ token: inviteToken }))
      .output(invitationPreview),
    accept: oc
      .route({ method: "POST", path: "/v1/invitations/accept", summary: "Nhận lời mời", tags: ["invitations"] })
      .errors(errors)
      .input(z.object({ token: inviteToken }))
      .output(myOrg),
  },
  ssoProviders: {
    get: route("GET", "/v1/sso", "Cấu hình SSO (OIDC) của tổ chức (quản trị)", "sso").output(ssoSettings),
    upsert: route("PUT", "/v1/sso", "Lưu cấu hình SSO (OIDC) của tổ chức (quản trị)", "sso")
      .input(
        z.object({
          issuer: z.url({ protocol: /^https?$/, error: "Issuer URL không hợp lệ." }),
          domain: emailDomain,
          clientId: z.string().trim().min(1, "Thiếu Client ID."),
          /** Bỏ trống khi sửa thì giữ secret cũ. */
          clientSecret: z.string().min(1).optional(),
          join: ssoJoin,
        }),
      )
      .output(ssoSettings),
    remove: route("DELETE", "/v1/sso", "Gỡ SSO của tổ chức (quản trị)", "sso").output(ssoSettings),
    requestDomainVerification: route(
      "POST",
      "/v1/sso/domain-verification",
      "Lấy bản ghi TXT để xác minh tên miền SSO (quản trị)",
      "sso",
    )
      .input(
        z.object({
          /** Bỏ trống thì dùng tên miền của cấu hình SSO đang lưu. */
          domain: emailDomain.optional(),
        }),
      )
      .output(ssoSettings),
    checkDomainVerification: route(
      "POST",
      "/v1/sso/domain-verification/check",
      "Kiểm bản ghi TXT và xác minh tên miền SSO (quản trị)",
      "sso",
    ).output(ssoSettings),
  },
};
