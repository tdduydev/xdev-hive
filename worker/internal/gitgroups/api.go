package gitgroups

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// maxPages chặn vòng lặp khi máy chủ trả trang kế tiếp mãi: 200 trang × 100 repo là đủ cho group lớn nhất hay gặp.
const maxPages = 200

// Client gọi API của một máy chủ Git bằng token cá nhân. Token rỗng thì gọi không xác thực (group công khai).
type Client struct {
	Host  Host
	Token string
	HTTP  *http.Client
}

func (c Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

// apiBase: GitLab là <url>/api/v4; GitHub.com là api.github.com, GitHub Enterprise là <url>/api/v3.
func apiBase(h Host) string {
	if h.Kind == KindGitHub {
		if u, err := url.Parse(h.URL); err == nil && strings.EqualFold(u.Hostname(), "github.com") {
			return "https://api.github.com"
		}
		return h.URL + "/api/v3"
	}
	return h.URL + "/api/v4"
}

// APIError là lỗi HTTP của máy chủ Git, đã viết thành câu cho người dùng.
type APIError struct {
	Status int
	Msg    string
}

func (e *APIError) Error() string { return e.Msg }

// get đọc một trang JSON vào v, trả URL trang kế tiếp (rỗng là hết).
func (c Client) get(ctx context.Context, raw string, v any) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	if c.Host.Kind == KindGitHub {
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	}
	if c.Token != "" {
		if c.Host.Kind == KindGitHub {
			req.Header.Set("Authorization", "Bearer "+c.Token)
		} else {
			req.Header.Set("PRIVATE-TOKEN", c.Token)
		}
	}
	res, err := c.http().Do(req)
	if err != nil {
		return "", fmt.Errorf("không gọi được %s: %w", c.Host.URL, err)
	}
	defer func() { _ = res.Body.Close() }()
	body := io.LimitReader(res.Body, 64<<20)
	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(body, 1<<20))
		return "", statusError(c.Host, res.StatusCode)
	}
	if err := json.NewDecoder(body).Decode(v); err != nil {
		return "", fmt.Errorf("máy chủ %s trả dữ liệu không đọc được: %w", c.Host.URL, err)
	}
	return c.nextPage(raw, res.Header), nil
}

func statusError(h Host, status int) *APIError {
	msg := fmt.Sprintf("máy chủ %s trả lỗi %d", h.URL, status)
	switch status {
	case http.StatusUnauthorized:
		msg = fmt.Sprintf("Token không dùng được với %s (401): hết hạn, bị thu hồi hoặc dán sai", h.URL)
	case http.StatusForbidden:
		msg = fmt.Sprintf("Token không đủ quyền trên %s (403): cần quyền đọc API và repo (read_api, read_repository hoặc repo)", h.URL)
	case http.StatusNotFound:
		msg = fmt.Sprintf("Không tìm thấy trên %s (404), hoặc token không thấy được", h.URL)
	case http.StatusTooManyRequests:
		msg = fmt.Sprintf("%s đang giới hạn lượt gọi (429), thử lại sau", h.URL)
	}
	return &APIError{Status: status, Msg: msg}
}

// nextPage đọc Link rel="next" (GitHub, GitLab), không có thì X-Next-Page (GitLab). Chỉ theo trang cùng máy chủ để token
// không bị gửi sang nơi khác.
func (c Client) nextPage(current string, h http.Header) string {
	cur, err := url.Parse(current)
	if err != nil {
		return ""
	}
	for _, part := range strings.Split(h.Get("Link"), ",") {
		segs := strings.Split(part, ";")
		if len(segs) < 2 {
			continue
		}
		next := false
		for _, s := range segs[1:] {
			if strings.EqualFold(strings.ReplaceAll(strings.TrimSpace(s), " ", ""), `rel="next"`) {
				next = true
			}
		}
		if !next {
			continue
		}
		u, err := url.Parse(strings.Trim(strings.TrimSpace(segs[0]), "<>"))
		if err != nil || !strings.EqualFold(u.Host, cur.Host) || u.Scheme != cur.Scheme {
			return ""
		}
		return u.String()
	}
	if p := strings.TrimSpace(h.Get("X-Next-Page")); p != "" {
		q := cur.Query()
		q.Set("page", p)
		cur.RawQuery = q.Encode()
		return cur.String()
	}
	return ""
}

// User đọc tên đăng nhập của token; dùng để kiểm token trước khi lưu.
func (c Client) User(ctx context.Context) (string, error) {
	var u struct {
		Username string `json:"username"`
		Login    string `json:"login"`
	}
	if _, err := c.get(ctx, apiBase(c.Host)+"/user", &u); err != nil {
		return "", err
	}
	if c.Host.Kind == KindGitHub {
		return u.Login, nil
	}
	return u.Username, nil
}

type gitlabProject struct {
	Name          string `json:"name"`
	PathNS        string `json:"path_with_namespace"`
	DefaultBranch string `json:"default_branch"`
	Archived      bool   `json:"archived"`
	EmptyRepo     bool   `json:"empty_repo"`
	HTTPURL       string `json:"http_url_to_repo"`
	SSHURL        string `json:"ssh_url_to_repo"`
	WebURL        string `json:"web_url"`
}

type githubRepo struct {
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	DefaultBranch string `json:"default_branch"`
	Archived      bool   `json:"archived"`
	Size          int    `json:"size"`
	CloneURL      string `json:"clone_url"`
	SSHURL        string `json:"ssh_url"`
	HTMLURL       string `json:"html_url"`
}

// ListRepos đọc mọi repo của group (GitLab, gồm subgroup) hay org/tài khoản (GitHub), qua mọi trang.
func (c Client) ListRepos(ctx context.Context, path string) ([]Repo, error) {
	var out []Repo
	if c.Host.Kind == KindGitHub {
		repos, err := c.githubRepos(ctx, path)
		if err != nil {
			return nil, err
		}
		for _, r := range repos {
			out = append(out, Repo{
				Path: r.FullName, Name: r.Name, DefaultBranch: r.DefaultBranch, Archived: r.Archived,
				Empty: r.Size == 0 && r.DefaultBranch == "", HTTPURL: r.CloneURL, SSHURL: r.SSHURL, WebURL: r.HTMLURL,
			})
		}
	} else {
		// with_shared=false: repo của namespace khác được chia sẻ vào group không nằm dưới đường dẫn group.
		next := fmt.Sprintf("%s/groups/%s/projects?include_subgroups=true&with_shared=false&per_page=100&order_by=path&sort=asc",
			apiBase(c.Host), url.PathEscape(path))
		for page := 0; next != ""; page++ {
			if page >= maxPages {
				return nil, fmt.Errorf("group %s có quá %d trang repo", path, maxPages)
			}
			var batch []gitlabProject
			var err error
			if next, err = c.get(ctx, next, &batch); err != nil {
				return nil, groupError(err, path)
			}
			for _, p := range batch {
				out = append(out, Repo{
					Path: p.PathNS, Name: p.Name, DefaultBranch: p.DefaultBranch, Archived: p.Archived,
					Empty: p.EmptyRepo, HTTPURL: p.HTTPURL, SSHURL: p.SSHURL, WebURL: p.WebURL,
				})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Path) < strings.ToLower(out[j].Path) })
	if out == nil {
		out = []Repo{}
	}
	return out, nil
}

func groupError(err error, path string) error {
	var api *APIError
	if errors.As(err, &api) && api.Status == http.StatusNotFound {
		return &APIError{Status: api.Status, Msg: fmt.Sprintf("Không tìm thấy group %q, hoặc token không thấy group này", path)}
	}
	return err
}

// githubRepos: org trước; không phải org thì là tài khoản. Tài khoản của chính token đọc qua /user/repos để thấy cả repo
// riêng tư.
func (c Client) githubRepos(ctx context.Context, owner string) ([]githubRepo, error) {
	base := apiBase(c.Host)
	esc := url.PathEscape(owner)
	all, err := c.githubPages(ctx, base+"/orgs/"+esc+"/repos?type=all&sort=full_name&per_page=100")
	var api *APIError
	if err == nil || !errors.As(err, &api) || api.Status != http.StatusNotFound {
		return all, groupError(err, owner)
	}
	next := base + "/users/" + esc + "/repos?type=owner&sort=full_name&per_page=100"
	if c.Token != "" {
		if login, err := c.User(ctx); err == nil && strings.EqualFold(login, owner) {
			next = base + "/user/repos?affiliation=owner&sort=full_name&per_page=100"
		}
	}
	all, err = c.githubPages(ctx, next)
	return all, groupError(err, owner)
}

func (c Client) githubPages(ctx context.Context, next string) ([]githubRepo, error) {
	var all []githubRepo
	for page := 0; next != ""; page++ {
		if page >= maxPages {
			return nil, fmt.Errorf("quá %d trang repo", maxPages)
		}
		var batch []githubRepo
		var err error
		if next, err = c.get(ctx, next, &batch); err != nil {
			return nil, err
		}
		all = append(all, batch...)
	}
	return all, nil
}

// Suggest gợi ý đường dẫn group cho ô nhập: group GitLab token là thành viên (có tìm theo chữ), hay org GitHub của token
// kèm chính tài khoản. Một trang là đủ cho gợi ý.
func (c Client) Suggest(ctx context.Context, search string) ([]string, error) {
	base := apiBase(c.Host)
	out := []string{}
	if c.Host.Kind == KindGitHub {
		if c.Token == "" {
			return out, nil
		}
		var orgs []struct {
			Login string `json:"login"`
		}
		if _, err := c.get(ctx, base+"/user/orgs?per_page=100", &orgs); err != nil {
			return nil, err
		}
		if login, err := c.User(ctx); err == nil && login != "" {
			out = append(out, login)
		}
		for _, o := range orgs {
			out = append(out, o.Login)
		}
		return filterPrefix(out, search), nil
	}
	q := url.Values{"per_page": {"100"}, "order_by": {"path"}, "sort": {"asc"}}
	if c.Token != "" {
		q.Set("min_access_level", "10")
	}
	if s := strings.TrimSpace(search); s != "" {
		q.Set("search", s)
	}
	var groups []struct {
		FullPath string `json:"full_path"`
	}
	if _, err := c.get(ctx, base+"/groups?"+q.Encode(), &groups); err != nil {
		return nil, err
	}
	for _, g := range groups {
		out = append(out, g.FullPath)
	}
	return out, nil
}

func filterPrefix(list []string, search string) []string {
	s := strings.ToLower(strings.TrimSpace(search))
	if s == "" {
		return list
	}
	out := []string{}
	for _, v := range list {
		if strings.Contains(strings.ToLower(v), s) {
			out = append(out, v)
		}
	}
	return out
}
