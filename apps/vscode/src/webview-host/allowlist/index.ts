import { procedures as artifacts } from "@/webview-host/allowlist/artifacts.ts";
import { procedures as chat } from "@/webview-host/allowlist/chat.ts";
import { procedures as docReview } from "@/webview-host/allowlist/doc-review.ts";
import { procedures as review } from "@/webview-host/allowlist/review.ts";
import { procedures as sdlc } from "@/webview-host/allowlist/sdlc.ts";
import type { WebviewScreen } from "@/webview-host/html.ts";

// Mỗi task màn khai báo đường dẫn chính xác ở allowlist/<màn>.ts; không cho phép theo tiền tố.
export const ALLOWED_PROCEDURES: Readonly<Record<WebviewScreen, readonly string[]>> = {
  review,
  sdlc,
  artifacts,
  chat,
  "doc-review": docReview,
};
