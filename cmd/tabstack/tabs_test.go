package main

import (
	"net/url"
	"testing"
)

// The same cases as the patterns tabstack's settings describe.
func TestCovers(t *testing.T) {
	cases := []struct {
		pattern, link string
		want          bool
	}{
		{"corp.com", "https://corp.com/x", true},
		{"corp.com", "https://www.corp.com/", true},
		{"corp.com", "https://mail.corp.com/", false},
		{"*.corp.com", "https://mail.corp.com/", true},
		{"*.corp.com", "https://corp.com/", true},
		{"https://corp.com/", "http://corp.com/a", true},
		{"github.com/acme", "https://github.com/acme", true},
		{"github.com/acme", "https://github.com/acme/repo/issues", true},
		{"github.com/acme", "https://github.com/acmecorp", false},
		{"github.com/acme/*", "https://github.com/acme/repo", true},
		{"github.com/g*", "https://github.com/grindlemire/tabstack", true},
		{"github.com/g*", "https://github.com/acme", false},
		{"github.com/*/issues", "https://github.com/acme/issues/4", true},
		{"github.com/*/issues", "https://github.com/acme/pulls", false},
		{"GitHub.com/Acme", "https://github.com/acme", true},
		{"localhost:3000", "http://localhost:3000/", true},
		{"localhost:3000", "http://localhost:8080/", false},
		{"localhost", "http://localhost:8080/", true},
		{"", "https://corp.com/", false},
	}
	for _, tc := range cases {
		u, err := url.Parse(tc.link)
		if err != nil {
			t.Fatal(err)
		}
		if got := covers(tc.pattern, u); got != tc.want {
			t.Errorf("covers(%q, %s) = %v, want %v", tc.pattern, tc.link, got, tc.want)
		}
	}
}
