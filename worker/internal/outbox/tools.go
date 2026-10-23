package outbox

const (
	GroupProgress  = "progress"
	GroupProposal  = "proposal"
	GroupImmediate = "immediate"
)

// Ba bảng dưới là bản Go của CLIENT_WRITE_TOOLS, CLIENT_WRITE_PROCEDURES và MACHINE_EVENT_KINDS trong contracts;
// tools_test.go so với fixture `client-write-tools.json` nên thêm tool ở hub mà quên ở đây thì CI đỏ. Kind lạ bị chặn
// ngay khi nộp, vì hub không biết xếp nó vào đâu và giữ lại chỉ làm đầy hộp thư.
var toolGroups = map[string]string{
	"task_update":           GroupProgress,
	"sdlc_report":           GroupProgress,
	"sdlc_ask":              GroupProgress,
	"doc_propose":           GroupProposal,
	"doc_suggest":           GroupProposal,
	"doc_comment":           GroupProposal,
	"skill_propose":         GroupProposal,
	"memory_write":          GroupProposal,
	"plan_submit":           GroupProposal,
	"review_submit":         GroupProposal,
	"skill_proposal_submit": GroupProposal,
	"brief_submit":          GroupProposal,
	"doc_check_submit":      GroupProposal,
	"doc_assist_submit":     GroupProposal,
	"leader_reply":          GroupImmediate,
	"leader_propose":        GroupImmediate,
	"leader_action":         GroupImmediate,
	"artifact_create":       GroupImmediate,
	"artifact_update":       GroupImmediate,
}

var procedureGroups = map[string]string{
	"memory.write": GroupProposal,
}

var machineEventGroups = map[string]string{
	KindTokenScore:        GroupProgress,
	KindProjectTokenUsage: GroupProgress,
	KindMemoryPropose:     GroupProposal,
}

// GroupOf trả nhóm của kind theo kênh: tên tool cho `mcp`, đường dẫn procedure cho `rpc`, kind sự kiện máy cho `worker`.
func GroupOf(transport, kind string) (string, bool) {
	var table map[string]string
	switch transport {
	case TransportMCP:
		table = toolGroups
	case TransportRPC:
		table = procedureGroups
	case TransportWorker:
		table = machineEventGroups
	default:
		return "", false
	}
	g, ok := table[kind]
	return g, ok
}

// Queueable là nhóm được giữ khi hub vắng; `immediate` cần hub trả lời ngay nên gửi thẳng, không vào hộp thư.
func Queueable(group string) bool { return group == GroupProgress || group == GroupProposal }
