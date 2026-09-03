package main

import "github.com/DonaldMurillo/gofastr/framework/uihost"

func fieldAssistLLMsSections() []uihost.LLMsTxtSection {
	return []uihost.LLMsTxtSection{
		{
			Title: "Start here",
			Links: []uihost.LLMsTxtLink{
				{Name: "Full agent guide", URL: "/llms-full.txt", Notes: "architecture, authority boundaries, stack, and operating flow in one document"},
				{Name: "Technology stack", URL: "/stack/llm.md", Notes: "released framework, browser capabilities, realtime transports, and hosting"},
				{Name: "WebMCP tool catalog", URL: "/tools/llm.md", Notes: "every page-scoped session tool rendered from the registered GoFastr declarations"},
				{Name: "All public screens", URL: "/llm-pages.md", Notes: "GoFastr-generated index of page-level Markdown representations"},
			},
		},
		{
			Title: "Session flow",
			Links: []uihost.LLMsTxtLink{
				{Name: "Field Assist overview", URL: "/llm.md", Notes: "product purpose and entry flow"},
				{Name: "Create a session", URL: "/new/llm.md", Notes: "open a live or deterministic demo workspace"},
			},
		},
		{
			Title: "Optional",
			Links: []uihost.LLMsTxtLink{
				{Name: "Sitemap", URL: "/sitemap.xml", Notes: "public crawlable routes"},
				{Name: "Agent card", URL: "/.well-known/agent-card.json", Notes: "machine-readable Field Assist identity and capabilities"},
			},
		},
	}
}

func fieldAssistLLMsFullText() string {
	return `# Field Assist: full agent guide

> Live remote support where an operator, an accountable support representative, and Codex share one physical workspace.

## When to use

Use Field Assist when a remote operator needs visual help identifying, inspecting, or manipulating physical equipment while an accountable human support representative remains in control.

## Operating flow

1. Create a live session at /new.
2. Open the support console and pair the operator through its one-time QR code or secure copy link.
3. The operator chooses a phone starter or submits a free-form request; only then does the phone start the rear camera. Starter identity is not exposed to the assistant—only the operator's resulting words are shared. WebRTC carries camera media directly between browsers.
4. The operator, support representative, and Codex share one backend-synchronized text conversation. Codex discovers the authenticated WebMCP tools on the support page, reads user-provided context, inspects the live scene, registers visible objects, and places reversible guidance.
5. Spatial guidance remains bound to transient OpenCV/Depth Anything tracking; human-only approval remains required for consequential physical instructions or final case resolution.

## Architecture

- Go 1.27 and the released GoFastr v0.75.0 module provide the HTTP application, server-rendered screens, typed handlers, security middleware, rate limiting, WebSocket transport, logging, and WebMCP bridge.
- WebRTC and MediaDevices provide peer-to-peer rear-camera video. Camera frames do not pass through the Go server.
- GoFastr WebSockets carry authenticated signaling, scene state, annotations, tracking telemetry, and delivery receipts.
- The support browser runs OpenCV 5 homography/PnP tracking and Depth Anything V2 Small through ONNX Runtime Web against its peer-video copy. The phone keeps a lightweight Canvas tracker and applies short-lived DeviceOrientation correction between healthy support-side visual updates; bounded orientation samples use the peer data channel, no sensor value reaches the server, and no depth value is reported as metric distance.
- barcode.donaldmurillo.com generates the operator QR code. A visible one-time copy-link fallback remains available.
- The service runs as a gated prebuilt Linux binary on private VPS infrastructure behind HTTPS and a WebSocket-capable proxy.
- Playwright verifies WebRTC, WebMCP, responsive layout, camera recovery, tracking, and the deployed Codex-to-phone loop.

## Codex and WebMCP

Codex is the only agent driving Field Assist. There is no separate model API embedded in the application. The authenticated support page exposes twenty-five semantic WebMCP tools for scene inspection, visible-object registration, same-object recalibration, room context, backend-synchronized conversation and phone instructions, object guidance, operator questions, snapshots, comparison, observations, case context, timeline inspection, and generic next-step suggestions. Debug-only connection tools are conditional and are not part of the submission surface.

WebMCP tools use the same typed HTTP commands and support-session authority as the human controls. The WebMCP marker attributes actions to Codex but never grants authorization.

Start with get_app_info. It copies Field Assist's versioned operating contract and live session request into Codex context without requiring a separate skill installation. Preserve the returned contextVersion and include it in every mutating WebMCP call; the backend rejects missing or stale context before shared state changes. Use model knowledge to form a likely device/control hypothesis, then use vision to map it onto the live frame. Treat identity, localization, tracking, and delivery as separate confidence signals. Register the containing device before its actionable control: manual bounds only seed the browser tracker, and precision guidance stays hidden until backend-confirmed OpenCV/Depth Anything tracking locks. Never fall back to fixed screen coordinates after tracking loss. Then call inspect_scene again whenever the operator answers or the scene materially changes.

## Safety and privacy boundaries

- Camera permission is requested only for the operator workflow; microphone access is denied by policy.
- Camera frames are peer-to-peer and are not recorded by Field Assist.
- Operator join links are single-use and session-bound.
- Authenticated pages, WebMCP assets, and session APIs use private no-store caching.
- Codex may inspect and place reversible guidance, but it cannot approve physical actions or resolve a case.
- Scene coordinates are normalized and authoritative; tracking telemetry is bounded, transient, and cannot prove physical completion.

## Public discovery

- /llms.txt is the concise index.
- /llms-full.txt is this full guide.
- /tools/llm.md lists the same WebMCP declarations registered on the authenticated support page.
- /llm-pages.md indexes public screen Markdown.
- /<screen>/llm.md returns a GoFastr-generated Markdown representation of a public screen.
- /.well-known/agent-card.json and /.well-known/agent.json expose the agent-ready identity document.
- /sitemap.xml and /robots.txt describe the public crawl surface. Private session routes are excluded.
`
}
