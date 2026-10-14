package terminal

import "bytes"

// minSecret: chuỗi ngắn hơn thế không che, vì sẽ che nhầm chữ bình thường trên màn hình (vd. giá trị "1").
const minSecret = 8

const mask = "***"

// redactor che bí mật (token MCP, token gói) trong output của PTY trước khi gửi hub. Bí mật có thể bị cắt giữa hai lần
// đọc, nên giữ lại đuôi có thể là đầu của một bí mật tới lần đọc sau. Đuôi giữ quá lâu thì nhả (release) để màn hình
// không đứng; khi đó vẫn nhớ đoạn đã gửi (tail) để phần sau của bí mật vẫn bị che, chỉ lộ phần đầu đã nhả.
type redactor struct {
	secrets [][]byte
	maxLen  int
	held    []byte
	tail    []byte
}

func newRedactor(secrets []string) *redactor {
	r := &redactor{}
	seen := map[string]bool{}
	for _, s := range secrets {
		if len(s) < minSecret || seen[s] {
			continue
		}
		seen[s] = true
		r.secrets = append(r.secrets, []byte(s))
		r.maxLen = max(r.maxLen, len(s))
	}
	return r
}

// push nhận byte mới, trả phần gửi được ngay.
func (r *redactor) push(p []byte) []byte {
	if len(r.secrets) == 0 {
		return p
	}
	buf := append(r.held, p...)
	r.held = nil
	return r.process(buf, true)
}

// release nhả đuôi đang giữ (hết dữ liệu, hoặc giữ đã lâu).
func (r *redactor) release() []byte {
	buf := r.held
	r.held = nil
	if len(buf) == 0 {
		return nil
	}
	return r.process(buf, false)
}

func (r *redactor) holding() bool { return len(r.held) > 0 }

func (r *redactor) process(buf []byte, hold bool) []byte {
	combined := append(append([]byte(nil), r.tail...), buf...)
	off := len(r.tail)
	masked := make([]bool, len(buf))
	for _, s := range r.secrets {
		for i := 0; i < len(combined); {
			j := bytes.Index(combined[i:], s)
			if j < 0 {
				break
			}
			start := i + j
			for k := max(start, off); k < start+len(s); k++ {
				masked[k-off] = true
			}
			i = start + 1
		}
	}
	keep := 0
	if hold {
	suffix:
		for k := min(r.maxLen-1, len(buf)); k > 0; k-- {
			for _, m := range masked[len(buf)-k:] {
				if m {
					continue suffix
				}
			}
			if r.prefixOfSecret(buf[len(buf)-k:]) {
				keep = k
				break
			}
		}
	}
	emit := buf[:len(buf)-keep]
	r.held = append([]byte(nil), buf[len(buf)-keep:]...)
	out := make([]byte, 0, len(emit))
	for i := 0; i < len(emit); i++ {
		if !masked[i] {
			out = append(out, emit[i])
			continue
		}
		out = append(out, mask...)
		for i+1 < len(emit) && masked[i+1] {
			i++
		}
	}
	// tail giữ byte thô đã gửi, đủ dài để nhận ra bí mật bắt đầu trong đó và kết thúc ở lần sau.
	r.tail = append(r.tail, emit...)
	if n := r.maxLen - 1; len(r.tail) > n {
		r.tail = append([]byte(nil), r.tail[len(r.tail)-n:]...)
	}
	return out
}

func (r *redactor) prefixOfSecret(b []byte) bool {
	for _, s := range r.secrets {
		if len(b) < len(s) && bytes.HasPrefix(s, b) {
			return true
		}
	}
	return false
}
