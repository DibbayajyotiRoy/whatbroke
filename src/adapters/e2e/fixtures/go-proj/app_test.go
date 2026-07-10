package main

import "testing"

// The broken Tally panics (nil-map write), which aborts the test binary — a
// real crash, not a plain t.Errorf assertion failure (those never panic and
// the go grammar has no assertion-report parser; see docs/adding-a-language.md).
func TestTallyFirstView(t *testing.T) {
	got := Tally(nil, "home")
	if got["home"] != 1 {
		t.Fatalf("home views = %d, want 1", got["home"])
	}
}
