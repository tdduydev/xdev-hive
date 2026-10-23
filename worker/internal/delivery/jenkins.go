package delivery

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Jenkins là client Jenkins chạy từ worker (port của hub `clients/jenkins.ts`). Credential có dạng "user:token".
type Jenkins struct{ c *apiClient }

// NewJenkins tạo client. cred là giá trị "user:token" đọc từ kho bí mật.
func NewJenkins(baseURL string, cred []byte, timeout time.Duration) (*Jenkins, error) {
	user, token, ok := strings.Cut(string(cred), ":")
	if !ok || user == "" || token == "" {
		return nil, newError(CodeBadRequest, 0, "Credential Jenkins phải có dạng user:token.")
	}
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+token))
	c, err := newAPIClient("Jenkins", baseURL, auth, timeout, nil)
	if err != nil {
		return nil, err
	}
	return &Jenkins{c: c}, nil
}

// JenkinsJobPath đổi "a/b/c" thành "/job/a/job/b/job/c", mã hoá từng đoạn.
func JenkinsJobPath(p string) (string, error) {
	segs := strings.Split(strings.Trim(p, "/"), "/")
	var sb strings.Builder
	for _, s := range segs {
		if s == "" || s == "." || s == ".." {
			return "", newError(CodeBadRequest, 0, "Đường dẫn job Jenkins không hợp lệ.")
		}
		sb.WriteString("/job/" + url.PathEscape(s))
	}
	return sb.String(), nil
}

type JenkinsTrigger struct {
	QueueID   int
	Number    int // 0 khi build còn trong hàng đợi
	URL       string
	Cancelled bool
}

type JenkinsBuild struct {
	Number   int
	URL      string
	Result   string // rỗng khi đang chạy
	Building bool
}

type JenkinsLog struct {
	Text string
	Next int64
	More bool
}

type JenkinsInput struct{ ID, Message string }

func (j *Jenkins) buildPath(job string, n int) (string, error) {
	if n < 1 {
		return "", newError(CodeBadRequest, 0, "Số build phải là số nguyên dương.")
	}
	p, err := JenkinsJobPath(job)
	if err != nil {
		return "", err
	}
	return p + "/" + strconv.Itoa(n), nil
}

var queueItem = regexp.MustCompile(`/queue/item/(\d+)`)

const jenkinsFormType = "application/x-www-form-urlencoded"

// Trigger bấm build. params == nil dùng /build, ngược lại /buildWithParameters (tham số nằm trong thân form, không nằm
// trên URL). Đợi tới wait để thấy số build; hết hạn thì trả Number 0.
func (j *Jenkins) Trigger(ctx context.Context, job string, params map[string]string, wait, poll time.Duration) (JenkinsTrigger, error) {
	p, err := JenkinsJobPath(job)
	if err != nil {
		return JenkinsTrigger{}, err
	}
	o := reqOpts{method: http.MethodPost, path: p + "/build", redirectOK: true}
	if params != nil {
		form := url.Values{}
		for k, v := range params {
			form.Set(k, v)
		}
		o.path = p + "/buildWithParameters"
		o.body = form.Encode()
		o.contentType = jenkinsFormType
	}
	res, err := j.c.do(ctx, o)
	if err != nil {
		return JenkinsTrigger{}, err
	}
	drain(res)
	m := queueItem.FindStringSubmatch(res.Header.Get("Location"))
	if m == nil {
		return JenkinsTrigger{}, newError(CodeUnavailable, res.StatusCode, "Jenkins không trả về mục hàng đợi.")
	}
	qid, _ := strconv.Atoi(m[1])
	out := JenkinsTrigger{QueueID: qid}
	if poll <= 0 {
		poll = 2 * time.Second
	}
	deadline := time.Now().Add(wait)
	for {
		item, err := j.c.json(ctx, reqOpts{
			path:  "/queue/item/" + strconv.Itoa(qid) + "/api/json",
			query: url.Values{"tree": {"id,cancelled,why,executable[number,url]"}},
		})
		if err != nil {
			return out, err
		}
		if cancelled, _ := item["cancelled"].(bool); cancelled {
			out.Cancelled = true
			return out, nil
		}
		if exe := rec(item["executable"]); exe["number"] != nil {
			out.Number, out.URL = num(exe["number"]), str(exe["url"])
			return out, nil
		}
		left := time.Until(deadline)
		if left <= 0 {
			return out, nil
		}
		if err := sleepCtx(ctx, min(poll, left)); err != nil {
			return out, j.c.networkError(ctx, err)
		}
	}
}

func (j *Jenkins) Build(ctx context.Context, job string, n int) (JenkinsBuild, error) {
	p, err := j.buildPath(job, n)
	if err != nil {
		return JenkinsBuild{}, err
	}
	raw, err := j.c.json(ctx, reqOpts{path: p + "/api/json", query: url.Values{"tree": {"number,result,building,url"}}})
	if err != nil {
		return JenkinsBuild{}, err
	}
	building, _ := raw["building"].(bool)
	return JenkinsBuild{Number: num(raw["number"]), URL: str(raw["url"]), Result: str(raw["result"]), Building: building}, nil
}

// Log đọc log từ byte start.
func (j *Jenkins) Log(ctx context.Context, job string, n int, start int64) (JenkinsLog, error) {
	p, err := j.buildPath(job, n)
	if err != nil {
		return JenkinsLog{}, err
	}
	if start < 0 {
		return JenkinsLog{}, newError(CodeBadRequest, 0, "start không được âm.")
	}
	res, err := j.c.do(ctx, reqOpts{path: p + "/logText/progressiveText", query: url.Values{"start": {strconv.FormatInt(start, 10)}}})
	if err != nil {
		return JenkinsLog{}, err
	}
	hdrNext, hdrMore := res.Header.Get("X-Text-Size"), res.Header.Get("X-More-Data")
	b, err := readBody(res)
	if err != nil {
		return JenkinsLog{}, err
	}
	next := start + int64(len(b))
	if v, perr := strconv.ParseInt(hdrNext, 10, 64); perr == nil && v >= 0 {
		next = v
	}
	return JenkinsLog{Text: string(b), Next: next, More: hdrMore == "true"}, nil
}

// PendingInputs là các bước input đang chờ; build không phải pipeline (404) thì không có.
func (j *Jenkins) PendingInputs(ctx context.Context, job string, n int) ([]JenkinsInput, error) {
	p, err := j.buildPath(job, n)
	if err != nil {
		return nil, err
	}
	res, err := j.c.do(ctx, reqOpts{path: p + "/wfapi/pendingInputActions", allow404: true})
	if err != nil {
		return nil, err
	}
	if res.StatusCode == 404 {
		drain(res)
		return nil, nil
	}
	b, err := readBody(res)
	if err != nil {
		return nil, err
	}
	var list []obj
	if err := json.Unmarshal(b, &list); err != nil {
		return nil, newError(CodeUnavailable, 0, "Jenkins trả về danh sách input không đọc được.")
	}
	var out []JenkinsInput
	for _, a := range list {
		if id := str(a["id"]); id != "" {
			out = append(out, JenkinsInput{ID: id, Message: str(a["message"])})
		}
	}
	return out, nil
}

func (j *Jenkins) post(ctx context.Context, path string) error {
	res, err := j.c.do(ctx, reqOpts{method: http.MethodPost, path: path, redirectOK: true})
	if err != nil {
		return err
	}
	drain(res)
	return nil
}

func (j *Jenkins) Stop(ctx context.Context, job string, n int) error {
	p, err := j.buildPath(job, n)
	if err != nil {
		return err
	}
	return j.post(ctx, p+"/stop")
}

// InputProceed cho build đi tiếp qua bước input (FR-042). [Unverified] dạng tham số khi bước đòi nhập.
func (j *Jenkins) InputProceed(ctx context.Context, job string, n int, inputID string) error {
	p, err := j.buildPath(job, n)
	if err != nil {
		return err
	}
	return j.post(ctx, p+"/input/"+url.PathEscape(inputID)+"/proceed")
}

func (j *Jenkins) InputAbort(ctx context.Context, job string, n int, inputID string) error {
	p, err := j.buildPath(job, n)
	if err != nil {
		return err
	}
	return j.post(ctx, p+"/input/"+url.PathEscape(inputID)+"/abort")
}
