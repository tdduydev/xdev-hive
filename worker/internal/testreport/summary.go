// Package testreport chỉ xuất mã TC và số liệu: reporter gốc có thể chứa bí mật trong tên, lỗi, stdout và attachment.
package testreport

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"
)

const MaxBytes = 32 * 1024 * 1024
const MaxCases = 5000
const maxDuration = 7 * 86400000

type Case struct {
	Code       string `json:"code"`
	Status     string `json:"status"`
	Retries    int    `json:"retries"`
	DurationMs int64  `json:"durationMs"`
}
type Totals struct {
	Total   int `json:"total"`
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Skipped int `json:"skipped"`
	Flaky   int `json:"flaky"`
}
type Summary struct {
	Runner     string `json:"runner"`
	Commit     string `json:"commit,omitempty"`
	Totals     Totals `json:"totals"`
	DurationMs int64  `json:"durationMs"`
	Cases      []Case `json:"cases"`
	Truncated  bool   `json:"truncated"`
}

var tcCode = regexp.MustCompile(`\bTC-[0-9]{3,5}\b`)
var sha = regexp.MustCompile(`^([a-f0-9]{40}|[a-f0-9]{64})$`)
var rank = map[string]int{"passed": 0, "skipped": 1, "flaky": 2, "failed": 3}

func Parse(r io.Reader, format, commit string, limit int) (Summary, error) {
	s := Summary{Commit: commit, Cases: []Case{}}
	if limit < 1 || limit > MaxCases || (commit != "" && !sha.MatchString(commit)) {
		return s, errors.New("Giới hạn TC hoặc SHA commit không hợp lệ.")
	}
	b, err := io.ReadAll(io.LimitReader(r, MaxBytes+1))
	if err != nil || len(b) > MaxBytes {
		return s, errors.New("Không đọc được báo cáo hoặc báo cáo vượt 32 MiB.")
	}
	if format == "" {
		if strings.HasPrefix(strings.TrimSpace(string(b)), "<") {
			format = "junit"
		} else {
			format = "playwright"
		}
	}
	s.Runner = format
	var results []Case
	switch format {
	case "playwright":
		results, s.DurationMs, err = playwright(b)
	case "junit":
		results, s.DurationMs, err = junit(b)
	default:
		err = errors.New("Định dạng phải là playwright hoặc junit.")
	}
	if err != nil {
		return s, err
	}
	if len(results) == 0 || len(results) > 1000000 {
		return s, errors.New("Báo cáo không có test hoặc vượt giới hạn số test.")
	}
	byCode := map[string]Case{}
	for _, c := range results {
		s.Totals.Total++
		switch c.Status {
		case "passed":
			s.Totals.Passed++
		case "failed":
			s.Totals.Failed++
		case "skipped":
			s.Totals.Skipped++
		case "flaky":
			s.Totals.Flaky++
		default:
			return s, errors.New("Trạng thái test không hợp lệ.")
		}
		if c.Code == "" {
			continue
		}
		if old, ok := byCode[c.Code]; ok {
			if rank[old.Status] > rank[c.Status] {
				c.Status = old.Status
			}
			c.DurationMs += old.DurationMs
			c.Retries = max(c.Retries, old.Retries)
		}
		if c.DurationMs > maxDuration {
			return s, errors.New("Thời gian TC vượt giới hạn.")
		}
		byCode[c.Code] = c
	}
	for _, c := range byCode {
		s.Cases = append(s.Cases, c)
	}
	// Giữ test chưa đạt trước khi cắt, nhưng hub vẫn chặn mọi TC bắt buộc thiếu bằng chứng.
	sort.Slice(s.Cases, func(i, j int) bool {
		a, b := s.Cases[i], s.Cases[j]
		if rank[a.Status] != rank[b.Status] {
			return rank[a.Status] > rank[b.Status]
		}
		return a.Code < b.Code
	})
	if len(s.Cases) > limit {
		s.Truncated = true
		s.Cases = s.Cases[:limit]
	}
	return s, nil
}

func codeIn(name string) (string, error) {
	codes := tcCode.FindAllString(name, -1)
	code := ""
	for _, c := range codes {
		if code != "" && code != c {
			return "", errors.New("Một test chứa nhiều mã TC; cần tách để truy vết.")
		}
		code = c
	}
	return code, nil
}
func millis(n float64) (int64, error) {
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > maxDuration {
		return 0, errors.New("Thời gian test không hợp lệ.")
	}
	return int64(math.Round(n)), nil
}

type pwResult struct {
	Status   string
	Duration float64
}
type pwTest struct {
	ExpectedStatus string
	Status         string
	Results        []pwResult
}
type pwSpec struct {
	Title string
	Tests []pwTest
}
type pwSuite struct {
	Title  string
	Suites []pwSuite
	Specs  []pwSpec
}

func playwright(b []byte) ([]Case, int64, error) {
	var doc struct {
		Suites []pwSuite
		Stats  struct{ Duration float64 }
		Errors []json.RawMessage
	}
	if json.Unmarshal(b, &doc) != nil {
		return nil, 0, errors.New("Báo cáo Playwright JSON không hợp lệ.")
	}
	if len(doc.Errors) > 0 {
		return nil, 0, errors.New("Playwright có lỗi ngoài test; cần chạy lại bộ test.")
	}
	duration, err := millis(doc.Stats.Duration)
	if err != nil {
		return nil, 0, err
	}
	var out []Case
	var walk func(pwSuite, string) error
	walk = func(suite pwSuite, parent string) error {
		path := parent + " " + suite.Title
		for _, spec := range suite.Specs {
			code, err := codeIn(path + " " + spec.Title)
			if err != nil {
				return err
			}
			for _, test := range spec.Tests {
				c := Case{Code: code, Status: "passed", Retries: max(0, len(test.Results)-1)}
				if c.Retries > 100 {
					return errors.New("Số lần thử lại vượt giới hạn.")
				}
				if len(test.Results) == 0 {
					if test.Status != "skipped" {
						return errors.New("Test thiếu kết quả thực thi.")
					}
					c.Status = "skipped"
				} else {
					expected := test.ExpectedStatus
					if expected == "" {
						expected = "passed"
					}
					if expected != "passed" && expected != "failed" && expected != "skipped" {
						return errors.New("Trạng thái mong đợi không hợp lệ.")
					}
					mismatch := false
					for _, r := range test.Results {
						if r.Status != "passed" && r.Status != "failed" && r.Status != "timedOut" && r.Status != "interrupted" && r.Status != "skipped" {
							return errors.New("Trạng thái Playwright không hợp lệ.")
						}
						ms, err := millis(r.Duration)
						if err != nil {
							return err
						}
						c.DurationMs += ms
						if r.Status != expected {
							mismatch = true
						}
					}
					last := test.Results[len(test.Results)-1].Status
					switch {
					case last == "skipped":
						c.Status = "skipped"
					case last != expected:
						c.Status = "failed"
					case mismatch || test.Status == "flaky":
						c.Status = "flaky"
					}
				}
				out = append(out, c)
			}
		}
		for _, child := range suite.Suites {
			if err := walk(child, path); err != nil {
				return err
			}
		}
		return nil
	}
	for _, suite := range doc.Suites {
		if err := walk(suite, ""); err != nil {
			return nil, 0, err
		}
	}
	return out, duration, nil
}

type junitCase struct {
	Name        string     `xml:"name,attr"`
	Class       string     `xml:"classname,attr"`
	Time        float64    `xml:"time,attr"`
	Failures    []struct{} `xml:"failure"`
	Errors      []struct{} `xml:"error"`
	Skipped     *struct{}  `xml:"skipped"`
	Flaky       []struct{} `xml:"flakyFailure"`
	Rerun       []struct{} `xml:"rerunFailure"`
	FlakyErrors []struct{} `xml:"flakyError"`
	RerunErrors []struct{} `xml:"rerunError"`
}
type junitSuite struct {
	XMLName xml.Name
	Cases   []junitCase  `xml:"testcase"`
	Suites  []junitSuite `xml:"testsuite"`
	Errors  []struct{}   `xml:"error"`
}

func junit(b []byte) ([]Case, int64, error) {
	var root junitSuite
	if xml.Unmarshal(b, &root) != nil || (root.XMLName.Local != "testsuite" && root.XMLName.Local != "testsuites") {
		return nil, 0, errors.New("Báo cáo JUnit XML không hợp lệ.")
	}
	var out []Case
	var duration int64
	var walk func(junitSuite) error
	walk = func(suite junitSuite) error {
		if len(suite.Errors) > 0 {
			return errors.New("JUnit có lỗi ngoài test; cần chạy lại bộ test.")
		}
		for _, test := range suite.Cases {
			code, err := codeIn(test.Class + " " + test.Name)
			if err != nil {
				return err
			}
			ms, err := millis(test.Time * 1000)
			if err != nil {
				return err
			}
			c := Case{Code: code, Status: "passed", DurationMs: ms, Retries: len(test.Flaky) + len(test.Rerun) + len(test.FlakyErrors) + len(test.RerunErrors)}
			if c.Retries > 100 {
				return errors.New("Số lần thử lại vượt giới hạn.")
			}
			switch {
			case len(test.Failures)+len(test.Errors) > 0:
				c.Status = "failed"
			case test.Skipped != nil:
				c.Status = "skipped"
			case c.Retries > 0:
				c.Status = "flaky"
			}
			out = append(out, c)
			duration += ms
		}
		for _, child := range suite.Suites {
			if err := walk(child); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(root); err != nil {
		return nil, 0, err
	}
	if duration > maxDuration {
		return nil, 0, errors.New("Thời gian bộ test vượt giới hạn.")
	}
	return out, duration, nil
}
