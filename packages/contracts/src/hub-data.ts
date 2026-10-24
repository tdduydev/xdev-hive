/** Danh mục dùng chung cho trang quản trị, hồ sơ SOC và kiểm tra bảng database (spec 027 US5). */
export interface HubDataCategory {
  id: string;
  label: string;
  tables: readonly string[];
  source: string;
  retention: string;
  deliberate: boolean;
}

const category = (
  id: string,
  label: string,
  names: string,
  source: string,
  retention: string,
  deliberate = true,
): HubDataCategory => ({
  id,
  label,
  tables: names.split(" ").map((name) => `${id === "identity" ? "auth" : "hive"}.${name}`),
  source,
  retention,
  deliberate,
});

export const HUB_DATA_INVENTORY: readonly HubDataCategory[] = [
  category(
    "migrations",
    "Lịch sử nâng cấp database",
    "migrations",
    "Tiến trình migration của hub.",
    "Giữ cùng database để xác định phiên bản schema.",
    false,
  ),
  category(
    "identity",
    "Danh tính và xác thực hub",
    "user session account verification ssoProvider jwks oauthClient oauthResource oauthClientResource oauthRefreshToken oauthAccessToken oauthConsent oauthClientAssertion",
    "Đăng nhập, SSO, OAuth; có thông tin xác thực của hub và nhà cung cấp đăng nhập.",
    "Tài khoản tới khi xoá; phiên và token theo hạn của cơ chế xác thực.",
  ),
  category(
    "tenancy",
    "Tổ chức và quyền",
    "orgs org_members teams team_members systems invitations custom_roles member_custom_roles team_custom_roles",
    "Quản trị tổ chức và thành viên.",
    "Tới khi xoá tổ chức, thành viên hoặc lời mời.",
  ),
  category(
    "catalog",
    "Metadata dự án",
    "projects project_members project_provision_steps merge_queue_entries",
    "Người dùng và API nhà cung cấp Git; không phải bản clone repo.",
    "Tới khi xoá dự án hoặc bản ghi liên quan.",
  ),
  category(
    "governance",
    "Chính sách tổ chức",
    "agent_policies",
    "Quản trị tổ chức.",
    "Tới khi thay thế hoặc xoá tổ chức.",
  ),
  category(
    "layers",
    "Cấu hình có khoá",
    "config_layer_entries",
    "Cấu hình chung và cấu hình dự án.",
    "Tới khi xoá mục cấu hình hoặc phạm vi sở hữu.",
  ),
  category(
    "tasks",
    "Việc và kế hoạch",
    "tasks plans task_dependencies",
    "Người dùng, SCM và đề xuất agent.",
    "Tới khi xoá task hoặc dự án.",
  ),
  category(
    "runs",
    "Tiến độ và báo cáo run",
    "runs run_events run_leases",
    "Worker và hub: pha, mã thoát, thời gian, chi phí, báo cáo, chỉ dẫn đã che secret; báo cáo có thể chứa đoạn output kiểm tra.",
    "Tới khi xoá run hoặc dữ liệu cha; lease theo vòng đời run.",
    false,
  ),
  category(
    "legacy-run-logs",
    "Log run đã có trước chuyển đổi",
    "run_logs",
    "Worker cũ đã ghi trước khi nâng cấp; không ghi log run mới.",
    "Job dọn theo runLogRetentionDays của tổ chức: 30, 90 hoặc 365 ngày.",
    false,
  ),
  category(
    "terminal",
    "Terminal từ xa (ngoại lệ spec 010)",
    "terminal_sessions terminal_chunks terminal_events remote_devices push_subscriptions machine_remote_state",
    "Worker, chủ máy và người được phép xem/điều khiển; vẫn ghi output đã che secret để phát lại cho người vào sau.",
    "Output theo runLogRetentionDays; metadata, thiết bị và quyền tới khi xoá hoặc thu hồi.",
    false,
  ),
  category(
    "fleet",
    "Máy và điểm sử dụng token",
    "machines machine_tokens registration_tokens desktop_connect_codes machine_token_scores project_token_usage",
    "Đăng ký máy, worker; khoá công khai và thông tin cấp token, không có khoá riêng máy.",
    "Máy tới khi xoá; mã đăng ký/kết nối theo hạn; điểm theo chính sách của module.",
    false,
  ),
  category(
    "scm",
    "Kết nối Git và webhook",
    "scm_connections run_git_tokens webhook_deliveries",
    "Quản trị và GitHub/GitLab; có thông tin xác thực kết nối được bảo vệ ở hub.",
    "Kết nối tới khi xoá; token run bị thu hồi theo vòng đời và hạn của nhà cung cấp.",
  ),
  category(
    "knowledge",
    "Tài liệu, memory, skill và duyệt",
    "memories docs doc_versions skills skill_versions skill_pack_settings proposals legacy_imports legacy_doc_assets skill_repos review_workflows review_instances review_gate_runs doc_drafts doc_suggestions doc_threads doc_comments doc_snapshots doc_presence project_briefs doc_chunks",
    "Nội dung người dùng hoặc agent chủ đích gửi; có thể chứa code/đoạn log trong tài liệu.",
    "Tới khi xoá nội dung hoặc phạm vi sở hữu; lịch sử theo chính sách của module.",
  ),
  category(
    "docsync",
    "Đồng bộ và nhập tài liệu",
    "doc_homes doc_repo_files doc_sync_batches doc_conflicts doc_imports doc_assets doc_extracts doc_import_files doc_word_imports doc_word_import_files",
    "Kho tài liệu Git và file người dùng nhập; có bản trích, tài liệu và đính kèm.",
    "Tới khi xoá nguồn hoặc mục nhập; file tạm theo công việc nhập.",
  ),
  category(
    "artifacts",
    "Sản phẩm được chủ đích gửi",
    "artifacts artifact_versions artifact_links artifact_previews artifact_public_links",
    "Người dùng và agent; có thể chứa code hoặc nội dung chia sẻ.",
    "Theo chính sách artifact và thùng rác; link theo hạn hoặc tới khi thu hồi.",
  ),
  category(
    "codereview",
    "Duyệt code",
    "code_reviews code_review_gate_runs code_review_comments code_review_comment_links",
    "SCM, AI và người duyệt; bình luận có thể chứa đoạn code/log.",
    "Tới khi xoá review hoặc dữ liệu cha.",
  ),
  category(
    "sdlc",
    "Cổng AI SDLC",
    "sdlc_modes sdlc_items sdlc_qa_cases sdlc_item_projects sdlc_item_phases sdlc_artifacts sdlc_artifact_syncs sdlc_questions sdlc_steps sdlc_item_tasks sdlc_trace_links sdlc_overrides sdlc_auto_approvals",
    "Cấu hình, tài liệu, kết quả bước và quyết định duyệt.",
    "Tới khi xoá hạng mục, cấu hình hoặc phạm vi sở hữu.",
  ),
  category(
    "skilllearn",
    "Đề xuất học skill",
    "skill_learning_batches skill_learning_marks learned_skill_proposals",
    "Đánh dấu của người dùng và báo cáo agent.",
    "Tới khi xoá đề xuất, lô hoặc dữ liệu cha.",
  ),
  category(
    "leader",
    "Trao đổi với leader",
    "chat_threads chat_messages approvals leader_delegations",
    "Người dùng và agent gửi tin, kế hoạch và đề xuất hành động.",
    "Tới khi xoá cuộc trao đổi hoặc dữ liệu cha.",
  ),
  category(
    "chat",
    "Kênh chat tích hợp",
    "chat_bots chat_org_settings chat_link_codes chat_links chat_outbox chat_usage",
    "Quản trị, bot và nhà cung cấp chat; có cấu hình xác thực bot.",
    "Mã liên kết theo hạn; cấu hình và lịch sử theo vòng đời kênh.",
  ),
  category(
    "mcp",
    "MCP và plugin",
    "mcp_tool_overrides mcp_user_tokens mcp_server_rules",
    "Quản trị, token của người dùng và quy tắc công cụ.",
    "Tới khi xoá hoặc thu hồi; token theo hạn.",
  ),
  category(
    "delivery",
    "CI và deploy",
    "ci_jenkins_connections ci_jenkins_user_tokens deploy_connections ci_project_jobs ci_runs_seen deploy_servers deploy_environments deploy_targets deploys deploy_log_chunks deploy_approvals delivery_jobs delivery_runners",
    "API CI/CD, quản trị và kết quả deploy; có credential kết nối, log deploy đã che secret (khác log run), việc giao cho worker và tên credential máy báo (không có giá trị).",
    "Log deploy theo chính sách giữ log; cấu hình và lịch sử tới khi xoá hoặc thu hồi.",
  ),
  category(
    "qa",
    "Kiểm thử",
    "qa_settings qa_project_settings qa_areas qa_cases qa_case_versions qa_case_status qa_ci_sources qa_ci_runs qa_ci_run_cases qa_rounds qa_round_cases qa_round_assignees qa_result_history",
    "Test case đọc từ docs home, kết quả test của CI (chỉ mã TC và số liệu, không có tên test hay thông báo lỗi) và kết quả tay của tester.",
    "Thư viện test case tới khi xoá dự án; kết quả CI và kết quả tay theo thời hạn giữ của tổ chức, mặc định 365 ngày.",
  ),
  category(
    "sandbox",
    "Cấu hình sandbox",
    "sandbox_org_settings egress_allowlists env_images",
    "Quản trị tổ chức/dự án.",
    "Tới khi xoá hoặc thay thế cấu hình.",
  ),
  category(
    "notify",
    "Thông báo",
    "notification_channels inbox_items notifications",
    "Cấu hình người dùng và sự kiện hub; có thông tin xác thực kênh.",
    "Tới khi xoá thông báo, kênh hoặc dữ liệu cha.",
  ),
  category(
    "audit",
    "Nhật ký kiểm toán",
    "audit_log audit_settings",
    "Thao tác API, MCP và quyết định nghiệp vụ; nội dung sự kiện theo từng module.",
    "Theo audit retention của tổ chức; không dùng thời hạn log run.",
    false,
  ),
  category(
    "blobs",
    "File đính kèm",
    "blobs blob_chunks",
    "Nội dung được chủ đích tải lên qua tính năng tài liệu/artifact.",
    "Theo vòng đời nội dung tham chiếu.",
  ),
  category(
    "client-events",
    "Kết quả sự kiện client",
    "client_events",
    "Client gửi khoá chống trùng, nguồn, thời điểm, kết quả xử lý và phản hồi nghiệp vụ.",
    "30 ngày.",
    false,
  ),
];

export const HUB_DATA_NOTES = [
  "Log run mới nằm ở DataDir/runlogs của máy chạy, xoá theo runLogRetentionDays được chụp lúc giao run (30, 90 hoặc 365 ngày; mặc định 365).",
  "Để giữ hive attach của spec 010, log run đã che secret vẫn đi qua hub và giữ tạm trong RAM: tối đa 5 phút, 1 MiB mỗi run, 32 MiB/256 run mỗi tiến trình. Nối lại quá cửa sổ này hoặc sau khi hub khởi động lại có thể thiếu log; file trên máy là bản đầy đủ.",
  "Ngoại lệ spec 010: terminal_chunks vẫn được ghi để người vào sau phát lại phiên từ xa. Vì vậy chưa thể tuyên bố mọi output terminal ở lại máy.",
  "Hub không tự tải bản clone repo, khoá riêng máy, kho secret dự án cục bộ hay tài khoản CLI AI lên. Tài liệu, artifact, bình luận và báo cáo do người dùng/agent gửi vẫn có thể chứa code hoặc đoạn log.",
  "Hub vẫn giữ credential cần cho đăng nhập, SCM, CI/deploy, MCP, bot và thông báo. Che secret theo mẫu là lớp phòng vệ, không bảo đảm nhận ra mọi bí mật tuỳ ý.",
  "PostgreSQL còn giữ dữ liệu vận hành của pg-boss và lịch sử migration; backup có thể chứa dữ liệu cũ tới khi hết hạn backup. Không xoá bảng hay dữ liệu cũ trong lần chuyển đổi này.",
] as const;

export function hubDataMarkdown(): string {
  const rows = HUB_DATA_INVENTORY.map(
    (c) =>
      `| ${c.label} | ${c.tables.map((t) => `\`${t}\``).join(", ")} | ${c.source} | ${c.retention} | ${c.deliberate ? "Có" : "Tự động / hỗn hợp"} |`,
  );
  return `# Dữ liệu hub giữ\n\nSinh từ \`HUB_DATA_INVENTORY\` trong \`packages/contracts/src/hub-data.ts\`. Cập nhật bằng \`node packages/contracts/scripts/hub-data.ts\`.\n\n${HUB_DATA_NOTES.map((n) => `- ${n}`).join("\n")}\n\n| Loại dữ liệu | Bảng | Nguồn | Thời gian giữ | Gửi có chủ đích |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
}
