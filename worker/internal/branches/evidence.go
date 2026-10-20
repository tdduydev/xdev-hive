package branches

import "context"

// Loại bằng chứng (Evidence.kind).
const (
	EvidenceMergedGit = "mergedGit"
	EvidenceMergedAPI = "mergedApi"
	EvidenceClosedAPI = "closedApi"
	EvidenceNone      = "none"
)

// Evidence là bằng chứng nhánh đã vào nhánh mặc định (plan.md mục 5 bước 4, mục 7).
type Evidence struct {
	Kind     string `json:"kind"`
	Onto     string `json:"onto,omitempty"`
	Provider string `json:"provider,omitempty"`
	Number   int    `json:"number,omitempty"`
	URL      string `json:"url,omitempty"`
	Note     string `json:"note,omitempty"`
}

// GitEvidence đọc bằng chứng git cho các đỉnh nhánh so với defaultRef. Khung của T004; T009 làm.
func GitEvidence(ctx context.Context, env Env, folder, defaultRef string, tips []string) (map[string]Evidence, *Error) {
	return nil, notImplemented()
}
