# Hub dưới Podman: deploy tự động

Phần chạy trong VM Linux. Cách dựng VM xem [windows-server-2022.md](windows-server-2022.md). Mã nguồn nằm ở `deploy/podman/`.

## Thành phần

| File (cài vào) | Việc |
|---|---|
| `quadlet/hive.network` → `/etc/containers/systemd/` | mạng podman `hive` cho hub và SeaweedFS |
| `quadlet/hive-seaweedfs.container` | SeaweedFS, không publish cổng nào, dữ liệu ở `/srv/hive/seaweedfs` |
| `quadlet/hive-hub.container.in` → `/usr/local/share/xdev-hive/` | mẫu unit của hub; `hive-deploy` sinh ra `/etc/containers/systemd/hive-hub.container` với image **theo digest** |
| `hive-deploy.sh` → `/usr/local/bin/hive-deploy` | deploy pull-based (bên dưới) |
| `hive-rollback.sh` → `/usr/local/bin/hive-rollback` | quay lại image cũ, có kiểm schema |
| `hive-status.sh` → `/usr/local/bin/hive-status` | trạng thái, tài nguyên, lịch sử deploy |
| `systemd/hive-deploy.{service,timer}` | chạy `hive-deploy` mỗi 2 phút |
| `hub.env.example` → `/etc/xdev-hive/hub.env` (600) | thiết lập của hub (`HIVE_*`) |
| `deploy.env.example` → `/etc/xdev-hive/deploy.env` (600) | image, tag, cổng, thời gian chờ, ngưỡng dung lượng |

Dữ liệu (ổ riêng, mount ở `/srv/hive`):

```
/srv/hive/data        hub.db (+ -wal, -shm), settings.json           → /data trong container
/srv/hive/backups     snapshot tự động của hub, files/ của SeaweedFS   → /data/backups
/srv/hive/backups/deploy   snapshot trước mỗi lần deploy
/srv/hive/seaweedfs   dữ liệu SeaweedFS
/srv/hive/logs        deploy.log, log của các lần chạy thử và lần start lỗi
/srv/hive/state       status, history.jsonl, schemas, failed, hold
```

Không có dữ liệu nào chỉ nằm trong lớp ghi của container: container hub chạy `ReadOnly=true`, chỉ ghi được vào `/data` và tmpfs.

## Container chạy thế nào

- Chạy bằng `User=1000:1000` (người dùng `node` của image), `DropCapability=ALL`, `NoNewPrivileges`, filesystem chỉ đọc. Không cần quyền privileged.
- Có `HealthCmd` gọi `/api/health`, chờ khởi động 60 giây, kiểm 30 giây một lần, sai 3 lần thì `HealthOnFailure=kill` và systemd khởi động lại (`Restart=always`).
- `Notify=healthy`: `systemctl start hive-hub` chỉ trả về khi hub đã trả lời, không phải khi process vừa chạy.
- Log của container vào journald (lưu lại qua reboot, tối đa 2 GB): `journalctl -u hive-hub`, `journalctl -u hive-seaweedfs`.
- Luôn chỉ có một hub mở `hub.db`. Mỗi bước deploy đều dừng hub cũ trước khi có gì khác mở database.

## Một lần deploy (`hive-deploy`)

1. **Tìm bản mới.** `skopeo inspect docker://ghcr.io/tdduydev/xdev-hive:prod` cho ra digest. Script bỏ qua nếu digest đó đang chạy, đã từng thất bại (`state/failed`), hoặc đang bị giữ lại sau một lần rollback tay (`state/hold`).
2. **Kiểm image.** Pull theo digest, kiến trúc phải là `amd64`, phải có nhãn `org.opencontainers.image.revision` (chỉ `hub-image.yml` đặt nhãn này). Nếu bật `HIVE_REQUIRE_ATTESTATION=1` thì `gh attestation verify` phải xác nhận image được build từ repo này.
3. **Dung lượng.** Cần còn ít nhất `HIVE_MIN_FREE_MB` cộng ba lần kích thước database.
4. **Snapshot nhất quán.** Dừng hub, rồi chạy CLI của chính hub (`src/cli.ts backup`, dùng `VACUUM INTO`, đọc qua WAL nên không chép file sống). Sau đó kiểm `PRAGMA integrity_check = ok` và `user_version` của snapshot phải bằng của database.
5. **Chạy thử cô lập.** Image mới chạy trên `127.0.0.1:17788`, chỉ trong VM nên không client nào vào được. Nó migrate database và phải trả lời `/api/health`, rồi vẫn healthy sau 15 giây nữa.
6. **Chạy thật.** Ghi unit với image theo digest, `systemctl start`, kiểm health trên cổng 7788. Thành công thì ghi trạng thái, lịch sử, schema của image, rồi dọn image cũ (giữ bản đang chạy và bản trước) và snapshot cũ.

Khoá `flock` bảo đảm mỗi lúc chỉ có một lần deploy, hoặc deploy và rollback, chạy.

### Khi hỏng

| Hỏng ở | Việc script tự làm | Mất dữ liệu? |
|---|---|---|
| bước 1–3 | ghi lỗi, hub cũ vẫn chạy, không dừng gì | không |
| bước 4 (snapshot lỗi) | bật lại hub cũ | không |
| bước 5 (chạy thử) | nếu đã migrate: đặt snapshot trở lại (chỉ lần chạy thử đã ghi, nên không mất gì). Sau đó bật lại image cũ và đánh dấu digest là thất bại | không |
| bước 6, schema không đổi | dừng image mới, bật lại image cũ | không |
| bước 6, schema đã đổi | **không** tự đặt lại snapshot vì client có thể đã ghi; để systemd thử tiếp, ghi rõ việc người phải làm | xem [backup-restore.md](backup-restore.md) |

Log của lần chạy thử và lần start lỗi nằm trong `/srv/hive/logs/`, lịch sử ở `state/history.jsonl`, và `hive-status` cho thấy lần lỗi gần nhất. Digest đã thất bại không bị deploy lại, trừ khi chạy `hive-deploy --force` hoặc tag `prod` trỏ sang digest khác.

## Lệnh thường dùng

```bash
sudo hive-status                     # trạng thái tổng
sudo hive-status --check && echo ok  # cho script giám sát
sudo systemctl list-timers hive-deploy.timer
sudo journalctl -u hive-deploy -n 50  # các lần chạy của timer
sudo tail -n 50 /srv/hive/logs/deploy.log
sudo hive-deploy --force             # thử lại digest đã thất bại
sudo hive-deploy --image ghcr.io/tdduydev/xdev-hive@sha256:<digest>   # deploy một digest cụ thể
podman stats --no-stream
```

Muốn tạm ngưng tự cập nhật: `sudo systemctl stop hive-deploy.timer`. Bật lại: `sudo systemctl start hive-deploy.timer`.
