package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

const (
	msgSidecarMissing = "Sidecar hive-worker không chạy; mở app xDev Hive hoặc chạy hive-worker run."
	// Agent đang chờ tool trả lời: chờ hub một lúc rồi báo đã xếp hàng, không giữ agent tới khi hub về.
	mcpSubmitWaitMs = 10000
)

// errHubDown là lỗi mạng khi gọi thẳng hub, để báo "hub đang vắng" thay vì lỗi chuyển tiếp chung chung.
type errHubDown struct{ err error }

func (e *errHubDown) Error() string { return e.err.Error() }
func (e *errHubDown) Unwrap() error { return e.err }

func (p *mcpProxy) hubDownMessage() string {
	return fmt.Sprintf("Hub đang vắng (%s). Thao tác này cần hub trả lời ngay.", p.hub)
}

// queueable cho biết tool ghi có được giữ trong hộp thư của worker khi hub vắng.
func queueable(name string) bool {
	g, ok := outbox.GroupOf(outbox.TransportMCP, name)
	return ok && outbox.Queueable(g)
}

type outboxReply struct {
	State      string          `json:"state"`
	Key        string          `json:"key"`
	Reason     string          `json:"reason"`
	HeldReason string          `json:"heldReason"`
	Result     *outboxResponse `json:"result"`
}

type outboxResponse struct {
	Outcome  string          `json:"outcome"`
	Code     string          `json:"code"`
	Reason   string          `json:"reason"`
	Response json.RawMessage `json:"response"`
}

// viaOutbox nộp tools/call cho worker thay vì gọi hub: worker giữ mục khi hub vắng và gửi lại cùng khoá, nên agent không
// phải tự gọi lại và hub không ghi hai lần.
func (p *mcpProxy) viaOutbox(ctx context.Context, id json.RawMessage, name string, args json.RawMessage) {
	reply, err := p.submit(ctx, name, args)
	if ctx.Err() != nil {
		return
	}
	var re *localipc.RemoteError
	switch {
	case errors.Is(err, localipc.ErrNotRunning):
		p.toolResult(id, msgSidecarMissing, true)
		return
	case errors.As(err, &re):
		p.toolResult(id, strings.TrimSpace(re.Message), true)
		return
	case err != nil:
		p.toolResult(id, fmt.Sprintf("Không gửi được qua hive-worker: %v", err), true)
		return
	}
	switch reply.State {
	case "queued":
		p.toolResult(id, fmt.Sprintf("Đã xếp hàng, chờ hub (khoá %s). Hub sẽ nhận khi kết nối lại; không cần gọi lại.", reply.Key), false)
	case "held":
		p.toolResult(id, fmt.Sprintf("Đang giữ trong hộp thư (khoá %s): %s Hub sẽ nhận khi đăng nhập lại; không cần gọi lại.",
			reply.Key, strings.TrimSpace(reply.Reason)), false)
	default:
		if reply.Result != nil && len(reply.Result.Response) > 0 {
			data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": reply.Result.Response})
			_ = p.write(data)
			return
		}
		if reply.State == "rejected" {
			msg := "Hub từ chối thao tác."
			if reply.Result != nil {
				msg = strings.TrimSpace(fmt.Sprintf("Hub từ chối (%s). %s", reply.Result.Code, reply.Result.Reason))
			}
			p.toolResult(id, msg, true)
			return
		}
		p.toolResult(id, fmt.Sprintf("Hub đã nhận (khoá %s).", reply.Key), false)
	}
}

func (p *mcpProxy) submit(ctx context.Context, name string, args json.RawMessage) (outboxReply, error) {
	var reply outboxReply
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	body, err := json.Marshal(map[string]any{"name": name, "arguments": args})
	if err != nil {
		return reply, err
	}
	req := map[string]any{
		"op": "outbox.submit", "key": outbox.NewKey(time.Now()), "source": "mcp-local", "transport": outbox.TransportMCP,
		"kind": name, "project": p.project, "body": json.RawMessage(body), "waitMs": mcpSubmitWaitMs,
	}
	if target := toolTarget(name, args); target != nil {
		req["target"] = target
	}
	if line, _ := json.Marshal(req); len(line) > submitLineBudget {
		file, err := writeIncoming(body)
		if err != nil {
			return reply, err
		}
		defer os.Remove(file)
		delete(req, "body")
		req["bodyFile"] = file
	}
	path, err := p.socket()
	if err != nil {
		return reply, err
	}
	c, _, err := localipc.Dial(path, "hive/"+version.Version)
	if err != nil {
		return reply, err
	}
	defer c.Close()
	// Đóng stdin thì huỷ ngay, không chờ hết thời gian worker chờ hub.
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	err = c.Call(req, &reply)
	return reply, err
}

// toolTarget gắn tài liệu đích để hộp thư hiện đúng mục và hub gộp các đề xuất cùng tài liệu.
func toolTarget(name string, args json.RawMessage) *outbox.Target {
	switch name {
	case "doc_propose", "doc_suggest", "doc_comment":
		var a struct {
			Key string `json:"key"`
		}
		if json.Unmarshal(args, &a) == nil && a.Key != "" {
			return &outbox.Target{Type: "doc", ID: a.Key}
		}
	}
	return nil
}

// toolResult trả lỗi trong kết quả tool (isError) chứ không phải lỗi JSON-RPC, để agent đọc được và quyết định tiếp.
func (p *mcpProxy) toolResult(id json.RawMessage, text string, isError bool) {
	result := map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}
	if isError {
		result["isError"] = true
	}
	data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	_ = p.write(data)
}
