# Backup, khôi phục và rollback

Phần này cho hub chạy dưới Podman ([podman-production.md](podman-production.md)). Mọi đường dẫn là đường dẫn trong VM.

## Những gì được backup, ở đâu

| Loại | Tạo khi | Nằm ở | Giữ |
|---|---|---|---|
| snapshot của hub | khi hub khởi động (trước migration), mỗi `HIVE_BACKUP_HOURS`, khi bấm "Backup ngay" trên trang Hub | `/srv/hive/backups/hub-*.db` | `HIVE_BACKUP_KEEP` bản không ghim; bản ghim giữ `HIVE_BACKUP_PIN_DAYS` ngày |
| file của SeaweedFS | cùng lúc với snapshot của hub | `/srv/hive/backups/files/` (đặt tên theo SHA-256) | cùng chu kỳ |
| snapshot trước deploy | mỗi lần `hive-deploy` và `hive-rollback --restore-backup` | `/srv/hive/backups/deploy/hub-*.db` | `HIVE_DEPLOY_BACKUP_KEEP` (mặc định 10) |

Mọi snapshot đều do CLI của chính hub tạo bằng `VACUUM INTO`. SQLite tự đọc cả phần đang nằm trong WAL, nên bản sao luôn nhất quán. **Không chép `hub.db` bằng `cp` khi hub đang chạy**: thiếu `-wal` thì bản sao có thể thiếu dữ liệu hoặc hỏng.

Muốn có bản sao ngoài VM (khuyên làm): chép định kỳ thư mục `/srv/hive/backups` sang một ổ hoặc máy khác, hoặc chụp VHDX dữ liệu bằng Windows Server Backup. Snapshot là file `.db` đã đóng, chép lúc nào cũng an toàn.

```bash
sudo podman run --rm --network none --user 1000:1000 -w /app/apps/web \
  -v /srv/hive/data:/data:Z -v /srv/hive/backups:/data/backups:Z -e HIVE_DB=/data/hub.db \
  --entrypoint node "$(sed -n 's/^Image=//p' /etc/containers/systemd/hive-hub.container)" \
  src/cli.ts backup /data/backups/manual 30          # một snapshot ngay, khi hub đang chạy cũng được
```

## Schema và rollback

Database có số phiên bản schema (`PRAGMA user_version`), bằng số migration đã chạy. Image mới có thể thêm migration, image cũ thì không biết các migration đó. Vì vậy:

- **Rollback chỉ đổi image** chỉ an toàn khi schema hiện tại *không mới hơn* schema mà image đích từng chạy. `hive-rollback` đọc điều này trong `/srv/hive/state/schemas` và từ chối nếu không thoả.
- **Rollback có khôi phục database** đưa database về đúng snapshot trước lần nâng cấp. Mọi thứ đã ghi sau snapshot đó sẽ mất khỏi hub. Script bắt buộc `--accept-data-loss`, và chụp database hiện tại trước khi ghi đè. Nhờ vậy phần dữ liệu bị bỏ vẫn còn trong `backups/deploy/` để đọc lại bằng tay.

`hive-deploy` tự xử lý lỗi xảy ra trong lúc chạy thử (xem bảng trong [podman-production.md](podman-production.md)). Phần dưới đây là cho người, khi lỗi xuất hiện sau khi bản mới đã chạy thật.

### Quay lại bản trước, schema không đổi

```bash
sudo hive-status                         # image, previous, schema
sudo hive-rollback --previous
```

`hive-rollback` ghi image vừa bị bỏ vào `state/hold`, để timer không deploy lại nó trong khi `prod` vẫn trỏ vào đó. Sửa xong thì cho `prod` trỏ sang bản mới hơn (merge bản sửa, hoặc dùng workflow **Hub promote**). Hold tự hết tác dụng vì digest đã khác. Muốn bỏ hold sớm thì xoá dòng tương ứng trong `/srv/hive/state/hold`.

### Quay lại bản trước, schema đã đổi

```bash
sudo ls -lt /srv/hive/backups/deploy/          # snapshot "trước deploy" của lần nâng cấp đó
sudo hive-rollback --previous \
  --restore-backup /srv/hive/backups/deploy/hub-<thời điểm>.db --accept-data-loss
```

Trước khi chạy:
1. Báo người dùng rằng mọi thay đổi từ lúc deploy tới giờ sẽ mất khỏi hub.
2. Chọn đúng snapshot: snapshot mới nhất trong `backups/deploy/` *trước* thời điểm deploy bản lỗi. Xem `state/history.jsonl`, trường `backup` của lần deploy đó.
3. Rollback xong, database lúc trước khi khôi phục nằm ở `backups/deploy/` (bản mới nhất). Nếu cần lấy lại dữ liệu từ đó, mở nó bằng `sqlite3` hoặc một hub thử, không bao giờ bằng hub đang chạy.

## Khôi phục khi mất đĩa dữ liệu

1. Dựng lại `/srv/hive` (ổ mới), chạy `deploy/podman/install.sh`, chép `hub.env` và `deploy.env` từ bản lưu của bạn.
2. Chép snapshot gần nhất thành `/srv/hive/data/hub.db` (owner `1000:1000`, xoá `hub.db-wal` và `hub.db-shm` nếu có).
3. Nếu SeaweedFS cũng mất: `hive-deploy` một lần để có hub, dừng nó, rồi nạp lại file từ backup bằng CLI của hub:

   ```bash
   sudo systemctl stop hive-hub
   sudo podman run --rm --network hive --user 1000:1000 -w /app/apps/web \
     -v /srv/hive/data:/data:Z -v /srv/hive/backups:/data/backups:Z \
     -e HIVE_DB=/data/hub.db -e HIVE_SEAWEEDFS_URL=http://hive-seaweedfs:8888 \
     --entrypoint node <image@digest> src/cli.ts files restore /data/backups
   sudo systemctl start hive-hub
   ```
4. Kiểm bằng `hive-status`, rồi đăng nhập xem tài liệu có hình và task có artifact.

`deploy/restore-drill.sh` diễn tập đúng các bước này trên một hub tạm, không đụng tới hub thật. Nó viết cho Docker trên máy deploy cũ, nhưng các bước giống hệt.
