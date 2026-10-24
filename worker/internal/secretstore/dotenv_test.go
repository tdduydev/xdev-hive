package secretstore

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseDotenv(t *testing.T) {
	src := strings.Join([]string{
		"\xef\xbb\xbf# chú thích",
		"",
		"PLAIN=plain-value-1234 # chú thích cuối dòng",
		"export EXPORTED=exported-value",
		"  lower_case = spaced-value  ",
		`DOUBLE="line1\nline2 \"q\" \\ \x"`,
		`SINGLE='raw \n # not comment'`,
		`MULTI="first`,
		`second"`,
		"HASH=abc#def",
		"EMPTY=",
		"no equals sign",
		"1BAD=value-value",
		"PATH=/usr/bin:/bin",
		"PLAIN=again-value-1234",
		`TRAILING="x" junk`,
		`UNCLOSED="never closed`,
		"AFTER=swallowed",
	}, "\r\n")
	entries, problems := ParseDotenv([]byte(src))
	want := []DotenvEntry{
		{3, "PLAIN", "plain-value-1234"},
		{4, "EXPORTED", "exported-value"},
		{5, "LOWER_CASE", "spaced-value"},
		{6, "DOUBLE", "line1\nline2 \"q\" \\ \\x"},
		{7, "SINGLE", `raw \n # not comment`},
		{8, "MULTI", "first\nsecond"},
		{10, "HASH", "abc#def"},
		{11, "EMPTY", ""},
	}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("entries:\n%+v\nmuốn\n%+v", entries, want)
	}
	type got struct {
		line int
		name string
		code string
	}
	var gotProblems []got
	for _, p := range problems {
		gotProblems = append(gotProblems, got{p.Line, p.Name, p.Err.Code})
	}
	wantProblems := []got{
		{12, "", CodeFileFormat},
		{13, "", CodeInvalidName},
		{14, "PATH", CodeReservedName},
		{15, "PLAIN", CodeDuplicateName},
		{16, "", CodeFileFormat},
		{17, "", CodeFileFormat},
	}
	if !reflect.DeepEqual(gotProblems, wantProblems) {
		t.Fatalf("problems:\n%+v\nmuốn\n%+v", gotProblems, wantProblems)
	}
	// Dòng sai không chép lại nội dung: phần trước dấu = có thể là giá trị dán nhầm.
	for _, p := range problems {
		if strings.Contains(p.Err.Message, "value") || strings.Contains(p.Err.Message, "never closed") {
			t.Errorf("dòng %d: thông báo chép nội dung: %s", p.Line, p.Err.Message)
		}
	}
}
