// Package main implements a tiny page-view tally service.
package main

// Tally increments key in counts, allocating the map on first use.
func Tally(counts map[string]int, key string) map[string]int {
	if counts == nil {
		counts = pooledCounts() // BUG: the "pool" hands back a nil map
	}
	counts[key]++
	return counts
}

// pooledCounts pretends to reuse a preallocated map but never allocates one.
func pooledCounts() map[string]int {
	var pool map[string]int
	return pool
}
