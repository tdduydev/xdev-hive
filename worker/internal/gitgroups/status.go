package gitgroups

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

// Trạng thái của repo trên máy (spec US3).
const (
	StateMissing  = "missing"
	StateClean    = "clean"
	StateDirty    = "dirty"
	StateAhead    = "ahead"
	StateBehind   = "behind"
	StateDiverged = "diverged"
	StateError    = "error"
)

// RepoStatus là trạng thái một repo của nhóm, đọc không cần mạng.
type RepoStatus struct {
	Path   string `json:"path"`
	Dir    string `json:"dir,omitempty"`
	State  string `json:"state"`
	Branch string `json:"branch,omitempty"`
	Ahead  int    `json:"ahead,omitempty"`
	Behind int    `json:"behind,omitempty"`
	// Reason giải thích trạng thái lệch hay lỗi bằng câu cho người dùng.
	Reason string `json:"reason,omitempty"`
}

// porcelain là phần cần dùng của `git status --porcelain=v2 --branch`.
type porcelain struct {
	head     string
	initial  bool
	upstream bool
	ahead    int
	behind   int
	changed  bool
}

func parsePorcelain(out string) porcelain {
	var p porcelain
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n") {
		switch {
		case strings.HasPrefix(line, "# branch.oid "):
			p.initial = strings.TrimPrefix(line, "# branch.oid ") == "(initial)"
		case strings.HasPrefix(line, "# branch.head "):
			p.head = strings.TrimPrefix(line, "# branch.head ")
		case strings.HasPrefix(line, "# branch.upstream "):
			p.upstream = true
		case strings.HasPrefix(line, "# branch.ab "):
			f := strings.Fields(strings.TrimPrefix(line, "# branch.ab "))
			if len(f) == 2 {
				p.ahead, _ = strconv.Atoi(strings.TrimPrefix(f[0], "+"))
				p.behind, _ = strconv.Atoi(strings.TrimPrefix(f[1], "-"))
			}
		// 1, 2: file đã theo dõi bị đổi hay đổi tên; u: xung đột. "?" (chưa theo dõi) và "!" (bỏ qua) không tính:
		// merge --ff-only tự dừng an toàn nếu sẽ ghi đè file chưa theo dõi.
		case strings.HasPrefix(line, "1 "), strings.HasPrefix(line, "2 "), strings.HasPrefix(line, "u "):
			p.changed = true
		}
	}
	return p
}

// classify xếp trạng thái từ kết quả status; defaultBranch rỗng thì không kiểm nhánh.
func classify(p porcelain, defaultBranch string) (state, reason string) {
	switch {
	case p.changed:
		return StateDirty, "có thay đổi chưa commit"
	case p.head == "(detached)":
		return StateDiverged, "HEAD đang rời nhánh"
	case defaultBranch != "" && p.head != defaultBranch:
		return StateDiverged, fmt.Sprintf("đang ở nhánh %s, không phải %s", p.head, defaultBranch)
	case p.initial:
		return StateClean, "repo chưa có commit"
	case !p.upstream:
		return StateDiverged, fmt.Sprintf("nhánh %s không theo dõi nhánh nào của remote", p.head)
	case p.ahead > 0 && p.behind > 0:
		return StateDiverged, fmt.Sprintf("vừa có %d commit chưa đẩy vừa thiếu %d commit của remote", p.ahead, p.behind)
	case p.ahead > 0:
		return StateAhead, ""
	case p.behind > 0:
		return StateBehind, ""
	}
	return StateClean, ""
}

// Inspect đọc trạng thái một repo của nhóm. Không gọi mạng: ahead/behind so với lần fetch gần nhất.
func Inspect(ctx context.Context, git Git, g Group, r Repo) RepoStatus {
	s := RepoStatus{Path: r.Path}
	dir, err := RepoDir(g.Root, r.Path)
	if err != nil {
		s.State, s.Reason = StateError, err.Error()
		return s
	}
	s.Dir = dir
	info, err := os.Stat(dir)
	switch {
	case errors.Is(err, os.ErrNotExist):
		s.State = StateMissing
		return s
	case err != nil:
		s.State, s.Reason = StateError, err.Error()
		return s
	case !info.IsDir():
		s.State, s.Reason = StateError, "đường dẫn đã có một file, không phải thư mục"
		return s
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		s.State, s.Reason = StateError, "thư mục đã có mà không phải repo git"
		return s
	}
	origin, _ := git.run(ctx, dir, "", "config", "--get", "remote.origin.url")
	origin = strings.TrimSpace(origin)
	if !projects.SameRepo(origin, r.HTTPURL) && !projects.SameRepo(origin, r.SSHURL) {
		s.State, s.Reason = StateError, fmt.Sprintf("remote origin (%s) là repo khác", projects.Redact(origin))
		if origin == "" {
			s.Reason = "repo không có remote origin"
		}
		return s
	}
	out, err := git.run(ctx, dir, "", "status", "--porcelain=v2", "--branch")
	if err != nil {
		s.State, s.Reason = StateError, err.Error()
		return s
	}
	p := parsePorcelain(out)
	s.Branch, s.Ahead, s.Behind = p.head, p.ahead, p.behind
	s.State, s.Reason = classify(p, r.DefaultBranch)
	return s
}
