package channel

type Hello struct {
	Type       string   `json:"type"`
	V          int      `json:"v"`
	ID         string   `json:"id"`
	MachineID  string   `json:"machineId"`
	Version    string   `json:"version"`
	ProtoRange [2]int   `json:"protoRange"`
	OS         string   `json:"os"`
	CLIs       []string `json:"clis"`
	Capacity   int      `json:"capacity"`
	ResumeRuns []string `json:"resumeRuns"`
}

type Welcome struct {
	Type           string `json:"type"`
	V              int    `json:"v"`
	ID             string `json:"id"`
	SessionID      string `json:"sessionId"`
	HeartbeatSec   int    `json:"heartbeatSec"`
	AccessTokenExp string `json:"accessTokenExp"`
}

type UpgradeRequired struct {
	Type   string `json:"type"`
	V      int    `json:"v"`
	ID     string `json:"id"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Sig    string `json:"sig"`
}
