import type { DocsyncFixtureHandler } from "./docsync-settings-fixture.ts";

// T021 bổ sung dữ liệu riêng ở đây để tránh cùng sửa fake-hub.ts.
export function docsyncImportFixture(): Record<string, DocsyncFixtureHandler> {
  return {};
}
