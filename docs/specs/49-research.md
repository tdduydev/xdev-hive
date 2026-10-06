# 49. Nghiên cứu: AI SDLC, điều phối agent, quản trị tri thức

Phụ lục của [49-ux-roles.md](49-ux-roles.md).

- Người tổng hợp: một agent nghiên cứu, ngày 5–6/10/2026.
- Các trang được đọc qua công cụ tóm tắt, không đọc nguyên văn.
- Ghi chú độ tin cậy:
  - [chưa kiểm]: chưa xác nhận được;
  - [suy luận]: tổng hợp của người viết, không phải lời của nguồn.

## Sản phẩm điều phối agent

| Sản phẩm | Điều đã kiểm |
|---|---|
| **Linear** | **Giao (delegate):** người vẫn là chủ issue ([docs](https://linear.app/docs/agents-in-linear)). **Phiên của agent:** có trạng thái `pending/active/awaitingInput/error/complete/stale`; hoạt động chia loại `thought/action/elicitation/response/error`; có checklist kế hoạch ([API](https://linear.app/developers/agent-interaction)). **Hộp thư:** *Priority Inbox* tách việc cần mình ([9/2026](https://linear.app/changelog/2026-09-03-priority-inbox)). **Review:** Linear Diffs, agent sửa theo yêu cầu ([5/2026](https://linear.app/changelog/2026-05-27-linear-diffs)). **Hướng dẫn:** đặt cho workspace hoặc team, của team thắng. |
| **GitHub Copilot / Agent HQ** | **Bảng agent:** có ở mọi trang, thêm một trang agent riêng. **Mỗi phiên:** log, token, thời gian; gõ thêm chỉ dẫn vào phiên đang chạy; dừng, lưu trữ ([docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/track-copilot-sessions)). **Khi review:** đọc log trước rồi mới đọc diff ([blog 12/2025](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/)). **Custom agent:** là file ở cấp repo, tổ chức hoặc doanh nghiệp ([docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-custom-agents)). |
| **Jules** | Có kế hoạch trước khi code, nút *approve plan*. Nếu người rời trang thì kế hoạch tự duyệt sau một khoảng thời gian ([docs](https://jules.google/docs/review-plan/)). |
| **Devin** | Devin Review ([1/2026](https://cognition.com/blog/devin-review)): nhóm và sắp xếp diff theo ý, giải thích từng nhóm, nhận ra code chỉ bị dời chỗ, cờ lỗi theo mức nặng. |
| **Cursor 2.0** | Tối đa 8 agent chạy song song, mỗi agent một worktree. Một khung diff gộp, hoàn tác theo từng agent ([changelog](https://cursor.com/changelog/2-0)). |
| **Factory** | Spec Mode: nghiên cứu chỉ đọc, rồi đưa kế hoạch để duyệt ([docs](https://docs.factory.ai/cli/user-guides/specification-mode)). |
| **Codex cloud** | Xem diff và test, yêu cầu sửa, rồi tạo PR bằng một lần bấm ([OpenAI](https://openai.com/index/introducing-upgrades-to-codex/)). |
| **OpenHands** | Kích hoạt bằng nhãn hoặc @mention trên issue hay PR ([docs](https://docs.openhands.dev/enterprise/integrations/github)). |

## Quản trị tri thức, memory, skill

- **Tài liệu và spec**: Kiro, Spec Kit và AI-DLC đều để markdown trong repo, có lịch sử qua git.
- **Devin Knowledge** ([docs](https://docs.devin.ai/use-cases/gallery/scheduled-knowledge-maintenance)):
  - agent tự gợi ý mục mới;
  - người duyệt từng lần tạo, gộp hay xoá;
  - một phiên chạy hằng tuần gộp mục trùng và đánh dấu mục đã cũ;
  - mỗi mục có mô tả khi nào dùng, và gắn với không repo nào, vài repo hay mọi repo.
- **Claude Code memory** ([docs](https://code.claude.com/docs/en/memory)):
  - có kiểu `user/feedback/project/reference`;
  - có chỉ mục `MEMORY.md` giới hạn 200 dòng;
  - nằm trên từng máy, không có bước duyệt.
- **mem0**: phát hiện trùng bằng LLM cộng hash, có cập nhật và thay thế ([docs](https://docs.mem0.ai/core-concepts/memory-operations/update)).
- **Letta ADE**: xem và sửa từng khối memory, có giới hạn ký tự ([docs](https://docs.letta.com/v1-sdk/ade)).
- **Skill**:
  - Claude skills chỉ nạp tên và mô tả cho tới khi cần ([docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview));
  - Cursor rules có 4 chế độ áp dụng: luôn, theo mô tả, theo glob, gọi tay; ưu tiên Team → Project → User ([docs](https://cursor.com/docs/context/rules));
  - Devin Playbooks là mẫu việc dùng chung, có tiêu chí xong ([docs](https://docs.devin.ai/product-guides/using-playbooks)).
- [chưa kiểm] Không thấy sản phẩm nào có phiên bản cho skill hay thống kê agent nào dùng skill nào.

## Vai trò → việc → artifact → quyết định ([suy luận], tổng hợp từ các khung)

| Vai trò | Việc | Artifact sở hữu | Quyết định duyệt |
|---|---|---|---|
| PO / người yêu cầu | Đưa ý định, làm rõ | Brief, spec, tiêu chí nghiệm thu, ưu tiên | Chốt Spec, đổi phạm vi, nghiệm thu |
| Tech lead / kiến trúc | Thiết kế, giữ chuẩn | Plan, ADR, constitution, skill của nhóm | Chốt Plan, đổi chuẩn, skill, memory |
| Dev / người giao việc | Giao, chỉnh hướng, theo dõi | Task, chỉ dẫn run | Trả lời agent, chạy lại |
| Reviewer | Review | Nhận xét review | Duyệt PR/MR, yêu cầu sửa |
| QA | Kịch bản, giám sát kiểm thử | Test plan, checklist | Chốt kiểm/hội tụ |
| Vận hành / admin | Máy, quyền, phát hành | Cấu hình runner, chính sách | Chốt merge/deploy, quyền |
| Persona agent | Viết nháp mọi artifact, gợi ý memory, skill | Chỉ bản nháp | Không quyết. Chỉ đề xuất, trừ lối tự duyệt bật tay |

## 12 mẫu UX nên học

1. Giao cho agent mà người vẫn là chủ (Linear).
2. Trạng thái "chờ bạn" và hộp thư ưu tiên (Linear).
3. Dòng hoạt động chia loại thay vì log thô (Linear).
4. Kế hoạch → duyệt → chạy (Jules, Factory, Copilot).
5. Độ chặt của chốt đặt theo dự án, có lối nhanh không chốt (Kiro Quick Spec).
6. Chỉnh hướng phiên đang chạy, dừng, lưu trữ (GitHub).
7. Đọc log phiên trước, diff sau; commit nối về log (GitHub).
8. Hỗ trợ review PR của agent: nhóm hunk, giải thích, cờ theo mức nặng (Devin Review).
9. Yêu cầu sửa rồi agent làm tiếp trên cùng diff (Linear Diffs, Codex).
10. Memory do agent gợi ý, người duyệt, cộng việc dọn trùng định kỳ (Devin).
11. Mọi mục tri thức hay skill có phạm vi và lúc áp dụng (Cursor, Devin, Claude skills).
12. Hướng dẫn nhiều lớp, thứ tự ưu tiên rõ: tổ chức → dự án → cá nhân (Cursor, Linear, GitHub).

## Chưa kiểm được

- Những bước nào của AI-DLC v2 có chốt.
- Nguyên văn bài của McKinsey và Gartner.
- BMAD còn persona Scrum Master và QA hay không.
- Tình trạng Cursor Memories và việc Amp chia sẻ công khai.
