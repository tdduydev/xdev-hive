import type { DocsyncFixtureHandler } from "./docsync-settings-fixture.ts";

// T023 bổ sung dữ liệu riêng ở đây để tránh cùng sửa fake-hub.ts.
export function docsyncReviewFixture(): Record<string, DocsyncFixtureHandler> {
  return {};
}
