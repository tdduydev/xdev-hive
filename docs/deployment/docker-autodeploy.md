# Hub trên một máy Docker Compose: tự deploy khi merge vào main

Cho máy chủ Linux chạy hub bằng `deploy/compose.yaml` (Docker Compose). Cơ chế giống bản Podman ([podman-production.md](podman-production.md)): máy chủ tự kéo image mà tag `prod` trên GHCR trỏ tới, theo digest. Không ai phải SSH vào sau mỗi lần merge. Luồng CI/CD tạo ra tag đó xem [cicd.md](cicd.md).

## Cài một lần

Trên máy chủ, bằng một tài khoản nằm trong nhóm `docker` (không cần root):

```bash
git clone https://github.com/tdduydev/xdev-hive.git ~/xdev-hive
cd ~/xdev-hive
cat > deploy/.env <<'EOF'
HIVE_LAN_HOSTS=<địa chỉ máy chủ>
HIVE_LAN_BIND=<địa chỉ máy chủ>
HIVE_LAN_PORT=7780
HIVE_LAN_HTTPS_PORT=7743
# COMPOSE_PROFILES=embed và HIVE_EMBED_URL=http://ollama:11434/v1 để tìm memory theo nghĩa
EOF
chmod 600 deploy/.env
bash deploy/docker/install.sh       # script vào ~/.local/bin, cấu hình ~/.config/xdev-hive/deploy.env, crontab
hive-deploy && hive-status          # deploy lần đầu
```

`install.sh` thêm một dòng crontab chạy `hive-deploy` 2 phút một lần. Sau khi máy khởi động lại, Docker tự bật lại hub (`restart: unless-stopped`) đúng image digest đã deploy lần cuối. Muốn tạm ngưng tự cập nhật thì xoá dòng đó bằng `crontab -e`.

Mỗi image trên máy này phải qua quét lỗ hổng:
- Image hub luôn là image CI đã quét bằng Trivy. Máy chủ không tự build.
- Image bên thứ ba (Caddy cho cổng LAN, SeaweedFS, Ollama) thì quét trước khi dùng, xem mục cuối.

## Một lần deploy

1. Đọc digest của `ghcr.io/tdduydev/xdev-hive:prod` bằng `docker buildx imagetools inspect`. Bỏ qua nếu digest đó đang chạy, đã từng thất bại, hoặc đang bị giữ lại sau một lần rollback.
2. Kéo image theo digest. Kiểm kiến trúc phải là `amd64`, và image phải có nhãn `org.opencontainers.image.revision` (chỉ `hub-image.yml` đặt nhãn này).
3. Kiểm dung lượng đĩa. Checkout repo đúng commit của image, để các file compose khớp với image (kể cả khi rollback).
4. Dừng hub (SQLite chỉ có một writer). Chụp snapshot bằng CLI của hub (`VACUUM INTO`) vào `/data/backups/deploy/` của volume backup, rồi kiểm `integrity_check` và schema.
5. Chạy thử: `docker compose run` image mới chỉ trên `127.0.0.1:17788`. Nó migrate database và phải trả lời `/api/health` hai lần, cách nhau 15 giây.
6. Chạy thật: ghi `deploy/compose.image.yaml` (image theo digest, file không nằm trong repo), rồi `docker compose up -d --no-build hub lan` và chờ container healthy.

Khi hỏng:
- Chạy thử hỏng: nếu đã migrate thì đặt snapshot trở lại, rồi bật image cũ. Không mất gì, vì chỉ lần chạy thử đã ghi.
- Chạy thật hỏng mà schema không đổi: quay về image cũ.
- Chạy thật hỏng mà schema đã đổi: giữ image mới và ghi rõ trong log việc người phải làm.

Digest đã thất bại không bị thử lại, trừ khi chạy `hive-deploy --force`.

Trạng thái và log nằm ở `~/.local/state/xdev-hive/`: `status`, `history.jsonl`, `schemas`, `failed`, `hold`, `logs/deploy.log`, và log của các lần chạy thử và lần start lỗi.

## Lệnh thường dùng

```bash
hive-status                          # health, image, commit, ngày build, lần deploy cuối, tài nguyên
hive-status --check                  # chỉ mã thoát, cho giám sát
tail -f ~/.local/state/xdev-hive/logs/deploy.log
hive-deploy --force                  # thử lại digest đã thất bại
hive-rollback --previous             # về image trước (chỉ khi schema không đổi)
hive-rollback --previous --restore-backup /data/backups/deploy/hub-<thời điểm>.db --accept-data-loss
docker compose -p xdev-hive -f deploy/compose.yaml -f deploy/compose.lan.yaml -f deploy/compose.image.yaml logs -f hub
```

Rollback có khôi phục database sẽ làm mất mọi thứ đã ghi sau snapshot đó. Script chụp database hiện tại trước khi khôi phục; quy tắc giống [backup-restore.md](backup-restore.md).

## Image bên thứ ba

| Dịch vụ | Image | Vì sao |
|---|---|---|
| Caddy (cổng LAN, HTTPS) | `ghcr.io/tdduydev/xdev-hive-caddy:2.11.7` | build lại từ Caddy v2.11.7 bằng Go 1.27 và các gói `golang.org/x` mới (`deploy/images/caddy`). Image chính thức cùng bản còn 4 lỗ hổng HIGH của Go stdlib và `x/net` cũ |
| SeaweedFS | `ghcr.io/tdduydev/xdev-hive-seaweedfs:4.48` | build lại từ SeaweedFS 4.48 như trên (`deploy/images/seaweedfs`); cùng binary `weed`, cùng định dạng dữ liệu |
| Ollama (profile `embed`) | `ollama/ollama:latest` | **ngoại lệ đã được chấp nhận tạm (10/10)**: còn lỗ hổng HIGH trong các thư viện Go cũ. Chỉ nằm trên mạng nội bộ của compose, không publish cổng. Kiểm lại mỗi khi Ollama ra bản mới, hoặc tắt profile `embed` (tìm memory sẽ khớp theo chữ) |

`.github/workflows/deps-images.yml` build và quét Caddy, SeaweedFS trên mỗi PR đụng tới `deploy/images/`. Trên main nó đẩy image lên GHCR, và mỗi tuần build lại để có bản vá Go mới. Còn HIGH hoặc CRITICAL đã có bản sửa thì workflow đỏ, không đẩy gì.

Quét một image ngay trên máy chủ:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/aquasecurity/trivy:0.69.3   image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed <image>
```
