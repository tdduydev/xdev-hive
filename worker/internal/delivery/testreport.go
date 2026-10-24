package delivery

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
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
