package main

import (
	"fmt"
	"net/http"

	"example.com/goapp/internal/store"
	"github.com/gorilla/mux"
)

func main() { fmt.Println(store.New(), mux.NewRouter(), http.StatusOK) }
