//go:build windows

package localipc

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strings"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const pipePrefix = `\\.\pipe\`

// pipeBuffer chứa trọn vài khúc output 32 KiB, để phiên không phải chờ client đọc xong từng khúc mới ghi tiếp.
const pipeBuffer = 64 << 10

// defaultPath: pipe theo SID để hai người dùng trên một máy mỗi người một worker, không đụng tên nhau.
func defaultPath() (string, error) {
	sid, err := currentSID()
	if err != nil {
		return "", err
	}
	return pipePrefix + "xdev-hive-" + sid.String(), nil
}

// pipeName đổi đường dẫn thành tên pipe. HIVE_SOCKET và test có thể đưa đường dẫn file như trên Unix; băm đường dẫn để
// mỗi đường dẫn một pipe riêng mà tên không vượt giới hạn 256 ký tự.
func pipeName(path string) string {
	if strings.HasPrefix(strings.ToLower(path), pipePrefix) {
		return path
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	sum := sha256.Sum256([]byte(strings.ToLower(path)))
	return pipePrefix + "xdev-hive-" + hex.EncodeToString(sum[:8])
}

// pipeSDDL: DACL được bảo vệ (P, không kế thừa) chỉ cho SID hiện tại; người dùng khác trên máy không mở được pipe nên không
// điều khiển được phiên. SameUser vẫn kiểm lại ở mỗi kết nối.
func pipeSDDL(sid *windows.SID) string {
	return "D:P(A;;GA;;;" + sid.String() + ")"
}

// Listen mở named pipe cho path. Lần tạo đầu dùng FILE_CREATE nên pipe đã có (worker khác của mình, hay tiến trình của
// người khác giữ trước tên) thì trả ErrInUse chứ không nhập chung.
func Listen(path string) (net.Listener, error) {
	sid, err := currentSID()
	if err != nil {
		return nil, err
	}
	ln, err := winio.ListenPipe(pipeName(path), &winio.PipeConfig{
		SecurityDescriptor: pipeSDDL(sid),
		InputBufferSize:    pipeBuffer,
		OutputBufferSize:   pipeBuffer,
	})
	if err != nil {
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) || errors.Is(err, windows.ERROR_PIPE_BUSY) ||
			errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return nil, fmt.Errorf("%w: %w", ErrInUse, err)
		}
		return nil, err
	}
	return ln, nil
}

func dialSocket(path string, timeout time.Duration) (net.Conn, error) {
	nc, err := winio.DialPipe(pipeName(path), &timeout)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return nil, fmt.Errorf("%w: %w", ErrNotRunning, err)
		}
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			// DACL của pipe không cho mình: pipe do người dùng khác tạo.
			return nil, fmt.Errorf("%w: pipe %s thuộc người dùng khác", ErrDenied, pipeName(path))
		}
		return nil, err
	}
	// Tên pipe ai cũng tạo được nếu tới trước: kiểm tiến trình server là của chính mình trước khi gửi lời nhắc hay phím.
	if err := checkServer(nc); err != nil {
		_ = nc.Close()
		return nil, fmt.Errorf("%w: %w", ErrDenied, err)
	}
	return nc, nil
}

func checkServer(c net.Conn) error {
	h, err := pipeHandle(c)
	if err != nil {
		return err
	}
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(h, &pid); err != nil {
		return fmt.Errorf("không đọc được tiến trình giữ pipe: %w", err)
	}
	return samePIDUser(pid, "tiến trình giữ pipe")
}
