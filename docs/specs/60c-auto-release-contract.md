# 60c: giao diện giữa hàng chờ và phát hành

## Máy Cổng kiểm và lệnh local

Quy trình → Phát hành lưu `releaseMachine` là **ID máy trong machines.list** (vd `runner.gate@token-name`), đồng thời chọn người/tự động trong trần hub. `ai` không tự phát hành: vẫn chờ người. Preset thận trọng/cân bằng giữ chốt người; tối đa mở tự động. Chỉ token có quyền taskWork của đúng ID máy mới báo/lấy/kết thúc lô. Người có projectSettings duyệt, từ chối, đối soát hoặc mở lại hàng chờ.

Cài đặt service trên desktop có mục Phát hành: mảng argv cho prepare, release, deploy và checkLogs; appRollout chỉ bật với service phát hành app desktop qua hub này. Mặc định tắt; cần bật nhận việc từ hub trên máy. Lệnh không chạy qua shell. Secret chỉ ở môi trường máy; không nhập secret vào argv. Hub nhận tên bước, thành công/thất bại, cờ cảnh báo; stdout/stderr giữ trong thư mục auto-release của máy (0600), không upload. Log local có thể chứa secret, không dùng làm artifact.

`prepare` nhận `HIVE_RELEASE_VERSION`, `HIVE_RELEASE_SHA`, `HIVE_RELEASE_BATCH`, `HIVE_RELEASE_TASKS_JSON`. Nó tăng version, đánh dấu roadmap của task trong lô, commit/push metadata theo quy trình service. Helper `node scripts/prepare-auto-release.mjs <manifest> <roadmap>` cập nhật hai file, từ chối version không tăng; wrapper local của service chịu trách nhiệm commit/push. Release tiếp theo dùng script của service; xdev-hive dùng release 59h để soạn ghi chú. Không có lệnh mặc định hay secret mặc định. `deploy` tùy chọn. Nếu appRollout bật, sau release/deploy hub đặt target đúng version, 100%, autoDownload và installWhen=idle (59f). Version phải được upload lên hub trước. Quản trị máy hub pin service được điều khiển rollout toàn hub bằng `HIVE_AUTO_RELEASE_PROJECT=<project>`; bỏ trống thì chỉ giữ rollout thủ công của admin, lệnh rollout tự động bị từ chối. Service khác không thể đổi rollout app toàn hub.

`checkLogs` tùy chọn chạy sau deploy/rollout: dùng bộ gom lỗi 59i hoặc kiểm log của service, exit khác 0 khi vượt ngưỡng lỗi lặp. Cảnh báo không đảo ngược một release đã thành công; hub ghi warning và tạo task OPS-release-log, hiện Hôm nay.

## 60b gọi sau lô xanh

Trước khi lấy/ghép/push lô mới, 60b **phải đọc `autoRelease.list({project}).paused`**. Nếu true, dừng hàng chờ của service. Không tự mở lại.

Sau toàn bộ cổng kiểm cấu hình xanh và đã push nhánh đích hoặc PR/MR đã merge, máy Cổng kiểm gửi kết quả landed qua `mergeQueue.finish`. Hub tạo sự kiện xanh cùng giao dịch chuyển task sang done. Service khác muốn gửi một lô xanh ngoài hàng chờ dùng API:

```ts
await backend.call("autoRelease.green", {
  project, batchId, sha, version, taskIds,
  landed: true,
  checks: allConfiguredChecks.map(name => ({ name, passed: true })),
}, runnerActor);
```

`sha` là SHA đã vào nhánh đích; `version` là stable semver kế tiếp do hàng chờ/service chọn. `checks` phải có **đủ mọi bước cấu hình**, không chỉ bước xanh; 60b chịu trách nhiệm bằng chứng cổng kiểm. Hub không kiểm git từ xa. ID lô và version bất biến; gửi lại cùng sự kiện trả cùng record, không chạy lần hai. Tích hợp 60b: runner đọc release pause trước khi lấy lô; version được chọn trước publication và lưu trong journal của kết quả merge. `mergeQueue.finish` của lô landed tạo green record cùng giao dịch chuyển task sang done, bằng ID `merge-<id>`, đủ các lệnh cấu hình và nhánh đích. MR giữ nguyên SHA, version và outcomes đã kiểm. Nếu chưa pin releaseMachine thì chỉ hoàn tất merge. Version kế tiếp là patch tăng trên version lớn nhất của manifest đã kiểm và các receipt trước đó (kể cả failed); xdev-hive đọc `apps/desktop/package.json`, service khác đọc `package.json`.

Worker desktop lấy `autoRelease.take` khi máy rảnh và được nhận việc, từng lô một, trên đúng máy đã pin lúc nhận green. Worker tạo clone riêng theo lô, dùng remote origin của repo cấu hình, checkout đúng SHA và nhánh đích của lô (fallback targetBranch local hoặc main). Trước lệnh đầu, clone phải sạch; không đổi checkout đang làm việc của người dùng. Clone được giữ để đối soát khi gián đoạn; không tự chạy lại cùng lô. Lệnh prepare chịu trách nhiệm cài dependency nếu cần. Nếu trần hạ trước khi lấy lô tự động, hub chuyển về chờ người. Người duyệt lô qua `autoRelease.decide`; từ chối không chạy.

Hub ghi gate release và record bền vững. Lỗi prepare/release/deploy/rollout: record failed, paused=true, task `OPS-release-<ver>`; nếu ID đã thuộc service khác, hậu tố `-<project>` tránh sửa task của service kia. Hôm nay liên kết tới task và Quy trình. `autoRelease.result` nhận biên nhận gửi lặp, không nhận nội dung log.

## Gián đoạn và đối soát

Worker ghi biên nhận local trước RPC, gửi lại biên nhận khi mất mạng. Record running không tự lấy lại sau restart, tránh lặp deploy. Người kiểm tra máy Cổng kiểm, **dừng/đợi hết process phát hành và đối soát side effect trước** khi bấm “Đã kiểm tra: dừng lô và tạo task OPS” (`autoRelease.reconcile`), sau đó xử lý OPS và mở lại hàng chờ (`autoRelease.resume`). Không tự retry cùng version hay tự rollback production. Sau đối soát thất bại, lô mới dùng version mới.
