package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
	"github.com/tdduydev/xdev-hive/worker/internal/gitgroups"
	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

const gitgroupsUsage = `Cách dùng: hive-worker gitgroups [lệnh] [--config FILE] [--json]
  (không lệnh)        liệt kê kết nối và nhóm theo dõi
  host-add            --kind gitlab|github [--url URL] [--name TÊN]; token trong biến HIVE_GIT_TOKEN
  host-remove         --id ID
  suggest             --host ID [--search CHỮ]
  group-add           --host ID --path GROUP --root THƯ_MỤC [--protocol https|ssh] [--filter REGEX] [--include-archived]
  group-update        --id ID [--root] [--protocol] [--filter] [--include-archived=true|false] [--excluded JSON] [--auto-fetch PHÚT]
  group-refresh       --id ID
  group-remove        --id ID (không xoá thư mục đã clone)
  status              --id ID
  sync                --id ID --action clone|fetch|pull|status [--concurrency N]; in mỗi dòng một JSON, gõ "cancel" để huỷ
  due                 nhóm đến lượt tự fetch
  auto-fetch          fetch các nhóm đến lượt
Token của kết nối đã lưu: biến HIVE_GIT_TOKENS dạng {"id kết nối": "token"}.`

// gitgroupsView là kết quả của lệnh gitgroups cho app desktop.
type gitgroupsView struct {
	Path   string                 `json:"path"`
	Hosts  []gitgroups.Host       `json:"hosts"`
	Groups []gitgroups.Group      `json:"groups"`
	Host   *gitgroups.Host        `json:"host,omitempty"`
	Group  *gitgroups.Group       `json:"group,omitempty"`
	Items  []string               `json:"items,omitempty"`
	Status []gitgroups.RepoStatus `json:"status,omitempty"`
	// Due là id nhóm đến lượt tự fetch kèm id kết nối, để app chỉ đọc token cần dùng.
	Due []dueGroup `json:"due,omitempty"`
}

type dueGroup struct {
	ID     string `json:"id"`
	HostID string `json:"hostId"`
}

// gitgroupsNow cho test thay.
var gitgroupsNow = time.Now

func gitgroupsCommand(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	action := "list"
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		action, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("gitgroups "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "file cấu hình worker (gitgroups.json nằm cạnh)")
	asJSON := fs.Bool("json", false, "in dạng JSON (cho app desktop)")
	id := fs.String("id", "", "id kết nối hay nhóm")
	hostID := fs.String("host", "", "id kết nối")
	kind := fs.String("kind", "", "gitlab hoặc github")
	authMode := fs.String("auth-mode", "token", "token hoặc git")
	rawURL := fs.String("url", "", "địa chỉ máy chủ")
	name := fs.String("name", "", "tên gợi nhớ")
	search := fs.String("search", "", "chữ cần tìm")
	path := fs.String("path", "", "đường dẫn group hay org")
	root := fs.String("root", "", "thư mục gốc để clone")
	protocol := fs.String("protocol", "", "https hoặc ssh")
	filter := fs.String("filter", "", "regex lọc đường dẫn repo")
	archived := fs.String("include-archived", "", "true hoặc false")
	excluded := fs.String("excluded", "", "JSON: danh sách đường dẫn repo bỏ chọn")
	autoFetch := fs.String("auto-fetch", "", "số phút giữa hai lần tự fetch, 0 là tắt")
	syncAction := fs.String("action", "", "clone, fetch, pull hoặc status")
	concurrency := fs.Int("concurrency", gitgroups.DefaultConcurrency, "số repo chạy cùng lúc")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	cfgPath, err := pathOr(*configPath)
	fail := func(err error) int {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err != nil {
		return fail(err)
	}
	file := gitgroups.DefaultPath(cfgPath)
	tokens, err := gitTokens()
	if err != nil {
		return fail(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	self, _ := os.Executable()
	view := gitgroupsView{Path: file}
	usage := func() int {
		fmt.Fprintln(stderr, gitgroupsUsage)
		return 2
	}

	switch action {
	case "list":
	case "host-add":
		h, err := gitgroups.NormalizeHost(*kind, *rawURL, *name)
		if err != nil {
			return fail(err)
		}
		if *authMode != "token" && *authMode != "git" {
			return fail(errors.New("cách đăng nhập không hợp lệ"))
		}
		h.AuthMode = *authMode
		token := strings.TrimSpace(os.Getenv(gitexec.TokenEnv))
		_ = os.Unsetenv(gitexec.TokenEnv)
		if token == "" {
			return fail(errors.New("thiếu token (biến HIVE_GIT_TOKEN)"))
		}
		user, err := gitgroups.Client{Host: h, Token: token}.User(ctx)
		if err != nil {
			return fail(err)
		}
		h.Username = user
		err = gitgroups.Modify(file, func(c *gitgroups.Config) error {
			h = c.AddHost(h)
			return nil
		})
		if err != nil {
			return fail(err)
		}
		view.Host = &h
	case "host-remove":
		if *id == "" {
			return usage()
		}
		if err := gitgroups.Modify(file, func(c *gitgroups.Config) error { return c.RemoveHost(*id) }); err != nil {
			return fail(err)
		}
	case "suggest":
		c, err := gitgroups.Load(file)
		if err != nil {
			return fail(err)
		}
		h := c.Host(*hostID)
		if h == nil {
			return fail(errors.New("không có kết nối này"))
		}
		if view.Items, err = (gitgroups.Client{Host: *h, Token: tokens[h.ID]}).Suggest(ctx, *search); err != nil {
			return fail(err)
		}
	case "group-add":
		c, err := gitgroups.Load(file)
		if err != nil {
			return fail(err)
		}
		h := c.Host(*hostID)
		if h == nil {
			return fail(errors.New("không có kết nối này"))
		}
		g := gitgroups.Group{HostID: h.ID, Root: *root, Protocol: *protocol, Filter: *filter, IncludeArchived: *archived == "true"}
		if g.Path, err = gitgroups.NormalizeGroupPath(*h, *path); err != nil {
			return fail(err)
		}
		if err := g.Check(); err != nil {
			return fail(err)
		}
		if g.Repos, err = (gitgroups.Client{Host: *h, Token: tokens[h.ID]}).ListRepos(ctx, g.Path); err != nil {
			return fail(err)
		}
		g.ListedAt = gitgroupsNow().UTC().Format(time.RFC3339)
		err = gitgroups.Modify(file, func(c *gitgroups.Config) error {
			var err error
			g, err = c.AddGroup(g)
			return err
		})
		if err != nil {
			return fail(err)
		}
		view.Group = &g
	case "group-update":
		if *id == "" {
			return usage()
		}
		err := gitgroups.Modify(file, func(c *gitgroups.Config) error {
			g := c.Group(*id)
			if g == nil {
				return errors.New("không có nhóm này")
			}
			next := *g
			if set["root"] {
				next.Root = *root
			}
			if set["protocol"] {
				next.Protocol = *protocol
			}
			if set["filter"] {
				next.Filter = *filter
			}
			if set["include-archived"] {
				on, err := strconv.ParseBool(*archived)
				if err != nil {
					return errors.New("--include-archived phải là true hoặc false")
				}
				next.IncludeArchived = on
			}
			if set["excluded"] {
				var list []string
				if err := json.Unmarshal([]byte(*excluded), &list); err != nil {
					return errors.New("--excluded phải là danh sách JSON")
				}
				next.Excluded = list
			}
			if set["auto-fetch"] {
				n, err := strconv.Atoi(*autoFetch)
				if err != nil {
					return errors.New("--auto-fetch phải là số phút")
				}
				next.AutoFetchMinutes = n
			}
			if err := next.Check(); err != nil {
				return err
			}
			*g = next
			view.Group = &next
			return nil
		})
		if err != nil {
			return fail(err)
		}
	case "group-refresh":
		c, err := gitgroups.Load(file)
		if err != nil {
			return fail(err)
		}
		g := c.Group(*id)
		if g == nil {
			return fail(errors.New("không có nhóm này"))
		}
		h := c.Host(g.HostID)
		if h == nil {
			return fail(errors.New("kết nối của nhóm đã bị xoá"))
		}
		repos, err := gitgroups.Client{Host: *h, Token: tokens[h.ID]}.ListRepos(ctx, g.Path)
		if err != nil {
			return fail(err)
		}
		err = gitgroups.Modify(file, func(c *gitgroups.Config) error {
			g := c.Group(*id)
			if g == nil {
				return errors.New("không có nhóm này")
			}
			g.Repos, g.ListedAt = repos, gitgroupsNow().UTC().Format(time.RFC3339)
			view.Group = g
			return nil
		})
		if err != nil {
			return fail(err)
		}
	case "group-remove":
		if *id == "" {
			return usage()
		}
		if err := gitgroups.Modify(file, func(c *gitgroups.Config) error { return c.RemoveGroup(*id) }); err != nil {
			return fail(err)
		}
	case "status", "sync":
		c, err := gitgroups.Load(file)
		if err != nil {
			return fail(err)
		}
		g := c.Group(*id)
		if g == nil {
			return fail(errors.New("không có nhóm này"))
		}
		h := c.Host(g.HostID)
		if h == nil {
			return fail(errors.New("kết nối của nhóm đã bị xoá"))
		}
		s := gitgroups.Sync{
			Git:         gitexec.Git{Askpass: self, Kind: h.Kind, Token: tokens[h.ID], UseGitCredentials: h.AuthMode == "git"},
			Group:       *g,
			Projects:    projects.DefaultPath(cfgPath),
			Concurrency: *concurrency,
		}
		if action == "status" {
			view.Status = []gitgroups.RepoStatus{}
			err := s.Run(ctx, gitgroups.ActionStatus, func(e gitgroups.Event) {
				if e.Status != nil {
					view.Status = append(view.Status, *e.Status)
				}
			})
			if err != nil {
				return fail(err)
			}
			break
		}
		if *syncAction == "" {
			return usage()
		}
		return gitgroupsSync(ctx, s, *syncAction, stdin, stdout, stderr, *asJSON)
	case "due":
		c, err := gitgroups.Load(file)
		if err != nil {
			return fail(err)
		}
		view.Due = []dueGroup{}
		for _, g := range c.Groups {
			if gitgroups.Due(g, gitgroupsNow()) {
				view.Due = append(view.Due, dueGroup{ID: g.ID, HostID: g.HostID})
			}
		}
	case "auto-fetch":
		if code := gitgroupsAutoFetch(ctx, file, cfgPath, self, tokens, stderr); code != 0 {
			return code
		}
	default:
		return usage()
	}

	c, err := gitgroups.Load(file)
	if err != nil {
		return fail(err)
	}
	view.Hosts, view.Groups = c.Hosts, c.Groups
	if *asJSON {
		_ = json.NewEncoder(stdout).Encode(view)
		return 0
	}
	return printGitgroups(view, stdout)
}

func printGitgroups(view gitgroupsView, stdout io.Writer) int {
	for _, s := range view.Items {
		fmt.Fprintln(stdout, s)
	}
	for _, s := range view.Status {
		fmt.Fprintf(stdout, "%-10s %s %s\n", s.State, s.Path, s.Reason)
	}
	if view.Items != nil || view.Status != nil {
		return 0
	}
	if len(view.Hosts) == 0 {
		fmt.Fprintf(stdout, "Chưa có kết nối Git nào (%s).\n", view.Path)
		return 0
	}
	for _, h := range view.Hosts {
		fmt.Fprintf(stdout, "%s  %s %s (%s)\n", h.ID, h.Kind, h.URL, h.Username)
	}
	for _, g := range view.Groups {
		fmt.Fprintf(stdout, "%s  %s → %s (%d repo)\n", g.ID, g.Path, g.Root, len(g.Repos))
	}
	return 0
}

// gitgroupsSync in tiến độ mỗi dòng một JSON. App huỷ bằng cách ghi "cancel" vào stdin: giết thẳng sidecar thì git con
// còn chạy tiếp và clone dở không được dọn.
func gitgroupsSync(ctx context.Context, s gitgroups.Sync, action string, stdin io.Reader, stdout, stderr io.Writer, asJSON bool) int {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		sc := bufio.NewScanner(stdin)
		for sc.Scan() {
			if strings.TrimSpace(sc.Text()) == "cancel" {
				cancel()
				return
			}
		}
	}()
	enc := json.NewEncoder(stdout)
	err := s.Run(ctx, action, func(e gitgroups.Event) {
		if asJSON {
			_ = enc.Encode(e)
			return
		}
		if e.Type == "repo" {
			fmt.Fprintf(stdout, "[%d/%d] %-9s %s %s\n", e.Done, e.Total, e.Result, e.Path, e.Message)
		}
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

// gitgroupsAutoFetch fetch các nhóm đến lượt rồi ghi giờ, kể cả khi fetch lỗi, để máy chủ trục trặc không bị gọi lại
// mỗi phút.
func gitgroupsAutoFetch(ctx context.Context, file, cfgPath, self string, tokens map[string]string, stderr io.Writer) int {
	c, err := gitgroups.Load(file)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	for _, g := range c.Groups {
		if !gitgroups.Due(g, gitgroupsNow()) {
			continue
		}
		h := c.Host(g.HostID)
		if h == nil {
			continue
		}
		s := gitgroups.Sync{Git: gitexec.Git{Askpass: self, Kind: h.Kind, Token: tokens[h.ID], UseGitCredentials: h.AuthMode == "git"}, Group: g, Projects: projects.DefaultPath(cfgPath)}
		if err := s.Run(ctx, gitgroups.ActionFetch, func(gitgroups.Event) {}); err != nil {
			fmt.Fprintf(stderr, "nhóm %s: %v\n", g.Path, err)
		}
		at := gitgroupsNow().UTC().Format(time.RFC3339)
		err := gitgroups.Modify(file, func(c *gitgroups.Config) error {
			if cur := c.Group(g.ID); cur != nil {
				cur.LastAutoFetchAt = at
			}
			return nil
		})
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	return 0
}

// gitTokens đọc token app đưa qua biến môi trường rồi xoá biến khỏi tiến trình, để git và tiến trình con không thừa
// hưởng (git.go cũng lọc lần nữa).
func gitTokens() (map[string]string, error) {
	raw := os.Getenv(gitexec.TokensEnv)
	_ = os.Unsetenv(gitexec.TokensEnv)
	tokens := map[string]string{}
	if strings.TrimSpace(raw) == "" {
		return tokens, nil
	}
	if err := json.Unmarshal([]byte(raw), &tokens); err != nil {
		return nil, errors.New("biến HIVE_GIT_TOKENS không phải JSON {id: token}")
	}
	return tokens, nil
}
