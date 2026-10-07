# 65a — Browser tool

## Chọn Playwright MCP

Seed `browser` dùng `@playwright/mcp@0.0.83` (Apache-2.0), `npx -y {package} --headless`, cho Claude và Codex, `enabledByDefault: false`. Phiên bản được xác minh từ npm khi triển khai; hash lệnh được ghim trong `apps/desktop/test/tools.test.ts`. Migration mới thêm seed bằng INSERT OR IGNORE, giữ mục browser do admin đã tạo. Không bật theo repo legacy.

So nhanh nguồn chính thức: [Playwright MCP](https://github.com/microsoft/playwright-mcp) thiên về thao tác theo accessibility snapshot, form, screenshot và kiểm thử. Có env cho profile/output, JSON config secrets và thay thế giá trị form bằng tên secret. [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) cũng hỗ trợ headless/profile riêng, mạnh về Chrome DevTools và phân tích hiệu năng; telemetry cần cấu hình riêng. Chọn Playwright vì task cần duyệt/test và đăng nhập tài khoản test, không cần phân tích trace hiệu năng. Không dùng extension hoặc profile Chrome cá nhân.

## Vòng đời run

- Admin bật tool browser cho dự án trong danh mục tool. Policy MCP phải cho phép `browser`; máy chỉ tự tin cậy hash seed, sửa lệnh/env/secretEnv cần máy cho phép lại.
- Runner mở rộng `{runDir}` trong env MCP cho cả CLI. Chỉ env hook/MCP được phép chứa nó; check/install/prepare/argv vẫn từ chối.
- `PLAYWRIGHT_MCP_USER_DATA_DIR={runDir}/browser-profile`; `PLAYWRIGHT_MCP_OUTPUT_DIR={runDir}/.xdev-hive/artifacts/browser`. Không chia sẻ cookie giữa run.
- `PLAYWRIGHT_MCP_CONFIG={runDir}/browser.json`: runner ghi JSON `{secrets: {...}}` quyền 0600 từ các biến đã khai báo trong `secretEnv`. File/profile nằm ngoài git và ngoài thư mục artifact, xóa khi run kết thúc.
- Ảnh chụp không truyền filename sẽ vào output-dir; runner thu qua cùng bộ kiểm tra artifact (định dạng, link, giới hạn 20 file / 5 MB mỗi file) và gửi về hub trước cleanup. Nếu cần filename riêng, dùng `.xdev-hive/artifacts/` của worktree: Playwright 0.0.83 giải quyết filename tường minh theo workspace, không theo output-dir.
- Không bật save-session: tránh lưu bản ghi thao tác đăng nhập. Screenshot có thể chứa dữ liệu trang; dùng tài khoản test và chỉ chụp trang được phép giữ. Upload lỗi được ghi trong log; output tạm bị xóa khi cleanup run.

## Tài khoản test

Ví dụ admin đặt `secretEnv: ["TEST_USER", "TEST_PASSWORD"]`; giá trị đặt ở env của profile/máy. Hub giữ tên biến, không giữ giá trị. Thiếu biến thì runner bỏ tool và ghi tên biến thiếu. Sửa secretEnv làm đổi hash, cần máy tin cậy lại.

Agent gọi `browser_fill_form` với `value: "TEST_USER"` / `value: "TEST_PASSWORD"`, hoặc `browser_type` với `text` là tên biến. Playwright tìm tên trong config secrets, điền giá trị thật và che nó trong text kết quả/codegen. Không yêu cầu agent đọc env, không đưa mật khẩu vào prompt hoặc tool arguments. Claude nhận `${NAME}`; Codex nhận `env_vars=["NAME"]`; Docker dùng `-e NAME`, không có giá trị trên argv. Che text không che nội dung pixel của screenshot.

## Container và egress

Runner chuyển riêng tool có handler browser vào container cho cả Claude/Codex, qua cùng selection/trust/policy. Mount writable `{runDir}` tại cùng đường dẫn; secret file không được ghi vào MCP config truyền trên argv. Những tool catalog khác vẫn theo hành vi container cũ.

Image phải có Node/npm, CLI tương ứng, Chrome (Playwright MCP mặc định dùng Chrome) và thư viện hệ thống cần thiết. Cài sẵn browser trong image; không tải trình duyệt trong mỗi run. Không tự thêm `--no-sandbox`; cấu hình browser sandbox theo image/host.

Với network limited, thêm vào danh sách egress của profile:

- `registry.npmjs.org` để npx tải gói và dependency nếu cache chưa có.
- Host trang thử nghiệm, ví dụ `example.com`; thêm host redirect, API, CDN và IdP thực sự được trang dùng.
- Nếu build image tải browser: `cdn.playwright.dev`, `playwright.download.prss.microsoft.com` (và host redirect download thực tế). Đây là nhu cầu lúc cài image; run đã có Chrome không cần chúng.

Không dùng allowed-origins của Playwright làm firewall; egress proxy của Hive là lớp giới hạn mạng. Không tự mở wildcard cho web.

Runner đặt `PLAYWRIGHT_MCP_PROXY_SERVER=http://egress:3128` trong env MCP browser của cả Claude và Codex khi container dùng network restricted, sau selection/trust. Chrome không dùng `HTTP_PROXY`/`HTTPS_PROXY` để điều hướng; Codex còn lọc env kế thừa nên cần cấu hình MCP tường minh. Override này chỉ thuộc run, không sửa catalog/hash. Network open và run trên host giữ proxy đã cấu hình cho tool.

## Kiểm tra

`npm run typecheck`, `npm test`. Test catalog kiểm seed/default/license, migration và hash runner. Test CLI kiểm paths từng run, chỉ tên secret trên argv, file secrets JSON 0600. Test runner kiểm thu ảnh ở output runDir và cleanup, không upload profile/config.

Smoke MCP thật: `node apps/desktop/scripts/browser-smoke.mjs .xdev-hive/artifacts`. Script bật seed trên hub SQLite tạm, chọn bằng runTools, khởi động server stdio bản ghim, mở `https://example.com`, chụp ảnh và đóng browser. Cần Chrome sẵn trên host. Trong sandbox của coding agent mà Chrome không khởi động được: `HIVE_BROWSER_SMOKE_NO_SANDBOX=1 node apps/desktop/scripts/browser-smoke.mjs .xdev-hive/artifacts`; chỉ smoke bỏ sandbox, seed không đổi. Smoke còn mở form cục bộ, điền mật khẩu tổng hợp bằng tên secret và kiểm tra text MCP không lộ giá trị. Bằng chứng run R-65a: `browser-example.png`. Không thay thế kiểm thử một tài khoản thật hoặc Docker thật; container được kiểm bằng fixture Docker.

Hồi quy proxy bằng Chrome thật: `HIVE_BROWSER_PROXY_SMOKE=1 node --test apps/desktop/test/browser-proxy.test.ts`. Test chạy chính proxy `docker/agent/egress.mjs` trên localhost: chứng minh HTTP_PROXY-only đi thẳng tới origin bị cấm; với proxy MCP, trang được phép mở được và origin bị cấm không nhận request. Không cần Docker hoặc website ngoài (npx cần registry.npmjs.org). Cần Chrome chạy được trên máy; có thể thêm `HIVE_BROWSER_SMOKE_NO_SANDBOX=1` cho smoke trong môi trường phù hợp. Khi PATH có wrapper nén output như RTK, dùng PATH chứa Node/npm thật để giữ luồng JSON-RPC stdio nguyên vẹn. Bộ test thông thường bỏ qua smoke này và kiểm wiring runner của Claude/Codex bằng fixture Docker.
