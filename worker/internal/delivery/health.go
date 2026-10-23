package delivery

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// HealthMatch so một trường JSON theo đường dẫn chấm, ví dụ "status.state".
type HealthMatch struct {
	Path   string
	Equals string
}

// HealthCheck là kiểm tra sau triển khai, chạy từ máy trong mạng nội bộ nên với được địa chỉ mà hub không với được.
type HealthCheck struct {
	URL string
	// ExpectStatus bằng 0 nghĩa là 200.
	ExpectStatus   int
	Match          *HealthMatch
	AttemptTimeout time.Duration
	Interval       time.Duration
}

type HealthResult struct {
	OK       bool
	Attempts int
	// Message chỉ nêu tên máy, không nêu đường dẫn hay query vì chúng có thể chứa token.
	Message string
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "địa chỉ kiểm tra"
	}
	return u.Host
}

// RunHealth thử lại đến hết deadline của ctx. Không đi theo chuyển hướng: 3xx là kết quả, không phải trang đích.
func RunHealth(ctx context.Context, hc HealthCheck) HealthResult {
	u, err := url.Parse(hc.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return HealthResult{Message: "Địa chỉ kiểm tra sức khoẻ không hợp lệ."}
	}
	expect := hc.ExpectStatus
	if expect == 0 {
		expect = 200
	}
	perTry := hc.AttemptTimeout
	if perTry <= 0 {
		perTry = 5 * time.Second
	}
	interval := hc.Interval
	if interval <= 0 {
		interval = 3 * time.Second
	}
	client := &http.Client{
		Timeout:       perTry,
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	host := hostOf(hc.URL)
	last := "chưa thử"
	res := HealthResult{}
	for {
		res.Attempts++
		last = attemptHealth(ctx, client, hc, expect, host)
		if last == "" {
			res.OK, res.Message = true, "Kiểm tra sức khoẻ đạt ("+host+")."
			return res
		}
		if err := sleepCtx(ctx, interval); err != nil {
			res.Message = "Hết thời gian kiểm tra sức khoẻ: " + last
			return res
		}
	}
}

// attemptHealth trả chuỗi rỗng khi đạt, ngược lại là lý do.
func attemptHealth(ctx context.Context, c *http.Client, hc HealthCheck, expect int, host string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, hc.URL, nil)
	if err != nil {
		return "yêu cầu không hợp lệ"
	}
	resp, err := c.Do(req)
	if err != nil {
		return "không kết nối được " + host
	}
	defer resp.Body.Close()
	if resp.StatusCode != expect {
		return host + " trả mã " + itoa(resp.StatusCode) + ", cần " + itoa(expect)
	}
	if hc.Match == nil {
		return ""
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "không đọc hết phản hồi từ " + host
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		return "phản hồi từ " + host + " không phải JSON"
	}
	for _, key := range strings.Split(hc.Match.Path, ".") {
		m, ok := v.(map[string]any)
		if !ok {
			return "không thấy trường cần so khớp"
		}
		v = m[key]
	}
	if got := stringify(v); got != hc.Match.Equals {
		return "giá trị trường cần so khớp chưa đúng"
	}
	return ""
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func stringify(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return ""
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}
