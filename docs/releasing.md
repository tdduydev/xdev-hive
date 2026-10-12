# Phát hành worker

Bản phát hành của `hive-worker` dựng bằng goreleaser (`worker/.goreleaser.yaml`) khi đẩy tag `v*` lên GitHub
(`.github/workflows/release.yml`).

## Các bước

1. `main` xanh CI, đã có mọi thay đổi cần phát hành.
2. Tạo tag theo semver rồi đẩy lên:

   ```sh
   git tag -a v0.2.0 -m "hive-worker 0.2.0" && git push origin v0.2.0
   ```

3. Workflow chạy test worker, kiểm khoá ký khớp khoá công khai trong repo, dựng 6 bản (linux, darwin, windows ×
   amd64, arm64) thành bản nháp, kiểm chữ ký và số phiên bản trong binary, tạo chứng thực nguồn gốc rồi mới công bố.
   Bản nháp không bao giờ hiện ở `/releases/latest`, nên lỗi giữa chừng không làm máy nào cài nhầm.

Tên file nén không có số phiên bản (`hive-worker_linux_amd64.tar.gz`) để link `/releases/latest/download/...` luôn trỏ
tới bản mới nhất. `install.sh`, `install.ps1` và `worker/internal/update` dựa vào tên này; đổi `name_template` thì sửa
cả ba.

## Khoá ký

`checksums.txt` được ký bằng ECDSA P-256 (chữ ký DER, file `checksums.txt.sig`). Khoá bí mật chỉ nằm trong secret
`WORKER_SIGNING_KEY` của repo; khoá công khai nằm trong `worker/internal/update/release-signing.pem` và chép nguyên vào
`scripts/install.sh`, `scripts/install.ps1` (test Go kiểm ba chỗ giống nhau).

Đổi khoá (lộ khoá hoặc mất secret):

```sh
openssl ecparam -name prime256v1 -genkey -noout -out release-signing.key
openssl ec -in release-signing.key -pubout -out worker/internal/update/release-signing.pem
gh secret set WORKER_SIGNING_KEY < release-signing.key && rm release-signing.key
```

Rồi chép khoá công khai mới vào hai script cài và phát hành bản mới. Worker đang chạy chỉ tin khoá cũ, nên sau khi đổi
khoá, `hive-worker update` của chúng sẽ từ chối bản mới: cài lại bằng script cài trên từng máy.
