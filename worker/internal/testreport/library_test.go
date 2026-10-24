package testreport

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestLibraryCodeInNames(t *testing.T) {
	for _, tc := range []struct {
		name string
		code string
		n    int
	}{
		{"đăng nhập TC-KHAM-001 thành công", "TC-KHAM-001", 1},
		{"[TC-KHAM-001] khám", "TC-KHAM-001", 1},
		{"suite/TC-K2-12345.spec", "TC-K2-12345", 1},
		{"TC-KHAM-001 lặp lại TC-KHAM-001", "TC-KHAM-001", 1},
		{"TC-KHAM-001 và TC-KHAM-002", "", 2},
		{"TC-KHAM-001 TC-THUOC-001 TC-KHAM-001", "", 2},
		{"TC-001 là mã 035", "", 0},
		{"tc-kham-001 chữ thường", "", 0},
		{"TC-K-001 khu một ký tự", "", 0},
		{"TC-KHAM-01 số quá ngắn", "", 0},
		{"TC-KHAM-123456 số quá dài", "", 0},
		{"XTC-KHAM-001 dính chữ", "", 0},
		{"TC-KHAM-001x dính chữ", "", 0},
		{"TC-ABCDEFGHIJKLMNOPQ-001 khu quá dài", "", 0},
		{"", "", 0},
	} {
		code, n, err := codeOf(tc.name, Options{Library: true})
		if err != nil || n != tc.n || (n == 1 && code != tc.code) {
			t.Errorf("%q: code=%q n=%d err=%v", tc.name, code, n, err)
		}
	}
}

func TestLibrarySummaryCountsAmbiguousAndUnmapped(t *testing.T) {
	raw := `<testsuites><testsuite>
	<testcase name="TC-KHAM-001 mở hồ sơ" time="0.1"/>
	<testcase name="TC-KHAM-001 mở hồ sơ firefox" time="0.2"><failure message="password=secret"/></testcase>
	<testcase name="TC-KHAM-002 và TC-KHAM-003" time="0.3"/>
	<testcase name="TC-001 mã cũ" time="0.4"/>
	<testcase name="không có mã" time="0.5"><skipped/></testcase>
	</testsuite></testsuites>`
	tests, runner, _, err := Read(strings.NewReader(raw), "")
	if err != nil || runner != "junit" {
		t.Fatalf("runner=%s err=%v", runner, err)
	}
	s, err := Summarize(tests, MaxCases, Options{Library: true})
	if err != nil {
		t.Fatal(err)
	}
	if s.Totals != (Totals{Total: 5, Passed: 3, Failed: 1, Skipped: 1}) || s.Unmapped != 2 || s.Ambiguous != 1 {
		t.Fatalf("summary: %+v", s)
	}
	if len(s.Cases) != 1 || s.Cases[0] != (Case{Code: "TC-KHAM-001", Status: "failed", DurationMs: 300}) {
		t.Fatalf("cases: %+v", s.Cases)
	}
	b, _ := json.Marshal(s)
	for _, leak := range []string{"secret", "mở hồ sơ", "không có mã", "TC-001"} {
		if strings.Contains(string(b), leak) {
			t.Fatalf("summary lộ %q: %s", leak, b)
		}
	}
	// Test nhiều mã 035 làm hỏng cả báo cáo ở `hive test-summary`, nhưng nguồn CI chỉ đếm nó vào unmapped.
	multi := `<testsuite><testcase name="TC-001 TC-002"/><testcase name="TC-KHAM-001"/></testsuite>`
	if _, err := Parse(strings.NewReader(multi), "", "", MaxCases); err == nil {
		t.Fatal("luật 035 phải từ chối test nhiều mã")
	}
	tests, _, _, _ = Read(strings.NewReader(multi), "")
	if s, err := Summarize(tests, MaxCases, Options{Library: true}); err != nil || s.Unmapped != 1 || len(s.Cases) != 1 {
		t.Fatalf("summary: %+v, %v", s, err)
	}
}

// Luật 035 không đổi: không có trường unmapped, ambiguous trong JSON của `hive test-summary`.
func TestParseKeepsLegacyOutput(t *testing.T) {
	s, err := Parse(strings.NewReader(`<testsuite><testcase name="TC-001"/><testcase name="không mã"/></testsuite>`), "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(s)
	if strings.Contains(string(b), "unmapped") || strings.Contains(string(b), "ambiguous") || strings.Contains(string(b), "Source") {
		t.Fatalf("đầu ra 035 đổi: %s", b)
	}
	if len(s.Cases) != 1 || s.Cases[0].Code != "TC-001" {
		t.Fatalf("cases: %+v", s.Cases)
	}
}

func TestLibraryWorstSource(t *testing.T) {
	tests := []Test{
		{Name: "TC-KHAM-001", Status: "passed", DurationMs: 5, Source: 10},
		{Name: "TC-KHAM-001", Status: "flaky", Retries: 2, DurationMs: 7, Source: 11},
		{Name: "TC-KHAM-001", Status: "flaky", Retries: 1, DurationMs: 1, Source: 12},
		{Name: "TC-KHAM-002", Status: "skipped", Source: 12},
		{Name: "TC-KHAM-002", Status: "failed", Source: 13},
	}
	s, err := Summarize(tests, MaxCases, Options{Library: true})
	if err != nil {
		t.Fatal(err)
	}
	want := []Case{
		{Code: "TC-KHAM-002", Status: "failed", Source: 13},
		{Code: "TC-KHAM-001", Status: "flaky", Retries: 2, DurationMs: 13, Source: 11},
	}
	if fmt.Sprint(s.Cases) != fmt.Sprint(want) {
		t.Fatalf("cases: %+v", s.Cases)
	}
}

func TestLibraryBrokenAndLargeReports(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want error
	}{
		{`<testsuite><testcase name="TC-KHAM-001"`, nil},
		{`{"suites":[{"specs":[{"title":"TC-KHAM-001","tests":[{"results":[{"status":"lạ"}]}]}]}]}`, nil},
		{`<testsuite></testsuite>`, ErrNoTests},
		{`{"suites":[]}`, ErrNoTests},
		{strings.Repeat(" ", MaxBytes+1), ErrTooLarge},
	} {
		tests, _, _, err := Read(strings.NewReader(tc.raw), "")
		if err == nil {
			_, err = Summarize(tests, MaxCases, Options{Library: true})
		}
		if err == nil || (tc.want != nil && !errors.Is(err, tc.want)) {
			t.Errorf("%.40q: err = %v, muốn %v", tc.raw, err, tc.want)
		}
	}
}

func TestLibraryTruncatesAtMaxCases(t *testing.T) {
	var b strings.Builder
	b.WriteString("<testsuite>")
	for i := range MaxCases + 2 {
		fmt.Fprintf(&b, `<testcase name="TC-KHAM-%05d"/>`, i)
	}
	b.WriteString(`<testcase name="TC-ZZ-99999"><failure/></testcase></testsuite>`)
	tests, _, _, err := Read(strings.NewReader(b.String()), "junit")
	if err != nil {
		t.Fatal(err)
	}
	s, err := Summarize(tests, MaxCases, Options{Library: true})
	if err != nil {
		t.Fatal(err)
	}
	if !s.Truncated || len(s.Cases) != MaxCases || s.Cases[0].Code != "TC-ZZ-99999" || s.Totals.Total != MaxCases+3 {
		t.Fatalf("truncated=%v cases=%d first=%+v total=%d", s.Truncated, len(s.Cases), s.Cases[0], s.Totals.Total)
	}
}
