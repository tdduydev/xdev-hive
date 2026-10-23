// Package secretstore giữ bí mật tại máy của người dùng cho agent (specs/031): giá trị trong kho của hệ điều hành, danh
// mục tên và gán dự án trong secrets.json, nhật ký cấp trong secret-grants.jsonl. Không file nào của gói chứa giá trị,
// và không lỗi nào gói trả ra chứa giá trị (FR-036).
package secretstore

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	MaxNameLen = 64
	// MinValueLen tính theo ký tự, MaxValueLen theo byte (FR-005). Giá trị đủ 8 ký tự thì cũng đủ 8 byte, nên bộ che
	// (chỉ che chuỗi từ 8 byte) luôn che được mọi giá trị hợp lệ.
	MinValueLen = 8
	MaxValueLen = 8 << 10
)

// ReservedExact và ReservedPrefixes là tên dành riêng của FR-004, cùng danh sách với
// packages/contracts/src/local-secrets.ts. Bí mật mang tên này sẽ chiếm quyền môi trường của agent hay của chính CLI.
var (
	ReservedExact = []string{
		"PATH", "HOME", "USER", "USERNAME", "USERPROFILE", "SHELL", "COMSPEC", "TEMP", "TMP", "TMPDIR", "PATHEXT",
		"NODE_OPTIONS",
	}
	ReservedPrefixes = []string{
		"HIVE_", "LD_", "DYLD_", "GIT_", "SSH_", "ANTHROPIC_", "OPENAI_", "CLAUDE_", "CODEX_", "GEMINI_",
	}
)

var namePattern = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)

// NormalizeName chuẩn hoá tên người dùng gõ về in hoa (FR-003).
func NormalizeName(s string) string { return strings.ToUpper(strings.TrimSpace(s)) }

// Reserved cho biết tên (đã chuẩn hoá) thuộc nhóm dành riêng. Windows không phân biệt hoa thường tên biến môi trường, nên
// so cả bản in hoa.
func Reserved(name string) bool {
	name = strings.ToUpper(name)
	for _, r := range ReservedExact {
		if name == r {
			return true
		}
	}
	for _, p := range ReservedPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// ValidName kiểm tên đã chuẩn hoá: lỗi invalid_name hay reserved_name.
func ValidName(name string) error {
	if len(name) == 0 || len(name) > MaxNameLen || !namePattern.MatchString(name) {
		return &Error{
			Code:    CodeInvalidName,
			Message: "Tên biến chỉ gồm chữ in hoa, số và `_`, không bắt đầu bằng số, tối đa 64 ký tự.",
		}
	}
	if Reserved(name) {
		return &Error{
			Code:    CodeReservedName,
			Message: fmt.Sprintf("`%s` là tên dành riêng, hãy đặt tên khác.", name),
			Names:   []string{name},
		}
	}
	return nil
}

// ValidValue kiểm giá trị (FR-005). Giá trị phải là UTF-8 hợp lệ: Windows giữ biến môi trường dạng UTF-16, chuỗi hỏng
// sẽ bị đổi byte khi đưa vào tiến trình và trái FR-013.
func ValidValue(v string) error {
	if len(v) > MaxValueLen || utf8.RuneCountInString(v) < MinValueLen || strings.IndexByte(v, 0) >= 0 ||
		!utf8.ValidString(v) {
		return &Error{
			Code:    CodeInvalidValue,
			Message: "Giá trị phải dài từ 8 ký tự đến 8 KiB và không chứa ký tự NUL.",
		}
	}
	return nil
}
