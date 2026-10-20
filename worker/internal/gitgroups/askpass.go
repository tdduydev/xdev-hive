package gitgroups

import (
	"io"
	"net/url"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
)

// AskpassEnv và Askpass giữ ở đây để main.go nhận lượt askpass như trước khi tách gitexec.
const AskpassEnv = gitexec.AskpassEnv

// Askpass trả lời câu hỏi của git cho kết nối của nhóm Git.
func Askpass(args []string, stdout io.Writer) int { return gitexec.Askpass(args, stdout) }

// hostOf là máy chủ kèm cổng của URL clone HTTPS; rỗng với SSH và đường dẫn tại máy.
func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	return u.Host
}
