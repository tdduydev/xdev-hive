package branches

import "context"

// SwitchOptions là cờ của `switch`: đúng một trong Branch (nhánh local) và Track (<remote>/<tên>).
type SwitchOptions struct {
	Folder      string
	Branch      string
	Track       string
	Carry       bool
	ConfirmBusy bool
}

type SwitchResult struct {
	Folder     string `json:"folder"`
	Branch     string `json:"branch"`
	HeadBefore string `json:"headBefore,omitempty"`
	Head       string `json:"head"`
	Carried    bool   `json:"carried"`
}

// Switch là lệnh `switch` (US2). Khung của T004; T007 làm.
func Switch(ctx context.Context, env Env, o SwitchOptions) (*SwitchResult, *Error) {
	return nil, notImplemented()
}

// CreateOptions là cờ của `create`; Base là tên ref đầy đủ.
type CreateOptions struct {
	Folder      string
	Name        string
	Base        string
	Switch      bool
	Fetch       bool
	Carry       bool
	ConfirmBusy bool
	DryRun      bool
}

type CreateResult struct {
	Folder   string `json:"folder"`
	Name     string `json:"name"`
	Base     string `json:"base"`
	Tip      string `json:"tip"`
	Switched bool   `json:"switched"`
	Fetched  bool   `json:"fetched"`
	DryRun   bool   `json:"dryRun"`
}

// Create là lệnh `create` (US3). Khung của T004; T007 làm.
func Create(ctx context.Context, env Env, o CreateOptions) (*CreateResult, *Error) {
	return nil, notImplemented()
}
