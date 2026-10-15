package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

const mcpMaxMessage = 8 << 20

type mcpProxy struct {
	client              *http.Client
	hub, token, project string
	out                 io.Writer
	mu                  sync.Mutex
	session, protocol   string
}

func (a *app) mcp(args []string) int {
	fs := newFlagSet("mcp", io.Discard)
	hubFlag := fs.String("hub", "", "địa chỉ hub")
	project := fs.String("project", "", "dự án của workspace")
	pos, err := parseInterspersed(fs, args)
	if err != nil || len(pos) != 0 {
		return a.errorf(exitUsage, "Cách dùng: hive mcp [--hub URL] [--project DỰ_ÁN].")
	}
	hub := *hubFlag
	if hub == "" {
		hub = a.defaultHub()
	}
	hub, err = normalizeHub(hub)
	if err != nil {
		return a.errorf(exitUsage, "Chưa có địa chỉ hub hợp lệ. Chạy hive login --hub URL.")
	}
	token, _, tokenErr := a.readToken(hub)
	if *project == "" {
		*project = a.mcpProject(hub)
	}
	// SSE có thể chờ lâu hơn timeout của REST; stdin đóng sẽ huỷ mọi request.
	client := *a.httpClient()
	client.Timeout = 0
	// Không chuyển PAT sang URL chuyển hướng, kể cả URL cùng tên miền.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	p := &mcpProxy{client: &client, hub: hub, token: token, project: *project, out: a.stdout}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var pending sync.WaitGroup
	scanner := bufio.NewScanner(a.stdin)
	scanner.Buffer(make([]byte, 4096), mcpMaxMessage)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var message struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
			Params  struct {
				ProtocolVersion string `json:"protocolVersion"`
			} `json:"params"`
		}
		if !json.Valid(line) {
			p.rpcError(nil, -32700, "Không đọc được JSON MCP.")
			continue
		}
		if json.Unmarshal(line, &message) != nil || message.JSONRPC != "2.0" {
			p.rpcError(nil, -32600, "Yêu cầu JSON-RPC không hợp lệ.")
			continue
		}
		if tokenErr != nil || !validPAT(token) {
			if len(message.ID) != 0 {
				p.rpcError(message.ID, -32001, "Chưa đăng nhập hoặc token không còn hiệu lực. Chạy hive login.")
			}
			continue
		}
		if message.Method == "initialize" {
			p.mu.Lock()
			p.protocol = message.Params.ProtocolVersion
			p.mu.Unlock()
		}
		data := bytes.Clone(line)
		pending.Add(1)
		go func() {
			defer pending.Done()
			if err := p.post(ctx, data); err != nil && ctx.Err() == nil && len(message.ID) != 0 {
				if errors.Is(err, errUnauthorized) {
					p.rpcError(message.ID, -32001, "Token hết hạn hoặc đã bị thu hồi. Chạy hive login.")
				} else {
					p.rpcError(message.ID, -32603, "Không chuyển tiếp được phản hồi MCP từ hub.")
				}
			}
		}()
	}
	cancel()
	pending.Wait()
	if scanner.Err() != nil {
		return a.errorf(exitFailed, "Không đọc được dữ liệu MCP từ stdin hoặc thông điệp quá lớn.")
	}
	return exitOK
}

func (p *mcpProxy) write(data []byte) error {
	if !json.Valid(data) {
		return errors.New("phản hồi MCP không phải JSON")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var response struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
		} `json:"result"`
	}
	if json.Unmarshal(data, &response) == nil && response.Result.ProtocolVersion != "" {
		p.protocol = response.Result.ProtocolVersion
	}
	_, err := p.out.Write(append(compact.Bytes(), '\n'))
	return err
}

func (p *mcpProxy) rpcError(id json.RawMessage, code int, message string) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	data, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": code, "message": message},
	})
	_ = p.write(data)
}

func (p *mcpProxy) post(ctx context.Context, data []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.hub+"/mcp", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+p.token)
	if p.project != "" {
		req.Header.Set("X-Hive-Project", p.project)
	}
	p.mu.Lock()
	if p.session != "" {
		req.Header.Set("Mcp-Session-Id", p.session)
	}
	if p.protocol != "" {
		req.Header.Set("Mcp-Protocol-Version", p.protocol)
	}
	p.mu.Unlock()
	res, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return errUnauthorized
	}
	if res.StatusCode/100 != 2 {
		return errors.New("hub từ chối MCP")
	}
	if session := res.Header.Get("Mcp-Session-Id"); session != "" {
		p.mu.Lock()
		p.session = session
		p.mu.Unlock()
	}
	if res.StatusCode == http.StatusAccepted || res.StatusCode == http.StatusNoContent {
		return nil
	}
	kind, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	switch kind {
	case "application/json":
		body, err := io.ReadAll(io.LimitReader(res.Body, mcpMaxMessage+1))
		if err != nil {
			return err
		}
		if len(body) > mcpMaxMessage {
			return errors.New("phản hồi MCP quá lớn")
		}
		return p.write(body)
	case "text/event-stream":
		return p.sse(res.Body)
	default:
		return errors.New("kiểu phản hồi MCP không hỗ trợ")
	}
}

func (p *mcpProxy) sse(body io.Reader) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4096), mcpMaxMessage)
	var data []byte
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if len(data) > 0 {
				if err := p.write(bytes.TrimSuffix(data, []byte("\n"))); err != nil {
					return err
				}
				data = nil
			}
			continue
		}
		if value, ok := strings.CutPrefix(line, "data:"); ok {
			value = strings.TrimPrefix(value, " ")
			if len(data)+len(value)+1 > mcpMaxMessage {
				return errors.New("sự kiện MCP quá lớn")
			}
			data = append(data, value...)
			data = append(data, '\n')
		}
	}
	return scanner.Err()
}

func (a *app) mcpProject(hub string) string {
	cwd, err := a.getwd()
	if err != nil {
		return ""
	}
	// Chỉ đọc header dự án; URL và token trong workspace không được đổi nơi gửi PAT.
	for dir := cwd; ; dir = filepath.Dir(dir) {
		data, err := os.ReadFile(filepath.Join(dir, ".mcp.json"))
		if err == nil {
			var cfg struct {
				Servers map[string]struct {
					URL     string            `json:"url"`
					Headers map[string]string `json:"headers"`
				} `json:"mcpServers"`
			}
			if json.Unmarshal(data, &cfg) == nil {
				server := cfg.Servers["xdev-hive"]
				if strings.TrimRight(server.URL, "/") == hub+"/mcp" {
					for key, value := range server.Headers {
						if strings.EqualFold(key, "X-Hive-Project") {
							return value
						}
					}
				}
			}
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	path, err := config.DefaultPath()
	if err != nil {
		return ""
	}
	list, err := projects.Load(projects.DefaultPath(path))
	if err != nil {
		return ""
	}
	var id, longest string
	for _, project := range list {
		rel, err := filepath.Rel(project.Folder, cwd)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && len(project.Folder) > len(longest) {
			id, longest = project.ProjectID, project.Folder
		}
	}
	return id
}
