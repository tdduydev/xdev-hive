package secretstore

import (
	"fmt"
	"strings"
)

// ContextBlock chỉ dùng metadata của phiên, không đọc kho hay ghi file hướng dẫn trong repo.
func ContextBlock(policy string, items []Secret) string {
	if len(items) == 0 {
		return ""
	}
	if policy == PolicyDeny {
		return "## Bí mật tại máy\n\nPhiên này không có bí mật nào được cấp (chính sách tổ chức hoặc người dùng đã từ chối). Nếu cần thông tin đăng nhập,\ndừng và báo người dùng; không đoán, không tìm trong máy.\n"
	}
	var b strings.Builder
	b.WriteString("## Bí mật tại máy\n\nPhiên này có các biến môi trường sau do người dùng cấp. Dùng qua tên biến (ví dụ `$STRIPE_TEST_KEY`,\n`process.env.STRIPE_TEST_KEY`). Không in, không ghi ra file, không commit giá trị. Không hỏi người dùng nhập các giá trị\nnày.\n\n")
	count := 0
	for _, item := range items {
		if ValidName(item.Name) != nil {
			continue
		}
		if count == MaxPerProject {
			break
		}
		count++
		fmt.Fprintf(&b, "- `%s`", item.Name)
		if !looksSecret(item.Description) {
			desc := strings.Join(strings.Fields(item.Description), " ")
			runes := []rune(desc)
			if len(runes) > 200 {
				desc = string(runes[:200])
			}
			if desc != "" {
				fmt.Fprintf(&b, ": %s", desc)
			}
		}
		b.WriteByte('\n')
	}
	return b.String()
}
