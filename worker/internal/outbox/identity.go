package outbox

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

// Identity là danh tính gửi. Kênh worker chỉ có máy: hub đọc tổ chức và máy từ token, không từ body. Kênh `mcp`, `rpc`
// gửi thay một người, nên mục ghi `userId` lúc tạo để không bao giờ gửi bằng token của người khác (spec 027 FR-018).
// Token không nằm trong mục; lúc gửi mới đọc từ keychain.
type Identity struct {
	HubURL    string `json:"hubUrl"`
	OrgID     string `json:"orgId,omitempty"`
	UserID    string `json:"userId,omitempty"`
	MachineID string `json:"machineId,omitempty"`
	Email     string `json:"email,omitempty"`
}

var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// Key là tên thư mục của danh tính. Người dùng: 16 hex đầu của SHA-256(`hubUrl|userId`), để tên thư mục không lộ email
// hay id và hai hub khác nhau không trộn mục. Máy: `machine-<machineId>`, ký tự lạ bị thay để không thoát ra ngoài thư
// mục outbox.
func (id Identity) Key() string {
	if id.UserID != "" {
		sum := sha256.Sum256([]byte(normalizeHub(id.HubURL) + "|" + id.UserID))
		return hex.EncodeToString(sum[:])[:16]
	}
	return "machine-" + unsafeIDChars.ReplaceAllString(id.MachineID, "_")
}

// IsUser cho biết danh tính là một người (kênh `mcp`, `rpc`), không phải máy.
func (id Identity) IsUser() bool { return id.UserID != "" }

func normalizeHub(u string) string { return strings.TrimRight(u, "/") }
