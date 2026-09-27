// Source catalogue: its keys are the keys of every other language. `{name}` is filled in by t().
import type { KeyPaths, Translation } from "../types.ts";

export const vi = {
  common: {
    shared: "Chung",
    sharedTeam: "Chung (cả team)",
    allProjects: "Tất cả dự án",
    close: "Đóng",
    cancel: "Huỷ",
    copy: "Sao chép",
  },
  language: {
    label: "Ngôn ngữ",
  },
  diff: {
    label: "Khác biệt",
    gap: "… {count} dòng không đổi",
    none: "Không có khác biệt.",
  },
  nav: {
    overview: "Tổng quan",
    board: "Board",
    docs: "Tài liệu",
    proposals: "Đề xuất",
    memory: "Memory",
    tasks: "Task",
    agents: "Gói sub & agent",
    machines: "Máy & run",
    setup: "Cài đặt máy",
    admin: "Quản trị",
    users: "Người dùng & quyền",
    tokens: "Token",
    projects: "Dự án & cài đặt",
    groupWork: "Làm việc",
    groupAgents: "Agent & máy",
    groupAdmin: "Quản trị",
  },
  app: {
    connecting: "Đang kết nối…",
    signInAgain: "Đăng nhập lại",
  },
  scope: {
    allHint: "Mọi dự án và dữ liệu chung",
    sharedHint: "Chỉ dữ liệu dùng cho mọi dự án",
    projectHint: "Dữ liệu riêng + dữ liệu chung",
    projects: "Dự án",
    noProjects: "Chưa có dự án nào.",
  },
  login: {
    tagline: "Tài liệu, memory và task dùng chung cho các coding agent của team.",
    username: "Tên đăng nhập",
    password: "Mật khẩu",
    token: "Token truy cập",
    submit: "Đăng nhập",
    submitting: "Đang đăng nhập…",
    useToken: "Dùng token truy cập thay cho tài khoản",
    useAccount: "Đăng nhập bằng tài khoản",
    help: "Tài khoản do admin tạo, kèm mật khẩu tạm; lần đăng nhập đầu sẽ yêu cầu đổi. Quên mật khẩu: nhờ admin đặt lại.",
    sessionExpired: "Phiên đăng nhập đã hết hạn hoặc tài khoản đã bị khoá.",
    tokenInvalid: "Token không hợp lệ hoặc đã bị thu hồi.",
  },
  password: {
    current: "Mật khẩu hiện tại",
    next: "Mật khẩu mới",
    again: "Nhập lại mật khẩu mới",
    tooShort: "Mật khẩu mới cần ít nhất {min} ký tự.",
    mismatch: "Hai lần nhập mật khẩu mới chưa khớp.",
    rules: "Ít nhất {min} ký tự, không chứa tên đăng nhập. Đổi xong, các trình duyệt khác đang đăng nhập sẽ bị đăng xuất.",
    saving: "Đang lưu…",
    firstTitle: "Đặt mật khẩu mới",
    firstBody: "Chào {name}. Bạn đang dùng mật khẩu tạm do admin cấp: đặt mật khẩu của riêng bạn để tiếp tục.",
    firstSubmit: "Lưu và vào hub",
    change: "Đổi mật khẩu",
    changeFor: "Tài khoản {username}",
    changed: "Đã đổi mật khẩu.",
  },
  account: {
    signOut: "Đăng xuất",
    hub: "Hub dùng chung",
    local: "Cục bộ trên máy này",
    noGrants: "Chưa được cấp dự án nào: chỉ thấy dữ liệu Chung.",
    adminAll: "Admin: thấy và quản trị mọi dự án.",
  },
  role: {
    viewer: "chỉ xem",
    agent: "agent",
    member: "thành viên",
    admin: "admin",
  },
  level: {
    view: "Xem",
    contribute: "Đóng góp",
    manage: "Quản trị",
  },
};

export type Catalog = Translation<typeof vi>;
export type MessageKey = KeyPaths<typeof vi>;
