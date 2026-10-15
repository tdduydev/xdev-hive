package main

import (
	"encoding/json"
	"io"
	"strings"
)

const authUsage = "Cách dùng: hive auth token|store|logout|status [--json] [--hub URL]. Lệnh store đọc token từ stdin."

type authResult struct {
	HubURL        string `json:"hubUrl"`
	Token         string `json:"token,omitempty"`
	OrgID         string `json:"orgId,omitempty"`
	Source        string `json:"source,omitempty"`
	Authenticated bool   `json:"authenticated"`
}

func (a *app) auth(args []string) int {
	if len(args) == 0 {
		return a.errorf(exitUsage, "%s", authUsage)
	}
	command := args[0]
	switch command {
	case "token", "store", "logout", "status":
	default:
		return a.errorf(exitUsage, "%s", authUsage)
	}
	// Không lặp lại đối số hay lỗi thư viện: chúng có thể chứa token người dùng dán nhầm.
	fs := newFlagSet("auth "+command, io.Discard)
	hubFlag := fs.String("hub", "", "địa chỉ hub")
	fs.Bool("json", false, "trả kết quả JSON")
	pos, err := parseInterspersed(fs, args[1:])
	if err != nil || len(pos) != 0 {
		return a.errorf(exitUsage, "%s", authUsage)
	}
	raw := *hubFlag
	if raw == "" {
		raw = a.defaultHub()
	}
	result := authResult{}
	if raw == "" {
		if command == "token" || command == "status" {
			return a.writeAuthResult(result, exitDenied)
		}
		return a.errorf(exitUsage, "Chưa biết hub nào. Dùng --hub URL.")
	}
	hub, err := normalizeHub(raw)
	if err != nil {
		return a.errorf(exitUsage, "Địa chỉ hub không hợp lệ; cần dạng https://hive.cong-ty.vn.")
	}
	result.HubURL = hub
	switch command {
	case "store":
		// Giới hạn cả dữ liệu lẫn việc đọc: PAT không cần hơn một KiB.
		data, err := io.ReadAll(io.LimitReader(a.stdin, 1025))
		if err != nil || len(data) > 1024 {
			return a.errorf(exitUsage, "Không đọc được token hợp lệ từ stdin.")
		}
		token := strings.TrimSpace(string(data))
		if !validPAT(token) {
			return a.errorf(exitUsage, "Token không đúng dạng hive_pat_….")
		}
		result.Source, err = a.saveToken(hub, token)
		if err != nil {
			return a.errorf(exitFailed, "%v", err)
		}
		result.Authenticated = true
		result.OrgID = patOrg.FindStringSubmatch(token)[1]
	case "logout":
		if err := a.deleteToken(hub); err != nil {
			return a.errorf(exitFailed, "%v", err)
		}
	default:
		token, source, err := a.readToken(hub)
		if err != nil {
			return a.errorf(exitFailed, "%v", err)
		}
		if !validPAT(token) {
			return a.writeAuthResult(result, exitDenied)
		}
		result.Authenticated = true
		result.Source = source
		result.OrgID = patOrg.FindStringSubmatch(token)[1]
		if command == "token" {
			result.Token = token
		}
	}
	return a.writeAuthResult(result, exitOK)
}

func (a *app) writeAuthResult(result authResult, code int) int {
	if err := json.NewEncoder(a.stdout).Encode(result); err != nil {
		return a.errorf(exitFailed, "Không ghi được kết quả xác thực.")
	}
	return code
}
