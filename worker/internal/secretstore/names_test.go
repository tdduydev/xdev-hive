package secretstore

import (
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestValidName(t *testing.T) {
	for _, tc := range []struct {
		name string
		code string
	}{
		{"STRIPE_TEST_KEY", ""},
		{"_X", ""},
		{"A1", ""},
		{strings.Repeat("A", 64), ""},
		{strings.Repeat("A", 65), CodeInvalidName},
		{"", CodeInvalidName},
		{"1ABC", CodeInvalidName},
		{"abc", CodeInvalidName},
		{"A-B", CodeInvalidName},
		{"A B", CodeInvalidName},
		{"Ä", CodeInvalidName},
		{"PATH", CodeReservedName},
		{"NODE_OPTIONS", CodeReservedName},
		{"HIVE_TOKEN", CodeReservedName},
		{"GIT_ASKPASS", CodeReservedName},
		{"ANTHROPIC_API_KEY", CodeReservedName},
		{"DYLD_INSERT_LIBRARIES", CodeReservedName},
		// Chỉ tiền tố có "_" là dành riêng: PATHS, GITHUB_TOKEN không đụng biến của hệ thống hay của git.
		{"PATHS", ""},
		{"GITHUB_TOKEN", ""},
		{"HIVEX", ""},
	} {
		err := ValidName(tc.name)
		var e *Error
		switch {
		case tc.code == "" && err != nil:
			t.Errorf("%q: lỗi %v, muốn hợp lệ", tc.name, err)
		case tc.code != "" && (!errors.As(err, &e) || e.Code != tc.code):
			t.Errorf("%q: lỗi %v, muốn mã %s", tc.name, err, tc.code)
		}
	}
}

func TestReservedIgnoresCase(t *testing.T) {
	if !Reserved("path") || !Reserved("Hive_X") {
		t.Fatal("Windows không phân biệt hoa thường tên biến; tên dành riêng viết thường vẫn phải bị chặn")
	}
	if NormalizeName("  stripe_key ") != "STRIPE_KEY" {
		t.Fatal("NormalizeName phải bỏ khoảng trắng và in hoa")
	}
}

func TestValidValue(t *testing.T) {
	for _, tc := range []struct {
		label string
		value string
		ok    bool
	}{
		{"8 ký tự", "12345678", true},
		{"7 ký tự", "1234567", false},
		{"8 KiB", strings.Repeat("x", MaxValueLen), true},
		{"8 KiB + 1", strings.Repeat("x", MaxValueLen+1), false},
		{"nhiều dòng, nháy, $, Unicode", "dòng 1 'a' \"b\" $HOME\r\nline 2\n", true},
		{"có NUL", "abcd\x00efgh", false},
		{"UTF-8 hỏng", "abcdefgh\xff", false},
		// 3 ký tự tiếng Việt là 9 byte nhưng chỉ 3 ký tự: FR-005 đếm ký tự.
		{"ngắn theo ký tự", "ặặặ", false},
	} {
		err := ValidValue(tc.value)
		if (err == nil) != tc.ok {
			t.Errorf("%s: lỗi %v, muốn hợp lệ=%v", tc.label, err, tc.ok)
		}
		if err != nil && !errors.Is(err, &Error{Code: CodeInvalidValue}) {
			t.Errorf("%s: mã lỗi %v", tc.label, err)
		}
	}
}

// File mẫu dùng chung với packages/contracts/src/local-secrets.ts (T002, luồng D). Chưa có file thì bỏ qua: test bảng ở
// trên vẫn kiểm cùng quy tắc.
const namesFixturePath = "../../../packages/contracts/fixtures/local-secrets.json"

func TestNamesSharedFixture(t *testing.T) {
	data, err := os.ReadFile(namesFixturePath)
	if errors.Is(err, os.ErrNotExist) {
		t.Skip("chưa có packages/contracts/fixtures/local-secrets.json")
	}
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Reserved struct {
			Exact    []string `json:"exact"`
			Prefixes []string `json:"prefixes"`
		} `json:"reserved"`
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if !sameSet(f.Reserved.Exact, ReservedExact) || !sameSet(f.Reserved.Prefixes, ReservedPrefixes) {
		t.Fatalf("tên dành riêng lệch với contracts: %v %v", f.Reserved.Exact, f.Reserved.Prefixes)
	}
	for _, n := range f.Valid {
		if err := ValidName(NormalizeName(n)); err != nil {
			t.Errorf("%q: %v, contracts coi là hợp lệ", n, err)
		}
	}
	for _, n := range f.Invalid {
		if ValidName(NormalizeName(n)) == nil {
			t.Errorf("%q hợp lệ ở worker, contracts coi là không hợp lệ", n)
		}
	}
}

func sameSet(a, b []string) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}
