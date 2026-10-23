package terminal

import (
	"bytes"
	"github.com/tdduydev/xdev-hive/worker/internal/secretmask"
)

const minSecret = secretmask.MinLen
const mask = secretmask.Stars

type redactor struct {
	out    bytes.Buffer
	writer *secretmask.Writer
}

func newRedactor(secrets []string) *redactor {
	r := &redactor{}
	r.writer = secretmask.New(secrets, secretmask.WithMask(mask)).Writer(&r.out)
	return r
}

func (r *redactor) take() []byte {
	out := bytes.Clone(r.out.Bytes())
	r.out.Reset()
	return out
}

func (r *redactor) push(p []byte) []byte {
	_, _ = r.writer.Write(p)
	return r.take()
}

func (r *redactor) release() []byte {
	_ = r.writer.Flush()
	return r.take()
}

func (r *redactor) holding() bool { return r.writer.Holding() }
