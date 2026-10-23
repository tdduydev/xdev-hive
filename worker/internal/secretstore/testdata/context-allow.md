## Bí mật tại máy

Phiên này có các biến môi trường sau do người dùng cấp. Dùng qua tên biến (ví dụ `$STRIPE_TEST_KEY`,
`process.env.STRIPE_TEST_KEY`). Không in, không ghi ra file, không commit giá trị. Không hỏi người dùng nhập các giá trị
này.

- `STRIPE_TEST_KEY`: Khoá Stripe môi trường test, quyền đọc
- `DB_URL_STAGING`
