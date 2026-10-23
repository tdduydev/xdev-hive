package terminal

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestRedactorEncodedSecrets(t *testing.T) {
	value := "giá-trị-'\"-thử\nxuống-dòng"
	encoded, _ := json.Marshal(value)
	for _, form := range []string{base64.StdEncoding.EncodeToString([]byte(value)), string(encoded[1 : len(encoded)-1])} {
		cut := len(form) / 2
		if got := feed(newRedactor([]string{value}), "x "+form[:cut], form[cut:]+" y"); got != "x *** y" {
			t.Fatal("terminal chưa che dạng mã hoá qua hai khối")
		}
	}
}

func feed(r *redactor, parts ...string) string {
	var out []byte
	for _, p := range parts {
		out = append(out, r.push([]byte(p))...)
	}
	return string(append(out, r.release()...))
}

func TestRedactorMasksWholeAndSplitSecrets(t *testing.T) {
	secret := "eyJhbGciOi.terminal.token"
	for _, tc := range []struct {
		name  string
		parts []string
		want  string
	}{
		{"nguyên", []string{"a " + secret + " b"}, "a *** b"},
		{"cắt đôi", []string{"a eyJhbGc", "iOi.terminal.token b"}, "a *** b"},
		{"cắt từng byte", strings.Split("x"+secret+"y", ""), "x***y"},
		{"hai lần", []string{secret + secret}, "***"},
		{"không có", []string{"eyJ không phải token", " eyJ"}, "eyJ không phải token eyJ"},
		{"đầu bí mật ở cuối luồng", []string{"kết thúc eyJhbGciOi"}, "kết thúc eyJhbGciOi"},
	} {
		if got := feed(newRedactor([]string{secret, "", "ngắn"}), tc.parts...); got != tc.want {
			t.Errorf("%s: %q, muốn %q", tc.name, got, tc.want)
		}
	}
}

// Đuôi bị nhả vì chờ lâu (màn hình không đứng): phần sau của bí mật tới muộn vẫn bị che nhờ nhớ đoạn đã gửi.
func TestRedactorMasksRestAfterRelease(t *testing.T) {
	secret := "tok-SECRET-123456"
	r := newRedactor([]string{secret})
	first := string(r.push([]byte("x tok-SECR")))
	if first != "x " || !r.holding() {
		t.Fatalf("first = %q, holding = %v", first, r.holding())
	}
	released := string(r.release())
	rest := string(r.push([]byte("ET-123456 y"))) + string(r.release())
	all := first + released + rest
	if strings.Contains(all, secret) || strings.Contains(all, "123456") {
		t.Fatalf("lộ bí mật: %q", all)
	}
	if rest != "*** y" {
		t.Fatalf("rest = %q", rest)
	}
}

func TestRedactorNoSecretsPassThrough(t *testing.T) {
	r := newRedactor(nil)
	if got := string(r.push([]byte("abc"))); got != "abc" || r.holding() {
		t.Fatalf("got %q", got)
	}
}
