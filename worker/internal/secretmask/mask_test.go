package secretmask

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"slices"
	"strings"
	"testing"
)

// Giá trị giả, có ký tự mà từng cách mã hoá đổi đi: nháy, $, \, /, +, khoảng trắng, Unicode, <&>.
const (
	tricky    = `pa$$ 'w"o\rd/+ặ<&>`
	multiline = "-----BEGIN TEST KEY-----\nAAAAB3NzaC1yc2EAAAADAQAB\n  QmFzZTY0IGxpbmUgdHdv\nend\n"
)

func TestStringForms(t *testing.T) {
	m := New([]string{tricky, multiline})
	cases := map[string]string{
		"gốc":             "token=" + tricky + ";",
		"base64 std":      base64.StdEncoding.EncodeToString([]byte(tricky)),
		"base64 raw":      base64.RawStdEncoding.EncodeToString([]byte(tricky)),
		"base64 url":      base64.URLEncoding.EncodeToString([]byte(tricky)),
		"base64 rawurl":   base64.RawURLEncoding.EncodeToString([]byte(tricky)),
		"QueryEscape":     "https://x.test/?k=" + url.QueryEscape(tricky),
		"PathEscape":      "https://x.test/" + url.PathEscape(tricky) + "/y",
		"JSON Go":         jsonOf(tricky, true),
		"JSON Node":       jsonOf(tricky, false),
		"nháy đơn shell":  `echo '` + strings.ReplaceAll(tricky, `'`, `'\''`) + `'`,
		"nháy kép shell":  `echo "` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, `$`, `\$`).Replace(tricky) + `"`,
		"khối \\n":        "key:\n" + multiline,
		"khối \\r\\n":     "key:\r\n" + strings.ReplaceAll(multiline, "\n", "\r\n"),
		"một dòng":        "dòng: AAAAB3NzaC1yc2EAAAADAQAB.",
		"dòng bỏ thụt lề": "QmFzZTY0IGxpbmUgdHdv",
		"khối trong JSON": jsonOf(multiline, true),
	}
	for label, s := range cases {
		got, hits := m.String(s)
		if leaks(got, tricky, multiline) || len(hits) == 0 || !strings.Contains(got, Mask) {
			// Không in s hay got: chúng chứa giá trị.
			t.Errorf("%s: chưa che (còn lộ=%v, hits=%v)", label, leaks(got, tricky, multiline), hits)
		}
	}
}

func TestStringReportsIndexes(t *testing.T) {
	m := New([]string{"short", "AAAAAAAA-first", "BBBBBBBB-second", "AAAAAAAA-first"})
	got, hits := m.String("x BBBBBBBB-second y AAAAAAAA-first z")
	if got != "x "+Mask+" y "+Mask+" z" {
		t.Fatalf("kết quả %q", got)
	}
	if !slices.Equal(hits, []int{1, 2, 3}) {
		t.Fatalf("chỉ số %v, muốn [1 2 3] (giá trị trùng báo cả hai chỉ số)", hits)
	}
	if got, hits := m.String("không có gì"); got != "không có gì" || hits != nil {
		t.Fatalf("không khớp: %q %v", got, hits)
	}
}

func TestShortValuesAndLinesNotMasked(t *testing.T) {
	m := New([]string{"1234567", "LONG-LINE-ONE\nshort\nend"})
	if m.Empty() {
		t.Fatal("giá trị nhiều dòng đủ dài phải được che")
	}
	got, _ := m.String("id=1234567 short end")
	if got != "id=1234567 short end" {
		t.Fatalf("che nhầm giá trị hay dòng ngắn hơn %d: %q", MinLen, got)
	}
	if got, _ := m.String("x LONG-LINE-ONE x"); got != "x "+Mask+" x" {
		t.Fatalf("dòng ≥%d byte phải bị che: %q", MinLen, got)
	}
	if !New([]string{"", "1234567"}).Empty() {
		t.Fatal("chỉ có giá trị ngắn thì Masker rỗng")
	}
}

func TestOverlapAndAdjacentBecomeOneMask(t *testing.T) {
	m := New([]string{"abcdefgh12", "gh12345678"})
	if got, _ := m.String("[abcdefgh12345678]"); got != "["+Mask+"]" {
		t.Fatalf("hai giá trị chồng nhau: %q", got)
	}
	m = New([]string{"secret-value-1"}, WithMask(Stars))
	if got, _ := m.String("secret-value-1secret-value-1"); got != Stars {
		t.Fatalf("mặt nạ ***: %q", got)
	}
}

func jsonOf(v string, html bool) string {
	b, _ := json.Marshal(v)
	if !html {
		return `"` + jsonEscape(v, false) + `"`
	}
	return string(b)
}

// leaks: s còn chứa giá trị gốc hay một dòng đủ dài của nó.
func leaks(s string, values ...string) bool {
	for _, v := range values {
		if strings.Contains(s, v) {
			return true
		}
		for _, line := range strings.Split(v, "\n") {
			if line = strings.TrimSpace(line); len(line) >= MinLen && strings.Contains(s, line) {
				return true
			}
		}
	}
	return false
}
