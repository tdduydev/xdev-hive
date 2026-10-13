# Payload webhook mẫu

Payload thật, chép nguyên văn (chỉ định dạng lại khoảng trắng) để test chuẩn hoá sự kiện không phụ thuộc trí nhớ
về định dạng của nhà cung cấp.

- `github/`: từ [octokit/webhooks](https://github.com/octokit/webhooks/tree/main/payload-examples/api.github.com),
  bộ mẫu GitHub dùng để sinh kiểu cho `@octokit/webhooks`. `push.json` là `push/with-new-branch.payload.json`,
  `push.tag-deleted.json` là `push/payload.json`.
- `gitlab/`: khối JSON trong
  [doc/user/project/integrations/webhook_events.md](https://gitlab.com/gitlab-org/gitlab/-/blob/master/doc/user/project/integrations/webhook_events.md).

Biến thể không có mẫu riêng (PR đã merge, MR đóng hay merge, issue GitLab được gắn nhãn, bình luận nhắc bot) được
test dựng bằng cách sửa vài trường của mẫu thật, để phần còn lại của payload vẫn đúng như nhà cung cấp gửi.

`github/pull_files.json` và `gitlab/merge_request_diffs.json` là phản hồi của `GET /pulls/{n}/files` và
`GET /merge_requests/{iid}/diffs`: mục đầu của file GitHub chép từ
[tài liệu REST](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files), các mục còn lại dựng theo cùng
lược đồ để phủ file đổi tên, file bị bỏ patch, file nhị phân và file xoá. Bản GitLab theo lược đồ trong
[doc/api/merge_requests.md](https://gitlab.com/gitlab-org/gitlab/-/blob/master/doc/api/merge_requests.md).
