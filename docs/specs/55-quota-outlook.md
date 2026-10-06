# 55. Còn dùng được bao nhiêu: phiên 5 giờ, credits, tổng cả nhóm

Viết ngày 6/10. Người dùng nói "đang thiếu các phần liên quan đến số lần reset còn sử dụng được". Họ chọn cả ba:
1. **số phiên 5 giờ còn trong tuần**;
2. **credits / dùng thêm còn lại**;
3. **tổng quota cả nhóm**.

Task: **R-55a** (máy và app), **R-55b** (hub và web).

## Đã kiểm ngày 6/10 trên Mac mini

**`claude -p /usage`** (Claude Code 2.1.291, tài khoản claude-3):
- Có `Current session: 93% used · resets …` và `Current week (all models): 32% used · resets …`.
- Có phần *What's contributing* (context dài, subagent, MCP).
- Không có số lần reset còn lại, không có credits.

**Codex** (codex-cli 0.160.1, file phiên của codex-3), `rate_limits` có:
- `primary` / `secondary` (`used_percent`, `window_minutes`, `resets_at`);
- `credits {has_credits, unlimited, balance}`;
- `plan_type`;
- `spend_control_reached`;
- `rate_limit_reached_type`.

Có hai dòng `limit_id`, là `codex` và `premium`.

**Kết luận:** không CLI nào báo sẵn "số lần reset còn lại", nên Hive tự tính từ số liệu trên.

**`agy -p /usage`** (53, BUG-agy-usage): hai nhóm Gemini và Claude/GPT, mỗi nhóm có `remaining_fraction` cho 5 giờ và tuần, kèm `reset_time`.

## Tính gì

### Số lần reset 5 giờ còn trước khi tuần làm mới

```
resetsLeft = số mốc reset 5 giờ từ bây giờ tới giờ reset tuần
           = 1 + floor((weekResetsAt − sessionResetsAt) / 5 giờ)   (khi sessionResetsAt < weekResetsAt)
```

Đây là số phiên mới còn mở được trong tuần này.

### Số phiên đầy còn dùng được (ước tính)

- **Mức tốn tuần mỗi phiên đầy:** mỗi lần đọc hạn mức, máy ghi `(at, session%, week%)` cho gói, giữ 14 ngày.
  - `weekPerSession` = trung vị của (week% tăng / session% tăng) qua các cửa sổ 5 giờ đã qua, nhân 100.
  - Hiểu là: một phiên dùng hết 100% thì tuần tăng bao nhiêu %.
  - Chưa đủ 3 cửa sổ thì dùng tỉ lệ của cửa sổ hiện tại. Nếu cả hai số còn nhỏ hơn 5% thì để "chưa đủ số liệu".
- **Phiên đầy còn dùng được:** `fullSessionsLeft = (100 − week%) / weekPerSession`.
- **Số hiện ra:** `min(resetsLeft, fullSessionsLeft)`, kèm nhãn *ước tính*.
  - Nếu `fullSessionsLeft < resetsLeft`, hiện thêm câu "Tuần sẽ chạm trần trước khi hết các lần reset".

### Credits và dùng thêm

- **Codex:**
  - `credits.balance`, `has_credits`, `unlimited`;
  - `spend_control_reached`: đã chạm trần chi tiêu thì gắn cờ;
  - `plan_type` hiện cạnh tên gói (plus / pro / team…).
- **Claude:** `/usage` không báo credits hay extra usage. Hiện "không có số liệu", không đoán.
- **Antigravity:** chưa có credits trong `/usage`. Hiện "không có số liệu".

## Hiện ở đâu

### App (R-55a, trang *Agent và quota*, khối quota của 52)

Thêm một dòng cho mỗi gói:

> Còn 23 lần reset 5 giờ tới khi tuần làm mới (T6 05:00) · đủ dùng khoảng 9 phiên đầy *(ước tính)* · credits 0

- Rê chuột vào thì giải thích cách tính.
- Đầu trang có tổng của máy:
  - số gói còn chạy được ngay;
  - tổng chỗ trống (theo `maxConcurrent`);
  - gói reset sớm nhất.

### Web (R-55b, *Máy & agent*, tab mới **Quota**)

- **Bảng mọi gói của mọi máy** trong phạm vi người xem có quyền:
  - máy, gói, loại, `plan_type` / tài khoản;
  - % phiên, % tuần;
  - giờ reset phiên và tuần;
  - lần reset còn và phiên đầy ước tính;
  - credits;
  - trạng thái (rảnh / bận / nghỉ / hết / đăng xuất).
- **Gộp theo `account`:** cùng một tài khoản ở nhiều máy thì là một dòng, kèm danh sách máy, để không đếm hạn mức hai lần.
- **Dòng tổng của cả nhóm** (theo loại gói và chung):
  - gói còn chạy được ngay;
  - tổng chỗ trống;
  - **"có thể giao thêm N agent ngay"**;
  - giờ có thêm hạn mức sớm nhất;
  - tổng phiên đầy ước tính còn trong tuần.
- **Bộ lọc:** loại gói, máy, chỉ gói còn chạy được.
- **Trên điện thoại** bảng thành thẻ (42c).

## Dữ liệu

- Heartbeat `reportedProfile` thêm:
  - `resetsLeft`;
  - `fullSessionsLeft` (`null` khi chưa đủ số liệu);
  - `weekPerSession`;
  - `credits {balance, hasCredits, unlimited} | null`;
  - `planType`;
  - `spendControlReached`.
- Máy tính các số này. Hub chỉ lưu và tổng hợp.
- Lịch sử `(at, session%, week%)` lưu ở `runs.db` của máy (bảng mới, migration của store), xoá sau 14 ngày.

## Test

- **Máy:**
  - tính `resetsLeft` với các mốc giờ giả (cả khi phiên reset sau tuần);
  - `weekPerSession` từ lịch sử mẫu;
  - chưa đủ số liệu;
  - đọc credits và `plan_type` từ dòng `rate_limits` mẫu (đúng dạng ở trên).
- **UI:** dòng mới trong khối quota; bảng Quota trên web (gộp account, dòng tổng, "giao thêm N agent").
- **Smoke / e2e:**
  - ảnh *Agent và quota* có dòng mới;
  - bước e2e web "quota-outlook" (desktop và mobile) với hai máy giả, một account chung.

## Ràng buộc khi làm

- Không đổi luật chọn gói.
- Số ước tính luôn ghi *ước tính*.
- Không tăng version, không đánh dấu roadmap.
