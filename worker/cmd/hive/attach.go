package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

// hive attach <id> (specs/010 US6): mã phiên trên máy (hex) gắn qua socket; mã của hub (UUID) là phiên trên máy này
// (gắn qua socket), run (xem log, gửi chỉ dẫn) hoặc phiên trên máy khác (chỉ xem).

var hubUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const (
	msgNotFound   = "Không tìm thấy run hoặc phiên."
	msgNoLogin    = "Chưa đăng nhập. Chạy `hive login`."
	msgAttachHelp = "Cách dùng: hive attach <id> [--view] [--escape KEY]."
)

func (a *app) attachCmd(args []string) int {
	fs := newFlagSet("attach", a.stderr)
	view := fs.Bool("view", false, "chỉ xem, không gõ")
	escFlag := escapeFlag(fs)
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		return exitUsage
	}
	if len(pos) != 1 {
		return a.errorf(exitUsage, msgAttachHelp)
	}
	esc, err := parseEscape(*escFlag)
	if err != nil {
		return a.errorf(exitUsage, "%v", err)
	}
	mode := modeControl
	if *view {
		mode = modeView
	}
	id := strings.ToLower(pos[0])
	if !hubUUID.MatchString(id) {
		return a.attachLocal(pos[0], mode, esc)
	}
	// Phiên mở trên máy này cũng có mã trên hub (hive ls --all, web): gắn qua socket để vẫn gõ được, không đi vòng hub.
	if local := a.localByHubID(id); local != "" {
		return a.attachLocal(local, mode, esc)
	}
	hub, token, err := a.credentials()
	if err != nil {
		return a.errorf(exitFailed, "%v", err)
	}
	if token == "" {
		return a.errorf(exitUsage, msgNoLogin)
	}
	c := &hubClient{http: a.httpClient(), base: hub, token: token}
	var r hubRun
	err = c.do(http.MethodGet, "/v1/runs/"+id, nil, &r)
	if err == nil {
		return a.attachRun(c, r, *view)
	}
	if !hidden(err) {
		return a.hubFail(err)
	}
	var s remoteSession
	err = c.do(http.MethodGet, "/v1/remote/sessions/"+id, nil, &s)
	if err == nil {
		return a.attachRemote(c, s, esc)
	}
	if hidden(err) {
		return a.errorf(exitFailed, msgNotFound)
	}
	return a.hubFail(err)
}

// hidden: 404 và 403 cùng báo "không tìm thấy" để người không có quyền không dò được id nào có thật (US6 kịch bản 4).
func hidden(err error) bool {
	var he *hubError
	return errors.As(err, &he) && (he.Status == http.StatusNotFound || he.Status == http.StatusForbidden)
}

func (a *app) attachLocal(id, mode string, esc byte) int {
	c, _, code := a.connect()
	if code != exitOK {
		return code
	}
	defer c.Close()
	var resp struct {
		ID string `json:"id"`
	}
	if err := c.Call(map[string]string{"op": "session.attach", "id": id, "mode": mode}, &resp); err != nil {
		return a.fail(err)
	}
	if mode == modeView {
		fmt.Fprintf(a.stderr, "hive: đang xem phiên %s. %s\n", resp.ID, escHint(esc, true))
	} else {
		fmt.Fprintf(a.stderr, "hive: đã gắn phiên %s. %s\n", resp.ID, escHint(esc, false))
	}
	return a.interact(c, resp.ID, mode, esc)
}

// localByHubID tìm phiên trên máy có mã hub là id; worker không chạy hay không có thì trả "" để thử hub.
func (a *app) localByHubID(id string) string {
	path, err := a.socket()
	if err != nil {
		return ""
	}
	c, _, err := localipc.Dial(path, "hive/"+version.Version)
	if err != nil {
		return ""
	}
	defer c.Close()
	var resp struct {
		Sessions []sessionInfo `json:"sessions"`
	}
	if c.Call(map[string]string{"op": "session.list"}, &resp) != nil {
		return ""
	}
	for _, s := range resp.Sessions {
		if s.HubID == id {
			return s.ID
		}
	}
	return ""
}

type hubRun struct {
	ID          string  `json:"id"`
	State       string  `json:"state"`
	CLI         *string `json:"cli"`
	MachineName *string `json:"machineName"`
}

// runEvent là RunEventView của hub; data giữ thô vì mỗi loại sự kiện một dạng.
type runEvent struct {
	ID   json.Number     `json:"id"`
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}
