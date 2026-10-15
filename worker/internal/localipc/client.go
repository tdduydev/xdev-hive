package localipc

import "time"

// Hello là trả lời bắt tay của worker.
type Hello struct {
	V      int    `json:"v"`
	Worker string `json:"worker"`
}

// DialTimeout chặn cả lúc nối lẫn lúc chờ bắt tay: worker treo thì `hive` báo lỗi thay vì đứng.
const DialTimeout = 5 * time.Second

// Dial nối worker ở path và bắt tay; client là tên và phiên bản người gọi ("hive/0.3.0"). Lỗi: ErrNotRunning,
// ErrDenied, *VersionError hoặc lỗi mạng khác.
func Dial(path, client string) (*Conn, Hello, error) { return dial(path, client, Version) }

func dial(path, client string, v int) (*Conn, Hello, error) {
	nc, err := dialSocket(path, DialTimeout)
	if err != nil {
		return nil, Hello{}, err
	}
	c := newConn(nc)
	_ = c.SetReadDeadline(time.Now().Add(DialTimeout))
	var h struct {
		Hello
		reply
	}
	// Worker từ chối peer thì ghi lời từ chối rồi đóng ngay, có thể trước khi hello tới: ghi lỗi vẫn đọc lời từ chối.
	werr := c.WriteJSON(hello{Op: "hello", V: v, Client: client})
	if err := c.ReadJSON(&h); err != nil {
		_ = c.Close()
		if werr != nil {
			return nil, Hello{}, werr
		}
		return nil, Hello{}, err
	}
	_ = c.SetReadDeadline(time.Time{})
	if !h.OK {
		_ = c.Close()
		switch h.Code {
		case CodeVersion:
			return nil, h.Hello, &VersionError{Want: v, Got: h.V, Worker: h.Worker}
		case CodeDenied:
			return nil, Hello{}, ErrDenied
		}
		return nil, Hello{}, &RemoteError{Code: h.Code, Message: h.Error}
	}
	if h.V != v {
		_ = c.Close()
		return nil, h.Hello, &VersionError{Want: v, Got: h.V, Worker: h.Worker}
	}
	return c, h.Hello, nil
}
