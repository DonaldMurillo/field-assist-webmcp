package main

import (
	_ "embed"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/DonaldMurillo/gofastr/framework"
	"github.com/DonaldMurillo/gofastr/framework/pluginhost"
	"github.com/DonaldMurillo/gofastr/framework/uihost"
)

// Field Assist follows the trusted host-page plugin pattern used by the
// released gofastr-plugins tour and geomap packages. Camera capture, WebRTC,
// and overlays must run in the host document, so an opaque iframe would be the
// wrong isolation boundary; GoFastr still owns registration and same-origin
// delivery of the app assets and the narrow, pinned perception artifact proxy.
const (
	fieldAssistPluginName      = "field-assist-browser"
	fieldAssistRoute           = "/__gofastr/plugin/field-assist"
	fieldAssistPerceptionJSURL = fieldAssistRoute + "/perception.js"
	fieldAssistOpenCVWorkerURL = fieldAssistRoute + "/opencv-worker.js"
	fieldAssistDepthWorkerURL  = fieldAssistRoute + "/depth-worker.js"
	fieldAssistJSURL           = fieldAssistRoute + "/app.js"
	fieldAssistCSSURL          = fieldAssistRoute + "/app.css"
	fieldAssistManifestURL     = fieldAssistRoute + "/manifest.webmanifest"
	fieldAssistIconURL         = fieldAssistRoute + "/icon.svg"
	fieldAssistIcon192URL      = fieldAssistRoute + "/icon-192.png"
	fieldAssistIcon512URL      = fieldAssistRoute + "/icon-512.png"
	fieldAssistAppleIconURL    = fieldAssistRoute + "/apple-touch-icon.png"
)

//go:embed web/static/app.js
var fieldAssistJS []byte

//go:embed web/static/perception.js
var fieldAssistPerceptionJS []byte

//go:embed web/static/opencv-worker.js
var fieldAssistOpenCVWorkerJS []byte

//go:embed web/static/depth-worker.js
var fieldAssistDepthWorkerJS []byte

//go:embed web/static/app.css
var fieldAssistCSS []byte

//go:embed web/static/manifest.webmanifest
var fieldAssistManifest []byte

//go:embed web/static/icon.svg
var fieldAssistIcon []byte

//go:embed web/static/icon-192.png
var fieldAssistIcon192 []byte

//go:embed web/static/icon-512.png
var fieldAssistIcon512 []byte

//go:embed web/static/apple-touch-icon.png
var fieldAssistAppleIcon []byte

type fieldAssistPlugin struct{}

func (*fieldAssistPlugin) Name() string { return fieldAssistPluginName }

func (*fieldAssistPlugin) Init(app *framework.App) error {
	assets := pluginhost.NewAssetServer(nil, fieldAssistRoute, nil)
	assets.AddBytes(fieldAssistPerceptionJSURL, "text/javascript; charset=utf-8", false, fieldAssistPerceptionJS)
	assets.AddBytes(fieldAssistJSURL, "text/javascript; charset=utf-8", false, fieldAssistJS)
	assets.AddBytes(fieldAssistCSSURL, "text/css; charset=utf-8", false, fieldAssistCSS)
	assets.AddBytes(fieldAssistManifestURL, "application/manifest+json; charset=utf-8", false, fieldAssistManifest)
	assets.AddBytes(fieldAssistIconURL, "image/svg+xml; charset=utf-8", false, fieldAssistIcon)
	assets.AddBytes(fieldAssistIcon192URL, "image/png", false, fieldAssistIcon192)
	assets.AddBytes(fieldAssistIcon512URL, "image/png", false, fieldAssistIcon512)
	assets.AddBytes(fieldAssistAppleIconURL, "image/png", false, fieldAssistAppleIcon)
	assets.Register(app.Router())
	registerPerceptionWorkers(app)
	registerPerceptionArtifacts(app)
	return nil
}

func registerPerceptionWorkers(app *framework.App) {
	workers := map[string][]byte{
		fieldAssistOpenCVWorkerURL: fieldAssistOpenCVWorkerJS,
		fieldAssistDepthWorkerURL:  fieldAssistDepthWorkerJS,
	}
	for route, source := range workers {
		route := route
		source := source
		app.Router().HandleFunc(http.MethodGet, route, func(w http.ResponseWriter, _ *http.Request) {
			// The released Emscripten/OpenCV build performs runtime compilation.
			// Scope unsafe-eval to these isolated, application-owned workers; the
			// host document retains GoFastr's strict default CSP.
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self'; worker-src 'self'; object-src 'none'")
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "private, no-store")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(source)
		})
	}
}

func fieldAssistUIHostOption() uihost.Option {
	return uihost.WithExtraScripts(fieldAssistPerceptionJSURL, fieldAssistJSURL)
}

type perceptionArtifact struct {
	upstreamURL string
	contentType string
}

// These immutable, version-pinned artifacts are fetched only when an operator
// activates spatial guidance. Serving them through a narrow same-origin proxy
// keeps GoFastr's default CSP intact and gives the browser a durable cache
// without ever sending camera pixels to the application server.
var perceptionArtifacts = map[string]perceptionArtifact{
	fieldAssistRoute + "/runtime/opencv.js": {
		upstreamURL: "https://docs.opencv.org/5.0/opencv.js",
		contentType: "text/javascript; charset=utf-8",
	},
	fieldAssistRoute + "/runtime/ort.webgpu.min.mjs": {
		upstreamURL: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort.webgpu.min.mjs",
		contentType: "text/javascript; charset=utf-8",
	},
	fieldAssistRoute + "/runtime/ort.wasm.min.mjs": {
		upstreamURL: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort.wasm.min.mjs",
		contentType: "text/javascript; charset=utf-8",
	},
	fieldAssistRoute + "/runtime/ort-wasm-simd-threaded.mjs": {
		upstreamURL: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.mjs",
		contentType: "text/javascript; charset=utf-8",
	},
	fieldAssistRoute + "/runtime/ort-wasm-simd-threaded.wasm": {
		upstreamURL: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.wasm",
		contentType: "application/wasm",
	},
	fieldAssistRoute + "/runtime/ort-wasm-simd-threaded.jsep.mjs": {
		upstreamURL: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.jsep.mjs",
		contentType: "text/javascript; charset=utf-8",
	},
	fieldAssistRoute + "/runtime/ort-wasm-simd-threaded.jsep.wasm": {
		upstreamURL: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.jsep.wasm",
		contentType: "application/wasm",
	},
	fieldAssistRoute + "/model/config.json": {
		upstreamURL: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/config.json",
		contentType: "application/json; charset=utf-8",
	},
	fieldAssistRoute + "/model/preprocessor_config.json": {
		upstreamURL: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/preprocessor_config.json",
		contentType: "application/json; charset=utf-8",
	},
	fieldAssistRoute + "/model/onnx/model_q4f16.onnx": {
		upstreamURL: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_q4f16.onnx",
		contentType: "application/octet-stream",
	},
	fieldAssistRoute + "/model/onnx/model_int8.onnx": {
		upstreamURL: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_int8.onnx",
		contentType: "application/octet-stream",
	},
}

func registerPerceptionArtifacts(app *framework.App) {
	client := &http.Client{Timeout: 3 * time.Minute}
	for route, artifact := range perceptionArtifacts {
		route := route
		artifact := artifact
		app.Router().HandleFunc(http.MethodGet, route, func(w http.ResponseWriter, r *http.Request) {
			request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, artifact.upstreamURL, nil)
			if err != nil {
				http.Error(w, "perception artifact unavailable", http.StatusBadGateway)
				return
			}
			request.Header.Set("User-Agent", "GoFastr-Field-Assist/1.0")
			response, err := client.Do(request)
			if err != nil {
				http.Error(w, "perception artifact unavailable", http.StatusBadGateway)
				return
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				http.Error(w, fmt.Sprintf("perception artifact upstream returned %d", response.StatusCode), http.StatusBadGateway)
				return
			}
			w.Header().Set("Content-Type", artifact.contentType)
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			if response.ContentLength >= 0 {
				w.Header().Set("Content-Length", fmt.Sprintf("%d", response.ContentLength))
			}
			w.WriteHeader(http.StatusOK)
			_, _ = io.Copy(w, response.Body)
		})
	}
}

func fieldAssistHeadHTML() string {
	return `<link rel="stylesheet" href="` + fieldAssistCSSURL + `">` +
		`<link rel="manifest" href="` + fieldAssistManifestURL + `">` +
		`<link rel="apple-touch-icon" sizes="180x180" href="` + fieldAssistAppleIconURL + `">` +
		`<meta name="mobile-web-app-capable" content="yes">` +
		`<meta name="apple-mobile-web-app-capable" content="yes">` +
		`<meta name="apple-mobile-web-app-title" content="Field Assist">` +
		`<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` +
		`<meta name="format-detection" content="telephone=no">`
}
