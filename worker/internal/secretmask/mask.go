// Package secretmask che giá trị bí mật tại máy (specs/031) trong output của agent, log và thông điệp gửi hub. Gói chỉ
// biết giá trị lúc chạy, không đọc kho: bên cấp (secretstore.Grant) đưa giá trị vào New.
package secretmask

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"slices"
	"strings"
)

// MinLen: chuỗi ngắn hơn thế không che, vì sẽ che nhầm chữ bình thường (FR-033). Cùng ngưỡng với terminal/redact.go.
const MinLen = 8

const (
	Mask  = "[đã che]"
	Stars = "***"
)

// Masker giữ mọi dạng có thể gặp của các giá trị. Dùng chung được giữa nhiều goroutine: sau New không đổi gì.
type Masker struct {
	pats   []pattern
	mask   []byte
	maxLen int
}

// pattern là một dạng của một hay nhiều giá trị; values là chỉ số trong danh sách đưa vào New.
type pattern struct {
	b      []byte
	values []int
}

type Option func(*Masker)

// WithMask đổi chuỗi thay thế, ví dụ Stars cho output đã quen với "***".
func WithMask(mask string) Option { return func(m *Masker) { m.mask = []byte(mask) } }

// New dựng Masker cho values. Giá trị ngắn hơn MinLen bị bỏ qua.
func New(values []string, opts ...Option) *Masker {
	m := &Masker{mask: []byte(Mask)}
	for _, o := range opts {
		o(m)
	}
	index := map[string]int{}
	for i, v := range values {
		if len(v) < MinLen {
			continue
		}
		for _, f := range forms(v) {
			if len(f) < MinLen {
				continue
			}
			k, ok := index[f]
			if !ok {
				k = len(m.pats)
				index[f] = k
				m.pats = append(m.pats, pattern{b: []byte(f)})
				m.maxLen = max(m.maxLen, len(f))
			}
			if !slices.Contains(m.pats[k].values, i) {
				m.pats[k].values = append(m.pats[k].values, i)
			}
		}
	}
	return m
}

// Empty cho biết Masker không che gì, để bên gọi bỏ qua bước quét.
func (m *Masker) Empty() bool { return m == nil || len(m.pats) == 0 }

// forms liệt kê các dạng của v mà agent hay in ra (FR-031, FR-033). Có thể trùng nhau; New bỏ trùng.
func forms(v string) []string {
	out := []string{v}
	b := []byte(v)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		out = append(out, enc.EncodeToString(b))
	}
	out = append(out, url.QueryEscape(v), url.PathEscape(v))
	out = append(out, jsonEscape(v, true), jsonEscape(v, false))
	// Phần bên trong '…' và "…" của shell: 'a'\''b' và "a\$b".
	out = append(out, strings.ReplaceAll(v, `'`, `'\''`))
	out = append(out, strings.NewReplacer(`\`, `\\`, `"`, `\"`, `$`, `\$`, "`", "\\`").Replace(v))

	if lf := strings.ReplaceAll(v, "\r\n", "\n"); strings.Contains(lf, "\n") {
		out = append(out, lf, strings.ReplaceAll(lf, "\n", "\r\n"))
		// Từng dòng riêng: agent hay in lại một phần khối (một dòng khoá PEM, có thể thụt lề khác).
		for _, line := range strings.Split(lf, "\n") {
			out = append(out, line, strings.TrimSpace(line))
		}
	}
	return out
}

// jsonEscape trả phần giữa hai dấu nháy khi v nằm trong chuỗi JSON. Bộ mã hoá của Go thoát <, >, & còn của Node thì
// không, nên lấy cả hai dạng.
func jsonEscape(v string, html bool) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(html)
	_ = enc.Encode(v)
	s := strings.TrimSuffix(buf.String(), "\n")
	return s[1 : len(s)-1]
}

// String che s và trả chỉ số (theo New) của các giá trị đã che, tăng dần, để bên gọi ghi nhận tên bị lộ (FR-037).
func (m *Masker) String(s string) (string, []int) {
	if m.Empty() {
		return s, nil
	}
	b := []byte(s)
	masked, hits := m.mark(b, 0)
	if len(hits) == 0 {
		return s, nil
	}
	return string(m.render(b, masked)), hits
}

// mark đánh dấu byte thuộc một dạng nào đó trong buf[from:]. Dạng bắt đầu trước from (phần đã gửi ở lần trước) vẫn được
// tìm, để phần còn lại của nó bị che.
func (m *Masker) mark(buf []byte, from int) ([]bool, []int) {
	masked := make([]bool, len(buf)-from)
	var hits []int
	for _, p := range m.pats {
		hit := false
		for i := 0; i <= len(buf)-len(p.b); {
			j := bytes.Index(buf[i:], p.b)
			if j < 0 {
				break
			}
			start, end := i+j, i+j+len(p.b)
			if end > from {
				hit = true
				for k := max(start, from); k < end; k++ {
					masked[k-from] = true
				}
			}
			i = start + 1
		}
		if hit {
			hits = append(hits, p.values...)
		}
	}
	slices.Sort(hits)
	return masked, slices.Compact(hits)
}

// render thay mỗi đoạn byte liền bị đánh dấu bằng một mặt nạ, để độ dài output không cho biết độ dài giá trị.
func (m *Masker) render(buf []byte, masked []bool) []byte {
	out := make([]byte, 0, len(buf))
	for i := 0; i < len(buf); i++ {
		if !masked[i] {
			out = append(out, buf[i])
			continue
		}
		out = append(out, m.mask...)
		for i+1 < len(buf) && masked[i+1] {
			i++
		}
	}
	return out
}

// holdFrom trả vị trí đầu của đuôi dài nhất trong buf có thể là phần đầu của một dạng, để Writer giữ lại chờ khối sau.
func (m *Masker) holdFrom(buf []byte) int {
	from := len(buf)
	for _, p := range m.pats {
		for i := max(len(buf)-len(p.b)+1, 0); i < from; i++ {
			j := bytes.IndexByte(buf[i:from], p.b[0])
			if j < 0 {
				break
			}
			i += j
			if bytes.HasPrefix(p.b, buf[i:]) {
				from = i
				break
			}
		}
	}
	return from
}
