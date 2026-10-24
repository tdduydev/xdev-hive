package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/testreport"
)

// KindTestReport là việc đọc kết quả test của GitLab (specs/036). Nó không phải cách triển khai nên không nằm trong
// `methods` của Capability.
const KindTestReport = "test-report"

// Capability phản chiếu `deliveryCapability`. Worker không khai `kinds` thì hub không giao việc test-report.
type Capability struct {
	Methods     []string `json:"methods"`
	Credentials []string `json:"credentials"`
	Kinds       []string `json:"kinds"`
}

// Mã lỗi riêng của việc test-report; hub đổi thành `read_state` của lần chạy CI.
const (
	CodeNoReport          Code = "no_report"
	CodeReportTooLarge    Code = "report_too_large"
	CodeReportInvalid     Code = "report_invalid"
	CodeGitLabAuth        Code = "gitlab_auth"
	CodeGitLabNotFound    Code = "gitlab_not_found"
	CodeGitLabUnreachable Code = "gitlab_unreachable"
)

// TestReportParams phản chiếu `testReportParams` (hợp của `op = read` và `op = list`).
type TestReportParams struct {
	Op           string   `json:"op"`
	ProjectPath  string   `json:"projectPath"`
	PipelineID   int64    `json:"pipelineId,omitempty"`
	Mode         string   `json:"mode,omitempty"`
	JobFilter    []string `json:"jobFilter,omitempty"`
	ArtifactPath string   `json:"artifactPath,omitempty"`
	Ref          string   `json:"ref,omitempty"`
	UpdatedAfter string   `json:"updatedAfter,omitempty"`
	Limit        int      `json:"limit,omitempty"`
}

var gitlabProjectPath = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$`)

// ParseTestReportParams đọc lại params đã qua zod ở hub. Worker vẫn kiểm vì đường dẫn đi thẳng vào URL GitLab.
func ParseTestReportParams(params map[string]any) (TestReportParams, error) {
	var p TestReportParams
	b, err := json.Marshal(params)
	if err != nil {
		return p, newError(CodeBadRequest, 0, "Tham số đọc kết quả test không hợp lệ.")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if dec.Decode(&p) != nil || !validProjectPath(p.ProjectPath) {
		return p, newError(CodeBadRequest, 0, "Tham số đọc kết quả test không hợp lệ.")
	}
	switch p.Op {
	case "read":
		if p.PipelineID < 1 || len(p.JobFilter) > 20 {
			return p, newError(CodeBadRequest, 0, "Tham số đọc kết quả test không hợp lệ.")
		}
		switch p.Mode {
		case "pipeline-report":
		case "junit-artifact", "playwright-artifact":
			if !safeArtifactPath(p.ArtifactPath) {
				return p, newError(CodeBadRequest, 0, "Đường dẫn artifact phải tương đối và không chứa `..`.")
			}
		default:
			return p, newError(CodeUnsupported, 0, "Worker này chưa hỗ trợ cách đọc báo cáo %q.", truncate(p.Mode, 40))
		}
	case "list":
		if p.Limit < 1 || p.Limit > 500 {
			return p, newError(CodeBadRequest, 0, "Tham số đọc kết quả test không hợp lệ.")
		}
	default:
		return p, newError(CodeBadRequest, 0, "Tham số đọc kết quả test không hợp lệ.")
	}
	return p, nil
}

// Đoạn `.` hay `..` khớp regex nhưng có thể bị proxy giải mã thành đường dẫn khác sau khi escape.
func validProjectPath(p string) bool {
	if len(p) > 255 || !gitlabProjectPath.MatchString(p) {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if part == "." || part == ".." {
			return false
		}
	}
	return true
}

func safeArtifactPath(p string) bool {
	if p == "" || len(p) > 255 || strings.HasPrefix(p, "/") {
		return false
	}
	for _, part := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return false
		}
	}
	return true
}

// PipelineMeta phản chiếu phần pipeline của `test-results` và `pipelines`.
type PipelineMeta struct {
	Ref        string  `json:"ref"`
	SHA        string  `json:"sha"`
	Status     string  `json:"status"`
	Source     string  `json:"source"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
}

type PipelineItem struct {
	PipelineID int64 `json:"pipelineId"`
	PipelineMeta
}

type TestTotals struct {
	Total   int `json:"total"`
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Skipped int `json:"skipped"`
	Flaky   int `json:"flaky"`
}

type TestResultCase struct {
	Code       string `json:"code"`
	Status     string `json:"status"`
	Retries    int    `json:"retries"`
	DurationMs int64  `json:"durationMs"`
	WorstJobID int64  `json:"worstJobId,omitempty"`
}

// TestResults là thân sự kiện `test-results`: chỉ mã TC và số liệu, không có tên test hay thông báo lỗi (FR-025).
type TestResults struct {
	Pipeline     PipelineMeta     `json:"pipeline"`
	JobIDs       []int64          `json:"jobIds"`
	Totals       TestTotals       `json:"totals"`
	Unmapped     int              `json:"unmapped"`
	Ambiguous    int              `json:"ambiguous"`
	UnknownCodes []string         `json:"unknownCodes"`
	Truncated    bool             `json:"truncated"`
	Cases        []TestResultCase `json:"cases"`
}

func (r TestResults) event() Event {
	return Event{"pipeline": r.Pipeline, "jobIds": r.JobIDs, "totals": r.Totals, "unmapped": r.Unmapped,
		"ambiguous": r.Ambiguous, "unknownCodes": r.UnknownCodes, "truncated": r.Truncated, "cases": r.Cases}
}

// Pipelines là thân sự kiện `pipelines`.
type Pipelines struct {
	Items []PipelineItem `json:"items"`
}

func (p Pipelines) event() Event { return Event{"items": p.Items} }

// Giới hạn phía worker trùng giới hạn của sự kiện strict ở hub: vượt thì hub từ chối cả việc.
const (
	maxJobIDs       = 100
	maxUnknownCodes = 200
	maxRetries      = 20
	maxPipelineItem = 100
	maxJobPages     = 10
	maxListPages    = 20
	gitlabPerPage   = 100
	// File 32 MiB qua mạng nội bộ chậm cần lâu hơn mặc định 15 giây của client chung.
	gitlabTimeout = 2 * time.Minute
)

var (
	pipelineFinal = map[string]bool{"success": true, "failed": true, "canceled": true, "skipped": true, "manual": true}
	gitlabSHA     = regexp.MustCompile(`^[0-9a-f]{40}$`)
	gitlabSource  = regexp.MustCompile(`^[a-z_]{1,64}$`)
	// [Unverified] Tên trạng thái lấy từ tài liệu GitLab test report API, chưa đối chiếu với pipeline thật.
	gitlabCaseStatus = map[string]string{"success": "passed", "failed": "failed", "error": "failed", "skipped": "skipped"}
)

// runTestReport chỉ gọi GET tới GitLab và chỉ gửi mã TC cùng số liệu. Lỗi chung của client HTTP được đổi sang mã
// của test-report để hub đặt đúng `read_state` của lần chạy CI.
func (e *Executor) runTestReport(ctx context.Context, spec JobSpec, cred []byte, jl *JobLog) error {
	if err := e.testReport(ctx, spec, cred, jl); err != nil {
		return testReportError(err)
	}
	return nil
}

func (e *Executor) testReport(ctx context.Context, spec JobSpec, cred []byte, jl *JobLog) error {
	p, err := ParseTestReportParams(spec.Params)
	if err != nil {
		return err
	}
	if err := requireTarget(spec, "baseUrl"); err != nil {
		return err
	}
	g, err := newGitLab(targetStr(spec.Target, "baseUrl"), cred, p.ProjectPath)
	if err != nil {
		return err
	}
	if p.Op == "list" {
		return e.listPipelines(ctx, spec.JobID, g, p, jl)
	}
	meta, err := g.pipeline(ctx, p.PipelineID)
	if err != nil {
		return err
	}
	var tests []testreport.Test
	var jobIDs []int64
	if p.Mode == "pipeline-report" {
		tests, jobIDs, err = g.pipelineReport(ctx, p)
	} else {
		tests, jobIDs, err = g.artifactReports(ctx, p)
	}
	if err != nil {
		return err
	}
	if len(tests) == 0 {
		return newError(CodeNoReport, 0, "Pipeline không có báo cáo test ở các job đã chọn.")
	}
	sum, err := testreport.Summarize(tests, testreport.MaxCases, testreport.Options{Library: true})
	if err != nil {
		// Lỗi của testreport là câu cố định, không chứa nội dung báo cáo.
		return newError(CodeReportInvalid, 0, "%s", err.Error())
	}
	r := resultsOf(meta, jobIDs, sum)
	e.emit(spec.JobID, "test-results", r.event())
	jl.Printf("pipeline %d: %d test, %d mã TC, %d không mã, %d nhiều mã", p.PipelineID, sum.Totals.Total, len(r.Cases),
		sum.Unmapped, sum.Ambiguous)
	return nil
}

func resultsOf(meta PipelineMeta, jobIDs []int64, s testreport.Summary) TestResults {
	r := TestResults{Pipeline: meta, JobIDs: []int64{}, Totals: TestTotals(s.Totals), Unmapped: s.Unmapped,
		Ambiguous: s.Ambiguous, UnknownCodes: []string{}, Truncated: s.Truncated, Cases: make([]TestResultCase, 0, len(s.Cases))}
	r.JobIDs = append(r.JobIDs, jobIDs[:min(len(jobIDs), maxJobIDs)]...)
	for _, c := range s.Cases {
		r.Cases = append(r.Cases, TestResultCase{Code: c.Code, Status: c.Status, Retries: min(c.Retries, maxRetries),
			DurationMs: c.DurationMs, WorstJobID: c.Source})
		r.UnknownCodes = append(r.UnknownCodes, c.Code)
	}
	// Worker không có danh sách mã của thư viện nên gửi mã đã thấy; hub giữ lại mã không có trong thư viện.
	sort.Strings(r.UnknownCodes)
	r.UnknownCodes = r.UnknownCodes[:min(len(r.UnknownCodes), maxUnknownCodes)]
	return r
}

func (e *Executor) listPipelines(ctx context.Context, jobID string, g *gitlab, p TestReportParams, jl *JobLog) error {
	perPage := min(p.Limit, gitlabPerPage)
	q := url.Values{"per_page": {strconv.Itoa(perPage)}, "order_by": {"id"}, "sort": {"desc"}}
	if p.Ref != "" {
		q.Set("ref", p.Ref)
	}
	if p.UpdatedAfter != "" {
		q.Set("updated_after", p.UpdatedAfter)
	}
	var batch []PipelineItem
	total := 0
	flush := func() {
		if len(batch) > 0 {
			e.emit(jobID, "pipelines", Pipelines{Items: batch}.event())
			batch = nil
		}
	}
	for page := 1; page <= maxListPages && total < p.Limit; page++ {
		q.Set("page", strconv.Itoa(page))
		var rows []gitlabPipeline
		if err := g.getJSON(ctx, "/pipelines", q, &rows); err != nil {
			return err
		}
		for _, row := range rows {
			// Pipeline đang chạy chưa có kết quả; lần lấy danh sách sau sẽ thấy nó khi đã xong.
			meta, ok := row.meta()
			if total == p.Limit || !ok || row.ID < 1 {
				continue
			}
			batch = append(batch, PipelineItem{PipelineID: row.ID, PipelineMeta: meta})
			total++
			if len(batch) == maxPipelineItem {
				flush()
			}
		}
		if len(rows) < perPage {
			break
		}
	}
	flush()
	jl.Printf("danh sách pipeline: %d pipeline đã xong", total)
	return nil
}

// gitlab đọc GitLab REST v4 trong phạm vi một project. Chỉ có GET: việc test-report không ghi gì lên GitLab.
type gitlab struct {
	c       *apiClient
	project string
}

func newGitLab(baseURL string, token []byte, projectPath string) (*gitlab, error) {
	if len(token) == 0 {
		return nil, newError(CodeGitLabAuth, 0, "Token GitLab trên máy chạy đang rỗng.")
	}
	c, err := newAPIClient("GitLab", baseURL, "Bearer "+string(token), gitlabTimeout, nil)
	if err != nil {
		return nil, err
	}
	return &gitlab{c: c, project: "/api/v4/projects/" + url.PathEscape(projectPath)}, nil
}

// fetch đọc tối đa limit byte. found = false khi allow404 và GitLab trả 404.
func (g *gitlab) fetch(ctx context.Context, path string, q url.Values, limit int, allow404 bool) ([]byte, bool, error) {
	res, err := g.c.do(ctx, reqOpts{path: g.project + path, query: q, allow404: allow404})
	if err != nil {
		return nil, false, err
	}
	if res.StatusCode == 404 {
		drain(res)
		return nil, false, nil
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, int64(limit)+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, ctxErr(ctx)
		}
		return nil, false, newError(CodeGitLabUnreachable, 0, "Không đọc hết phản hồi của GitLab.")
	}
	if len(b) > limit {
		if limit == testreport.MaxBytes {
			return nil, false, newError(CodeReportTooLarge, 0, "File báo cáo test lớn hơn 32 MiB.")
		}
		return nil, false, newError(CodeGitLabUnreachable, 0, "Phản hồi của GitLab quá lớn.")
	}
	return b, true, nil
}

func (g *gitlab) getJSON(ctx context.Context, path string, q url.Values, v any) error {
	b, _, err := g.fetch(ctx, path, q, maxBodyBytes, false)
	if err != nil {
		return err
	}
	if json.Unmarshal(b, v) != nil {
		return newError(CodeGitLabUnreachable, 0, "GitLab trả về nội dung không phải JSON (có thể proxy chặn).")
	}
	return nil
}

type gitlabPipeline struct {
	ID         int64   `json:"id"`
	Ref        string  `json:"ref"`
	SHA        string  `json:"sha"`
	Status     string  `json:"status"`
	Source     string  `json:"source"`
	StartedAt  *string `json:"started_at"`
	FinishedAt *string `json:"finished_at"`
}

// meta trả ok = false khi pipeline chưa xong hoặc có trường không qua được schema strict của hub.
func (p gitlabPipeline) meta() (PipelineMeta, bool) {
	m := PipelineMeta{Ref: p.Ref, SHA: p.SHA, Status: p.Status, Source: p.Source, StartedAt: utcTime(p.StartedAt),
		FinishedAt: utcTime(p.FinishedAt)}
	ok := m.Ref != "" && len(m.Ref) <= 255 && gitlabSHA.MatchString(m.SHA) && pipelineFinal[m.Status] &&
		gitlabSource.MatchString(m.Source)
	return m, ok
}

// utcTime đưa giờ có độ lệch múi giờ của GitLab về dạng `Z` mà zod `datetime()` nhận; giờ không đọc được coi như không có.
func utcTime(s *string) *string {
	if s == nil {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, *s)
	if err != nil {
		return nil
	}
	v := t.UTC().Format(time.RFC3339)
	return &v
}

func (g *gitlab) pipeline(ctx context.Context, id int64) (PipelineMeta, error) {
	var p gitlabPipeline
	if err := g.getJSON(ctx, fmt.Sprintf("/pipelines/%d", id), nil, &p); err != nil {
		return PipelineMeta{}, err
	}
	if !pipelineFinal[p.Status] {
		return PipelineMeta{}, newError(CodeNoReport, 0, "Pipeline chưa chạy xong nên chưa có báo cáo test.")
	}
	m, ok := p.meta()
	if !ok {
		return PipelineMeta{}, newError(CodeReportInvalid, 0, "Thông tin pipeline GitLab trả về không đúng dạng.")
	}
	return m, nil
}

// pipelineReport đọc test report mà GitLab gộp từ `artifacts:reports:junit`. [Unverified] `build_ids` của summary cho
// biết suite thuộc job nào, nên worstJobId chỉ có khi suite thuộc đúng một job.
func (g *gitlab) pipelineReport(ctx context.Context, p TestReportParams) ([]testreport.Test, []int64, error) {
	var summary struct {
		Total struct {
			Count int `json:"count"`
		} `json:"total"`
		TestSuites []struct {
			Name     string  `json:"name"`
			BuildIDs []int64 `json:"build_ids"`
		} `json:"test_suites"`
	}
	if err := g.getJSON(ctx, fmt.Sprintf("/pipelines/%d/test_report_summary", p.PipelineID), nil, &summary); err != nil {
		return nil, nil, err
	}
	if summary.Total.Count == 0 {
		return nil, nil, nil
	}
	b, _, err := g.fetch(ctx, fmt.Sprintf("/pipelines/%d/test_report", p.PipelineID), nil, testreport.MaxBytes, false)
	if err != nil {
		return nil, nil, err
	}
	// Chỉ khai trường cần dùng: system_output, stack_trace, attachment bị bỏ ngay khi giải mã.
	var report struct {
		TotalCount int `json:"total_count"`
		TestSuites []struct {
			Name      string `json:"name"`
			TestCases []struct {
				Status        string  `json:"status"`
				Name          string  `json:"name"`
				Classname     string  `json:"classname"`
				ExecutionTime float64 `json:"execution_time"`
			} `json:"test_cases"`
		} `json:"test_suites"`
	}
	if json.Unmarshal(b, &report) != nil {
		return nil, nil, newError(CodeReportInvalid, 0, "Báo cáo test của GitLab không đọc được.")
	}
	if report.TotalCount == 0 {
		return nil, nil, nil
	}
	builds := map[string][]int64{}
	for _, s := range summary.TestSuites {
		builds[s.Name] = append(builds[s.Name], s.BuildIDs...)
	}
	match := jobMatcher(p.JobFilter)
	var tests []testreport.Test
	var jobIDs []int64
	seen := map[int64]bool{}
	for _, suite := range report.TestSuites {
		// [Inference] GitLab đặt tên suite theo tên job nên jobFilter lọc trên tên suite.
		if !match(suite.Name) {
			continue
		}
		var source int64
		if ids := builds[suite.Name]; len(ids) == 1 {
			source = ids[0]
		}
		for _, id := range builds[suite.Name] {
			if id > 0 && !seen[id] {
				seen[id] = true
				jobIDs = append(jobIDs, id)
			}
		}
		for _, tc := range suite.TestCases {
			status, ok := gitlabCaseStatus[tc.Status]
			ms := tc.ExecutionTime * 1000
			if !ok || ms < 0 || ms > 7*86400000 {
				return nil, nil, newError(CodeReportInvalid, 0, "Báo cáo test của GitLab có trạng thái hoặc thời gian không hợp lệ.")
			}
			tests = append(tests, testreport.Test{Name: tc.Classname + " " + tc.Name, Status: status,
				DurationMs: int64(ms + 0.5), Source: source})
		}
	}
	return tests, jobIDs, nil
}

type gitlabJob struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// artifactReports tải file ở artifactPath của từng job khớp jobFilter. Job không có file (404) hoặc file không có test
// bị bỏ qua: pipeline thường có job build, lint không chạy test.
func (g *gitlab) artifactReports(ctx context.Context, p TestReportParams) ([]testreport.Test, []int64, error) {
	format := "junit"
	if p.Mode == "playwright-artifact" {
		format = "playwright"
	}
	match := jobMatcher(p.JobFilter)
	var jobs []int64
	q := url.Values{"per_page": {strconv.Itoa(gitlabPerPage)}}
	for page := 1; page <= maxJobPages; page++ {
		q.Set("page", strconv.Itoa(page))
		var rows []gitlabJob
		if err := g.getJSON(ctx, fmt.Sprintf("/pipelines/%d/jobs", p.PipelineID), q, &rows); err != nil {
			return nil, nil, err
		}
		for _, j := range rows {
			if j.ID > 0 && match(j.Name) {
				jobs = append(jobs, j.ID)
			}
		}
		if len(rows) < gitlabPerPage {
			break
		}
	}
	path := artifactURLPath(p.ArtifactPath)
	var tests []testreport.Test
	var jobIDs []int64
	for _, id := range jobs {
		if len(jobIDs) == maxJobIDs {
			break
		}
		b, found, err := g.fetch(ctx, fmt.Sprintf("/jobs/%d/artifacts/%s", id, path), nil, testreport.MaxBytes, true)
		if err != nil {
			return nil, nil, err
		}
		if !found {
			continue
		}
		ts, _, _, err := testreport.Read(bytes.NewReader(b), format)
		switch {
		case errors.Is(err, testreport.ErrTooLarge):
			return nil, nil, newError(CodeReportTooLarge, 0, "File báo cáo test lớn hơn 32 MiB.")
		case err != nil:
			return nil, nil, newError(CodeReportInvalid, 0, "%s", err.Error())
		case len(ts) == 0:
			continue
		}
		for i := range ts {
			ts[i].Source = id
		}
		tests = append(tests, ts...)
		jobIDs = append(jobIDs, id)
	}
	return tests, jobIDs, nil
}

// artifactURLPath escape từng đoạn để `?`, `#` hay khoảng trắng trong tên file không đổi nghĩa URL.
func artifactURLPath(p string) string {
	parts := strings.FieldsFunc(p, func(r rune) bool { return r == '/' })
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

// jobMatcher khớp tên job với jobFilter: `*` là ký tự đại diện, rỗng là mọi job.
func jobMatcher(filters []string) func(string) bool {
	if len(filters) == 0 {
		return func(string) bool { return true }
	}
	res := make([]*regexp.Regexp, 0, len(filters))
	for _, f := range filters {
		parts := strings.Split(f, "*")
		for i, s := range parts {
			parts[i] = regexp.QuoteMeta(s)
		}
		res = append(res, regexp.MustCompile("^"+strings.Join(parts, ".*")+"$"))
	}
	return func(name string) bool {
		for _, re := range res {
			if re.MatchString(name) {
				return true
			}
		}
		return false
	}
}

// testReportError đổi lỗi chung của client HTTP sang mã của test-report; mã riêng, huỷ và tham số sai giữ nguyên.
func testReportError(err error) error {
	var de *Error
	if !errors.As(err, &de) {
		return newError(CodeGitLabUnreachable, 0, "Không đọc được GitLab từ máy này.")
	}
	code := de.Code
	switch de.Code {
	case CodeAuthFailed, CodeForbidden:
		code = CodeGitLabAuth
	case CodeNotFound:
		code = CodeGitLabNotFound
	case CodeUnavailable, CodeTimeout:
		code = CodeGitLabUnreachable
	case CodeBadRequest:
		// Có mã HTTP là GitLab từ chối (400, 409, 422); không có là tham số của việc sai.
		if de.Status != 0 {
			code = CodeGitLabUnreachable
		}
	}
	return &Error{Code: code, Status: de.Status, Message: de.Message}
}
