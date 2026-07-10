package main

import "fmt"

func main() {
	views := Tally(nil, "home")
	fmt.Println("home views:", views["home"])
}
