package remoteauth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"sync"
	"time"
)

// PairTTL: mã ghép sống 10 phút và chỉ dùng một lần (FR-014).
const PairTTL = 10 * time.Minute

// Lý do trong term_pair_result.
const (
	PairExpired = "expired"
	PairBadTag  = "bad_tag"
)

type pendingPair struct {
	secret  []byte
	expires time.Time
}

// Pairings giữ mã ghép đang chờ trong bộ nhớ: bí mật chỉ đi vào QR (fragment URL) và không bao giờ tới hub, nên hub
// không thay được khoá công khai của điện thoại.
type Pairings struct {
	Now     func() time.Time
	mu      sync.Mutex
	pending map[string]pendingPair
}

func (p *Pairings) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

// Begin tạo mã ghép mới: pairId để hub định tuyến, bí mật 128 bit để điện thoại ký tag.
func (p *Pairings) Begin() (pairID string, secret []byte, expires time.Time, err error) {
	id := make([]byte, 12)
	secret = make([]byte, 16)
	if _, err = rand.Read(id); err != nil {
		return "", nil, time.Time{}, err
	}
	if _, err = rand.Read(secret); err != nil {
		return "", nil, time.Time{}, err
	}
	pairID = "pair-" + b64url.EncodeToString(id)
	expires = p.now().Add(PairTTL)
	p.put(pairID, secret, expires)
	return pairID, secret, expires, nil
}

func (p *Pairings) put(pairID string, secret []byte, expires time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pending == nil {
		p.pending = map[string]pendingPair{}
	}
	now := p.now()
	for id, e := range p.pending {
		if now.After(e.expires) {
			delete(p.pending, id)
		}
	}
	p.pending[pairID] = pendingPair{secret: secret, expires: expires}
}

// Verify kiểm tag của term_pair rồi bỏ mã ghép (đúng hay sai đều bỏ: một lần thử, không đoán dần). Trả "" khi đúng,
// hoặc lý do PairExpired/PairBadTag. SPKI phải là khoá ES256 dùng được.
func (p *Pairings) Verify(pairID, userID, credentialID, spki, tag string) string {
	p.mu.Lock()
	e, ok := p.pending[pairID]
	delete(p.pending, pairID)
	p.mu.Unlock()
	if !ok || p.now().After(e.expires) {
		return PairExpired
	}
	got, err := b64url.DecodeString(tag)
	if err != nil {
		return PairBadTag
	}
	payload, err := PairTagPayload(pairID, userID, credentialID, spki)
	if err != nil {
		return PairBadTag
	}
	mac := hmac.New(sha256.New, e.secret)
	mac.Write(payload)
	if !hmac.Equal(got, mac.Sum(nil)) {
		return PairBadTag
	}
	if _, err := ParseSPKI(spki); err != nil {
		return PairBadTag
	}
	return ""
}

// PairTagPayload khớp pairTagPayload của contracts: JSON chuẩn hoá thay cho nối thẳng SPKI‖credentialId‖userId để ranh
// giới các trường không mơ hồ.
func PairTagPayload(pairID, userID, credentialID, spki string) ([]byte, error) {
	return Canonical(map[string]any{"pairId": pairID, "userId": userID, "credentialId": credentialID, "spki": spki})
}
