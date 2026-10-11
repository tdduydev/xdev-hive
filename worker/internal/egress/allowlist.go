package egress

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

type rule struct {
	host     string
	wildcard bool
	prefix   netip.Prefix
	port     string
}

// Allowlist is immutable after parsing, so concurrent requests share one policy snapshot.
type Allowlist struct{ rules []rule }

// Parse reads one domain, *.suffix, IP or CIDR per line, optionally followed by :port.
// IPv6 entries with ports use brackets, including CIDRs: [2001:db8::/32]:443.
func Parse(reader io.Reader) (*Allowlist, error) {
	list := &Allowlist{}
	scanner := bufio.NewScanner(reader)
	for line := 1; scanner.Scan(); line++ {
		entry := strings.TrimSpace(strings.SplitN(scanner.Text(), "#", 2)[0])
		if entry == "" {
			continue
		}
		host, port, err := splitEntry(entry)
		if err != nil {
			return nil, fmt.Errorf("allowlist dòng %d: %w", line, err)
		}
		item := rule{port: port}
		if prefix, err := netip.ParsePrefix(host); err == nil {
			if prefix.Addr().Is4In6() {
				return nil, fmt.Errorf("allowlist dòng %d: CIDR IPv4 ánh xạ không được hỗ trợ", line)
			}
			item.prefix = prefix.Masked()
		} else {
			item.wildcard = strings.HasPrefix(host, "*.")
			if item.wildcard {
				host = host[2:]
			}
			item.host, err = normalizeHost(host)
			if err != nil {
				return nil, fmt.Errorf("allowlist dòng %d: %w", line, err)
			}
			if addr, err := netip.ParseAddr(item.host); err == nil {
				if item.wildcard {
					return nil, fmt.Errorf("allowlist dòng %d: wildcard phải là tên miền", line)
				}
				item.prefix = netip.PrefixFrom(addr, addr.BitLen())
				item.host = ""
			}
		}
		list.rules = append(list.rules, item)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("không đọc được allowlist: %w", err)
	}
	return list, nil
}

func splitEntry(entry string) (string, string, error) {
	if _, err := netip.ParsePrefix(entry); err == nil {
		return entry, "", nil
	}
	if _, err := netip.ParseAddr(entry); err == nil {
		return entry, "", nil
	}
	if strings.HasPrefix(entry, "[") || strings.Contains(entry, ":") {
		host, port, err := net.SplitHostPort(entry)
		if err != nil {
			return "", "", fmt.Errorf("đích hoặc cổng không hợp lệ")
		}
		port, err = normalizePort(port)
		return host, port, err
	}
	return entry, "", nil
}

func normalizePort(port string) (string, error) {
	if port == "" || strings.Trim(port, "0123456789") != "" {
		return "", fmt.Errorf("cổng không hợp lệ")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("cổng không hợp lệ")
	}
	return strconv.Itoa(n), nil
}

func normalizeHost(host string) (string, error) {
	if addr, err := netip.ParseAddr(host); err == nil {
		if addr.Zone() != "" {
			return "", fmt.Errorf("không cho phép địa chỉ có zone")
		}
		return addr.String(), nil
	}
	ascii, err := idna.Lookup.ToASCII(host)
	ascii = strings.ToLower(strings.TrimSuffix(ascii, "."))
	if err != nil || ascii == "" || len(ascii) > 253 {
		return "", fmt.Errorf("tên miền không hợp lệ")
	}
	for _, label := range strings.Split(ascii, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", fmt.Errorf("tên miền không hợp lệ")
		}
		for _, ch := range label {
			if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-') {
				return "", fmt.Errorf("tên miền không hợp lệ")
			}
		}
	}
	// Numeric aliases must never become an alternative spelling of an IP literal.
	if strings.Trim(ascii, "0123456789.") == "" {
		return "", fmt.Errorf("địa chỉ IP không hợp lệ")
	}
	return ascii, nil
}

func (a *Allowlist) allowsHost(host, port string) bool {
	if addr, err := netip.ParseAddr(host); err == nil {
		return a.allowsIP(addr, port)
	}
	for _, item := range a.rules {
		if item.port != "" && item.port != port {
			continue
		}
		if item.host == host && !item.wildcard || item.wildcard && strings.HasSuffix(host, "."+item.host) {
			return true
		}
	}
	return false
}

func (a *Allowlist) allowsIP(addr netip.Addr, port string) bool {
	for _, item := range a.rules {
		if (item.port == "" || item.port == port) && item.prefix.IsValid() && item.prefix.Contains(addr) {
			return true
		}
	}
	return false
}
