package runner

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
)

// MCPServer là MCP server ngoài hub cho phép run dùng (MCP-06), khớp jobMcpServer trong
// packages/contracts/src/mcp-admin.ts. Worker chỉ nạp những server này cùng cổng MCP của hub: Claude chạy với
// --strict-mcp-config, Codex xoá bảng mcp_servers trước, nên server người dùng tự khai trên máy bị bỏ qua.
type MCPServer struct {
	Name      string   `json:"name"`
	Transport string   `json:"transport"`
	Command   string   `json:"command,omitempty"`
	Args      []string `json:"args,omitempty"`
	URL       string   `json:"url,omitempty"`
}

var mcpServerName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// hubMCPNames là tên worker đặt cho cổng MCP của hub; server ngoài trùng tên sẽ thay mất cổng đó.
var hubMCPNames = map[string]bool{"xdev-hive": true, "xdev-hive-run": true}

// cliCredentialEnv là biến khoá API mà runner host đưa vào container cho chính CLI (sandboxCLIEnv).
var cliCredentialEnv = []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"}

func (s MCPServer) valid() bool {
	if !mcpServerName.MatchString(s.Name) || hubMCPNames[s.Name] {
		return false
	}
	// Claude Code thay ${BIẾN} trong cấu hình MCP bằng biến môi trường của nó, gồm run token; hub đã chặn, kiểm lại ở đây.
	for _, v := range append([]string{s.Command, s.URL}, s.Args...) {
		if strings.Contains(v, "${") {
			return false
		}
	}
	switch s.Transport {
	case "stdio":
		return strings.TrimSpace(s.Command) != "" && s.URL == ""
	case "http":
		u, err := url.Parse(s.URL)
		return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && s.Command == "" && len(s.Args) == 0
	}
	return false
}

// externalMCPServers là server ngoài worker sẽ nạp cho job. Run chỉ đọc (review, plan, leader) không nhận server nào:
// tool của server ngoài (vd. tạo issue trên GitHub) có thể ghi mà chế độ chỉ đọc của CLI không chặn hết.
func externalMCPServers(j Job) []MCPServer {
	if readOnlyKind(j.Kind) {
		return nil
	}
	seen := map[string]bool{}
	out := make([]MCPServer, 0, len(j.MCPServers))
	for _, s := range j.MCPServers {
		if !s.valid() || seen[s.Name] {
			continue
		}
		seen[s.Name] = true
		out = append(out, s)
	}
	return out
}

// hubSecretEnv là các biến chứa bí mật của hub hoặc của CLI trong môi trường run. Server stdio ngoài nhận chúng với giá
// trị rỗng: Claude Code chạy server với môi trường của chính nó cộng "env" của cấu hình, không bỏ được biến, chỉ đè được.
func hubSecretEnv(j Job) map[string]string {
	keys := map[string]bool{}
	for k := range j.Env {
		keys[k] = true
	}
	for _, kv := range os.Environ() {
		if k, _, ok := strings.Cut(kv, "="); ok && strings.HasPrefix(k, "HIVE_") {
			keys[k] = true
		}
	}
	for _, k := range cliCredentialEnv {
		keys[k] = true
	}
	out := make(map[string]string, len(keys))
	for k := range keys {
		out[k] = ""
	}
	return out
}

// claudeMCPEntries là mục mcpServers của Claude Code cho server ngoài, ghi chung file --mcp-config với cổng của hub.
func claudeMCPEntries(j Job) map[string]any {
	servers := externalMCPServers(j)
	if len(servers) == 0 {
		return nil
	}
	blank := hubSecretEnv(j)
	out := make(map[string]any, len(servers))
	for _, s := range servers {
		if s.Transport == "http" {
			out[s.Name] = map[string]any{"type": "http", "url": s.URL}
			continue
		}
		args := s.Args
		if args == nil {
			args = []string{}
		}
		out[s.Name] = map[string]any{"type": "stdio", "command": s.Command, "args": args, "env": blank}
	}
	return out
}

// tomlString ghi chuỗi cơ bản của TOML. Chuỗi JSON là chuỗi TOML hợp lệ (cùng cách thoát \", \\, \n, \uXXXX), còn %q
// của Go có thể sinh \x.. mà TOML không nhận.
func tomlString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// codexMCPArgs là các cờ -c thêm server ngoài vào bảng mcp_servers của Codex, sau cờ xoá bảng và cổng của hub.
func codexMCPArgs(j Job) []string {
	servers := externalMCPServers(j)
	if len(servers) == 0 {
		return nil
	}
	blank := hubSecretEnv(j)
	keys := make([]string, 0, len(blank))
	for k := range blank {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	env := make([]string, 0, len(keys))
	for _, k := range keys {
		env = append(env, tomlString(k)+`=""`)
	}
	out := make([]string, 0, 2*len(servers))
	for _, s := range servers {
		var value string
		if s.Transport == "http" {
			value = fmt.Sprintf("{url=%s}", tomlString(s.URL))
		} else {
			args := make([]string, 0, len(s.Args))
			for _, a := range s.Args {
				args = append(args, tomlString(a))
			}
			// Codex chỉ chuyển một danh sách biến cố định cho server stdio; đè rỗng thêm cho chắc khi bản sau đổi ý.
			value = fmt.Sprintf("{command=%s,args=[%s],env={%s}}", tomlString(s.Command), strings.Join(args, ","), strings.Join(env, ","))
		}
		out = append(out, "-c", "mcp_servers."+s.Name+"="+value)
	}
	return out
}
