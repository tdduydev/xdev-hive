package delivery

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultHTTPTimeout = 15 * time.Second
	maxBodyBytes       = 8 << 20
)

// apiClient là phần HTTP dùng chung của client Jenkins và Argo CD. Header xác thực nằm trong struct này và
// không bao giờ đi vào lỗi hay log; thông điệp từ máy chủ ngoài không được đưa nguyên văn vào lỗi.
type apiClient struct {
	system string
	base   string
	auth   string
	hc     *http.Client
}

func newAPIClient(system, baseURL, authHeader string, timeout time.Duration, tlsCfg *tls.Config) (*apiClient, error) {
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, newError(CodeBadRequest, 0, "Địa chỉ %s không hợp lệ.", system)
	}
	if timeout <= 0 {
		timeout = defaultHTTPTimeout
	}
	tr := &http.Transport{Proxy: nil, TLSClientConfig: tlsCfg, DisableKeepAlives: true}
	hc := &http.Client{
		Timeout:   timeout,
		Transport: tr,
		// 3xx thường là chuyển về trang đăng nhập SSO: phải thấy được, không đi theo.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &apiClient{system: system, base: strings.TrimRight(u.String(), "/"), auth: authHeader, hc: hc}, nil
}

func tlsWithCA(caPEM string) (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if caPEM == "" {
		return cfg, nil
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(caPEM)) {
		return nil, newError(CodeBadRequest, 0, "CA của cụm không đọc được.")
	}
	cfg.RootCAs = pool
	return cfg, nil
}

type reqOpts struct {
	method      string
	path        string
	query       url.Values
	body        string
	contentType string
	// redirectOK coi 3xx là thành công (Jenkins trả 302 sau stop, abort).
	redirectOK bool
	allow404   bool
}

func (c *apiClient) do(ctx context.Context, o reqOpts) (*http.Response, error) {
	if o.method == "" {
		o.method = http.MethodGet
	}
	target := c.base + o.path
	if len(o.query) > 0 {
		target += "?" + o.query.Encode()
	}
	var body io.Reader
	if o.body != "" {
		body = strings.NewReader(o.body)
	}
	req, err := http.NewRequestWithContext(ctx, o.method, target, body)
	if err != nil {
		return nil, newError(CodeBadRequest, 0, "Yêu cầu tới %s không hợp lệ.", c.system)
	}
	req.Header.Set("Accept", "application/json, text/plain, */*")
	if c.auth != "" {
		req.Header.Set("Authorization", c.auth)
	}
	if o.contentType != "" {
		req.Header.Set("Content-Type", o.contentType)
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return nil, c.networkError(ctx, err)
	}
	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return res, nil
	case res.StatusCode >= 300 && res.StatusCode < 400:
		if o.redirectOK && !strings.Contains(strings.ToLower(res.Header.Get("Location")), "login") {
			return res, nil
		}
		drain(res)
		return nil, httpError(c.system, 401)
	case res.StatusCode == 404 && o.allow404:
		return res, nil
	}
	drain(res)
	return nil, httpError(c.system, res.StatusCode)
}

func (c *apiClient) networkError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.Canceled) {
		return newError(CodeCanceled, 0, "Đã huỷ.")
	}
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return newError(CodeTimeout, 0, "%s không trả lời kịp.", c.system)
	}
	// Không đưa err.Error() vào thông điệp: nó chứa URL đầy đủ và có thể chứa chuỗi do máy chủ ngoài đặt.
	return newError(CodeUnavailable, 0, "Không kết nối được %s từ máy này.", c.system)
}

func drain(res *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	_ = res.Body.Close()
}

func readBody(res *http.Response) ([]byte, error) {
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxBodyBytes+1))
	if err != nil {
		return nil, newError(CodeUnavailable, 0, "Không đọc hết phản hồi.")
	}
	if len(b) > maxBodyBytes {
		return nil, newError(CodeUnavailable, 0, "Phản hồi quá lớn.")
	}
	return b, nil
}

type obj = map[string]any

func (c *apiClient) json(ctx context.Context, o reqOpts) (obj, error) {
	res, err := c.do(ctx, o)
	if err != nil {
		return nil, err
	}
	b, err := readBody(res)
	if err != nil {
		return nil, err
	}
	var v obj
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, newError(CodeUnavailable, res.StatusCode, "%s trả về nội dung không phải JSON (có thể proxy chặn).", c.system)
	}
	return v, nil
}

func rec(v any) obj {
	if m, ok := v.(obj); ok {
		return m
	}
	return obj{}
}

func arr(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	return nil
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func num(v any) int {
	f, _ := v.(float64)
	return int(f)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
