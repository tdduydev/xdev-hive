package secretstore

import "time"

var platformBackend = func() backend { return osKeyring{} }

// NewSystemStore giới hạn thời gian chờ kho; NewStore giữ lối vào go-keyring cho unit test dùng MockInit.
func NewSystemStore() *Store {
	return &Store{kr: timedBackend{inner: platformBackend(), timeout: readTimeout}}
}

type timedBackend struct {
	inner   backend
	timeout time.Duration
}
type backendResult struct {
	value string
	err   error
}

func (b timedBackend) call(f func() (string, error)) (string, error) {
	ch := make(chan backendResult, 1)
	go func() { v, err := f(); ch <- backendResult{v, err} }()
	timer := time.NewTimer(b.timeout)
	defer timer.Stop()
	select {
	case r := <-ch:
		return r.value, r.err
	case <-timer.C:
		return "", locked()
	}
}
func (b timedBackend) Get(s, u string) (string, error) {
	return b.call(func() (string, error) { return b.inner.Get(s, u) })
}
func (b timedBackend) Set(s, u, v string) error {
	_, err := b.call(func() (string, error) { return "", b.inner.Set(s, u, v) })
	return err
}
func (b timedBackend) Delete(s, u string) error {
	_, err := b.call(func() (string, error) { return "", b.inner.Delete(s, u) })
	return err
}
