package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestToolOutcomeLoggingRecordsStatusWithoutRequestPayload(t *testing.T) {
	store := NewSessionStore(time.Hour)
	defer store.StopAll()
	session, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	service := &service{
		sessions: store,
		logger:   func() *slog.Logger { return logger },
	}
	secret := "SECRET-SDP-AND-TURN-CREDENTIAL"
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != secret {
			t.Fatalf("body = %q", body)
		}
		http.Error(w, "validation failed", http.StatusUnprocessableEntity)
	})
	request := httptest.NewRequest(http.MethodPost, "https://assist.example.test/api/tools/inspect-scene", strings.NewReader(secret))
	request.Header.Set("X-Gofastr-WebMCP", "1")
	request.AddCookie(&http.Cookie{Name: supportCookieName, Value: session.ID + "." + session.SupportToken})
	response := httptest.NewRecorder()
	service.observeToolOutcome("inspect_scene", next).ServeHTTP(response, request)

	logs := output.String()
	for _, expected := range []string{
		`"msg":"tool.invoked"`,
		`"msg":"tool.completed"`,
		`"session_id":"` + session.ID + `"`,
		`"tool":"inspect_scene"`,
		`"source":"webmcp"`,
		`"outcome":"failed"`,
		`"http_status":422`,
	} {
		if !strings.Contains(logs, expected) {
			t.Fatalf("logs missing %q: %s", expected, logs)
		}
	}
	for _, forbidden := range []string{secret, session.SupportToken, "validation failed"} {
		if strings.Contains(logs, forbidden) {
			t.Fatalf("logs leaked %q: %s", forbidden, logs)
		}
	}
}

func TestSafeWebRTCLogMetadataAllowlistsValues(t *testing.T) {
	payload := json.RawMessage(`{"candidate":{"candidate":"candidate:1 1 udp 1 192.0.2.10 54321 typ relay raddr DO-NOT-LOG"}}`)
	if got := safeICECandidateType(payload); got != "relay" {
		t.Fatalf("candidate type = %q", got)
	}
	if got := safeICECandidateType(json.RawMessage(`{"candidate":{"candidate":"SECRET typ invented"}}`)); got != "unknown" {
		t.Fatalf("invented candidate type = %q", got)
	}
	connection, ice := safeWebRTCStates(json.RawMessage(`{"connectionState":"connected","iceConnectionState":"completed","credential":"DO-NOT-LOG"}`))
	if connection != "connected" || ice != "completed" {
		t.Fatalf("states = %q %q", connection, ice)
	}
	connection, ice = safeWebRTCStates(json.RawMessage(`{"connectionState":"SECRET","iceConnectionState":42}`))
	if connection != "unknown" || ice != "unknown" {
		t.Fatalf("unsafe states = %q %q", connection, ice)
	}
	pair := safeCandidatePair(json.RawMessage(`{"candidatePair":{"localType":"host","remoteType":"relay","protocol":"udp","address":"192.0.2.10","credential":"DO-NOT-LOG"}}`))
	if pair == nil || pair.LocalType != "host" || pair.RemoteType != "relay" || pair.Protocol != "udp" || !pair.Relay {
		t.Fatalf("candidate pair = %#v", pair)
	}
	pair = safeCandidatePair(json.RawMessage(`{"candidatePair":{"localType":"SECRET","remoteType":"invented","protocol":"QUIC"}}`))
	if pair == nil || pair.LocalType != "unknown" || pair.RemoteType != "unknown" || pair.Protocol != "unknown" || pair.Relay {
		t.Fatalf("unsafe candidate pair = %#v", pair)
	}
}

func TestOperatorQRCodeUsesPublicBaseURLAndBarcodeAPI(t *testing.T) {
	var generated map[string]any
	requests := 0
	barcode := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Path != "/api/generate" {
			t.Fatalf("barcode request = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "" {
			t.Fatal("anonymous barcode request unexpectedly included authorization")
		}
		if err := json.NewDecoder(r.Body).Decode(&generated); err != nil {
			t.Fatalf("decode barcode request: %v", err)
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("test-png"))
	}))
	defer barcode.Close()

	store := NewSessionStore(time.Hour)
	defer store.StopAll()
	session, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	publicURL, _ := url.Parse("https://assist.example.test/base")
	service := &service{
		sessions:       store,
		barcodeBaseURL: barcode.URL,
		barcodeClient:  barcode.Client(),
		publicBaseURL:  publicURL,
	}

	request := httptest.NewRequest(http.MethodGet, "http://internal/api/session/operator-qr", nil)
	request.AddCookie(&http.Cookie{Name: supportCookieName, Value: session.ID + "." + session.SupportToken})
	response := httptest.NewRecorder()
	service.operatorQRCode(response, request)

	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("QR response = %d %q: %s", response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
	if response.Body.String() != "test-png" || response.Header().Get("Cache-Control") != "private, no-store, max-age=0" {
		t.Fatalf("unexpected QR response headers/body: %#v %q", response.Header(), response.Body.String())
	}
	data, _ := generated["data"].(string)
	if !strings.HasPrefix(data, "https://assist.example.test/base/session/") || !strings.Contains(data, "/operator?token=") {
		t.Fatalf("generated QR URL did not use PUBLIC_BASE_URL: %q", data)
	}
	if generated["type"] != "qr" || generated["format"] != "png" || generated["size"] != "320" {
		t.Fatalf("unexpected barcode payload: %#v", generated)
	}

	cachedResponse := httptest.NewRecorder()
	service.operatorQRCode(cachedResponse, request)
	if cachedResponse.Code != http.StatusOK || cachedResponse.Body.String() != "test-png" {
		t.Fatalf("cached QR response = %d: %q", cachedResponse.Code, cachedResponse.Body.String())
	}
	if requests != 1 {
		t.Fatalf("barcode requests = %d, want one generation per session", requests)
	}
}

func TestOperatorQRCodeUsesAuthenticatedBarcodeAPIWhenConfigured(t *testing.T) {
	const apiKey = "btk_test_secret"
	requests := 0
	barcode := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/generate" {
			t.Fatalf("barcode request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+apiKey {
			t.Fatalf("barcode authorization header was not configured")
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("keyed-png"))
	}))
	defer barcode.Close()

	store := NewSessionStore(time.Hour)
	defer store.StopAll()
	session, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	service := &service{
		sessions:       store,
		barcodeBaseURL: barcode.URL,
		barcodeAPIKey:  apiKey,
		barcodeClient:  barcode.Client(),
	}
	request := httptest.NewRequest(http.MethodGet, "/api/session/operator-qr", nil)
	request.AddCookie(&http.Cookie{Name: supportCookieName, Value: session.ID + "." + session.SupportToken})
	response := httptest.NewRecorder()
	service.operatorQRCode(response, request)

	if response.Code != http.StatusOK || response.Body.String() != "keyed-png" {
		t.Fatalf("keyed QR response = %d: %q", response.Code, response.Body.String())
	}
	if requests != 1 {
		t.Fatalf("keyed barcode requests = %d, want 1", requests)
	}
}

func TestOperatorQRCodeRetriesAfterUpstreamRateLimit(t *testing.T) {
	requests := 0
	barcode := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			w.Header().Set("Retry-After", "2")
			w.Header().Set("X-RateLimit-Reset", "1788149100")
			http.Error(w, "busy", http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("recovered-png"))
	}))
	defer barcode.Close()

	store := NewSessionStore(time.Hour)
	defer store.StopAll()
	session, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	service := &service{sessions: store, barcodeBaseURL: barcode.URL, barcodeClient: barcode.Client()}
	request := httptest.NewRequest(http.MethodGet, "/api/session/operator-qr", nil)
	request.AddCookie(&http.Cookie{Name: supportCookieName, Value: session.ID + "." + session.SupportToken})

	rateLimited := httptest.NewRecorder()
	service.operatorQRCode(rateLimited, request)
	if rateLimited.Code != http.StatusTooManyRequests || rateLimited.Header().Get("Retry-After") != "2" || rateLimited.Header().Get("X-RateLimit-Reset") != "1788149100" {
		t.Fatalf("rate-limited QR response = %d retry-after=%q reset=%q", rateLimited.Code, rateLimited.Header().Get("Retry-After"), rateLimited.Header().Get("X-RateLimit-Reset"))
	}

	recovered := httptest.NewRecorder()
	service.operatorQRCode(recovered, request)
	if recovered.Code != http.StatusOK || recovered.Body.String() != "recovered-png" {
		t.Fatalf("recovered QR response = %d: %q", recovered.Code, recovered.Body.String())
	}
	if requests != 2 {
		t.Fatalf("barcode requests = %d, want failed generation to remain retryable", requests)
	}
}

func TestOperatorQRCodeRequiresSupportSession(t *testing.T) {
	service := &service{sessions: NewSessionStore(time.Hour)}
	defer service.sessions.StopAll()
	request := httptest.NewRequest(http.MethodGet, "/api/session/operator-qr", nil)
	response := httptest.NewRecorder()
	service.noStoreAuthenticated(http.HandlerFunc(service.operatorQRCode)).ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		body, _ := io.ReadAll(response.Result().Body)
		t.Fatalf("status = %d, want 401: %s", response.Code, body)
	}
	if cacheControl := response.Header().Get("Cache-Control"); !strings.Contains(cacheControl, "private") || !strings.Contains(cacheControl, "no-store") {
		t.Fatalf("cache-control = %q, want private no-store", cacheControl)
	}
	if vary := response.Header().Values("Vary"); !strings.Contains(strings.Join(vary, ", "), "Cookie") {
		t.Fatalf("vary = %#v, want Cookie", vary)
	}
}

func TestOperatorQRCodeExpiresWithJoinToken(t *testing.T) {
	store := NewSessionStore(time.Hour)
	defer store.StopAll()
	session, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	service := &service{sessions: store}
	request := httptest.NewRequest(http.MethodGet, "/api/session/operator-qr", nil)
	request.AddCookie(&http.Cookie{Name: supportCookieName, Value: session.ID + "." + session.SupportToken})

	session.mu.Lock()
	session.operatorJoinExpiresAt = time.Now().UTC().Add(-time.Second)
	session.mu.Unlock()
	response := httptest.NewRecorder()
	service.operatorQRCode(response, request)
	if response.Code != http.StatusGone {
		t.Fatalf("status = %d, want 410", response.Code)
	}
}

func TestWebSocketOriginAllowsSameOriginAndConfiguredOrigin(t *testing.T) {
	service := &service{allowedOrigins: allowedOriginSet([]string{"https://browser.example.test"})}

	same := httptest.NewRequest(http.MethodGet, "https://assist.example.test/ws", nil)
	same.Host = "assist.example.test"
	same.Header.Set("Origin", "https://assist.example.test")
	if !service.websocketOriginAllowed(same) {
		t.Fatal("same-origin WebSocket was rejected")
	}

	configured := httptest.NewRequest(http.MethodGet, "https://assist.example.test/ws", nil)
	configured.Header.Set("Origin", "https://browser.example.test")
	if !service.websocketOriginAllowed(configured) {
		t.Fatal("configured WebSocket origin was rejected")
	}

	rejected := httptest.NewRequest(http.MethodGet, "https://assist.example.test/ws", nil)
	rejected.Header.Set("Origin", "https://attacker.example.test")
	if service.websocketOriginAllowed(rejected) {
		t.Fatal("unconfigured cross-origin WebSocket was accepted")
	}
}

func TestMutationOriginGuard(t *testing.T) {
	service := &service{}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	guarded := service.requireSameOriginMutation(next)

	tests := []struct {
		name   string
		origin string
		status int
	}{
		{name: "same origin", origin: "https://assist.example.test", status: http.StatusNoContent},
		{name: "cross origin", origin: "https://attacker.example.test", status: http.StatusForbidden},
		{name: "missing origin", status: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "https://assist.example.test/api/action", nil)
			request.Host = "assist.example.test"
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			response := httptest.NewRecorder()
			guarded.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
		})
	}
}

func TestWebMCPAssetsRequireSupportSessionAndDisableSharedCaching(t *testing.T) {
	store := NewSessionStore(time.Hour)
	defer store.StopAll()
	session, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	service := &service{sessions: store}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.WriteHeader(http.StatusNoContent)
	})
	guarded := service.sessionPageAuth(next)

	for _, path := range []string{"/__gofastr/webmcp.js", "/__gofastr/webmcp/tools.json"} {
		t.Run(path+" anonymous", func(t *testing.T) {
			response := httptest.NewRecorder()
			guarded.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", response.Code)
			}
		})

		t.Run(path+" operator", func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request.AddCookie(&http.Cookie{Name: operatorCookieName, Value: session.ID + "." + session.OperatorToken})
			response := httptest.NewRecorder()
			guarded.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", response.Code)
			}
		})

		t.Run(path+" support", func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request.AddCookie(&http.Cookie{Name: supportCookieName, Value: session.ID + "." + session.SupportToken})
			response := httptest.NewRecorder()
			guarded.ServeHTTP(response, request)
			if response.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want 204", response.Code)
			}
			cacheControl := response.Header().Get("Cache-Control")
			if !strings.Contains(cacheControl, "private") || !strings.Contains(cacheControl, "no-store") {
				t.Fatalf("Cache-Control = %q, want private no-store", cacheControl)
			}
			if !strings.Contains(response.Header().Get("Vary"), "Cookie") {
				t.Fatalf("Vary = %q, want Cookie", response.Header().Get("Vary"))
			}
		})
	}
}

func TestSceneTrackingHandlerPreservesFourPointGeometryAndRejectsMalformedQuad(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()
	guidance, err := session.HighlightObject("wan-port", "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	var bounds Bounds
	for _, object := range session.Scene().Objects {
		if object.ID == "wan-port" {
			bounds = object.Bounds
			break
		}
	}
	base := sceneTrackingInput{
		GuidanceID: guidance.ID, ObjectID: "wan-port", BaseSceneVersion: session.Scene().Version,
		Status: SceneTrackingLocked, Confidence: 0.9, Bounds: bounds, Source: "opencv-homography",
	}
	base.Quad = []Point{{X: bounds.X, Y: bounds.Y}, {X: bounds.X + bounds.Width, Y: bounds.Y}, {X: bounds.X + bounds.Width, Y: bounds.Y + bounds.Height}}
	if _, err := (&service{}).recordSceneTrackingForSession(base, session, "support"); err == nil {
		t.Fatal("three-point tracking quad unexpectedly succeeded")
	}
	base.Quad = append(base.Quad, Point{X: bounds.X, Y: bounds.Y + bounds.Height})
	base.Anchor = &Point{X: bounds.X + bounds.Width/2, Y: bounds.Y + bounds.Height}
	response, err := (&service{}).recordSceneTrackingForSession(base, session, "support")
	if err != nil {
		t.Fatal(err)
	}
	if !response.Recorded || response.Tracking.Quad == nil || response.Tracking.Anchor == nil || len(*response.Tracking.Quad) != 4 {
		t.Fatalf("tracking geometry was not preserved: %#v", response.Tracking)
	}
	base.Source = "opencv-pnp+depth-anything"
	base.DepthSource = "depth-anything-v2-small-int8"
	base.DepthScore = 0.61
	base.DepthConfidence = 0.84
	base.ModelRelativeDepth = 0.92
	response, err = (&service{}).recordSceneTrackingForSession(base, session, "support")
	if err != nil || !response.Recorded || response.Tracking.Source != "opencv-pnp+depth-anything" || response.Tracking.ScaleSource != "pnp-world-relative" {
		t.Fatalf("PnP tracking response=%#v err=%v", response, err)
	}
	pnpTracking := response.Tracking
	base.Source = "opencv-homography"
	base.DepthSource = ""
	base.DepthScore = 0
	base.DepthConfidence = 0
	base.ModelRelativeDepth = 0
	base.PartialVisibility = true
	base.VisibleFraction = 0.10 / bounds.Width
	base.Bounds = Bounds{X: 0.90, Y: bounds.Y, Width: 0.10, Height: bounds.Height}
	base.Quad = []Point{
		{X: 0.90, Y: bounds.Y},
		{X: 0.90 + bounds.Width, Y: bounds.Y},
		{X: 0.90 + bounds.Width, Y: bounds.Y + bounds.Height},
		{X: 0.90, Y: bounds.Y + bounds.Height},
	}
	base.Anchor = &Point{X: 0.985, Y: bounds.Y + bounds.Height}
	response, err = (&service{}).recordSceneTrackingForSession(base, session, "support")
	if err != nil || response.Recorded || response.Tracking.Source != pnpTracking.Source || response.Tracking.Anchor == nil {
		t.Fatalf("fresh PnP authority was overwritten: response=%#v err=%v", response, err)
	}
	session.mu.Lock()
	session.sceneTracking.UpdatedAt = time.Now().Add(-4 * time.Second)
	session.mu.Unlock()
	response, err = (&service{}).recordSceneTrackingForSession(base, session, "support")
	if err != nil || !response.Recorded || !response.Tracking.PartialVisibility || response.Tracking.Quad == nil || response.Tracking.Quad[1].X <= 1 {
		t.Fatalf("partial tracking response=%#v err=%v", response, err)
	}
}
