package branches

import "context"

type PullOptions struct {
	Folder      string
	ConfirmBusy bool
}

// PullResult là trường pull của sự kiện done: State là "done" (đã tiến nhanh) hay "unchanged".
type PullResult struct {
	State      string `json:"state"`
	HeadBefore string `json:"headBefore,omitempty"`
	Head       string `json:"head,omitempty"`
	Behind     int    `json:"behind,omitempty"`
}

// Pull là job `pull` (US5). Khung của T004; T012 làm.
func Pull(ctx context.Context, env Env, o PullOptions, emit Emit) {
	emit(Event{Type: EventDone, Folder: o.Folder, Error: notImplemented()})
}
