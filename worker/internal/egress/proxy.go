package egress

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Config struct {
	Allowlist      *Allowlist
	Resolver       Resolver
	DialContext    func(context.Context, string, string) (net.Conn, error)
	Logger         *slog.Logger
	ConnectTimeout time.Duration
	IdleTimeout    time.Duration
	AllowIPv6      bool
}

type Proxy struct {
	config  Config
	mu      sync.Mutex
	tunnels map[net.Conn]struct{}
	closed  bool
}

func New(config Config) (*Proxy, error) {
	if config.Allowlist == nil {
		return nil, fmt.Errorf("phải cung cấp allowlist")
	}
	if config.ConnectTimeout < 0 || config.IdleTimeout < 0 {
		return nil, fmt.Errorf("thời gian chờ phải lớn hơn 0")
	}
	if config.ConnectTimeout == 0 {
		config.ConnectTimeout = 10 * time.Second
	}
	if config.IdleTimeout == 0 {
		config.IdleTimeout = 60 * time.Second
	}
	if config.Resolver == nil {
		config.Resolver = net.DefaultResolver
	}
	if config.DialContext == nil {
		config.DialContext = (&net.Dialer{}).DialContext
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	return &Proxy{config: config, tunnels: make(map[net.Conn]struct{})}, nil
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, port, reason := "", "", "được phép"
	allowed := false
	var sent, received int64
	var bodySent atomic.Int64
	defer func() {
		p.config.Logger.Info("yêu cầu egress", "allowed", allowed, "host", host, "port", port, "reason", reason, "bytes_sent", sent+bodySent.Load(), "bytes_received", received)
	}()
	deny := func(message string) { reason = message; http.Error(w, message, http.StatusForbidden) }
	var err error
	if r.Method == http.MethodConnect {
		host, port, err = authority(r.RequestURI, "")
	} else {
		if r.URL.Scheme != "http" || r.URL.User != nil || r.URL.Host == "" {
			deny("chỉ hỗ trợ URL HTTP tuyệt đối")
			return
		}
		host, port, err = authority(r.URL.Host, "80")
	}
	if err != nil {
		deny(err.Error())
		return
	}
	defaultPort := "80"
	if r.Method == http.MethodConnect {
		defaultPort = ""
	}
	headerHost, headerPort, err := authority(r.Host, defaultPort)
	if err != nil || host != headerHost || port != headerPort {
		deny("Host không khớp đích yêu cầu")
		return
	}
	destination, err := p.resolve(r.Context(), host, port)
	if err != nil {
		deny(err.Error())
		return
	}
	if r.Method == http.MethodConnect {
		allowed, reason, sent, received = p.connect(w, r, destination)
		return
	}
	if r.Header.Get("Upgrade") != "" {
		deny("không hỗ trợ nâng cấp giao thức HTTP")
		return
	}
	out := r.Clone(r.Context())
	out.RequestURI = ""
	out.URL.Host = net.JoinHostPort(host, port)
	out.Host = out.URL.Host
	stripHopHeaders(out.Header)
	// Each request dials its own checked addresses; no pooled connection can escape a new policy check.
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            func(ctx context.Context, _, _ string) (net.Conn, error) { return p.dial(ctx, destination) },
		DisableKeepAlives:      true,
		ResponseHeaderTimeout:  p.config.IdleTimeout,
		MaxResponseHeaderBytes: 1 << 20,
	}
	defer transport.CloseIdleConnections()
	if out.Body != nil {
		out.Body = &countBody{ReadCloser: out.Body, count: &bodySent}
	}
	response, err := transport.RoundTrip(out)
	if err != nil {
		reason = "không chuyển tiếp được HTTP"
		http.Error(w, reason, http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusSwitchingProtocols {
		deny("không hỗ trợ nâng cấp giao thức HTTP")
		return
	}
	allowed = true
	stripHopHeaders(response.Header)
	for key, values := range response.Header {
		w.Header()[key] = values
	}
	w.WriteHeader(response.StatusCode)
	received, err = io.Copy(w, response.Body)
	if err != nil {
		reason = "truyền HTTP bị ngắt hoặc hết thời gian chờ"
	}
}

func stripHopHeaders(header http.Header) {
	for _, value := range header.Values("Connection") {
		for _, key := range strings.Split(value, ",") {
			header.Del(strings.TrimSpace(key))
		}
	}
	for _, key := range []string{"Connection", "Proxy-Connection", "Proxy-Authorization", "Proxy-Authenticate", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade"} {
		header.Del(key)
	}
}

type countBody struct {
	io.ReadCloser
	count *atomic.Int64
}

func (b *countBody) Read(data []byte) (int, error) {
	n, err := b.ReadCloser.Read(data)
	b.count.Add(int64(n))
	return n, err
}

type idleConn struct {
	net.Conn
	timeout                     time.Duration
	mu                          sync.Mutex
	readDeadline, writeDeadline time.Time
}

func earlierDeadline(absolute time.Time, timeout time.Duration) time.Time {
	idle := time.Now().Add(timeout)
	if !absolute.IsZero() && absolute.Before(idle) {
		return absolute
	}
	return idle
}

func (c *idleConn) Read(data []byte) (int, error) {
	c.mu.Lock()
	_ = c.Conn.SetReadDeadline(earlierDeadline(c.readDeadline, c.timeout))
	c.mu.Unlock()
	return c.Conn.Read(data)
}
func (c *idleConn) Write(data []byte) (int, error) {
	c.mu.Lock()
	_ = c.Conn.SetWriteDeadline(earlierDeadline(c.writeDeadline, c.timeout))
	c.mu.Unlock()
	return c.Conn.Write(data)
}

// net/http uses past deadlines to interrupt background reads before Hijack.
// Preserve those deadlines instead of replacing them with the idle timeout.
func (c *idleConn) SetReadDeadline(deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.readDeadline = deadline
	return c.Conn.SetReadDeadline(deadline)
}
func (c *idleConn) SetWriteDeadline(deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writeDeadline = deadline
	return c.Conn.SetWriteDeadline(deadline)
}
func (c *idleConn) SetDeadline(deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.readDeadline, c.writeDeadline = deadline, deadline
	return c.Conn.SetDeadline(deadline)
}

type idleListener struct {
	net.Listener
	timeout time.Duration
}

func (l idleListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &idleConn{Conn: conn, timeout: l.timeout}, nil
}

func (p *Proxy) connect(w http.ResponseWriter, r *http.Request, destination target) (bool, string, int64, int64) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "không hỗ trợ CONNECT", http.StatusInternalServerError)
		return false, "không hỗ trợ CONNECT", 0, 0
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return false, "không mở được CONNECT", 0, 0
	}
	defer client.Close()
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return false, "proxy đang dừng", 0, 0
	}
	p.tunnels[client] = struct{}{}
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.tunnels, client); p.mu.Unlock() }()
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return false, "không mở được CONNECT", 0, 0
	}
	if err := buffered.Flush(); err != nil {
		return false, "không mở được CONNECT", 0, 0
	}
	// A fixed deadline also bounds clients that drip a fragmented ClientHello forever.
	timer := time.AfterFunc(p.config.ConnectTimeout, func() { _ = client.Close() })
	hello, name, err := readHello(buffered.Reader)
	timer.Stop()
	if err == nil {
		_, ipErr := netip.ParseAddr(destination.host)
		if name != destination.host && (name != "" || ipErr != nil) {
			err = fmt.Errorf("SNI không khớp host CONNECT")
		}
	}
	if err != nil {
		// The client needs 200 before sending TLS. A denial after that point is a TLS alert, never a second HTTP response.
		_, _ = client.Write([]byte{21, 3, 3, 0, 2, 2, 49})
		return false, err.Error(), 0, 0
	}
	upstream, err := p.dial(r.Context(), destination)
	if err != nil {
		return false, err.Error(), 0, 0
	}
	defer upstream.Close()
	n, err := upstream.Write(hello)
	if err != nil {
		return false, "không gửi được ClientHello", int64(n), 0
	}
	type transfer struct {
		bytes int64
		err   error
	}
	upload := make(chan transfer, 1)
	go func() {
		size, copyErr := io.Copy(upstream, buffered.Reader)
		upload <- transfer{size, copyErr}
		_ = upstream.Close()
		_ = client.Close()
	}()
	received, copyErr := io.Copy(client, upstream)
	_ = upstream.Close()
	_ = client.Close()
	result := <-upload
	reason := "được phép"
	if copyErr != nil || result.err != nil {
		reason = "kết nối đóng hoặc hết thời gian chờ"
	}
	return true, reason, int64(n) + result.bytes, received
}

// Serve closes active HTTP requests and hijacked tunnels when the run ends.
func (p *Proxy) Serve(ctx context.Context, listeners ...net.Listener) error {
	if len(listeners) == 0 {
		return fmt.Errorf("phải có ít nhất một địa chỉ nghe")
	}
	server := &http.Server{Handler: p, ReadHeaderTimeout: p.config.ConnectTimeout, IdleTimeout: p.config.IdleTimeout, MaxHeaderBytes: 1 << 20, BaseContext: func(net.Listener) context.Context { return ctx }}
	errors := make(chan error, len(listeners))
	for _, listener := range listeners {
		go func() { errors <- server.Serve(idleListener{listener, p.config.IdleTimeout}) }()
	}
	var err error
	select {
	case <-ctx.Done():
	case err = <-errors:
	}
	_ = server.Close()
	// Close listeners explicitly too: cancellation can happen before Serve registers them.
	for _, listener := range listeners {
		_ = listener.Close()
	}
	p.mu.Lock()
	p.closed = true
	for conn := range p.tunnels {
		_ = conn.Close()
	}
	p.mu.Unlock()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
