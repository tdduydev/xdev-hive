import type { DocsyncFixtureHandler } from "./docsync-settings-fixture.ts";

// T022 bổ sung dữ liệu riêng ở đây để tránh cùng sửa fake-hub.ts.
export function docsyncDocsFixture(): Record<string, DocsyncFixtureHandler> {
  return {};
}
