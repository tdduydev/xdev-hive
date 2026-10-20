package repolock

import (
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Worktree là một mục của `git worktree list --porcelain`.
type Worktree struct {
	Path string
	HEAD string
	// Branch là tên ref đầy đủ (refs/heads/…); rỗng khi worktree detached hay bare.
	Branch   string
	Bare     bool
	Detached bool
	Locked   bool
	// LockedReason và PrunableReason là lý do git ghi sau từ khoá; rỗng khi không có lý do.
	LockedReason   string
	Prunable       bool
	PrunableReason string
}

func ParseWorktrees(porcelain string) []Worktree {
	var out []Worktree
	for _, block := range strings.Split(strings.ReplaceAll(porcelain, "\r\n", "\n"), "\n\n") {
		var e Worktree
		for _, line := range strings.Split(block, "\n") {
			key, value, _ := strings.Cut(line, " ")
			switch key {
			case "worktree":
				e.Path = filepath.FromSlash(value)
			case "HEAD":
				e.HEAD = value
			case "branch":
				e.Branch = value
			case "bare":
				e.Bare = true
			case "detached":
				e.Detached = true
			case "locked":
				e.Locked, e.LockedReason = true, unquoteReason(value)
			case "prunable":
				e.Prunable, e.PrunableReason = true, unquoteReason(value)
			}
		}
		if e.Path != "" {
			out = append(out, e)
		}
	}
	return out
}

// unquoteReason bỏ trích dẫn kiểu C mà git đặt quanh lý do có ký tự ngoài ASCII hay xuống dòng (core.quotePath).
func unquoteReason(s string) string {
	if strings.HasPrefix(s, `"`) {
		if u, err := strconv.Unquote(s); err == nil {
			return u
		}
	}
	return s
}

func InsideDir(root, p string) bool {
	rel, err := filepath.Rel(CleanAbs(root), CleanAbs(p))
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func SamePath(a, b string) bool { return CleanAbs(a) == CleanAbs(b) }

// CleanAbs đi qua symlink (thư mục tạm của macOS là /private/var qua /var) để so được đường dẫn git trả về với
// đường dẫn worker tự dựng; Windows không phân biệt hoa thường.
func CleanAbs(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	// Worktree đã dời đi thì không còn để đi qua symlink: đi qua thư mục cha rồi ghép tên.
	if real, err := filepath.EvalSymlinks(p); err == nil {
		p = real
	} else if dir, err := filepath.EvalSymlinks(filepath.Dir(p)); err == nil {
		p = filepath.Join(dir, filepath.Base(p))
	}
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}
