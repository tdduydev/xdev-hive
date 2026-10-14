package main

import (
	"bufio"
	"flag"
	"fmt"
	"strings"
	"time"
)

// hive remote totp … quản lý mã Authenticator tại máy (specs/010 T026). Khoá đang chờ xác nhận nằm trong worker,
// nên app gọi enroll --json rồi confirm <mã> bằng hai tiến trình riêng vẫn được.

const totpUsage = `Cách dùng: hive remote totp <lệnh> [--json]

  status                  mã Authenticator đang bật, tắt hay đang khoá
  enroll                  tạo khoá mới: in mã QR otpauth://, hỏi một mã để xác nhận
  confirm <mã>            xác nhận khoá vừa tạo bằng mã 6 số (cho app; enroll trong terminal tự hỏi)
  disable [--yes]         tắt và xoá khoá (hỏi xác nhận)
  unlock                  mở khoá sau khi nhập sai quá nhiều lần
`

type totpEnroll struct {
	URI       string    `json:"uri"`
	Secret    string    `json:"secret"`
	ExpiresAt time.Time `json:"expiresAt"`
	HubURL    string    `json:"hubUrl"`
}

func (a *app) remoteTOTP(args []string) int {
	if len(args) == 0 {
		args = []string{"status"}
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "status":
		return a.totpStatus(rest)
	case "enroll":
		return a.totpEnroll(rest)
	case "confirm":
		return a.totpConfirm(rest)
	case "disable":
		return a.totpDisable(rest)
	case "unlock":
		return a.totpSimple("unlock", rest, "remote.totp.unlock", "Đã mở khoá mã Authenticator.")
	case "help", "-h", "--help":
		fmt.Fprint(a.stdout, totpUsage)
		return exitOK
	}
	fmt.Fprintf(a.stderr, "hive: không có lệnh remote totp %q.\n", sub)
	fmt.Fprint(a.stderr, totpUsage)
	return exitUsage
}

func (a *app) totpStatus(args []string) int {
	pos, asJSON, code := a.remoteFlags("totp status", args, nil)
	if code != exitOK {
		return code
	}
	if len(pos) > 0 {
		return a.errorf(exitUsage, "Thừa đối số %q.", pos[0])
	}
	out, code := a.remoteCall(map[string]any{"op": "remote.status"}, asJSON)
	if code != exitOK || asJSON {
		return code
	}
	a.printTOTP(out.Status)
	return exitOK
}

func (a *app) totpSimple(name string, args []string, op, done string) int {
	pos, asJSON, code := a.remoteFlags("totp "+name, args, nil)
	if code != exitOK {
		return code
	}
	if len(pos) > 0 {
		return a.errorf(exitUsage, "Thừa đối số %q.", pos[0])
	}
	if _, code := a.remoteCall(map[string]any{"op": op}, asJSON); code != exitOK || asJSON {
		return code
	}
	fmt.Fprintln(a.stdout, done)
	return exitOK
}

func (a *app) totpDisable(args []string) int {
	var yes *bool
	pos, asJSON, code := a.remoteFlags("totp disable", args, func(fs *flag.FlagSet) { yes = fs.Bool("yes", false, "đã xác nhận ở nơi khác") })
	if code != exitOK {
		return code
	}
	if len(pos) > 0 {
		return a.errorf(exitUsage, "Thừa đối số %q.", pos[0])
	}
	if code := a.confirm("Tắt mã Authenticator? Khoá trong app Authenticator sẽ không dùng được nữa.", *yes); code != exitOK {
		return code
	}
	if _, code := a.remoteCall(map[string]any{"op": "remote.totp.disable"}, asJSON); code != exitOK || asJSON {
		return code
	}
	fmt.Fprintln(a.stdout, "Đã tắt mã Authenticator; khoá cũ đã bị xoá.")
	return exitOK
}

func (a *app) totpConfirm(args []string) int {
	pos, asJSON, code := a.remoteFlags("totp confirm", args, nil)
	if code != exitOK {
		return code
	}
	if len(pos) != 1 {
		return a.errorf(exitUsage, "Cần đúng một mã 6 số: hive remote totp confirm <mã>.")
	}
	if _, code := a.remoteCall(map[string]any{"op": "remote.totp.confirm", "code": strings.TrimSpace(pos[0])}, asJSON); code != exitOK || asJSON {
		return code
	}
	fmt.Fprintln(a.stdout, "Đã bật mã Authenticator.")
	return exitOK
}

func (a *app) totpEnroll(args []string) int {
	pos, asJSON, code := a.remoteFlags("totp enroll", args, nil)
	if code != exitOK {
		return code
	}
	if len(pos) > 0 {
		return a.errorf(exitUsage, "Thừa đối số %q.", pos[0])
	}
	out, code := a.remoteCall(map[string]any{"op": "remote.totp.begin"}, asJSON)
	if code != exitOK || asJSON {
		return code
	}
	t := out.TOTP
	art, err := renderQR(t.URI, a.console.IsTerminal())
	if err != nil {
		return a.errorf(exitFailed, "Không vẽ được mã QR: %v", err)
	}
	fmt.Fprint(a.stdout, art)
	fmt.Fprintln(a.stdout, "Quét mã này bằng app Authenticator (Google Authenticator, 1Password, …).")
	fmt.Fprintf(a.stdout, "Không quét được thì nhập khoá: %s\n", groupBy4(t.Secret))
	fmt.Fprintf(a.stdout, "Khoá chờ xác nhận tới %s.\n", t.ExpiresAt.Local().Format("15:04"))
	if strings.HasPrefix(strings.ToLower(t.HubURL), "http://") {
		fmt.Fprintf(a.stderr, "Cảnh báo: hub %s chạy HTTP, mã đi trên đường không mã hoá. Chỉ dùng trong mạng LAN tin cậy; chuyển hub sang HTTPS để dùng passkey.\n", t.HubURL)
	} else {
		fmt.Fprintln(a.stdout, "Hub chạy HTTPS: mã chỉ được nhận khi bật hive remote set totp-on-https on.")
	}
	in := bufio.NewReader(a.stdin)
	for {
		fmt.Fprint(a.stdout, "Mã 6 số trên app: ")
		line, err := in.ReadString('\n')
		if c := strings.TrimSpace(line); c != "" {
			_, code := a.remoteCall(map[string]any{"op": "remote.totp.confirm", "code": c}, false)
			switch code {
			case exitOK:
				fmt.Fprintln(a.stdout, "Đã bật mã Authenticator. Từ giờ điện thoại mở phiên từ xa cần nhập mã từ app.")
				return exitOK
			case exitUsage:
				// Sai mã: worker đếm số lần và tự bỏ khoá khi quá giới hạn (trả denied), nên chỉ cần hỏi lại.
			default:
				return code
			}
		}
		if err != nil {
			fmt.Fprintln(a.stdout)
			return a.errorf(exitFailed, "Chưa nhập mã nên khoá chưa được lưu. Chạy lại hive remote totp enroll.")
		}
	}
}

// groupBy4 chia khoá base32 thành nhóm 4 ký tự cho dễ gõ tay.
func groupBy4(s string) string {
	var b strings.Builder
	for i, r := range s {
		if i > 0 && i%4 == 0 {
			b.WriteByte(' ')
		}
		b.WriteRune(r)
	}
	return b.String()
}
