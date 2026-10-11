package egress

import (
	"context"
	"fmt"
	"net"
	"net/netip"
)

type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type target struct {
	host, port string
	addresses  []netip.Addr
}

var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	// Azure's virtual platform address is globally numbered but serves host metadata.
	netip.MustParsePrefix("168.63.129.16/32"),
	netip.MustParsePrefix("::/96"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
}

func restrictedIP(addr netip.Addr) bool {
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() {
		return true
	}
	for _, prefix := range blockedPrefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func authority(value, defaultPort string) (string, string, error) {
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		if defaultPort == "" || value == "" {
			return "", "", fmt.Errorf("đích phải có host và cổng")
		}
		host, port = value, defaultPort
	}
	host, err = normalizeHost(host)
	if err != nil {
		return "", "", err
	}
	port, err = normalizePort(port)
	return host, port, err
}

func (p *Proxy) resolve(ctx context.Context, host, port string) (target, error) {
	result := target{host: host, port: port}
	if addr, err := netip.ParseAddr(host); err == nil {
		if !p.config.AllowIPv6 && !addr.Is4() {
			return result, fmt.Errorf("đích IPv6 bị chặn")
		}
		if !p.config.Allowlist.allowsIP(addr, port) {
			return result, fmt.Errorf("IP chưa được cho phép rõ")
		}
		result.addresses = []netip.Addr{addr}
		return result, nil
	}
	if !p.config.Allowlist.allowsHost(host, port) {
		return result, fmt.Errorf("đích không nằm trong allowlist")
	}
	ctx, cancel := context.WithTimeout(ctx, p.config.ConnectTimeout)
	defer cancel()
	addresses, err := p.config.Resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return result, fmt.Errorf("không phân giải được DNS")
	}
	for _, addr := range addresses {
		if !addr.IsValid() || addr.Zone() != "" {
			return result, fmt.Errorf("DNS trả địa chỉ không hợp lệ")
		}
		if !p.config.AllowIPv6 && !addr.Is4() {
			continue
		}
		if restrictedIP(addr) && !p.config.Allowlist.allowsIP(addr, port) {
			return result, fmt.Errorf("DNS trả IP thuộc mạng bị chặn")
		}
		result.addresses = append(result.addresses, addr)
	}
	if len(result.addresses) == 0 {
		return result, fmt.Errorf("DNS không có địa chỉ được hỗ trợ; IPv6 bị chặn mặc định")
	}
	return result, nil
}

func (p *Proxy) dial(ctx context.Context, destination target) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, p.config.ConnectTimeout)
	defer cancel()
	for _, addr := range destination.addresses {
		network := "tcp4"
		if addr.Is6() {
			network = "tcp6"
		}
		// Passing a checked literal prevents the dialer from doing a second DNS lookup.
		conn, err := p.config.DialContext(ctx, network, net.JoinHostPort(addr.String(), destination.port))
		if err == nil {
			return &idleConn{Conn: conn, timeout: p.config.IdleTimeout}, nil
		}
	}
	return nil, fmt.Errorf("không kết nối được đích")
}
