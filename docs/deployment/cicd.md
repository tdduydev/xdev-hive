# CI/CD của hub

```
PR ──► CI (ci.yml): npm ci · typecheck · test · build web · build image linux/amd64 · Trivy
                                │ merge vào main
                                ▼
       CI (ci.yml) trên push main: npm ci · typecheck · test · build web
                                │ thành công (workflow_run)
                                ▼
       Hub image (hub-image.yml): build → Trivy → push :sha-<commit> → attestation
                                │
                                ▼ job promote (environment "production")
       :latest và :prod → digest đó
                                │ VM kiểm tag prod 2 phút một lần (pull, không ai đẩy vào)
                                ▼
       hive-deploy: snapshot → chạy thử cô lập → chạy thật → health → (rollback)
```

## Các workflow

| Workflow | Chạy khi | Quyền | Việc |
|---|---|---|---|
| `ci.yml` | mọi PR, push main | `contents: read` | job `check`: cài, typecheck, test, build web. Job `hub-image` (chỉ trên PR): build image không push rồi quét Trivy (HIGH/CRITICAL đã có bản sửa thì làm CI đỏ) |
| `hub-image.yml` | `workflow_run` của CI trên push main, chỉ khi CI thành công | `packages: write`, `id-token: write`, `attestations: write` (chỉ job publish) | checkout đúng commit của lần CI đó, build `linux/amd64`, quét Trivy, push `sha-<commit>`, gắn build provenance attestation, rồi promote `latest` và `prod` theo digest |
| `hub-promote.yml` | bấm tay | `packages: write` | trỏ `prod` về image đã có của một commit trên main (rollback qua CI hoặc phát hành lại) |
| `release.yml` | tag `v*`, bấm tay | `contents: write` | phát hành app desktop. Không đổi gì |

Cách giữ an toàn:
- Image chỉ được build từ commit của main mà CI đã xanh. PR, kể cả từ fork, không bao giờ được push image hay chạm vào production.
- Image được quét trước khi push. Bản đã push và bản đã quét build từ cùng input và cùng cache.
- `concurrency: hub-image` xếp các lần publish và promote thành hàng, không chạy song song.
- Production deploy theo **digest** mà tag `prod` trỏ tới, không theo `latest`. Unit systemd ghi digest, nên reboot vẫn chạy đúng bản đó.
- Các action pin theo commit SHA (ghi kèm tag trong comment).
- Workflow không giữ secret nào khác ngoài `GITHUB_TOKEN`.

## Thiết lập trên GitHub (một lần)

1. **Settings → Environments → New environment `production`.** Muốn mỗi bản phải có người duyệt trước khi lên production thì thêm *Required reviewers*. Không thêm thì bản sẽ lên tự động sau khi merge.
2. **Settings → Actions → General → Workflow permissions:** để mặc định *Read repository contents*. Các workflow tự xin quyền cần thiết cho từng job.
3. **Packages:** sau lần publish đầu, vào package `xdev-hive` trên GHCR:
   - Hoặc đặt *Public* (repo đã public; image không chứa secret).
   - Hoặc giữ *Private*, và tạo một token `read:packages` chỉ để VM `podman login` (xem [windows-server-2022.md](windows-server-2022.md)).
4. Không cần secret nào trong repo cho CI/CD hub. `HIVE_RELEASE_HUB`/`HIVE_RELEASE_TOKEN` chỉ dùng cho `release.yml` của app desktop.

## Rollback bằng CI

Actions → **Hub promote** → Run workflow, nhập commit SHA đầy đủ trên main và lý do. Workflow kiểm commit nằm trên main và image của commit đó đã có, rồi trỏ `prod` về đó. VM sẽ deploy nó như mọi bản khác.

Nếu bản cũ có schema database cũ hơn production, VM sẽ từ chối: nó thấy schema tụt khi chạy thử, hoặc `hive-rollback` từ chối. Khi đó phải làm theo [backup-restore.md](backup-restore.md).

## Kiểm sau khi bật

- Mở một PR: thấy hai check `check` và `hub-image`.
- Merge vào main: CI xanh xong thì workflow **Hub image** chạy. Trên GHCR có tag `sha-<commit>`, `latest`, `prod`.
- Trong VM: `sudo hive-status` thấy `prod now` bằng `image`, và `commit` là commit vừa merge.
