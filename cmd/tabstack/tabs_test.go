package main

import (
	"encoding/json"
	"net/url"
	"os"
	"testing"
)

// The cases tabstack's own covers runs too (src/background/covers.test.ts),
// so the command line opens a link where the browser would move it.
func TestCovers(t *testing.T) {
	data, err := os.ReadFile("../../testdata/covers.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Pattern string `json:"pattern"`
		URL     string `json:"url"`
		Covers  bool   `json:"covers"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		u, err := url.Parse(tc.URL)
		if err != nil {
			t.Fatal(err)
		}
		if got := covers(tc.Pattern, u); got != tc.Covers {
			t.Errorf("covers(%q, %s) = %v, want %v", tc.Pattern, tc.URL, got, tc.Covers)
		}
	}
}
