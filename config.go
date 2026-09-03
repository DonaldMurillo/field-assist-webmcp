package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultPort                 = "8080"
	defaultBarcodeServiceURL    = "https://barcode.donaldmurillo.com"
	minimumConfiguredSession    = 5 * time.Minute
	maximumConfiguredSession    = 24 * time.Hour
	maximumConfiguredICEServers = 8
)

type stringList []string

func (s *stringList) UnmarshalJSON(data []byte) error {
	var single string
	if err := json.Unmarshal(data, &single); err == nil {
		*s = stringList{single}
		return nil
	}
	var multiple []string
	if err := json.Unmarshal(data, &multiple); err != nil {
		return fmt.Errorf("must be a string or array of strings")
	}
	*s = stringList(multiple)
	return nil
}

type iceServerConfig struct {
	URLs       stringList `json:"urls"`
	Username   string     `json:"username,omitempty"`
	Credential string     `json:"credential,omitempty"`
}

type runtimeConfig struct {
	Port              string
	PublicBaseURL     *url.URL
	AllowedOrigins    []string
	SessionTTL        time.Duration
	ICEServers        []iceServerConfig
	DemoMode          bool
	LogLevel          slog.Level
	BarcodeServiceURL string
	BarcodeAPIKey     string
	WebMCPDebug       bool
}

func loadRuntimeConfig() (runtimeConfig, error) {
	return parseRuntimeConfig(func(key string) string { return strings.TrimSpace(os.Getenv(key)) })
}

func parseRuntimeConfig(value func(string) string) (runtimeConfig, error) {
	cfg := runtimeConfig{
		Port:              defaultPort,
		SessionTTL:        sessionTTL,
		ICEServers:        []iceServerConfig{{URLs: stringList{"stun:global.stun.twilio.com:3478"}}},
		DemoMode:          true,
		LogLevel:          slog.LevelInfo,
		BarcodeServiceURL: defaultBarcodeServiceURL,
	}

	if port := value("PORT"); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return runtimeConfig{}, fmt.Errorf("PORT must be an integer from 1 to 65535")
		}
		cfg.Port = port
	}
	if raw := value("SESSION_TTL"); raw != "" {
		ttl, err := time.ParseDuration(raw)
		if err != nil || ttl < minimumConfiguredSession || ttl > maximumConfiguredSession {
			return runtimeConfig{}, fmt.Errorf("SESSION_TTL must be a duration from %s to %s", minimumConfiguredSession, maximumConfiguredSession)
		}
		cfg.SessionTTL = ttl
	}
	if raw := value("PUBLIC_BASE_URL"); raw != "" {
		parsed, err := parseHTTPOrigin(raw, false)
		if err != nil {
			return runtimeConfig{}, fmt.Errorf("PUBLIC_BASE_URL: %w", err)
		}
		if err := requireHTTPSOutsideLoopback(parsed); err != nil {
			return runtimeConfig{}, fmt.Errorf("PUBLIC_BASE_URL: %w", err)
		}
		cfg.PublicBaseURL = parsed
	}
	if raw := value("ALLOWED_ORIGINS"); raw != "" {
		for _, candidate := range strings.Split(raw, ",") {
			parsed, err := parseHTTPOrigin(strings.TrimSpace(candidate), true)
			if err != nil {
				return runtimeConfig{}, fmt.Errorf("ALLOWED_ORIGINS: %w", err)
			}
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, parsed.String())
		}
	}
	if raw := value("ICE_SERVERS_JSON"); raw != "" {
		servers, err := parseICEServers(raw)
		if err != nil {
			return runtimeConfig{}, fmt.Errorf("ICE_SERVERS_JSON: %w", err)
		}
		cfg.ICEServers = servers
	}
	if raw := value("DEMO_MODE"); raw != "" {
		enabled, err := strconv.ParseBool(raw)
		if err != nil {
			return runtimeConfig{}, fmt.Errorf("DEMO_MODE must be true or false")
		}
		cfg.DemoMode = enabled
	}
	if raw := value("LOG_LEVEL"); raw != "" {
		var level slog.Level
		if err := level.UnmarshalText([]byte(raw)); err != nil {
			return runtimeConfig{}, fmt.Errorf("LOG_LEVEL must be debug, info, warn, or error")
		}
		cfg.LogLevel = level
	}
	if raw := value("BARCODE_SERVICE_URL"); raw != "" {
		parsed, err := parseHTTPOrigin(raw, false)
		if err != nil {
			return runtimeConfig{}, fmt.Errorf("BARCODE_SERVICE_URL: %w", err)
		}
		if err := requireHTTPSOutsideLoopback(parsed); err != nil {
			return runtimeConfig{}, fmt.Errorf("BARCODE_SERVICE_URL: %w", err)
		}
		cfg.BarcodeServiceURL = strings.TrimRight(parsed.String(), "/")
	}
	if raw := value("BARCODE_API_KEY"); raw != "" {
		if len(raw) <= len("btk_") || len(raw) > 512 || !strings.HasPrefix(raw, "btk_") {
			return runtimeConfig{}, fmt.Errorf("BARCODE_API_KEY must be a registered barcode key beginning with btk_")
		}
		cfg.BarcodeAPIKey = raw
	}
	if raw := value("WEBMCP_DEBUG"); raw != "" {
		enabled, err := strconv.ParseBool(raw)
		if err != nil {
			return runtimeConfig{}, fmt.Errorf("WEBMCP_DEBUG must be true or false")
		}
		cfg.WebMCPDebug = enabled
	}
	return cfg, nil
}

func requireHTTPSOutsideLoopback(parsed *url.URL) error {
	if parsed == nil {
		return fmt.Errorf("must be an absolute URL")
	}
	if strings.EqualFold(parsed.Scheme, "https") {
		return nil
	}
	host := strings.Trim(strings.ToLower(parsed.Hostname()), "[]")
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	return fmt.Errorf("must use https outside loopback development")
}

func parseHTTPOrigin(raw string, requireNoPath bool) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil {
		return nil, fmt.Errorf("must be an absolute http or https URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("must use http or https")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("must not contain a query or fragment")
	}
	if requireNoPath && parsed.Path != "" && parsed.Path != "/" {
		return nil, fmt.Errorf("origin %q must not contain a path", raw)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed, nil
}

func parseICEServers(raw string) ([]iceServerConfig, error) {
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.DisallowUnknownFields()
	var servers []iceServerConfig
	if err := decoder.Decode(&servers); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("must contain exactly one JSON value")
	}
	if len(servers) == 0 || len(servers) > maximumConfiguredICEServers {
		return nil, fmt.Errorf("must contain 1 to %d servers", maximumConfiguredICEServers)
	}
	for i := range servers {
		if len(servers[i].URLs) == 0 || len(servers[i].URLs) > 8 {
			return nil, fmt.Errorf("server %d must contain 1 to 8 URLs", i)
		}
		for j, rawURL := range servers[i].URLs {
			rawURL = strings.TrimSpace(rawURL)
			if len(rawURL) > 2048 || !validICEURL(rawURL) {
				return nil, fmt.Errorf("server %d URL %d must use stun, stuns, turn, or turns", i, j)
			}
			servers[i].URLs[j] = rawURL
		}
		if len(servers[i].Username) > 512 || len(servers[i].Credential) > 2048 {
			return nil, fmt.Errorf("server %d credentials are too long", i)
		}
	}
	return servers, nil
}

func validICEURL(raw string) bool {
	lower := strings.ToLower(raw)
	for _, scheme := range []string{"stun:", "stuns:", "turn:", "turns:"} {
		if strings.HasPrefix(lower, scheme) {
			return len(strings.TrimSpace(raw[len(scheme):])) > 0
		}
	}
	return false
}
