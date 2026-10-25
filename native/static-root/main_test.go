package main

import (
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
)

func fixture(t *testing.T) (string, string, staticFiles) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{root, outside} {
		if err := os.Mkdir(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("inside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "file.txt"), []byte("outside-secret"), 0600); err != nil {
		t.Fatal(err)
	}
	root, _ = filepath.EvalSymlinks(root)
	outside, _ = filepath.EvalSymlinks(outside)
	r, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	return root, outside, staticFiles{r, root}
}
func TestOpenedFileSurvivesReplacement(t *testing.T) {
	root, outside, s := fixture(t)
	f, err := s.open("file.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := os.Rename(filepath.Join(root, "file.txt"), filepath.Join(root, "old")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "file.txt"), filepath.Join(root, "file.txt")); err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(f)
	if err != nil || string(body) != "inside" {
		t.Fatalf("held file changed: %s %v", body, err)
	}
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest("GET", "/file.txt", nil))
	if rr.Code != 403 {
		t.Fatalf("outside leaf status %d", rr.Code)
	}
}
func TestRootAndProjectAnchors(t *testing.T) {
	root, outside, s := fixture(t)
	moved := root + "-held"
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, root); err != nil {
		t.Fatal(err)
	}
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest("GET", "/file.txt", nil))
	if rr.Body.String() != "inside" {
		t.Fatalf("root replacement escaped: %s", rr.Body.String())
	}
	project := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(project, "dist")); err != nil {
		t.Fatal(err)
	}
	if r, err := openStaticRoot(filepath.Join(project, "dist"), project); err == nil {
		r.Close()
		t.Fatal("project escape root accepted")
	}
}
func TestInsideSymlinksAndRegularFiles(t *testing.T) {
	root, _, s := fixture(t)
	for _, target := range []string{"file.txt", filepath.Join(root, "file.txt")} {
		path := filepath.Join(root, "link.txt")
		os.Remove(path)
		if err := os.Symlink(target, path); err != nil {
			t.Fatal(err)
		}
		rr := httptest.NewRecorder()
		s.ServeHTTP(rr, httptest.NewRequest("GET", "/link.txt", nil))
		if rr.Code != 200 || rr.Body.String() != "inside" {
			t.Fatalf("inside link: %d %s", rr.Code, rr.Body.String())
		}
	}
	fifo := filepath.Join(root, "pipe")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest("GET", "/pipe", nil))
	if rr.Code != 403 {
		t.Fatal("non-regular file served")
	}
	for _, path := range []string{"/%2e%2e/outside/file.txt", "/%00", "/%ZZ"} {
		rr := httptest.NewRecorder()
		request := httptest.NewRequest("GET", "/", nil)
		request.RequestURI = path
		s.ServeHTTP(rr, request)
		if rr.Code == 200 {
			t.Fatal("invalid request accepted")
		}
	}
}
func TestConcurrentParentAndIndexReplacementNeverEscapes(t *testing.T) {
	root, outside, s := fixture(t)
	dir := filepath.Join(root, "dir")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(dir, "index.html"), filepath.Join(dir, "file.txt")} {
		if err := os.WriteFile(p, []byte("inside"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(outside, "index.html"), []byte("outside-secret"), 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Go(func() {
		defer close(done)
		for range 1000 {
			if err := os.Rename(dir, dir+"-held"); err != nil {
				t.Error(err)
				return
			}
			if err := os.Symlink(outside, dir); err != nil {
				t.Error(err)
				return
			}
			os.Remove(dir)
			if err := os.Rename(dir+"-held", dir); err != nil {
				t.Error(err)
				return
			}
		}
	})
	count := 0
	for {
		for _, path := range []string{"/dir/", "/dir/file.txt"} {
			rr := httptest.NewRecorder()
			request := httptest.NewRequest("GET", "/", nil)
			request.RequestURI = path
			s.ServeHTTP(rr, request)
			if strings.Contains(rr.Body.String(), "outside-secret") {
				t.Fatal("response escaped root")
			}
			if rr.Code == 200 {
				count++
			}
		}
		select {
		case <-done:
			wg.Wait()
			if count == 0 {
				t.Fatal("race never served inside files")
			}
			return
		default:
		}
	}
}
