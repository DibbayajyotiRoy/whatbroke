// Package main implements a tiny page-view tally service.
package main

// Tally increments key in counts, allocating the map on first use.
func Tally(counts map[string]int, key string) map[string]int {
	if counts == nil {
		counts = make(map[string]int)
	}
	counts[key]++
	return counts
}
