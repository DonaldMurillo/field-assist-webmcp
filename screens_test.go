package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPublicEntryAndErrorScreens(t *testing.T) {
	cfg, err := parseRuntimeConfig(configValues(nil))
	if err != nil {
		t.Fatal(err)
	}
	app, err := newApplicationWithConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.Router())
	defer server.Close()

	tests := []struct {
		name         string
		path         string
		wantStatus   int
		wantMarker   string
		wantNoStore  bool
		wantCreateUI bool
	}{
		{name: "new session", path: "/new", wantStatus: http.StatusOK, wantMarker: `id="new-session-app"`, wantCreateUI: true},
		{name: "technology stack", path: "/stack", wantStatus: http.StatusOK, wantMarker: `id="stack-app"`},
		{name: "WebMCP tool catalog", path: "/tools", wantStatus: http.StatusOK, wantMarker: `id="tools-app"`},
		{name: "missing session", path: "/session/missing", wantStatus: http.StatusNotFound, wantMarker: `id="session-unavailable-app"`, wantNoStore: true, wantCreateUI: true},
		{name: "unknown route", path: "/definitely-not-a-route", wantStatus: http.StatusNotFound, wantMarker: `id="not-found-app"`, wantCreateUI: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response, err := server.Client().Get(server.URL + test.path)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			page := string(body)
			if response.StatusCode != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.StatusCode, test.wantStatus, page)
			}
			if !strings.Contains(page, test.wantMarker) {
				t.Fatalf("body does not contain %q", test.wantMarker)
			}
			if test.wantCreateUI && !strings.Contains(page, `id="create-session-form"`) {
				t.Fatal("page does not contain the create-session form")
			}
			if strings.Contains(page, `/__gofastr/webmcp.js`) {
				t.Fatal("public entry/error page must not load the authenticated WebMCP bridge")
			}
			if test.wantNoStore {
				cacheControl := response.Header.Get("Cache-Control")
				if !strings.Contains(cacheControl, "private") || !strings.Contains(cacheControl, "no-store") {
					t.Fatalf("Cache-Control = %q, want private no-store", cacheControl)
				}
				vary := response.Header.Values("Vary")
				if !strings.Contains(strings.Join(vary, ","), "Cookie") || !strings.Contains(strings.Join(vary, ","), "Accept") {
					t.Fatalf("Vary = %q, want Cookie and Accept", vary)
				}
			}
		})
	}
}

func TestNotFoundNegotiatesProblemJSON(t *testing.T) {
	cfg, err := parseRuntimeConfig(configValues(nil))
	if err != nil {
		t.Fatal(err)
	}
	app, err := newApplicationWithConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.Router())
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet, server.URL+"/not-here", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept", "application/problem+json")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); !strings.Contains(got, "application/problem+json") {
		t.Fatalf("Content-Type = %q, want application/problem+json", got)
	}
}

func TestAgentReadyDiscoverySurface(t *testing.T) {
	cfg, err := parseRuntimeConfig(configValues(map[string]string{
		"PUBLIC_BASE_URL": "https://assist.example.test",
	}))
	if err != nil {
		t.Fatal(err)
	}
	app, err := newApplicationWithConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.Router())
	defer server.Close()

	tests := []struct {
		path        string
		contentType string
		contains    []string
	}{
		{path: "/llms.txt", contentType: "text/plain", contains: []string{"# Field Assist", "/llms-full.txt", "/stack/llm.md", "/tools/llm.md", "/llm-pages.md"}},
		{path: "/llms-full.txt", contentType: "text/plain", contains: []string{"# Field Assist: full agent guide", "Codex is the only agent", "private VPS infrastructure"}},
		{path: "/llm-pages.md", contentType: "text/markdown", contains: []string{"Technology stack", "/stack/llm.md", "WebMCP tool catalog", "/tools/llm.md"}},
		{path: "/stack/llm.md", contentType: "text/markdown", contains: []string{"Technology stack", "GoFastr WebMCP", "VPS hosting"}},
		{path: "/tools/llm.md", contentType: "text/markdown", contains: []string{"WebMCP tool catalog", "inspect_scene", "send_operator_instruction", "suggest_next_step"}},
		{path: "/.well-known/agent-card.json", contentType: "application/json", contains: []string{"Field Assist", "inspect-scene", "spatial-guidance"}},
		{path: "/.well-known/agent.json", contentType: "application/json", contains: []string{"Field Assist", "case-reasoning"}},
		{path: "/sitemap.xml", contentType: "application/xml", contains: []string{"https://assist.example.test/stack", "https://assist.example.test/tools", "https://assist.example.test/new"}},
		{path: "/robots.txt", contentType: "text/plain", contains: []string{"Disallow: /session/", "Sitemap: https://assist.example.test/sitemap.xml", "Content-Signal: ai-train=no, search=yes, ai-input=yes"}},
	}

	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			response, err := server.Client().Get(server.URL + test.path)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", response.StatusCode, body)
			}
			if got := response.Header.Get("Content-Type"); !strings.Contains(got, test.contentType) {
				t.Fatalf("Content-Type = %q, want %q", got, test.contentType)
			}
			for _, want := range test.contains {
				if !strings.Contains(string(body), want) {
					t.Errorf("body does not contain %q", want)
				}
			}
			if strings.Contains(test.path, "sitemap") && strings.Contains(string(body), "/session/") {
				t.Fatal("sitemap must not publish private session routes")
			}
		})
	}

	request, err := http.NewRequest(http.MethodGet, server.URL+"/stack", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept", "text/markdown")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(response.Header.Get("Content-Type"), "text/markdown") {
		t.Fatalf("markdown negotiation status/content-type = %d/%q", response.StatusCode, response.Header.Get("Content-Type"))
	}

	htmlResponse, err := server.Client().Get(server.URL + "/stack")
	if err != nil {
		t.Fatal(err)
	}
	defer htmlResponse.Body.Close()
	if links := strings.Join(htmlResponse.Header.Values("Link"), ","); !strings.Contains(links, "/llms.txt") || !strings.Contains(links, "/sitemap.xml") {
		t.Fatalf("Link headers = %q, want llms.txt and sitemap.xml discovery", links)
	}
}
