// Package localipc là socket nội bộ giữa hive-worker và client trên cùng máy (`hive`, sau này app desktop), specs/010
// mục "Socket nội bộ". Chỉ người dùng hệ điều hành của worker nối được: đây là ranh giới "tại máy" (FR-012), nên mọi
// kết nối bị kiểm peer trước khi đọc byte nào.
//
// Giao thức: mỗi yêu cầu và mỗi trả lời là một dòng JSON. Dòng đầu là bắt tay
// {"op":"hello","v":1,"client":"hive/x"} → {"ok":true,"v":1,"worker":"x"}. Sau khi gắn vào phiên (session.attach,
// session.create), kết nối chuyển sang khung nhị phân [loại u8][độ dài u32 big-endian][dữ liệu].
package localipc

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

// Version là phiên bản giao thức socket nội bộ; hai bên khác nhau thì từ chối thay vì đoán ý gói lạ.
const Version = 1

// PathEnv ghi đè đường dẫn socket (test, chạy hai worker thử trên một máy).
const PathEnv = "HIVE_SOCKET"

const (
	// MaxLine chặn một dòng JSON: yêu cầu hợp lệ chỉ vài trăm byte, dòng dài là client hỏng hoặc cố làm worker tốn bộ nhớ.
	MaxLine = 64 * 1024
	// MaxFrame chặn một khung nhị phân: output đi theo khúc 32 KiB, phím và resize nhỏ hơn nhiều.
	MaxFrame = 1024 * 1024
	// HelloTimeout: client không bắt tay trong khoảng này thì đóng, để kết nối treo không giữ goroutine mãi.
	HelloTimeout = 10 * time.Second
)

// Loại khung sau khi gắn vào phiên.
const (
	FrameOut    byte = 1 // worker → client: output của PTY
	FrameIn     byte = 2 // client → worker: phím
	FrameResize byte = 3 // client → worker: JSON {"cols","rows"}
	FrameCtl    byte = 4 // hai chiều: JSON điều khiển (Ctl)
)

// Mã lỗi trong trả lời {"ok":false,"code":…}; client đổi ra mã thoát.
const (
	CodeVersion     = "version"
	CodeDenied      = "denied"
	CodeBadRequest  = "bad_request"
	CodeNotFound    = "not_found"
	CodeBusy        = "busy"
	CodeUnsupported = "unsupported"
	CodeFailed      = "failed"
)

// Loại Ctl.
const (
	CtlDetach  = "detach"  // client → worker: tách, phiên chạy tiếp
	CtlTake    = "take"    // client → worker: giành quyền điều khiển
	CtlControl = "control" // worker → client: bạn đang điều khiển
	CtlTaken   = "taken"   // worker → client: client khác đã giành quyền, bạn chỉ còn xem
	CtlExit    = "exit"    // worker → client: phiên đã kết thúc
)

// Ctl là khung điều khiển. Code chỉ có khi CLI tự thoát.
type Ctl struct {
	Type    string `json:"type"`
	Code    *int   `json:"code,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

// Size là dữ liệu của khung resize.
type Size struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

var (
	// ErrNotRunning: không có worker nào nghe ở đường dẫn socket.
	ErrNotRunning = errors.New("hive-worker chưa chạy")
	// ErrDenied: worker từ chối kết nối vì người gọi không phải người dùng của worker.
	ErrDenied = errors.New("hive-worker từ chối kết nối")
	// ErrInUse: đã có worker khác nghe ở đường dẫn socket.
	ErrInUse = errors.New("đã có hive-worker khác đang chạy trên máy")
	// ErrFrameTooLarge: khung vượt MaxFrame; kết nối phải đóng vì không còn biết ranh giới khung.
	ErrFrameTooLarge = errors.New("khung quá cỡ")
	// ErrLineTooLong: dòng JSON vượt MaxLine.
	ErrLineTooLong = errors.New("yêu cầu quá dài")
)

// VersionError: hai bên khác phiên bản giao thức.
type VersionError struct {
	Want, Got int
	Worker    string
}

func (e *VersionError) Error() string {
	return "Phiên bản hive và hive-worker khác nhau. Chạy `hive-worker update`."
}

// RemoteError là trả lời {"ok":false} của worker.
type RemoteError struct {
	Code    string
	Message string
}

func (e *RemoteError) Error() string { return e.Message }

// DefaultPath là <UserConfigDir>/xdev-hive/run/hive.sock (Windows: named pipe \\.\pipe\xdev-hive-<SID>), hoặc
// HIVE_SOCKET nếu đặt.
func DefaultPath() (string, error) {
	if p := os.Getenv(PathEnv); p != "" {
		return p, nil
	}
	return defaultPath()
}

// Request là một yêu cầu đã đọc; Decode đọc các trường riêng của op.
type Request struct {
	Op  string `json:"op"`
	raw []byte
}

func (r Request) Decode(v any) error {
	if err := json.Unmarshal(r.raw, v); err != nil {
		return fmt.Errorf("yêu cầu %s không hợp lệ: %w", r.Op, err)
	}
	return nil
}

// reply là phần chung của mọi trả lời.
type reply struct {
	OK    bool   `json:"ok"`
	Code  string `json:"code,omitempty"`
	Error string `json:"error,omitempty"`
}

// Conn là một kết nối socket nội bộ, dùng cho cả hai đầu. Đọc chỉ từ một goroutine; ghi an toàn từ nhiều goroutine.
type Conn struct {
	nc  net.Conn
	r   *bufio.Reader
	wmu sync.Mutex
}

func newConn(nc net.Conn) *Conn { return &Conn{nc: nc, r: bufio.NewReaderSize(nc, 32*1024)} }

// NewConn bọc một net.Conn đã có (test, client tự nối).
func NewConn(nc net.Conn) *Conn { return newConn(nc) }

func (c *Conn) Close() error                       { return c.nc.Close() }
func (c *Conn) SetReadDeadline(t time.Time) error  { return c.nc.SetReadDeadline(t) }
func (c *Conn) SetWriteDeadline(t time.Time) error { return c.nc.SetWriteDeadline(t) }

// readLine đọc một dòng, không quá MaxLine. Byte sau dòng ở lại trong bộ đệm cho khung nhị phân.
func (c *Conn) readLine() ([]byte, error) {
	var line []byte
	for {
		chunk, err := c.r.ReadSlice('\n')
		if len(line)+len(chunk) > MaxLine {
			return nil, ErrLineTooLong
		}
		line = append(line, chunk...)
		if err == nil {
			return line, nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			if errors.Is(err, io.EOF) && len(line) > 0 {
				return nil, io.ErrUnexpectedEOF
			}
			return nil, err
		}
	}
}

// ReadJSON đọc một dòng JSON vào v.
func (c *Conn) ReadJSON(v any) error {
	line, err := c.readLine()
	if err != nil {
		return err
	}
	return json.Unmarshal(line, v)
}

// ReadRequest đọc một yêu cầu.
func (c *Conn) ReadRequest() (Request, error) {
	line, err := c.readLine()
	if err != nil {
		return Request{}, err
	}
	var r Request
	if err := json.Unmarshal(line, &r); err != nil {
		return Request{}, fmt.Errorf("yêu cầu không phải JSON: %w", err)
	}
	r.raw = line
	return r, nil
}

// WriteJSON ghi v thành một dòng.
func (c *Conn) WriteJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.nc.Write(append(b, '\n'))
	return err
}

// OK trả lời thành công; fields (có thể nil) là các trường thêm, ghép cùng "ok":true.
func (c *Conn) OK(fields map[string]any) error {
	m := map[string]any{"ok": true}
	for k, v := range fields {
		m[k] = v
	}
	return c.WriteJSON(m)
}

// Fail trả lời lỗi; message là tiếng Việt cho người dùng đọc.
func (c *Conn) Fail(code, message string) error {
	return c.WriteJSON(reply{OK: false, Code: code, Error: message})
}

// Call gửi yêu cầu rồi đọc trả lời vào resp (có thể nil); trả lời ok=false thành *RemoteError.
func (c *Conn) Call(req any, resp any) error {
	if err := c.WriteJSON(req); err != nil {
		return err
	}
	line, err := c.readLine()
	if err != nil {
		return err
	}
	var base reply
	if err := json.Unmarshal(line, &base); err != nil {
		return fmt.Errorf("trả lời của hive-worker không hợp lệ: %w", err)
	}
	if !base.OK {
		return &RemoteError{Code: base.Code, Message: base.Error}
	}
	if resp != nil {
		return json.Unmarshal(line, resp)
	}
	return nil
}

// WriteFrame ghi một khung; dữ liệu quá MaxFrame bị từ chối thay vì để đầu kia đóng kết nối.
func (c *Conn) WriteFrame(typ byte, data []byte) error {
	if len(data) > MaxFrame {
		return ErrFrameTooLarge
	}
	var hdr [5]byte
	hdr[0] = typ
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(data)))
	c.wmu.Lock()
	defer c.wmu.Unlock()
	// net.Buffers gửi đầu khung và dữ liệu trong một lần ghi (writev) mà không chép dữ liệu.
	bufs := net.Buffers{hdr[:], data}
	_, err := bufs.WriteTo(c.nc)
	return err
}

// WriteCtl ghi khung điều khiển.
func (c *Conn) WriteCtl(ctl Ctl) error {
	b, err := json.Marshal(ctl)
	if err != nil {
		return err
	}
	return c.WriteFrame(FrameCtl, b)
}

// ReadFrame đọc một khung. Kết nối đóng giữa khung trả io.ErrUnexpectedEOF.
func (c *Conn) ReadFrame() (byte, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(c.r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > MaxFrame {
		return 0, nil, ErrFrameTooLarge
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(c.r, data); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return 0, nil, err
	}
	return hdr[0], data, nil
}
