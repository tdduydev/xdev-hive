package runner

import (
	"encoding/json"
	"io"
	"sort"
	"sync"

	"github.com/tdduydev/xdev-hive/worker/internal/redact"
)

type runLogSink struct {
	mu      sync.Mutex
	file    io.Writer
	next    Sink
	stream  redact.Stream
	streams map[string]*redact.Stream
	offsets map[string]int64
	job     Job
}

func (s *runLogSink) forward(name string, b []byte) error {
	if len(b) == 0 {
		return nil
	}
	if s.offsets == nil {
		s.offsets = map[string]int64{}
	}
	err := s.next.Emit(Event{Type: "log", RunID: s.job.RunID, Attempt: s.job.Attempt, Stream: name, Offset: s.offsets[name], Data: b})
	if err == nil {
		s.offsets[name] += int64(len(b))
	}
	return err
}

func (s *runLogSink) Emit(e Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.Type == "log" {
		if _, err := s.file.Write(e.Data); err != nil {
			return err
		}
		if s.streams == nil {
			s.streams = map[string]*redact.Stream{}
		}
		if s.streams[e.Stream] == nil {
			s.streams[e.Stream] = &redact.Stream{Exact: s.stream.Exact}
		}
		return s.forward(e.Stream, s.streams[e.Stream].Push(e.Data))
	}
	// Hub coi cleanup là sự kiện cuối trước kết quả; nhả đuôi đã che trước mốc đó để giữ thứ tự của spec 010.
	if e.Type == "result" || e.Type == "phase" && e.Phase == "cleanup" {
		names := make([]string, 0, len(s.streams))
		for name := range s.streams {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if err := s.forward(name, s.streams[name].Flush()); err != nil {
				return err
			}
		}
	}
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	b, err = redact.JSON(b, s.stream.Exact)
	if err != nil {
		return err
	}
	var stats *DiffStats
	if e.Result != nil {
		stats = e.Result.DiffStats
	}
	if err := json.Unmarshal(b, &e); err != nil {
		return err
	}
	if e.Result != nil {
		e.Result.DiffStats = stats
	}
	return s.next.Emit(e)
}
