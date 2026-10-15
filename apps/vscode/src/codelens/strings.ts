import { addStrings } from "@/lib/i18n.ts";

addStrings(
  {
    "codelens.assign": "Giao agent",
    "codelens.assignSymbol": "Giao agent sửa",
    "codelens.running": "Đang chạy · run #{id}",
    "codelens.queued": "Đang chờ máy · run #{id}",
    "codelens.planning": "Chờ duyệt kế hoạch · run #{id}",
    "codelens.signIn": "Đăng nhập để thấy trạng thái",
    "codelens.hoverScope": "Thuộc {code} (spec {spec})",
    "codelens.hoverTokens": "Nạp khoảng {tokens} token mỗi phiên",
    "codelens.hoverTokensRough": "Nạp khoảng {tokens} token mỗi phiên (ước tính thô, ký tự / 4)",
    "codelens.untrusted": "Workspace chưa tin cậy nên chưa giao được việc cho agent. Hãy tin cậy workspace trước.",
    "codelens.promptTask": "Làm task {code} của spec {spec}: {title}",
    "codelens.promptSymbol": "Sửa {kind} {name} trong {file}, dòng {start}-{end}.",
  },
  {
    "codelens.assign": "Assign to agent",
    "codelens.assignSymbol": "Assign agent to fix",
    "codelens.running": "Running · run #{id}",
    "codelens.queued": "Waiting for a machine · run #{id}",
    "codelens.planning": "Waiting for plan approval · run #{id}",
    "codelens.signIn": "Sign in to see status",
    "codelens.hoverScope": "Belongs to {code} (spec {spec})",
    "codelens.hoverTokens": "Loads about {tokens} tokens per session",
    "codelens.hoverTokensRough": "Loads about {tokens} tokens per session (rough estimate, characters / 4)",
    "codelens.untrusted":
      "This workspace is not trusted, so work cannot be assigned to an agent. Trust the workspace first.",
    "codelens.promptTask": "Do task {code} of spec {spec}: {title}",
    "codelens.promptSymbol": "Fix {kind} {name} in {file}, lines {start}-{end}.",
  },
);
