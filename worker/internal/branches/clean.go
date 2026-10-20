package branches

import "context"

// CleanItem là một mục người dùng chọn dọn, lấy từ Candidate.
type CleanItem struct {
	Folder   string   `json:"folder"`
	Branch   string   `json:"branch"`
	Tip      string   `json:"tip"`
	Worktree string   `json:"worktree,omitempty"`
	Prunable bool     `json:"prunable,omitempty"`
	Evidence Evidence `json:"evidence"`
}

// CleanResult là kết quả dọn một mục (sự kiện item).
type CleanResult struct {
	Folder          string `json:"folder"`
	Branch          string `json:"branch"`
	Tip             string `json:"tip"`
	Worktree        string `json:"worktree,omitempty"`
	Result          string `json:"result"`
	Code            string `json:"code,omitempty"`
	Reason          string `json:"reason,omitempty"`
	WorktreeRemoved bool   `json:"worktreeRemoved"`
	BranchDeleted   bool   `json:"branchDeleted"`
	Left            string `json:"left,omitempty"`
}

// Clean là job `clean` (US4). fetched là remote fetch được lúc quét của từng thư mục chính. Khung của T004; T010 làm.
func Clean(ctx context.Context, env Env, items []CleanItem, fetched map[string][]string, emit Emit) {
	emit(Event{Type: EventDone, Error: notImplemented()})
}
