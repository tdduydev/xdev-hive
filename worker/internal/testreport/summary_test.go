package testreport

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPlaywrightMetadata(t *testing.T) {
	raw := `{"suites":[{"title":"login","suites":[{"specs":[
	{"title":"TC-001 secret https://private","tests":[{"expectedStatus":"passed","results":[{"status":"failed","duration":5},{"status":"passed","duration":7,"error":{"message":"password=secret"}}]}]},
	{"title":"TC-002","tests":[{"results":[{"status":"failed","duration":3}]}]},
	{"title":"TC-003","tests":[{"status":"skipped","results":[]}]},
	{"title":"unmapped","tests":[{"results":[{"status":"passed","duration":2}]}]}
	]}]}],"stats":{"duration":50},"attachments":["secret"]}`
	s, err := Parse(strings.NewReader(raw), "", "", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if s.Totals != (Totals{Total: 4, Passed: 1, Failed: 1, Skipped: 1, Flaky: 1}) {
		t.Fatalf("totals: %+v", s.Totals)
	}
	if len(s.Cases) != 3 || s.Cases[0].Code != "TC-002" || s.Cases[1].Status != "flaky" || s.Cases[1].Retries != 1 || s.Cases[1].DurationMs != 12 {
		t.Fatalf("cases: %+v", s.Cases)
	}
	b, _ := json.Marshal(s)
	for _, secret := range []string{"secret", "https://", "password", "attachments", "login", "message"} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("metadata lộ trường tự do %s", secret)
		}
	}
}

func TestJUnitAndAggregation(t *testing.T) {
	raw := `<testsuites><testsuite><testsuite>
	<testcase name="TC-001" time="0.1"/><testcase name="TC-001 another browser" time="0.2"><skipped/></testcase>
	<testcase name="TC-002" time="0.3"><failure message="secret">https://private</failure><system-out>token</system-out></testcase>
	<testcase classname="TC-003" name="retry" time="0.4"><flakyFailure/></testcase>
	<testcase name="TC-004" time="0.5"><rerunFailure/></testcase>
	</testsuite></testsuite></testsuites>`
	s, err := Parse(strings.NewReader(raw), "", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if s.Totals.Total != 5 || s.DurationMs != 1500 || !s.Truncated || len(s.Cases) != 2 || s.Cases[0].Status != "failed" {
		t.Fatalf("summary: %+v", s)
	}
	s, err = Parse(strings.NewReader(raw), "junit", strings.Repeat("a", 40), 5000)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range s.Cases {
		if c.Code == "TC-001" && (c.Status != "skipped" || c.DurationMs != 300) {
			t.Fatalf("TC nhiều test phải giữ trạng thái xấu nhất: %+v", c)
		}
	}
	b, _ := json.Marshal(s)
	if strings.Contains(string(b), "secret") || strings.Contains(string(b), "token") {
		t.Fatal("lộ nội dung reporter")
	}
}

func TestRejectInvalidReports(t *testing.T) {
	for _, raw := range []string{
		`{}`, `invalid`, `<root/>`, `<testsuite/>`, `<testsuite><testcase time="-1"/></testsuite>`,
		`<testsuite><testcase time="NaN"/></testsuite>`,
		`<testsuite><testcase name="TC-001 TC-002"/></testsuite>`,
		`<testsuite><testcase name="TC-001"/><error message="setup failed"/></testsuite>`,
		`{"suites":[{"specs":[{"title":"TC-001","tests":[{"results":[]}]}]}]}`,
		`{"suites":[{"specs":[{"title":"TC-001","tests":[{"results":[{"status":"unknown"}]}]}]}]}`,
		`{"suites":[{"specs":[{"tests":[{"results":[{"status":"passed"}]}]}]}],"errors":[{"message":"secret"}]}`,
	} {
		if _, err := Parse(strings.NewReader(raw), "", "", 5000); err == nil {
			t.Fatalf("nhận báo cáo sai: %s", raw)
		}
	}
	if _, err := Parse(strings.NewReader(`<testsuite><testcase/></testsuite>`), "junit", "main", 5000); err == nil {
		t.Fatal("nhận SHA sai")
	}
	if _, err := Parse(strings.NewReader(`<testsuite><testcase/></testsuite>`), "junit", "", 0); err == nil {
		t.Fatal("nhận giới hạn sai")
	}
	if _, err := Parse(strings.NewReader(strings.Repeat("x", MaxBytes+1)), "", "", 5000); err == nil {
		t.Fatal("nhận file quá lớn")
	}
}

func TestExpectedFailureAndWorstStatus(t *testing.T) {
	raw := `{"suites":[{"specs":[{"title":"TC-001","tests":[{"expectedStatus":"failed","results":[{"status":"failed"}]},{"results":[{"status":"passed"}]}]},
	{"title":"TC-002","tests":[{"results":[{"status":"passed"}]},{"results":[{"status":"interrupted"}]}]}]}]}`
	s, err := Parse(strings.NewReader(raw), "playwright", "", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if s.Cases[0].Code != "TC-002" || s.Cases[0].Status != "failed" || s.Cases[1].Status != "passed" {
		t.Fatalf("summary: %+v", s)
	}
}
