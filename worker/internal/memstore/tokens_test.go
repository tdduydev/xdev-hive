package memstore

import (
	"strings"
	"testing"
)

func TestEstimateTokens(t *testing.T) {
	for _, tc := range []struct {
		name, content string
		want          int
	}{
		{"empty", "", 0},
		{"ascii", "abcd", 1},
		{"round up", "abcde", 2},
		{"unicode characters", "漢字中文", 1},
		{"Vietnamese", strings.Repeat("ệ", 12), 4},
		{"Vietnamese mixed", "Việt Nam", 3},
		{"Vietnamese D", "Đabcde", 2},
		{"Vietnamese decomposed", "a\u0302\u0301", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := EstimateTokens(tc.content); got != tc.want {
				t.Fatalf("tokens = %d, want %d", got, tc.want)
			}
		})
	}
}
