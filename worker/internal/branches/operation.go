package branches

import "context"

// Trạng thái của GitOperation.
const (
	OperationDone       = "done"
	OperationConflict   = "conflict"
	OperationInProgress = "inProgress"
	OperationAborted    = "aborted"
	OperationError      = "error"
)

// GitOperation là merge, rebase do app chạy hay thao tác dở list đọc được (US8).
type GitOperation struct {
	Kind           string   `json:"kind"`
	State          string   `json:"state"`
	Branch         string   `json:"branch,omitempty"`
	Onto           *OntoRef `json:"onto,omitempty"`
	HeadBefore     string   `json:"headBefore,omitempty"`
	Head           string   `json:"head,omitempty"`
	Conflicts      []string `json:"conflicts"`
	ConflictsTotal int      `json:"conflictsTotal"`
	Step           int      `json:"step,omitempty"`
	Total          int      `json:"total,omitempty"`
	Error          *Error   `json:"error,omitempty"`
}

type OntoRef struct {
	Name string `json:"name"`
	Tip  string `json:"tip"`
}

// MergeOptions là cờ của `merge`; Onto là mã commit đầy đủ, OntoName chỉ để hiện và ghi nhật ký.
type MergeOptions struct {
	Folder      string
	Onto        string
	OntoName    string
	FF          bool
	ConfirmBusy bool
}

type RebaseOptions struct {
	Folder         string
	Onto           string
	OntoName       string
	ConfirmRewrite bool
	ConfirmBusy    bool
}

// Merge, Rebase, Continue, Abort là lệnh của US8. Khung của T004; T015 làm.
func Merge(ctx context.Context, env Env, o MergeOptions) (*GitOperation, *Error) {
	return nil, notImplemented()
}

func Rebase(ctx context.Context, env Env, o RebaseOptions) (*GitOperation, *Error) {
	return nil, notImplemented()
}

func Continue(ctx context.Context, env Env, folder string) (*GitOperation, *Error) {
	return nil, notImplemented()
}

func Abort(ctx context.Context, env Env, folder string) (*GitOperation, *Error) {
	return nil, notImplemented()
}
