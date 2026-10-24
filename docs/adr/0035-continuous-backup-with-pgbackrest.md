# ADR 0035: Backup liên tục bằng pgBackRest trong image Postgres riêng

- Trạng thái: Chấp nhận
- Ngày: 2026-10-24
- Liên quan: spec 027 US4 (FR-040, FR-041, FR-042, SC-005), research R7 và R14, ADR 0032

## Bối cảnh

Spec 027 đưa hub thành nguồn dữ liệu duy nhất của dự án: mất database là mất dự án. `deploy/backup.sh` chỉ có
`pg_dump` hằng ngày, nên khôi phục mất tới một ngày dữ liệu và bản dump nằm cùng máy với database. FR-040 cần khôi phục
về thời điểm bất kỳ trong 14 ngày, lưu ở máy khác. FR-041 cần diễn tập hằng tháng có biên bản. Constitution VII giữ
self-host đơn giản: không thêm dịch vụ chạy thường trực, mọi image và hệ thống ngoài mới phải có ADR.
`docs/architecture.md` mục 10 đã ghi tên pgBackRest từ trước.

## Quyết định

1. Service `postgres` của `deploy/compose.yaml` build từ `deploy/postgres/Dockerfile`: image gốc (`HIVE_POSTGRES_IMAGE`,
   mặc định `pgvector/pgvector`) cộng gói `pgbackrest` của apt.postgresql.org. Không thêm container hay tiến trình
   thường trực; pgBackRest chỉ chạy khi Postgres đẩy WAL hoặc khi script gọi.
2. `HIVE_BACKUP_REPO` trống thì Postgres chạy như image gốc và chỉ có `pg_dump`. Đặt `s3://<bucket>/<đường dẫn>` (S3
   hay MinIO) hoặc `sftp://<user>@<máy>[:<cổng>]/<đường dẫn>` thì entrypoint ghi cấu hình pgBackRest và bật
   `archive_mode`, `archive_command`, `archive_timeout=300` trên dòng lệnh Postgres. Bỏ biến là tắt ở lần khởi động sau.
3. Kho luôn mã hoá `aes-256-cbc` bằng `HIVE_BACKUP_CIPHER_PASS`; thiếu thì Postgres không khởi động. Kho SFTP phải có
   `known_hosts` của máy kho và kiểm khoá máy chặt. Giữ backup đầy đủ theo thời gian (`repo1-retention-full-type=time`,
   mặc định 14 ngày).
4. `deploy/backup.sh` vẫn `pg_dump`, rồi gọi pgBackRest: đầy đủ mỗi Chủ nhật (UTC), tăng dần các ngày khác. Dùng chung
   cron và khoá với backup/restore.
5. `deploy/pitr-restore.sh <thời điểm>` dừng hub và Postgres, `pgbackrest restore --delta --type=time`, chờ Postgres
   promote, đặt `db_epoch` mới với `restored_to` là thời điểm đó (ADR 0032, research R7), đồng bộ mật khẩu role
   `postgres`, rồi chạy lại `hub` và `hub-jobs`. Thời điểm bắt buộc có múi giờ.
6. `deploy/drill.sh` không dừng hub. Khoá SHARE các bảng chính, tính số dòng và checksum, tạo điểm khôi phục
   (`pg_create_restore_point`), mở khoá; khôi phục tới điểm đó vào container và volume tạm cùng image; so khớp; ghi
   biên bản `<dir>/backups/drills/<ngày>.md` (thời gian khôi phục, thời điểm khôi phục tới, kết quả từng bảng); xoá
   container và volume tạm. Bản tạm không đẩy WAL (`HIVE_BACKUP_ARCHIVE=off`) để timeline mới không lẫn vào kho thật.

## Hệ quả

- Tốt: mất tối đa khoảng 5 phút dữ liệu khi máy hỏng (`archive_timeout`), thay vì một ngày. Kho ở máy khác và mã hoá.
  Diễn tập dùng đúng image và kho của bản thật, có biên bản cho SC-005.
- Tốt: `remote.sh` không đổi lệnh (`compose up -d --build` build luôn image Postgres). Không đặt kho thì hành vi như cũ.
- Xấu: kho không gọi được thì `archive_command` lỗi, WAL dồn trong `pg_wal` tới khi đầy đĩa. Cần theo dõi
  `docker compose logs postgres` và dung lượng đĩa; chưa bật `archive-push-queue-max`.
- Xấu: mật khẩu mã hoá kho là secret mới. Mất mật khẩu là mất mọi bản backup liên tục; cất riêng như `HIVE_MASTER_KEY`.
- Xấu: diễn tập cần trống đĩa bằng cỡ database và chặn ghi vào các bảng chính trong lúc tính checksum (vài giây với
  database nhỏ). Chạy lúc ít người dùng.
- Xấu: deploy đầu tiên sau thay đổi này build image Postgres (cần tải apt) và tạo lại container Postgres.
- Chưa làm: trang admin báo "Chưa có backup liên tục" khi `HIVE_BACKUP_REPO` trống; lịch diễn tập tự động (quản trị
  tự đặt cron hằng tháng).

## Phương án đã cân nhắc

- WAL-G: tương đương về tính năng, ít người trong đội đã dùng; kiến trúc đã chọn pgBackRest.
- `pg_dump` mỗi giờ: không khôi phục được về thời điểm bất kỳ, và mỗi lần dump đọc toàn bộ database.
- Container pgBackRest riêng (repo host): thêm dịch vụ thường trực và SSH giữa hai container, trái constitution VII.
- Snapshot volume của nhà cung cấp: phụ thuộc hạ tầng, máy chủ LAN không có.

## Liên kết

- [spec 027](../../specs/027-hub-client-model/spec.md) FR-040, FR-041, FR-042; [research R14](../../specs/027-hub-client-model/research.md)
- [ADR 0032](0032-client-events-and-outbox.md): khoá chống trùng và hộp thư đi gửi lại sau khôi phục
- [docs/self-hosting.md](../self-hosting.md): cấu hình kho, PITR và diễn tập
