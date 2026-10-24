package delivery

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

const (
	trToken   = "test-token-not-real"
	trProject = "/api/v4/projects/group%2Fe2e-tests"
	trSHA     = "9fceb02d0ae598e95dc970b74767f19372d61af8"
)

// route là phản hồi của GitLab giả: string là thân JSON 200, int là mã HTTP, hàm thì tự trả.
type route = any

// fakeGitLab chỉ nhận GET có đúng Bearer token; đường dẫn khớp theo dạng đã escape như worker gửi.
func fakeGitLab(t *testing.T, routes map[string]route) (*httptest.Server, *[]string) {
	t.Helper()
	var mu sync.Mutex
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.EscapedPath()
		if q := r.URL.RawQuery; q != "" {
			key += "?" + q
		}
		mu.Lock()
		hits = append(hits, key)
		mu.Unlock()
		if r.Method != http.MethodGet {
			t.Errorf("worker gọi %s %s: việc test-report chỉ được đọc", r.Method, key)
		}
		if r.Header.Get("Authorization") != "Bearer "+trToken {
			w.WriteHeader(401)
			return
		}
		h, ok := routes[key]
		if !ok {
			h, ok = routes[r.URL.EscapedPath()]
		}
		switch v := h.(type) {
		case string:
			_, _ = w.Write([]byte(v))
		case int:
			w.WriteHeader(v)
		case func(http.ResponseWriter, *http.Request):
			v(w, r)
		default:
			if !ok {
				t.Errorf("GitLab giả không có %s", key)
			}
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// runTR gọi thẳng runTestReport (chưa có nhánh trong dispatch, việc của T054). Job log mở không kèm token để test
// thấy được nếu worker ghi token vào log.
func runTR(t *testing.T, baseURL string, params map[string]any) (*sink, error, string) {
	t.Helper()
	s := &sink{}
	e := newExec(t, "reg-a", MapCredentials{}, s)
	dir := t.TempDir()
	jl, err := OpenJobLog(dir, jobA)
	if err != nil {
		t.Fatal(err)
	}
	spec := JobSpec{JobID: jobA, Kind: KindTestReport, Target: map[string]any{"baseUrl": baseURL},
		Credential: "gitlab-main", Params: params}
	err = e.runTestReport(context.Background(), spec, []byte(trToken), jl)
	e.finish(jobA, err)
	_ = jl.Close()
	b, _ := os.ReadFile(filepath.Join(dir, jobA+".log"))
	return s, err, string(b)
}

func readParams(mode string, extra map[string]any) map[string]any {
	p := map[string]any{"op": "read", "projectPath": "group/e2e-tests", "pipelineId": 7, "mode": mode}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

// noLeak kiểm SC-003: sự kiện chỉ mang mã TC và số liệu, không mang tên test, tên suite, thông báo lỗi hay token.
func noLeak(t *testing.T, s *sink, log string, secrets ...string) {
	t.Helper()
	b, err := json.Marshal(s.ev)
	if err != nil {
		t.Fatal(err)
	}
	for _, sec := range append(secrets, trToken) {
		if strings.Contains(string(b), sec) {
			t.Errorf("sự kiện lộ %q: %s", sec, b)
		}
	}
	if strings.Contains(log, trToken) {
		t.Errorf("log lộ token: %s", log)
	}
}

func resultsEvent(t *testing.T, s *sink) TestResults {
	t.Helper()
	if len(s.ev) != 2 || s.ev[0]["type"] != "test-results" || s.last()["state"] != "succeeded" {
		t.Fatalf("sự kiện: %+v", s.ev)
	}
	b, _ := json.Marshal(s.ev[0])
	var r TestResults
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func finishedCode(s *sink) string {
	ev, _ := s.last()["error"].(Event)
	code, _ := ev["code"].(string)
	return code
}

func pipelineJSON(id int, status string) string {
	return fmt.Sprintf(`{"id":%d,"iid":3,"ref":"main","sha":"%s","status":%q,"source":"push",`+
		`"started_at":"2026-10-23T14:52:00.123+07:00","finished_at":null,"web_url":"https://gitlab.example.com/x"}`,
		id, trSHA, status)
}

func TestTestReportPipelineReport(t *testing.T) {
	report := `{"total_time":9,"total_count":6,"test_suites":[
	{"name":"e2e:chrome","test_cases":[
		{"status":"success","name":"TC-KHAM-001 mở hồ sơ","classname":"kham","execution_time":1.5},
		{"status":"failed","name":"TC-KHAM-002 secret-test-name","classname":"secret-class","execution_time":0.25,
		 "system_output":"secret-failure-message","stack_trace":"secret-stack"},
		{"status":"skipped","name":"không có mã","classname":"kham","execution_time":0}]},
	{"name":"e2e:firefox","test_cases":[
		{"status":"failed","name":"TC-KHAM-001 mở hồ sơ","classname":"kham","execution_time":2},
		{"status":"error","name":"TC-KHAM-002 secret-test-name","classname":"secret-class","execution_time":0}]},
	{"name":"unit","test_cases":[{"status":"success","name":"TC-KHAM-003","classname":"u","execution_time":1}]}]}`
	srv, _ := fakeGitLab(t, map[string]route{
		trProject + "/pipelines/7": pipelineJSON(7, "failed"),
		trProject + "/pipelines/7/test_report_summary": `{"total":{"count":6},"test_suites":[
			{"name":"e2e:chrome","build_ids":[501]},{"name":"e2e:firefox","build_ids":[502]},{"name":"unit","build_ids":[503]}]}`,
		trProject + "/pipelines/7/test_report": report,
	})
	s, err, log := runTR(t, srv.URL, readParams("pipeline-report", map[string]any{"jobFilter": []any{"e2e:*"}}))
	if err != nil {
		t.Fatal(err)
	}
	r := resultsEvent(t, s)
	started := "2026-10-23T07:52:00Z"
	want := TestResults{
		Pipeline: PipelineMeta{Ref: "main", SHA: trSHA, Status: "failed", Source: "push", StartedAt: &started},
		JobIDs:   []int64{501, 502},
		Totals:   TestTotals{Total: 5, Passed: 1, Failed: 3, Skipped: 1},
		Unmapped: 1, UnknownCodes: []string{"TC-KHAM-001", "TC-KHAM-002"},
		Cases: []TestResultCase{
			{Code: "TC-KHAM-001", Status: "failed", DurationMs: 3500, WorstJobID: 502},
			{Code: "TC-KHAM-002", Status: "failed", DurationMs: 250, WorstJobID: 501},
		},
	}
	if !reflect.DeepEqual(r, want) {
		t.Fatalf("test-results:\n got %+v\nwant %+v", r, want)
	}
	noLeak(t, s, log, "secret", "mở hồ sơ", "không có mã", "e2e:chrome", "e2e:firefox", "kham")
}

func TestTestReportPipelineReportWithoutBuildIDs(t *testing.T) {
	srv, _ := fakeGitLab(t, map[string]route{
		trProject + "/pipelines/7":                     pipelineJSON(7, "success"),
		trProject + "/pipelines/7/test_report_summary": `{"total":{"count":1},"test_suites":[{"name":"e2e"}]}`,
		trProject + "/pipelines/7/test_report": `{"total_count":1,"test_suites":[{"name":"e2e","test_cases":[
			{"status":"success","name":"TC-KHAM-001","classname":"k","execution_time":0.001}]}]}`,
	})
	s, err, _ := runTR(t, srv.URL, readParams("pipeline-report", nil))
	if err != nil {
		t.Fatal(err)
	}
	r := resultsEvent(t, s)
	if len(r.JobIDs) != 0 || len(r.Cases) != 1 || r.Cases[0].WorstJobID != 0 || r.Cases[0].DurationMs != 1 {
		t.Fatalf("test-results: %+v", r)
	}
	// worstJobId vắng hẳn chứ không là 0: schema hub yêu cầu số ≥ 1 khi có.
	b, _ := json.Marshal(s.ev[0])
	if strings.Contains(string(b), "worstJobId") || !strings.Contains(string(b), `"jobIds":[]`) {
		t.Fatalf("event: %s", b)
	}
}

func TestTestReportNoReport(t *testing.T) {
	for name, routes := range map[string]map[string]route{
		"summary rỗng": {
			trProject + "/pipelines/7":                     pipelineJSON(7, "success"),
			trProject + "/pipelines/7/test_report_summary": `{"total":{"count":0},"test_suites":[]}`,
		},
		"total_count 0": {
			trProject + "/pipelines/7":                     pipelineJSON(7, "success"),
			trProject + "/pipelines/7/test_report_summary": `{"total":{"count":3},"test_suites":[]}`,
			trProject + "/pipelines/7/test_report":         `{"total_count":0,"test_suites":[]}`,
		},
		"pipeline đang chạy": {trProject + "/pipelines/7": pipelineJSON(7, "running")},
	} {
		t.Run(name, func(t *testing.T) {
			srv, _ := fakeGitLab(t, routes)
			s, _, _ := runTR(t, srv.URL, readParams("pipeline-report", nil))
			if finishedCode(s) != string(CodeNoReport) || len(s.ev) != 1 {
				t.Fatalf("sự kiện: %+v", s.ev)
			}
		})
	}
}

func TestTestReportJUnitArtifactAcrossJobs(t *testing.T) {
	var page1 []string
	for i := 1; i <= 100; i++ {
		name := "lint"
		switch i {
		case 10:
			name = "e2e:a"
		case 20:
			name = "e2e:b"
		}
		page1 = append(page1, fmt.Sprintf(`{"id":%d,"name":%q,"status":"success"}`, i, name))
	}
	srv, hits := fakeGitLab(t, map[string]route{
		trProject + "/pipelines/7":                          pipelineJSON(7, "failed"),
		trProject + "/pipelines/7/jobs?page=1&per_page=100": "[" + strings.Join(page1, ",") + "]",
		trProject + "/pipelines/7/jobs?page=2&per_page=100": `[{"id":200,"name":"e2e:c"},{"id":201,"name":"deploy"}]`,
		trProject + "/jobs/10/artifacts/reports/junit%20report.xml": `<testsuite>
			<testcase name="TC-KHAM-001 đăng nhập" time="1"/><testcase name="TC-KHAM-002" time="2"/></testsuite>`,
		trProject + "/jobs/20/artifacts/reports/junit%20report.xml": 404,
		trProject + "/jobs/200/artifacts/reports/junit%20report.xml": `<testsuite>
			<testcase name="TC-KHAM-001 đăng nhập" time="0.5"><failure message="secret-failure-message"/></testcase>
			<testcase name="TC-KHAM-001 TC-KHAM-002 gộp" time="0.1"/></testsuite>`,
	})
	s, err, log := runTR(t, srv.URL, readParams("junit-artifact", map[string]any{
		"jobFilter": []any{"e2e:*"}, "artifactPath": "reports/junit report.xml"}))
	if err != nil {
		t.Fatal(err)
	}
	r := resultsEvent(t, s)
	want := []TestResultCase{
		{Code: "TC-KHAM-001", Status: "failed", DurationMs: 1500, WorstJobID: 200},
		{Code: "TC-KHAM-002", Status: "passed", DurationMs: 2000, WorstJobID: 10},
	}
	if !reflect.DeepEqual(r.JobIDs, []int64{10, 200}) || !reflect.DeepEqual(r.Cases, want) || r.Ambiguous != 1 ||
		r.Totals != (TestTotals{Total: 4, Passed: 3, Failed: 1}) {
		t.Fatalf("test-results: %+v", r)
	}
	for _, h := range *hits {
		if strings.Contains(h, "/jobs/1/") || strings.Contains(h, "/jobs/201/") {
			t.Fatalf("worker tải artifact của job không khớp jobFilter: %s", h)
		}
	}
	noLeak(t, s, log, "secret", "đăng nhập", "gộp", "e2e:", "junit report")
}

func TestTestReportPlaywrightFlakyRetriesClamped(t *testing.T) {
	var results []string
	for range 24 {
		results = append(results, `{"status":"failed","duration":10}`)
	}
	results = append(results, `{"status":"passed","duration":10}`)
	pw := `{"stats":{"duration":300},"suites":[{"title":"secret-suite","specs":[
		{"title":"TC-KHAM-001 thử lại","tests":[{"expectedStatus":"passed","results":[` + strings.Join(results, ",") + `]}]},
		{"title":"TC-KHAM-002","tests":[{"status":"skipped","results":[]}]}]}]}`
	srv, _ := fakeGitLab(t, map[string]route{
		trProject + "/pipelines/7":                                      pipelineJSON(7, "success"),
		trProject + "/pipelines/7/jobs":                                 `[{"id":31,"name":"e2e"}]`,
		trProject + "/jobs/31/artifacts/playwright-report/results.json": pw,
	})
	s, err, log := runTR(t, srv.URL, readParams("playwright-artifact", map[string]any{
		"artifactPath": "playwright-report/results.json"}))
	if err != nil {
		t.Fatal(err)
	}
	r := resultsEvent(t, s)
	want := []TestResultCase{
		{Code: "TC-KHAM-001", Status: "flaky", Retries: 20, DurationMs: 250, WorstJobID: 31},
		{Code: "TC-KHAM-002", Status: "skipped", WorstJobID: 31},
	}
	if !reflect.DeepEqual(r.Cases, want) || r.Totals != (TestTotals{Total: 2, Skipped: 1, Flaky: 1}) {
		t.Fatalf("test-results: %+v", r)
	}
	noLeak(t, s, log, "secret-suite", "thử lại")
}

func TestTestReportArtifactErrors(t *testing.T) {
	big := func(w http.ResponseWriter, _ *http.Request) {
		chunk := []byte(strings.Repeat(" ", 1<<20))
		for range 33 {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}
	for name, tc := range map[string]struct {
		file route
		code Code
	}{
		"lớn hơn 32 MiB":        {big, CodeReportTooLarge},
		"XML hỏng":              {`<testsuite><testcase name="TC-KHAM-001"`, CodeReportInvalid},
		"không job nào có file": {404, CodeNoReport},
		"file không có test":    {`<testsuite></testsuite>`, CodeNoReport},
	} {
		t.Run(name, func(t *testing.T) {
			srv, _ := fakeGitLab(t, map[string]route{
				trProject + "/pipelines/7":                 pipelineJSON(7, "failed"),
				trProject + "/pipelines/7/jobs":            `[{"id":41,"name":"test"}]`,
				trProject + "/jobs/41/artifacts/junit.xml": tc.file,
			})
			s, _, _ := runTR(t, srv.URL, readParams("junit-artifact", map[string]any{"artifactPath": "junit.xml"}))
			if finishedCode(s) != string(tc.code) || len(s.ev) != 1 {
				t.Fatalf("sự kiện: %+v", s.ev)
			}
		})
	}
}

func TestTestReportPipelineReportTooLarge(t *testing.T) {
	srv, _ := fakeGitLab(t, map[string]route{
		trProject + "/pipelines/7":                     pipelineJSON(7, "failed"),
		trProject + "/pipelines/7/test_report_summary": `{"total":{"count":1},"test_suites":[]}`,
		trProject + "/pipelines/7/test_report": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"total_count":1,"x":"` + strings.Repeat("a", 32<<20) + `"}`))
		},
	})
	s, _, _ := runTR(t, srv.URL, readParams("pipeline-report", nil))
	if finishedCode(s) != string(CodeReportTooLarge) {
		t.Fatalf("sự kiện: %+v", s.last())
	}
}

func TestTestReportGitLabErrors(t *testing.T) {
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	for name, tc := range map[string]struct {
		pipeline route
		baseURL  string
		code     Code
	}{
		"401":            {401, "", CodeGitLabAuth},
		"403":            {403, "", CodeGitLabAuth},
		"404":            {404, "", CodeGitLabNotFound},
		"500":            {500, "", CodeGitLabUnreachable},
		"422":            {422, "", CodeGitLabUnreachable},
		"trang HTML":     {"<html>đăng nhập</html>", "", CodeGitLabUnreachable},
		"máy chủ đã tắt": {nil, closed.URL, CodeGitLabUnreachable},
		"trạng thái lạ":  {`{"id":7,"ref":"main","sha":"xyz","status":"success","source":"push"}`, "", CodeReportInvalid},
	} {
		t.Run(name, func(t *testing.T) {
			srv, _ := fakeGitLab(t, map[string]route{trProject + "/pipelines/7": tc.pipeline})
			base := srv.URL
			if tc.baseURL != "" {
				base = tc.baseURL
			}
			s, _, log := runTR(t, base, readParams("pipeline-report", nil))
			last := s.last()
			msg, _ := last["error"].(Event)["message"].(string)
			if finishedCode(s) != string(tc.code) || last["state"] != "failed" || msg == "" || len([]rune(msg)) > 200 {
				t.Fatalf("finished: %+v", last)
			}
			noLeak(t, s, log, "127.0.0.1")
		})
	}
}

func TestTestReportWrongTokenAndBadParams(t *testing.T) {
	srv, _ := fakeGitLab(t, map[string]route{})
	s := &sink{}
	e := newExec(t, "reg-a", MapCredentials{}, s)
	jl, err := OpenJobLog(t.TempDir(), jobA)
	if err != nil {
		t.Fatal(err)
	}
	defer jl.Close()
	spec := JobSpec{JobID: jobA, Kind: KindTestReport, Target: map[string]any{"baseUrl": srv.URL},
		Params: readParams("pipeline-report", nil)}
	if err := e.runTestReport(context.Background(), spec, []byte("sai-token"), jl); CodeOf(err) != CodeGitLabAuth {
		t.Fatalf("token sai: %v", err)
	}
	if err := e.runTestReport(context.Background(), spec, nil, jl); CodeOf(err) != CodeGitLabAuth {
		t.Fatalf("token rỗng: %v", err)
	}
	spec.Params = map[string]any{"op": "read", "projectPath": "group/e2e-tests", "pipelineId": 7, "mode": "html"}
	if err := e.runTestReport(context.Background(), spec, []byte(trToken), jl); CodeOf(err) != CodeUnsupported {
		t.Fatalf("mode lạ: %v", err)
	}
	spec.Params, spec.Target = readParams("pipeline-report", nil), map[string]any{}
	if err := e.runTestReport(context.Background(), spec, []byte(trToken), jl); CodeOf(err) != CodeBadRequest {
		t.Fatalf("thiếu baseUrl: %v", err)
	}
	if len(s.ev) != 0 {
		t.Fatalf("không được phát sự kiện: %+v", s.ev)
	}
}

func TestTestReportListPipelines(t *testing.T) {
	statuses := []string{"success", "failed", "running", "canceled", "skipped", "manual", "pending", "created"}
	page := func(from, n int) string {
		var rows []string
		for i := range n {
			id := from - i
			rows = append(rows, fmt.Sprintf(`{"id":%d,"ref":"main","sha":"%s","status":%q,"source":"schedule",`+
				`"started_at":null,"finished_at":"2026-10-23T08:05:00Z","updated_at":"2026-10-23T08:05:00Z"}`,
				id, trSHA, statuses[id%len(statuses)]))
		}
		return "[" + strings.Join(rows, ",") + "]"
	}
	srv, hits := fakeGitLab(t, map[string]route{
		trProject + "/pipelines?order_by=id&page=1&per_page=100&ref=main&sort=desc&updated_after=2026-10-16T00%3A00%3A00Z": page(1000, 100),
		trProject + "/pipelines?order_by=id&page=2&per_page=100&ref=main&sort=desc&updated_after=2026-10-16T00%3A00%3A00Z": page(900, 100),
		trProject + "/pipelines?order_by=id&page=3&per_page=100&ref=main&sort=desc&updated_after=2026-10-16T00%3A00%3A00Z": page(800, 40),
	})
	s, err, log := runTR(t, srv.URL, map[string]any{"op": "list", "projectPath": "group/e2e-tests", "ref": "main",
		"updatedAfter": "2026-10-16T00:00:00Z", "limit": 150})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.ev) != 3 || s.ev[0]["type"] != "pipelines" || s.ev[1]["type"] != "pipelines" || s.last()["state"] != "succeeded" {
		t.Fatalf("sự kiện: %d, %+v", len(s.ev), s.last())
	}
	var items []PipelineItem
	for _, ev := range s.ev[:2] {
		got := ev["items"].([]PipelineItem)
		if len(got) > 100 {
			t.Fatalf("một sự kiện có %d pipeline", len(got))
		}
		items = append(items, got...)
	}
	if len(items) != 150 || len(s.ev[0]["items"].([]PipelineItem)) != 100 {
		t.Fatalf("items: %d", len(items))
	}
	for _, it := range items {
		if !pipelineFinal[it.Status] || it.StartedAt != nil || *it.FinishedAt != "2026-10-23T08:05:00Z" {
			t.Fatalf("item: %+v", it)
		}
	}
	// 6 trong 8 trạng thái là đã xong: 150 pipeline cần ba trang, không đọc trang thứ tư.
	if len(*hits) != 3 {
		t.Fatalf("số lần gọi: %v", *hits)
	}
	noLeak(t, s, log)
}

func TestTestReportListEmpty(t *testing.T) {
	srv, _ := fakeGitLab(t, map[string]route{trProject + "/pipelines": `[]`})
	s, err, _ := runTR(t, srv.URL, map[string]any{"op": "list", "projectPath": "group/e2e-tests", "limit": 5})
	if err != nil || len(s.ev) != 1 || s.last()["state"] != "succeeded" {
		t.Fatalf("err=%v sự kiện=%+v", err, s.ev)
	}
}
