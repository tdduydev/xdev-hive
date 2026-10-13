# Quy tắc cho việc tăng tốc
- Đo TRƯỚC khi sửa và SAU khi sửa, bằng số (ms, số truy vấn, KB), ghi cả cách đo vào tóm tắt. Không sửa thứ không đo được là chậm.
- Mỗi tối ưu một commit riêng, có test giữ hành vi. Không đổi hành vi người dùng thấy (trừ nhanh hơn).
- Máy đang chạy nhiều agent song song: chỉ chạy test liên quan tới phần bạn sửa, không chạy `pnpm check` toàn repo nhiều lần.
