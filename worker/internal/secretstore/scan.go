package secretstore

import (
	"math"
	"regexp"
	"strings"
	"unicode"
)

// Chép nguyên từ worker/internal/ctxsync/secrets.go (FR-021): bên đó không xuất ra, và import ctxsync kéo cả bộ đồng bộ
// ngữ cảnh vào lệnh sidecar. Sửa một bên thì sửa cả bên kia; cả hai cùng kiểm file mẫu secret-scan.json.
var (
	strongSecretPatterns = []*regexp.Regexp{
		regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
		regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abeprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16})\b`),
		regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
	}
	// urlCredRe: nhóm 1 là mật khẩu trong https://user:pass@host. Mật khẩu ngắn vẫn là mật khẩu, chỉ bỏ chỗ giữ chỗ.
	urlCredRe = regexp.MustCompile(`://[^/\s:@]*:([^/\s@]+)@`)
	// Nhóm 1 là giá trị đứng sau "Bearer" hay sau tên có token, secret, password…
	credValuePatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\b(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]{12,})`),
		regexp.MustCompile("(?i)\\b[a-z0-9_.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|credential|private[_-]?key)[a-z0-9_.-]*[\"']?\\s*[=:]\\s*[\"']?([^\\s\"'`,;]+)"),
	}
	// entropyRunRe tách các chuỗi liền giống khoá base64/base64url để đo độ ngẫu nhiên.
	entropyRunRe = regexp.MustCompile(`[A-Za-z0-9+/=_-]{24,}`)
	hexRunRe     = regexp.MustCompile(`^[0-9a-fA-F-]+$`)
)

// minSecretEntropy (bit mỗi ký tự): chuỗi ngẫu nhiên 24 ký tự chữ số đo được khoảng 4,2 trở lên; tên biến, đường dẫn
// ghép từ chữ tiếng Anh lặp chữ nhiều nên thấp hơn 4.
const minSecretEntropy = 4.0

// looksSecret cho biết nội dung có thứ trông như bí mật. Chỉ trả có/không: bên gọi không được đưa nội dung hay chỗ khớp
// vào log hay lỗi.
func looksSecret(s string) bool {
	for _, re := range strongSecretPatterns {
		if re.MatchString(s) {
			return true
		}
	}
	for _, m := range urlCredRe.FindAllStringSubmatch(s, -1) {
		if !placeholder(m[1]) {
			return true
		}
	}
	for _, re := range credValuePatterns {
		for _, m := range re.FindAllStringSubmatch(s, -1) {
			if credentialLike(m[1]) {
				return true
			}
		}
	}
	for _, run := range entropyRunRe.FindAllString(s, -1) {
		if randomLooking(run) {
			return true
		}
	}
	return false
}

// placeholder: chỗ giữ chỗ trong tài liệu (<token>, ${TOKEN}, {{ secrets.X }}, ***, xxxx, ...) không phải bí mật thật.
func placeholder(v string) bool {
	if v == "" || strings.ContainsAny(v[:1], "<$%{[(") {
		return true
	}
	l := strings.ToLower(v)
	return strings.Contains(l, "***") || strings.Contains(l, "xxxx") || strings.Contains(l, "...") ||
		strings.Contains(l, "example") || strings.Contains(l, "your")
}

// credentialLike: giá trị đủ dài, có cả chữ lẫn số. Lời văn ("token: xem PAT", "password: hỏi trưởng nhóm") và tên
// biến (process.env.DB_PASSWORD) không có số nên không bị bỏ nhầm.
func credentialLike(v string) bool {
	if len(v) < 6 || placeholder(v) {
		return false
	}
	var letter, digit bool
	for _, r := range v {
		switch {
		case r >= '0' && r <= '9':
			digit = true
		case unicode.IsLetter(r):
			letter = true
		}
	}
	return letter && digit
}

// randomLooking: chuỗi dài có chữ hoa, chữ thường, số và độ ngẫu nhiên cao. Bỏ qua chuỗi hex (mã commit, UUID).
func randomLooking(run string) bool {
	if hexRunRe.MatchString(run) {
		return false
	}
	var upper, lower, digit bool
	for _, r := range run {
		switch {
		case r >= 'A' && r <= 'Z':
			upper = true
		case r >= 'a' && r <= 'z':
			lower = true
		case r >= '0' && r <= '9':
			digit = true
		}
	}
	return upper && lower && digit && shannon(run) >= minSecretEntropy
}

func shannon(s string) float64 {
	counts := map[rune]int{}
	n := 0
	for _, r := range s {
		counts[r]++
		n++
	}
	var h float64
	for _, c := range counts {
		p := float64(c) / float64(n)
		h -= p * math.Log2(p)
	}
	return h
}
