package runner

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

// RepoReport đi vào report.repo của run_result (ADR 0022): hub dùng nó để biết brief của dự án đã cũ so với nhánh chính
// bao nhiêu commit, mà không cần webhook (dự án gắn thư mục máy không có webhook). Trường nào không xác định thì null.
type RepoReport struct {
	BaseSHA     *string `json:"baseSha"`
	BriefBehind *int    `json:"briefBehind"`
}

var (
	baseSHAPattern  = regexp.MustCompile(`^[0-9a-f]{40,64}$`)
	briefSHAPattern = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
)

// repoReport đo ngay sau khi tạo worktree, khi origin/<nhánh chính> vừa fetch xong. Lỗi git chỉ làm trường tương ứng
// thành null: báo drift là phụ, không được làm hỏng run.
func repoReport(ctx context.Context, work string, job Job) *RepoReport {
	rep := &RepoReport{}
	out, err := gitOutput(ctx, work, "rev-parse", "--verify", "--quiet", "origin/"+job.BaseBranch+"^{commit}")
	base := strings.TrimSpace(out)
	if err != nil || !baseSHAPattern.MatchString(base) {
		return rep
	}
	rep.BaseSHA = &base
	// SHA của brief do hub gửi; chỉ nhận hex để không thể thành tuỳ chọn của git. Commit không có trong repo (đã bị
	// force-push mất) làm rev-list lỗi, và đó là null chứ không phải 0.
	sha := strings.ToLower(job.BriefSHA)
	if !briefSHAPattern.MatchString(sha) {
		return rep
	}
	count, err := gitOutput(ctx, work, "rev-list", "--count", sha+".."+base)
	if err != nil {
		return rep
	}
	if n, err := strconv.Atoi(strings.TrimSpace(count)); err == nil && n >= 0 {
		rep.BriefBehind = &n
	}
	return rep
}
