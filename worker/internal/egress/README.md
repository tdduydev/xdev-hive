# Egress proxy cho sandbox

Proxy độc lập trong binary worker. File allowlist bắt buộc, rỗng thì chặn mọi đích. Không đọc cấu hình đăng ký worker và không tự thêm miền mặc định.

```sh
hive-worker egress-proxy \
  --allowlist /run/hive/run-id/allowlist.txt \
  --unix-socket /run/hive/run-id/egress.sock \
  --connect-timeout 10s --idle-timeout 60s
```

Có thể thêm `--listen 127.0.0.1:3128`, hoặc chỉ dùng TCP. TCP không có xác thực: chỉ bind vào địa chỉ tin cậy, không công bố cổng cho run khác. Socket có quyền `0600`; thư mục cha phải do runner host tạo riêng, không cho container ghi. Không xoá hay ghi đè socket đang tồn tại. Dừng bằng SIGINT/SIGTERM sẽ đóng HTTP và tunnel đang chạy, xoá socket do listener tạo.

## File allowlist

Mỗi dòng một mục; bỏ qua dòng trống và phần sau `#`:

```text
api.anthropic.com:443
api.openai.com:443
registry.npmjs.org:443
proxy.golang.org:443
sum.golang.org:443
# Ví dụ dự án riêng, chỉ thêm khi được chính sách tổ chức cho phép:
# *.packages.example:443
# 10.20.30.0/24:443
# 10.20.30.40:8443
# [2001:db8::/32]:443
```

Không ghi cổng thì cho phép mọi cổng của mục đó. Tên miền không phân biệt hoa thường, chuẩn hoá IDNA và bỏ dấu chấm cuối; `*.example.com` khớp các miền con ở mọi cấp nhưng không khớp `example.com`. IPv4/CIDR là quyền cho phép rõ cho chính dải IP đó, gồm cả địa chỉ nội bộ; phải duyệt kỹ các mục này. Miền phân giải ra IP nội bộ chỉ được dùng khi vừa có mục miền vừa có mục IP/CIDR khớp cổng. IPv6 bị chặn mặc định kể cả có mục IP/CIDR; `--allow-ipv6` là ngoại lệ vận hành cho tương lai, không dùng cho M6.

Proxy tự phân giải DNS; không dùng proxy từ môi trường. Tất cả địa chỉ IPv4 trả về đều phải qua kiểm tra; chỉ một địa chỉ bị chặn cũng từ chối toàn bộ yêu cầu. AAAA bị bỏ qua khi IPv6 tắt. Chặn loopback, private, link-local, CGNAT, multicast, địa chỉ không định tuyến/reserved và metadata phổ biến (gồm `169.254.169.254`, `100.100.100.200`, `168.63.129.16`, `fd00:ec2::254`). Kết nối trực tiếp tới literal đã kiểm, không tra DNS lần hai và không tái dùng kết nối giữa yêu cầu HTTP.

HTTP thường phải dùng URL tuyệt đối `http://...`, Host phải khớp URL; bỏ header hop-by-hop và Proxy-Authorization khi chuyển tiếp. Redirect trả cho client để yêu cầu tiếp theo kiểm lại đích. Không hỗ trợ HTTP Upgrade.

CONNECT chỉ chuyển tiếp TLS sau khi đọc ClientHello (tối đa 64 KiB, hỗ trợ chia nhiều record). SNI phải khớp host CONNECT sau chuẩn hoá; với IP được cho phép rõ có thể không có SNI, nhưng SNI khác IP vẫn bị chặn. Chặn ClientHello sai cấu trúc, extension lặp và ECH vì ECH che tên đích. Client gửi ClientHello sau HTTP 200: lỗi chính sách trước 200 trả 403 với lý do tiếng Việt; lỗi ClientHello/SNI sau 200 gửi TLS alert rồi đóng, không thể trả thêm một HTTP 403 trong tunnel.

Log JSON mỗi yêu cầu gồm `allowed`, `host`, `port`, `reason`, `bytes_sent`, `bytes_received`. Byte là payload chuyển ra/về upstream (body cho HTTP, dữ liệu TLS cho CONNECT), không tính header HTTP của proxy. Không ghi đường dẫn, query, nội dung, header hay Authorization. Đích bị chặn trước khi chuyển tiếp có byte bằng 0.

## Đề xuất nối runner host

Chưa triển khai runner host trong task này. Đề xuất:

1. Hub tính allowlist cuối cùng cho từng run theo quyền dự án và khoá tổ chức; runner host ghi snapshot vào thư mục riêng do host sở hữu. Container không được sửa file này. Chạy một proxy cho mỗi run, không chia socket/TCP giữa run khác chính sách.
2. Chạy container gVisor với `--network=none`, chỉ mount socket hoặc thư mục socket ở chế độ chỉ đọc. Không mount Docker socket, socket của host khác hoặc file allowlist có quyền ghi. Căn chỉnh UID/quyền để đúng user trong container nối được socket `0600`.
3. Client hỗ trợ Unix socket nối trực tiếp. Với CLI chỉ hỗ trợ HTTP proxy TCP, image cần một relay cục bộ, ví dụ `socat TCP4-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/hive/egress.sock`. Đặt `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` và các biến chữ thường tới `http://127.0.0.1:3128`; để `NO_PROXY`/`no_proxy` rỗng. Proxy là HTTP, kể cả biến HTTPS_PROXY. Relay không phân giải DNS hay mở kết nối ngoài container.
4. Không có mạng ngoài nên client, DNS tự gọi và tiến trình con bỏ qua biến proxy đều không ra mạng được. Env proxy chỉ giúp client dùng đúng đường ra; ranh giới bảo mật là network namespace và các socket được mount. Runner host cần kiểm chứng relay/socket mount với gVisor thực tế, bảo vệ policy/socket của từng run và đóng proxy khi huỷ/hết run.

## Allowlist đề xuất và giới hạn

Danh sách trong ví dụ chỉ là đề xuất theo nhu cầu, không bật tự động: API [Anthropic](https://github.com/anthropics/skills/blob/main/skills/claude-api/curl/examples.md), API [OpenAI](https://developers.openai.com/api/docs), [npm registry](https://docs.npmjs.com/misc/registry/), [Go module proxy/checksum](https://go.dev/doc/modules/managing-dependencies). Nên ưu tiên registry/mirror nội bộ với miền và cổng cụ thể. Go proxy có thể redirect tải archive sang miền khác; miền CDN phải được duyệt riêng sau khi quan sát request bị chặn, hoặc dùng mirror không redirect ra ngoài. Cấu hình GOPROXY chỉ dùng proxy đã duyệt, tránh fallback tải trực tiếp SCM. GitHub/GitLab, dịch vụ đăng nhập gói cá nhân và miền tải artifact chỉ thêm theo dự án, không mở wildcard toàn nhà cung cấp.

Proxy không giải mã TLS, không kiểm HTTP Host/URL bên trong CONNECT, không chặn domain fronting hoặc một API được cho phép tự làm proxy/SSRF, không hạn chế nội dung hay chi phí gửi tới miền hợp lệ. ECH (kể cả GREASE) và TLS thiếu SNI tới miền bị từ chối, có thể cần tắt ECH phía client. Chưa có hot reload, auth TCP, hạn mức đồng thời/băng thông, tích hợp hub/khoá tổ chức hoặc thử nghiệm gVisor/runner. File thay đổi chỉ có tác dụng khi chạy proxy mới. Chính sách cần hạn chế IP/CIDR, wildcard, cổng và các dịch vụ được phép.
