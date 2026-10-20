package branches

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Loại thao tác dở (OperationKind).
const (
	OpMerge      = "merge"
	OpRebase     = "rebase"
	OpCherryPick = "cherryPick"
	OpRevert     = "revert"
	OpBisect     = "bisect"
)

// Trạng thái worktree (WorktreeState).
const (
	StatePending     = "pending"
	StateSkipped     = "skipped"
	StateClean       = "clean"
	StateDirty       = "dirty"
	StateUntracked   = "untracked"
	StateMissing     = "missing"
	StateUnreachable = "unreachable"
	StateError       = "error"
)

// Số file tối đa trong files, ignoredBlocking (hợp đồng mục 2.2).
const maxFiles = 20

// OperationIn đọc thao tác dở trong thư mục git của một worktree (`git rev-parse --absolute-git-dir`). Rebase xét trước
// merge: rebase dừng vì xung đột ở commit merge cũng có MERGE_HEAD, mà phải tiếp tục bằng rebase --continue.
// rebase-apply còn là của `git am`; hợp đồng không có loại am, báo rebase để vẫn chặn đổi nhánh (FR-012).
func OperationIn(gitDir string) string {
	exists := func(name string) bool {
		_, err := os.Stat(filepath.Join(gitDir, name))
		return err == nil
	}
	switch {
	case exists("rebase-merge"), exists("rebase-apply"):
		return OpRebase
	case exists("MERGE_HEAD"):
		return OpMerge
	case exists("CHERRY_PICK_HEAD"):
		return OpCherryPick
	case exists("REVERT_HEAD"):
		return OpRevert
	case exists("BISECT_LOG"):
		return OpBisect
	}
	return ""
}

// gitDirOf trả thư mục git riêng của worktree (với worktree liên kết là <chung>/worktrees/<tên>), nơi git ghi
// MERGE_HEAD, rebase-merge/… của chính worktree đó.
func (e Env) gitDirOf(ctx context.Context, dir string) (string, error) {
	out, err := e.read(ctx, dir, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return "", err
	}
	return filepath.Clean(strings.TrimSpace(out)), nil
}

// tree là kết quả `git status --porcelain=v2 -z` của một thư mục làm việc.
type tree struct {
	head     string // tên nhánh ngắn; rỗng khi detached
	detached bool
	oid      string // rỗng khi chưa có commit
	upstream string
	// hasAB: git chỉ in branch.ab khi upstream còn ref trên máy; có upstream mà không có dòng này là upstream đã xoá.
	hasAB         bool
	ahead, behind int
	tracked       []string
	untracked     []string
	ignored       []string
	submodule     bool
}

// statusArgs là lệnh status chung. -z để tên file có dấu cách, ký tự ngoài ASCII không bị git đặt trong ngoặc kép.
func statusArgs(ignored bool) []string {
	args := []string{"status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal"}
	if ignored {
		args = append(args, "--ignored=matching")
	}
	return args
}

func parseStatus(out string) tree {
	var t tree
	entries := strings.Split(out, "\x00")
	for i := 0; i < len(entries); i++ {
		e := entries[i]
		switch {
		case strings.HasPrefix(e, "# branch.oid "):
			if v := strings.TrimPrefix(e, "# branch.oid "); v != "(initial)" {
				t.oid = v
			}
		case strings.HasPrefix(e, "# branch.head "):
			if v := strings.TrimPrefix(e, "# branch.head "); v == "(detached)" {
				t.detached = true
			} else {
				t.head = v
			}
		case strings.HasPrefix(e, "# branch.upstream "):
			t.upstream = strings.TrimPrefix(e, "# branch.upstream ")
		case strings.HasPrefix(e, "# branch.ab "):
			f := strings.Fields(strings.TrimPrefix(e, "# branch.ab "))
			if len(f) == 2 {
				t.hasAB = true
				t.ahead, _ = strconv.Atoi(strings.TrimPrefix(f[0], "+"))
				t.behind, _ = strconv.Atoi(strings.TrimPrefix(f[1], "-"))
			}
		case strings.HasPrefix(e, "1 "):
			t.addTracked(e, 9)
		case strings.HasPrefix(e, "2 "):
			t.addTracked(e, 10)
			// Đổi tên: đường dẫn cũ là mục kế tiếp, không phải một mục riêng.
			i++
		case strings.HasPrefix(e, "u "):
			t.addTracked(e, 11)
		case strings.HasPrefix(e, "? "):
			t.untracked = append(t.untracked, e[2:])
		case strings.HasPrefix(e, "! "):
			t.ignored = append(t.ignored, e[2:])
		}
	}
	return t
}

// addTracked lấy đường dẫn ở trường thứ n của một dòng thay đổi; trường thứ ba bắt đầu bằng S khi là submodule.
func (t *tree) addTracked(e string, n int) {
	f := strings.SplitN(e, " ", n)
	if len(f) < n {
		return
	}
	if strings.HasPrefix(f[2], "S") {
		t.submodule = true
	}
	t.tracked = append(t.tracked, f[n-1])
}

// state xếp trạng thái worktree: file bị bỏ qua không đổi trạng thái (hợp đồng mục 2.2).
func (t tree) state() string {
	switch {
	case len(t.tracked) > 0:
		return StateDirty
	case len(t.untracked) > 0:
		return StateUntracked
	}
	return StateClean
}

// files là danh sách file hiện cho người dùng: file đã theo dõi trước, cắt ở maxFiles.
func (t tree) files() ([]string, int) {
	all := append(append([]string{}, t.tracked...), t.untracked...)
	return capList(all, maxFiles)
}

func capList(all []string, n int) ([]string, int) {
	if len(all) == 0 {
		return nil, 0
	}
	if len(all) > n {
		return all[:n], len(all)
	}
	return all, len(all)
}

// IgnoredBlocking là các file bị bỏ qua không dựng lại được: không đoạn nào của đường dẫn trùng tên trong rebuildable
// (Q15), để apps/web/node_modules/ cũng khớp node_modules. Git dùng "/" trong đường dẫn kể cả trên Windows.
func IgnoredBlocking(ignored, rebuildable []string) []string {
	ok := map[string]bool{}
	for _, r := range rebuildable {
		ok[r] = true
	}
	var out []string
	for _, p := range ignored {
		accepted := false
		for seg := range strings.SplitSeq(strings.TrimSuffix(p, "/"), "/") {
			if ok[seg] {
				accepted = true
				break
			}
		}
		if !accepted {
			out = append(out, p)
		}
	}
	return out
}

// readTree đọc status và thao tác dở của một thư mục làm việc.
func (e Env) readTree(ctx context.Context, dir string, ignored bool) (tree, string, error) {
	gitDir, err := e.gitDirOf(ctx, dir)
	if err != nil {
		return tree{}, "", err
	}
	out, err := e.read(ctx, dir, statusArgs(ignored)...)
	if err != nil {
		return tree{}, "", err
	}
	return parseStatus(out), OperationIn(gitDir), nil
}

// pathState phân biệt worktree mất thư mục (cha còn, git worktree prune gỡ được) với worktree trên ổ chưa gắn hay thư
// mục cha không đọc được (spec "Edge Cases"); rỗng khi thư mục còn.
func pathState(path string) string {
	if _, err := os.Stat(path); err == nil {
		return ""
	} else if !errors.Is(err, os.ErrNotExist) {
		return StateUnreachable
	}
	parent := filepath.Dir(path)
	if parent == path {
		return StateUnreachable
	}
	if info, err := os.Stat(parent); err != nil || !info.IsDir() {
		return StateUnreachable
	}
	return StateMissing
}

// hasSubmodule: git worktree remove từ chối worktree có submodule, nên dọn phải biết trước. .gitmodules có là coi như có submodule, kể cả khi chưa init: chặn thừa an toàn hơn sót.
func hasSubmodule(path string) bool {
	_, err := os.Stat(filepath.Join(path, ".gitmodules"))
	return err == nil
}
