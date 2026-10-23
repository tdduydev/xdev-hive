package outbox

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
)

// Tên header theo CLIENT_EVENT_HEADERS và khoá `_meta` theo MCP_CLIENT_EVENT_META trong contracts.
const (
	headerKey       = "Idempotency-Key"
	headerSource    = "X-Hive-Source"
	headerMachine   = "X-Hive-Machine"
	headerCreatedAt = "X-Hive-Created-At"
	headerClient    = "X-Hive-Client"
	headerResult    = "Hive-Client-Event"
	metaClientEvent = "dev.xdev.hive/clientEvent"

	maxResponseBytes = 8 << 20
)

// ErrLoginRequired là lỗi Token trả khi máy chưa có token của người tạo mục.
var ErrLoginRequired = &HoldError{Reason: HeldLoginRequired, Message: "Chưa đăng nhập hub; chạy `hive login`."}

// UserSender gửi mục kênh `mcp` và `rpc` bằng token của người tạo mục. Token đọc mỗi lần gửi (từ keychain) và không bao
// giờ nằm trong mục; Token trả *HoldError khi máy chưa đăng nhập hay đang đăng nhập người khác.
type UserSender struct {
	HTTP      *http.Client
	Token     func(ctx context.Context, id Identity) (string, error)
	MachineID string
	Client    string
}

// Dispatch dùng được làm Dispatcher. Mục kênh `worker` không gửi được ở đây vì cần machine token.
func (u UserSender) Dispatch(ctx context.Context, it Item) (Delivery, error) {
	token, err := u.Token(ctx, it.Identity)
	if err != nil {
		return Delivery{}, err
	}
	var req *http.Request
	switch it.Transport {
	case TransportMCP:
		req, err = u.mcpRequest(ctx, it)
	case TransportRPC:
		req, err = u.rpcRequest(ctx, it)
	default:
		return Delivery{}, &hubclient.StatusError{Status: http.StatusBadRequest, Message: "kênh " + it.Transport + " không gửi bằng token người dùng"}
	}
	if err != nil {
		return Delivery{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set(headerKey, it.Key)
	req.Header.Set(headerSource, it.Source)
	req.Header.Set(headerCreatedAt, it.CreatedAt.UTC().Format(time.RFC3339Nano))
	if u.MachineID != "" {
		req.Header.Set(headerMachine, u.MachineID)
	}
	if u.Client != "" {
		req.Header.Set(headerClient, u.Client)
	}
	if it.Project != "" {
		req.Header.Set("X-Hive-Project", it.Project)
	}
	hc := u.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(req)
	if err != nil {
		return Delivery{}, fmt.Errorf("không gọi được hub %s: %w", normalizeHub(it.Identity.HubURL), err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
	if err != nil {
		return Delivery{}, fmt.Errorf("không đọc được trả lời của hub: %w", err)
	}
	if res.StatusCode == http.StatusUnauthorized {
		// Token hết hạn hay bị thu hồi: gửi lại bằng token này vẫn 401, nên chờ người dùng đăng nhập lại.
		return Delivery{}, &HoldError{Reason: HeldLoginRequired, Message: "Token hết hạn hoặc đã bị thu hồi; chạy `hive login`."}
	}
	if it.Transport == TransportMCP {
		return mcpDelivery(res, body)
	}
	return rpcDelivery(res, body)
}

func (u UserSender) mcpRequest(ctx context.Context, it Item) (*http.Request, error) {
	call, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": it.Kind, "arguments": it.Body},
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, normalizeHub(it.Identity.HubURL)+"/mcp", bytes.NewReader(call))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	return req, nil
}

// rpcRequest gọi `POST /rpc/<path>` theo giao thức RPC của oRPC: input nằm trong `json`.
func (u UserSender) rpcRequest(ctx context.Context, it Item) (*http.Request, error) {
	call, err := json.Marshal(map[string]any{"json": it.Body})
	if err != nil {
		return nil, err
	}
	url := normalizeHub(it.Identity.HubURL) + "/rpc/" + strings.ReplaceAll(it.Kind, ".", "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(call))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}

// mcpDelivery đọc `_meta` của kết quả tool. Kết quả không có sự kiện mà là lỗi (tool hỏng trước khi ghi, hub lỗi giữa
// chừng) thì thử lại: hub chưa ghi gì cho khoá này. Kết quả thành công không có sự kiện là hub cũ chưa biết khoá; hub đã
// chạy tool nên coi như nhận.
func mcpDelivery(res *http.Response, body []byte) (Delivery, error) {
	if res.StatusCode/100 != 2 {
		return Delivery{}, &hubclient.StatusError{Status: res.StatusCode, Message: clip(body)}
	}
	msg, err := jsonRPCMessage(res.Header.Get("Content-Type"), body)
	if err != nil {
		return Delivery{}, &hubclient.StatusError{Status: http.StatusBadGateway, Message: err.Error()}
	}
	var rpc struct {
		Result *struct {
			IsError bool                       `json:"isError"`
			Meta    map[string]json.RawMessage `json:"_meta"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(msg, &rpc); err != nil {
		return Delivery{}, &hubclient.StatusError{Status: http.StatusBadGateway, Message: "trả lời MCP không đọc được"}
	}
	if rpc.Error != nil {
		return Delivery{}, &hubclient.StatusError{Status: http.StatusBadGateway, Message: rpc.Error.Message}
	}
	if rpc.Result == nil {
		return Delivery{}, &hubclient.StatusError{Status: http.StatusBadGateway, Message: "trả lời MCP thiếu result"}
	}
	var raw struct {
		Result json.RawMessage `json:"result"`
	}
	_ = json.Unmarshal(msg, &raw)
	d := Delivery{Response: raw.Result}
	if ev, ok := rpc.Result.Meta[metaClientEvent]; ok {
		if err := json.Unmarshal(ev, &d.Result); err != nil || d.Result.Outcome == "" {
			return Delivery{}, &hubclient.StatusError{Status: http.StatusBadGateway, Message: "sự kiện client trong _meta không đọc được"}
		}
		return d, nil
	}
	if rpc.Result.IsError {
		return Delivery{}, &hubclient.StatusError{Status: http.StatusBadGateway, Message: "tool lỗi trước khi hub ghi; sẽ gửi lại"}
	}
	d.Result = hubclient.ClientEventResult{Outcome: hubclient.OutcomeAccepted}
	return d, nil
}

// jsonRPCMessage lấy thông điệp trả lời: body JSON, hoặc sự kiện SSE đầu tiên có `result` hay `error`.
func jsonRPCMessage(contentType string, body []byte) ([]byte, error) {
	kind, _, _ := mime.ParseMediaType(contentType)
	if kind != "text/event-stream" {
		if !json.Valid(body) {
			return nil, errors.New("trả lời MCP không phải JSON")
		}
		return body, nil
	}
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 4096), maxResponseBytes)
	var data []byte
	flush := func() []byte {
		msg := bytes.TrimSuffix(data, []byte("\n"))
		data = nil
		var probe struct {
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(msg, &probe) == nil && (probe.Result != nil || probe.Error != nil) {
			return msg
		}
		return nil
	}
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if msg := flush(); msg != nil {
				return msg, nil
			}
			continue
		}
		if v, ok := strings.CutPrefix(line, "data:"); ok {
			data = append(append(data, strings.TrimPrefix(v, " ")...), '\n')
		}
	}
	if msg := flush(); msg != nil {
		return msg, nil
	}
	return nil, errors.New("luồng SSE của MCP không có trả lời")
}

// rpcDelivery đọc header `Hive-Client-Event`. Hub đặt header cả khi từ chối (lỗi nghiệp vụ, hay 409 khi gửi lại lần đã bị
// từ chối), nên có header là có kết quả; không có header thì là lỗi trước khi ghi, để permanent quyết định.
func rpcDelivery(res *http.Response, body []byte) (Delivery, error) {
	var d Delivery
	if h := res.Header.Get(headerResult); h != "" {
		if err := json.Unmarshal([]byte(h), &d.Result); err != nil || d.Result.Outcome == "" {
			return Delivery{}, &hubclient.StatusError{Status: http.StatusBadGateway, Message: "header Hive-Client-Event không đọc được"}
		}
		var out struct {
			JSON json.RawMessage `json:"json"`
		}
		if json.Unmarshal(body, &out) == nil {
			d.Response = out.JSON
		}
		if res.StatusCode/100 != 2 && d.Result.Outcome != hubclient.OutcomeRejected {
			return Delivery{}, &hubclient.StatusError{Status: res.StatusCode, Message: rpcMessage(body)}
		}
		return d, nil
	}
	if res.StatusCode/100 != 2 {
		return Delivery{}, &hubclient.StatusError{Status: res.StatusCode, Message: rpcMessage(body)}
	}
	var out struct {
		JSON json.RawMessage `json:"json"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return Delivery{}, &hubclient.StatusError{Status: http.StatusBadGateway, Message: "trả lời của hub không đọc được"}
	}
	// Hub cũ chưa đặt header nhưng đã chạy procedure.
	d.Result, d.Response = hubclient.ClientEventResult{Outcome: hubclient.OutcomeAccepted}, out.JSON
	return d, nil
}

// rpcMessage lấy `json.message` của lỗi oRPC, để lý do hiện cho người dùng là chữ của hub, không phải JSON.
func rpcMessage(body []byte) string {
	var e struct {
		JSON struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"json"`
	}
	if json.Unmarshal(body, &e) == nil && e.JSON.Message != "" {
		return e.JSON.Message
	}
	return clip(body)
}

func clip(b []byte) string {
	r := []rune(strings.TrimSpace(string(b)))
	return string(r[:min(len(r), 200)])
}
