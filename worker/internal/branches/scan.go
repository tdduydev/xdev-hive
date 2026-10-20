package branches

import "context"

// Lý do chặn (BlockCode), theo thứ tự xét của plan.md mục 5 bước 5.
const (
	BlockHiveWorker     = "hiveWorker"
	BlockBusy           = "busy"
	BlockUnreachable    = "unreachable"
	BlockLocked         = "locked"
	BlockSubmodule      = "submodule"
	BlockDirty          = "dirty"
	BlockUntracked      = "untracked"
	BlockIgnored        = "ignored"
	BlockUnpushed       = "unpushed"
	BlockPROpen         = "prOpen"
	BlockCurrent        = "current"
	BlockCheckedOutMain = "checkedOutMain"
	BlockNoEvidence     = "noEvidence"
	BlockNeedsFetch     = "needsFetch"
)

type ScanOptions struct {
	Folders []string
	NoFetch bool
}

type ScanRepo struct {
	Folder         string          `json:"folder"`
	DefaultBranch  string          `json:"defaultBranch,omitempty"`
	Current        string          `json:"current,omitempty"`
	Fetched        []string        `json:"fetched"`
	FetchFailed    []FetchFailure  `json:"fetchFailed"`
	APIError       string          `json:"apiError,omitempty"`
	Candidates     []Candidate     `json:"candidates"`
	Blocked        []Candidate     `json:"blocked"`
	SuggestDefault *SuggestDefault `json:"suggestDefault,omitempty"`
	Error          *Error          `json:"error,omitempty"`
}

type SuggestDefault struct {
	Branch string `json:"branch"`
	Clean  bool   `json:"clean"`
}

type Candidate struct {
	Folder      string             `json:"folder"`
	Branch      string             `json:"branch"`
	Tip         string             `json:"tip"`
	CommittedAt int64              `json:"committedAt"`
	Subject     string             `json:"subject,omitempty"`
	Worktree    *CandidateWorktree `json:"worktree,omitempty"`
	Evidence    Evidence           `json:"evidence"`
	Selected    bool               `json:"selected"`
	Blocked     *BlockReason       `json:"blocked,omitempty"`
}

type CandidateWorktree struct {
	Path          string   `json:"path"`
	Prunable      bool     `json:"prunable"`
	AgentWorktree bool     `json:"agentWorktree"`
	Ignored       []string `json:"ignored,omitempty"`
}

type BlockReason struct {
	Code       string    `json:"code"`
	Message    string    `json:"message"`
	Files      []string  `json:"files,omitempty"`
	FilesTotal int       `json:"filesTotal,omitempty"`
	Count      int       `json:"count,omitempty"`
	Busy       []BusyDir `json:"busy,omitempty"`
}

// Scan là job `scan` (US4). Khung của T004; T009 làm.
func Scan(ctx context.Context, env Env, o ScanOptions, emit Emit) {
	emit(Event{Type: EventDone, Error: notImplemented()})
}
