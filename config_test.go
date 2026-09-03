package main

import (
	"log/slog"
	"testing"
	"time"
)

func configValues(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestParseRuntimeConfigDefaults(t *testing.T) {
	cfg, err := parseRuntimeConfig(configValues(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != "8080" || cfg.SessionTTL != 2*time.Hour || !cfg.DemoMode || cfg.LogLevel != slog.LevelInfo {
		t.Fatalf("unexpected defaults: %#v", cfg)
	}
	if len(cfg.ICEServers) != 1 || cfg.ICEServers[0].URLs[0] != "stun:global.stun.twilio.com:3478" {
		t.Fatalf("unexpected ICE defaults: %#v", cfg.ICEServers)
	}
}

func TestParseRuntimeConfigOverrides(t *testing.T) {
	cfg, err := parseRuntimeConfig(configValues(map[string]string{
		"PORT":                "9090",
		"SESSION_TTL":         "45m",
		"PUBLIC_BASE_URL":     "https://assist.example.test/",
		"ALLOWED_ORIGINS":     "https://assist.example.test, http://localhost:8080",
		"ICE_SERVERS_JSON":    `[{"urls":"stun:stun.example.test:3478"},{"urls":["turns:turn.example.test:5349"],"username":"demo","credential":"secret"}]`,
		"DEMO_MODE":           "false",
		"LOG_LEVEL":           "debug",
		"BARCODE_SERVICE_URL": "https://barcode.example.test/",
		"BARCODE_API_KEY":     "btk_test_key",
		"WEBMCP_DEBUG":        "true",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != "9090" || cfg.SessionTTL != 45*time.Minute || cfg.DemoMode || cfg.LogLevel != slog.LevelDebug {
		t.Fatalf("unexpected overrides: %#v", cfg)
	}
	if got := cfg.PublicBaseURL.String(); got != "https://assist.example.test" {
		t.Fatalf("public URL = %q", got)
	}
	if len(cfg.AllowedOrigins) != 2 || len(cfg.ICEServers) != 2 {
		t.Fatalf("origins/ICE not parsed: %#v %#v", cfg.AllowedOrigins, cfg.ICEServers)
	}
	if cfg.BarcodeServiceURL != "https://barcode.example.test" {
		t.Fatalf("barcode URL = %q", cfg.BarcodeServiceURL)
	}
	if cfg.BarcodeAPIKey != "btk_test_key" {
		t.Fatalf("barcode API key was not parsed")
	}
	if !cfg.WebMCPDebug {
		t.Fatalf("WebMCP debug flag not parsed: %#v", cfg)
	}
}

func TestParseRuntimeConfigRejectsUnsafeValues(t *testing.T) {
	tests := []map[string]string{
		{"PORT": "0"},
		{"SESSION_TTL": "1m"},
		{"PUBLIC_BASE_URL": "javascript:alert(1)"},
		{"PUBLIC_BASE_URL": "http://assist.example.test"},
		{"ALLOWED_ORIGINS": "https://example.test/path"},
		{"ICE_SERVERS_JSON": `[{"urls":"https://not-ice.example"}]`},
		{"ICE_SERVERS_JSON": `[{"urls":"stun:ok","extra":true}]`},
		{"ICE_SERVERS_JSON": `[{"urls":"stun:"}]`},
		{"ICE_SERVERS_JSON": `[{"urls":"stun:ok"}] true`},
		{"DEMO_MODE": "sometimes"},
		{"LOG_LEVEL": "verbose"},
		{"BARCODE_SERVICE_URL": "http://barcode.example.test"},
		{"BARCODE_API_KEY": "not-a-barcode-key"},
		{"WEBMCP_DEBUG": "sometimes"},
	}
	for _, values := range tests {
		if _, err := parseRuntimeConfig(configValues(values)); err == nil {
			t.Fatalf("expected error for %#v", values)
		}
	}
}

func TestParseRuntimeConfigAllowsLoopbackHTTP(t *testing.T) {
	cfg, err := parseRuntimeConfig(configValues(map[string]string{
		"PUBLIC_BASE_URL":     "http://localhost:8080",
		"BARCODE_SERVICE_URL": "http://127.0.0.1:9090",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicBaseURL.String() != "http://localhost:8080" || cfg.BarcodeServiceURL != "http://127.0.0.1:9090" {
		t.Fatalf("unexpected loopback config: %#v", cfg)
	}
}
