package runner

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
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
	if len(servers) == 0 && j.codegraph == "" {
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
	if j.codegraph != "" {
		command, args, env := codegraphServer(j)
		// alwaysLoad: không để tool tìm kiếm của Claude Code hoãn codegraph_explore, vì agent phải thấy nó ngay từ lượt
		// đầu mới bỏ được bước dò repo bằng grep (claude 2.1.296 nhận khoá này trong --mcp-config).
		out[codegraphServerName] = map[string]any{"type": "stdio", "command": command, "args": args, "env": env, "alwaysLoad": true}
	}
	return out
}

// codegraphServerName là tên server CodeGraph của run; ghi sau server ngoài nên server ngoài trùng tên không đè được
// bản worker đã kiểm. Tool của nó có tên mcp__codegraph__… trong Claude Code.
const codegraphServerName = "codegraph"

// tomlEnv ghi bảng env của Codex theo thứ tự khoá cố định.
func tomlEnv(env map[string]string) string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, tomlString(k)+"="+tomlString(env[k]))
	}
	return "{" + strings.Join(out, ",") + "}"
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
	if len(servers) == 0 && j.codegraph == "" {
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
	if j.codegraph != "" {
		command, args, env := codegraphServer(j)
		quoted := make([]string, 0, len(args))
		for _, a := range args {
			quoted = append(quoted, tomlString(a))
		}
		out = append(out, "-c", fmt.Sprintf("mcp_servers.%s={command=%s,args=[%s],env=%s}", codegraphServerName, tomlString(command), strings.Join(quoted, ","), tomlEnv(env)))
	}
	return out
}

// geminiMCPServers là mục mcpServers của Gemini CLI: cổng MCP của hub (Gemini chưa có cách nào khác nhận run token) và
// server ngoài được phép.
func geminiMCPServers(j Job) map[string]any {
	out := map[string]any{"xdev-hive": map[string]any{
		"httpUrl": mcpURL(j.Env),
		"headers": map[string]string{"Authorization": "Bearer " + j.Env["HIVE_RUN_TOKEN"]},
	}}
	blank := hubSecretEnv(j)
	for _, s := range externalMCPServers(j) {
		if s.Transport == "http" {
			out[s.Name] = map[string]any{"httpUrl": s.URL}
			continue
		}
		args := s.Args
		if args == nil {
			args = []string{}
		}
		out[s.Name] = map[string]any{"command": s.Command, "args": args, "env": blank}
	}
	if j.codegraph != "" {
		command, args, env := codegraphServer(j)
		out[codegraphServerName] = map[string]any{"command": command, "args": args, "env": env}
	}
	return out
}

// geminiMCPArgs là cờ --allowed-mcp-server-names: Gemini chỉ nạp server có tên ở đây, nên server khai trong ~/.gemini
// của máy mà hub không cho phép bị bỏ qua (đã thử `gemini mcp list` trên gemini-cli 0.63.0). Dạng `--cờ=giá-trị` vì cờ
// là mảng: viết tách thì yargs nuốt cả tham số đứng sau.
func geminiMCPArgs(j Job) []string {
	names := []string{"xdev-hive"}
	for _, s := range externalMCPServers(j) {
		names = append(names, s.Name)
	}
	if j.codegraph != "" {
		names = append(names, codegraphServerName)
	}
	args := make([]string, 0, len(names))
	for _, n := range names {
		args = append(args, "--allowed-mcp-server-names="+n)
	}
	return args
}

// writeGeminiSettings ghi .gemini/settings.json (cấu hình workspace của Gemini) vào worktree của run và loại khỏi git để
// agent không commit nó. Repo đã có file đó thì không ghi đè (sẽ thành thay đổi trong PR): run chỉ có server mà repo
// khai, vẫn bị giới hạn theo tên ở geminiMCPArgs. Trả về false khi không ghi.
func writeGeminiSettings(j Job) (bool, error) {
	if j.workspace == "" {
		return false, nil
	}
	path := filepath.Join(j.workspace, ".gemini", "settings.json")
	if _, err := os.Stat(path); err == nil {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, err
	}
	b, err := json.MarshalIndent(map[string]any{"mcpServers": geminiMCPServers(j)}, "", "  ")
	if err != nil {
		return false, err
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return false, err
	}
	return true, appendExclude(j.workspace, ".gemini/settings.json")
}

// antigravityPlugin là plugin worker ghi khi repo đã có .agents/mcp_config.json. agy đặt tên server của plugin là
// <plugin>_<server>, nên agent thấy cổng hub là xdev-hive_xdev-hive.
const antigravityPlugin = "xdev-hive"

// antigravityMCPServers là mục mcpServers của agy: cổng MCP của hub (agy gửi cả header, đã thử trên 1.3.3) và server ngoài
// được phép.
func antigravityMCPServers(j Job) map[string]any {
	out := map[string]any{"xdev-hive": map[string]any{
		"url":     mcpURL(j.Env),
		"headers": map[string]string{"Authorization": "Bearer " + j.Env["HIVE_RUN_TOKEN"]},
	}}
	blank := hubSecretEnv(j)
	for _, s := range externalMCPServers(j) {
		if s.Transport == "http" {
			out[s.Name] = map[string]any{"url": s.URL}
			continue
		}
		args := s.Args
		if args == nil {
			args = []string{}
		}
		out[s.Name] = map[string]any{"command": s.Command, "args": args, "env": blank}
	}
	if j.codegraph != "" {
		command, args, env := codegraphServer(j)
		out[codegraphServerName] = map[string]any{"command": command, "args": args, "env": env}
	}
	return out
}

// writeAntigravityMCPConfig ghi cấu hình MCP của run vào .agents/ của worktree (agy nạp cả .agents/mcp_config.json lẫn
// plugin trong .agents/plugins/) và loại khỏi git để agent không commit run token. Repo đã có .agents/mcp_config.json
// thì không ghi đè (sẽ thành thay đổi trong PR) mà ghi thành plugin riêng. Trả về đường dẫn tương đối của file đã ghi,
// rỗng khi không ghi.
func writeAntigravityMCPConfig(j Job) (string, error) {
	if j.workspace == "" {
		return "", nil
	}
	files := map[string]any{}
	config := filepath.Join(".agents", "mcp_config.json")
	if _, err := os.Stat(filepath.Join(j.workspace, config)); err == nil {
		plugin := filepath.Join(".agents", "plugins", antigravityPlugin)
		if _, err := os.Stat(filepath.Join(j.workspace, plugin)); err == nil {
			return "", nil
		}
		config = filepath.Join(plugin, "mcp_config.json")
		files[filepath.Join(plugin, "plugin.json")] = map[string]string{"name": antigravityPlugin}
	}
	files[config] = map[string]any{"mcpServers": antigravityMCPServers(j)}
	for rel, content := range files {
		path := filepath.Join(j.workspace, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return "", err
		}
		b, err := json.MarshalIndent(content, "", "  ")
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(path, b, 0o600); err != nil {
			return "", err
		}
		if err := appendExclude(j.workspace, filepath.ToSlash(rel)); err != nil {
			return "", err
		}
	}
	return config, nil
}
