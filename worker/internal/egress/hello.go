package egress

import (
	"encoding/binary"
	"fmt"
	"io"
)

const maxHelloBytes = 64 << 10

type cursor struct{ data []byte }

func (c *cursor) take(n int) ([]byte, bool) {
	if n < 0 || n > len(c.data) {
		return nil, false
	}
	data := c.data[:n]
	c.data = c.data[n:]
	return data, true
}
func (c *cursor) vector(width int) ([]byte, bool) {
	size, ok := c.take(width)
	if !ok {
		return nil, false
	}
	n := 0
	for _, b := range size {
		n = n<<8 | int(b)
	}
	return c.take(n)
}

// Only a bounded ClientHello is buffered. No TLS application data is decrypted.
func readHello(reader io.Reader) ([]byte, string, error) {
	var wire, handshake []byte
	for {
		var header [5]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return nil, "", fmt.Errorf("không đọc được ClientHello")
		}
		size := int(binary.BigEndian.Uint16(header[3:]))
		if header[0] != 22 || header[1] != 3 || header[2] > 3 || size == 0 || size > 16384 || len(wire)+5+size > maxHelloBytes {
			return nil, "", fmt.Errorf("ClientHello không hợp lệ hoặc quá lớn")
		}
		record := make([]byte, size)
		if _, err := io.ReadFull(reader, record); err != nil {
			return nil, "", fmt.Errorf("ClientHello bị thiếu")
		}
		wire = append(wire, header[:]...)
		wire = append(wire, record...)
		handshake = append(handshake, record...)
		if len(handshake) < 4 {
			continue
		}
		length := int(handshake[1])<<16 | int(handshake[2])<<8 | int(handshake[3])
		if handshake[0] != 1 || length > maxHelloBytes-4 {
			return nil, "", fmt.Errorf("ClientHello không hợp lệ hoặc quá lớn")
		}
		if len(handshake) < length+4 {
			continue
		}
		name, err := helloName(handshake[4 : length+4])
		return wire, name, err
	}
}

func helloName(data []byte) (string, error) {
	invalid := fmt.Errorf("ClientHello không hợp lệ")
	c := cursor{data}
	if _, ok := c.take(34); !ok {
		return "", invalid
	}
	if session, ok := c.vector(1); !ok || len(session) > 32 {
		return "", invalid
	}
	if suites, ok := c.vector(2); !ok || len(suites) == 0 || len(suites)%2 != 0 {
		return "", invalid
	}
	if compression, ok := c.vector(1); !ok || len(compression) == 0 {
		return "", invalid
	}
	if len(c.data) == 0 {
		return "", nil
	}
	extensions, ok := c.vector(2)
	if !ok || len(c.data) != 0 {
		return "", invalid
	}
	c = cursor{extensions}
	seen := map[uint16]bool{}
	name := ""
	for len(c.data) > 0 {
		kind, ok := c.take(2)
		if !ok {
			return "", invalid
		}
		value, ok := c.vector(2)
		if !ok {
			return "", invalid
		}
		id := binary.BigEndian.Uint16(kind)
		if seen[id] {
			return "", invalid
		}
		seen[id] = true
		// ECH hides the actual server name, so its outer SNI cannot authorize a tunnel.
		if id == 0xfe0d {
			return "", fmt.Errorf("không cho phép ClientHello mã hoá ECH")
		}
		if id != 0 {
			continue
		}
		sni := cursor{value}
		names, ok := sni.vector(2)
		if !ok || len(sni.data) != 0 || len(names) == 0 {
			return "", invalid
		}
		sni = cursor{names}
		kind, ok = sni.take(1)
		if !ok || kind[0] != 0 {
			return "", invalid
		}
		host, ok := sni.vector(2)
		if !ok || len(host) == 0 || len(sni.data) != 0 {
			return "", invalid
		}
		var err error
		name, err = normalizeHost(string(host))
		if err != nil {
			return "", invalid
		}
	}
	return name, nil
}
