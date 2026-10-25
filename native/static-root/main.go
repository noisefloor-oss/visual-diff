// The helper owns only loopback HTTP and anchored static reads. It never
// accepts a host path from an HTTP client or opens a response by pathname.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type staticFiles struct {
	root      *os.Root
	canonical string
}

// absolute in-root symlinks are supported by translating their resolved target
// back to a relative name. The final open still goes through the held root;
// changing any component between resolution and open cannot escape it.
func (s staticFiles) open(name string) (*os.File, error) {
	f, err := s.root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err == nil {
		return f, nil
	}
	real, resolveErr := filepath.EvalSymlinks(filepath.Join(s.canonical, name))
	if resolveErr != nil {
		if errors.Is(resolveErr, os.ErrNotExist) {
			return nil, resolveErr
		}
		return nil, err
	}
	rel, relErr := filepath.Rel(s.canonical, real)
	if relErr != nil || !filepath.IsLocal(rel) {
		return nil, os.ErrPermission
	}
	return s.root.OpenFile(rel, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}

var contentTypes = map[string]string{
	".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain",
}

func (s staticFiles) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(405)
		return
	}
	name, err := url.PathUnescape(strings.SplitN(r.RequestURI, "?", 2)[0])
	if err != nil {
		http.Error(w, "bad request", 400)
		return
	}
	name = strings.TrimLeft(name, "/")
	if name == "" {
		name = "index.html"
	}
	if !filepath.IsLocal(name) || strings.IndexByte(name, 0) >= 0 {
		http.Error(w, "forbidden", 403)
		return
	}
	f, err := s.open(name)
	if err != nil {
		serveError(w, err)
		return
	}
	defer func() { f.Close() }()
	st, err := f.Stat()
	if err != nil {
		serveError(w, err)
		return
	}
	if st.IsDir() {
		f.Close()
		name = filepath.Join(name, "index.html")
		f, err = s.open(name)
		if err != nil {
			serveError(w, err)
			return
		}
		st, err = f.Stat()
		if err != nil {
			serveError(w, err)
			return
		}
	}
	if !st.Mode().IsRegular() {
		http.Error(w, "forbidden", 403)
		return
	}
	kind := contentTypes[strings.ToLower(filepath.Ext(name))]
	if kind == "" {
		kind = "application/octet-stream"
	}
	w.Header().Set("Content-Type", kind)
	http.ServeContent(w, r, name, st.ModTime(), f)
}
func serveError(w http.ResponseWriter, err error) {
	code := 403
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		code = 404
	}
	http.Error(w, http.StatusText(code), code)
}
func openStaticRoot(root, project string) (*os.Root, error) {
	if project == "" {
		return os.OpenRoot(root)
	}
	p, err := os.OpenRoot(project)
	if err != nil {
		return nil, err
	}
	defer p.Close()
	rel, err := filepath.Rel(project, root)
	if err != nil || !filepath.IsLocal(rel) {
		return nil, os.ErrPermission
	}
	return p.OpenRoot(rel)
}
func run() error {
	if len(os.Args) != 3 {
		return errors.New("static-root requires root and project arguments")
	}
	root, err := openStaticRoot(os.Args[1], os.Args[2])
	if err != nil {
		return err
	}
	defer root.Close()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	server := &http.Server{Handler: staticFiles{root, os.Args[1]}, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 15 * time.Second}
	done := make(chan error, 1)
	go func() { done <- server.Serve(ln) }()
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Port int `json:"port"`
	}{ln.Addr().(*net.TCPAddr).Port}); err != nil {
		server.Close()
		return err
	}
	// The parent alone owns this pipe. EOF also follows an abrupt parent exit.
	_, _ = io.Copy(io.Discard, os.Stdin)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		server.Close()
	}
	err = <-done
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "static-root:", err)
		os.Exit(1)
	}
}
