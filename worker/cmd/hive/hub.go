package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Gọi REST API của hub bằng token cá nhân (specs/010 D12): chỉ để biết mình là ai, tra task/dự án và xem phiên trên
// máy khác. Phiên `hive chat` không cần token: worker ghi bằng danh tính máy.

const hubTimeout = 30 * time.Second

// patOrg lấy tổ chức trong token (`hive_pat_<org>_<bí mật>`): hub đòi `x-hive-org` khớp với tổ chức của token.
var patOrg = regexp.MustCompile(`^hive_pat_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$`)

func validPAT(token string) bool { return patOrg.MatchString(token) }

// errUnauthorized: hub không nhận token (hết hạn, bị thu hồi, sai tổ chức).
var errUnauthorized = errors.New("token không còn hiệu lực")

type hubClient struct {
	http  *http.Client
	base  string
	token string
}

// hubError là lỗi hub trả về; Message đã là tiếng Việt nên in nguyên.
type hubError struct {
	Status  int
	Message string
}

func (e *hubError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("Hub trả lỗi %d.", e.Status)
}

func normalizeHub(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("địa chỉ hub %q không hợp lệ; cần dạng https://hive.cong-ty.vn", raw)
	}
	return strings.TrimRight(u.Scheme+"://"+u.Host+u.Path, "/"), nil
}

func (c *hubClient) do(method, path string, body io.Reader, out any) error {
	req, err := http.NewRequest(method, c.base+"/api"+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("accept", "application/json")
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("authorization", "Bearer "+c.token)
		if m := patOrg.FindStringSubmatch(c.token); m != nil {
			req.Header.Set("x-hive-org", m[1])
		}
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("không gọi được hub %s: %w", c.base, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("không đọc được trả lời của hub: %w", err)
	}
	if res.StatusCode == http.StatusUnauthorized && c.token != "" {
		return errUnauthorized
	}
	if res.StatusCode/100 != 2 {
		var e struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &e)
		return &hubError{Status: res.StatusCode, Message: e.Message}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return errors.New("hub trả dữ liệu không đọc được; hub có thể là bản cũ hoặc địa chỉ sai")
	}
	return nil
}

type me struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

func (c *hubClient) me() (me, error) {
	var m me
	return m, c.do(http.MethodGet, "/v1/me", nil, &m)
}

type hubProject struct {
	ID   string `json:"id"`
	Key  string `json:"key"`
	Name string `json:"name"`
}

type hubTask struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Key       string `json:"key"`
	Title     string `json:"title"`
}

// project tìm dự án theo key (không phân biệt hoa thường) trong các dự án người dùng xem được.
func (c *hubClient) project(key string) (*hubProject, error) {
	var list []hubProject
	if err := c.do(http.MethodGet, "/v1/projects", nil, &list); err != nil {
		return nil, err
	}
	for i := range list {
		if strings.EqualFold(list[i].Key, key) || list[i].ID == key {
			return &list[i], nil
		}
	}
	return nil, nil
}

// task tìm task theo key `<dự án>-<số>`: lấy dự án theo phần trước dấu gạch cuối rồi tìm trong task của dự án đó.
func (c *hubClient) task(key string) (*hubTask, error) {
	i := strings.LastIndexByte(key, '-')
	if i <= 0 || i == len(key)-1 {
		return nil, nil
	}
	p, err := c.project(key[:i])
	if err != nil || p == nil {
		return nil, err
	}
	var list []hubTask
	if err := c.do(http.MethodGet, "/v1/tasks?projectId="+url.QueryEscape(p.ID), nil, &list); err != nil {
		return nil, err
	}
	for i := range list {
		if strings.EqualFold(list[i].Key, key) {
			return &list[i], nil
		}
	}
	return nil, nil
}

type remoteSession struct {
	ID          string  `json:"id"`
	MachineName string  `json:"machineName"`
	CLI         string  `json:"cli"`
	CwdLabel    *string `json:"cwdLabel"`
	TaskKey     *string `json:"taskKey"`
	ProjectKey  *string `json:"projectKey"`
	State       string  `json:"state"`
	Controller  *string `json:"controller"`
	CreatedAt   string  `json:"createdAt"`
}

func (c *hubClient) remoteSessions() (json.RawMessage, error) {
	var raw json.RawMessage
	return raw, c.do(http.MethodGet, "/v1/remote/sessions?active=true", nil, &raw)
}
