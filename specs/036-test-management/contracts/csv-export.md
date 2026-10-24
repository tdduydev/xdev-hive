# Contract: xuất kết quả đợt ra CSV

Route `testing.rounds.export({roundId})`, `POST /v1/testing/rounds/export`, `.output(z.file())` (FR-062, User Story 7).
Cùng mẫu với `audit.export` (`packages/contracts/src/audit.ts`, `audit/query-service.ts`).

```ts
export: orgRoute("POST", "/v1/testing/rounds/export", "Xuất kết quả đợt ra CSV", "testing")
  .input(z.object({ roundId: z.uuid() }))
  .output(z.file()),
```

## Quyền

- Cần `qa.read` ở đội của dự án có đợt. Đợt của dự án ngoài đội trả `404`, như đợt không tồn tại.
- Xuất được cả đợt `open` và `closed`.
- Ghi audit trong cùng giao dịch: `action = "qa.rounds.export"`, `targetType = "qa_round"`, `targetId = roundId`,
  `data = { count }`. Giống `audit.export`, audit ghi người xuất, không ghi nội dung file. FR-070 không nêu việc xuất;
  người viết thêm vì file chứa ghi chú của tester và rời khỏi hive.

## File

| Thuộc tính | Giá trị |
|---|---|
| Kiểu | `text/csv;charset=utf-8` |
| Mã hoá | UTF-8, ba byte BOM `EF BB BF` ở đầu, để Excel đọc đúng chữ tiếng Việt |
| Xuống dòng | `\r\n`, theo `csvRow()` |
| Tên | `dot-test-<slug tên đợt>-<YYYY-MM-DD>.csv`, ngày tạo file theo giờ máy chủ |
| Số dòng | 1 dòng tiêu đề, rồi mỗi TC trong đợt 1 dòng |
| Thứ tự | mã khu, rồi mã TC |

Hub dựng ô bằng `csvRow()` và `csvCell()` của `audit/csv.ts`. `audit/index.ts` export thêm hai hàm này (research D15).
`csvCell()` thêm `'` trước giá trị bắt đầu bằng `=`, `+`, `@`, `-` (kể cả sau khoảng trắng hoặc BOM), để Excel không
chạy ghi chú của tester như công thức.

## Cột

| # | Tiêu đề | Giá trị |
|---|---|---|
| 1 | Mã | `qa_cases.code` |
| 2 | Tên | `qa_cases.name` |
| 3 | Khu | mã khu và tên khu, ví dụ `DANGNHAP Đăng nhập` |
| 4 | Người được giao | tên hiển thị, cách nhau bằng `; ` |
| 5 | Trạng thái | chữ giao diện (data-model, mục "Mã trạng thái và chữ giao diện"): Đạt, Không đạt, Khác, Chưa test, Không test, Chuyển đợt sau |
| 6 | Bước lỗi | `failed_step`, rỗng khi không có |
| 7 | Ghi chú | `note`; ghi chú đã bị quản trị xoá thì "Ghi chú đã bị quản trị xoá" |
| 8 | Liên kết lỗi | `links`, cách nhau bằng dấu cách |
| 9 | Người ghi | tên hiển thị của `recorded_by`, rỗng khi chưa ghi |
| 10 | Thời điểm | `recorded_at` dạng ISO 8601 UTC, rỗng khi chưa ghi |

- TC `retired` vẫn có dòng, vì nó vẫn ở trong đợt.
- Không có cột kết quả CI: file là kết quả đợt test tay.

[Inference: một đợt có tối đa vài nghìn TC, nên hub dựng file trong bộ nhớ như `exportAudit` mà không cần stream.
Chưa đo với đợt thật.]

## Web

Nút "Xuất CSV" ở trang đợt. Web dùng `api.testing.rounds.export.mutationOptions` và tải file như trang nhật ký
(`apps/web/src/pages/admin/audit-page.tsx`): tạo `URL.createObjectURL(file)`, gán `link.download = file.name`, rồi thu
hồi URL.

## Kiểm

- `qa/export.test.ts`: BOM ở đầu, tiêu đề đúng 10 cột, ghi chú có dấu phẩy, dấu ngoặc kép và xuống dòng, ghi chú bắt
  đầu bằng `=` bị thêm `'`.
- `qa/rounds.db.test.ts`: đợt 20 TC cho 21 dòng; người không có `qa.read` nhận `403`; đợt của dự án ngoài đội nhận `404`;
  audit có `qa.rounds.export`.
