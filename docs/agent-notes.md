# Agent notes

## 2026-08-30 - Reconcile realtime overlays instead of rebuilding them
- Scope: operator-overlay-rendering
- Trigger: Tracking telemetry and viewport events rebuilt every marker and command banner, repeatedly restarting their entrance animations as visible flashing.
- Approach: Key direct overlay children by durable annotation ID, update their geometry and copy in place, and prune only elements that are no longer active.
- Evidence: `web/static/app.js`; the two-browser Playwright flow marks the live phone overlay nodes, dispatches a viewport resize, and proves both nodes retain identity.
- Next time: Preserve DOM identity for realtime visual elements; reserve entrance animation for newly created guidance only.
- Status: active

## 2026-08-30 - Keep Field Assist video-only
- Scope: webrtc-product-scope
- Trigger: Real-device testing showed optional audio added permission friction without strengthening the visual WebMCP guidance demo.
- Approach: Remove microphone controls and audio elements, stop negotiating audio transceivers, send video-only readiness, and enforce `microphone=()` while keeping `camera=(self)`.
- Evidence: `main.go`, `screens.go`, `web/static/app.js`, and the two-browser Playwright assertions for zero audio UI/transceivers before and after peer recovery.
- Next time: Treat bounded phone questions as the operator response channel and reject microphone features unless the product scope explicitly changes.
- Status: active

## 2026-08-30 - Share enhanced geometry with the renderer that needs it
- Scope: cross-device-spatial-guidance
- Trigger: Desktop OpenCV plus Depth Anything kept tracking a target while the phone's Canvas fallback lost it, but the phone hid the marker because enhanced telemetry was support-only.
- Approach: Include only the transient scene-tracking record in the least-privilege operator snapshot/event allowlist, validate its scene and guidance binding in the renderer, and prefer usable shared bounds over local fallback state.
- Evidence: `session_store.go`, `web/static/app.js`, and `pnpm exec playwright test tests/field-assist.spec.ts -g "builds a live scene from observed targets"`.
- Next time: Route authoritative perception geometry to every renderer that consumes it while keeping frames, support history, and diagnostics outside that boundary.
- Status: verified locally with the two-browser loss-and-recovery path

## 2026-08-30 - Let the live workspace own pairing and media state
- Scope: support-console-ui
- Trigger: The QR code lived in a secondary rail while the primary camera area showed a dead placeholder, and static case/chat panels obscured the actual demo workflow.
- Approach: Render the one-time QR and copy fallback inside the video stage only while no operator is paired, switch that same stage to a camera-permission waiting state after join, and remove the unused embedded-assistant form in favor of the authenticated Codex WebMCP surface. Keep scene controls and activity as the only persistent right-rail workflow.
- Evidence: `screens.go`, `web/static/app.css`, `web/static/app.js`, and the two-browser Playwright pairing/joined/live assertions plus containment checks at 390, 600, 768, and 1024 CSS pixels.
- Next time: Put setup controls in the space their successful result will occupy, and derive empty states from realtime state rather than duplicating the workflow elsewhere.
- Status: verified locally in the built-in browser and the normal/debug Playwright suites

## 2026-08-30 - GoFastr dynamic screens require parameter setters
- Scope: gofastr-ui
- Trigger: A dynamic `/session/:sessionId` screen panicked during live navigation.
- Approach: Implement `SetParams(map[string]string)` on every screen registered with dynamic route segments.
- Evidence: `screens.go`; `go test ./...` and the Playwright session-creation flow pass.
- Next time: Add the dynamic-screen contract before boot-smoke testing a new GoFastr route.
- Status: active

## 2026-08-30 - Browser media policy must explicitly allow the camera origin
- Scope: webrtc-security
- Trigger: GoFastr's default `Permissions-Policy` denied camera access even though `getUserMedia` was correct.
- Approach: Set `camera=(self)` while denying microphone and geolocation. Camera remains the operator workflow's explicit retry path; no microphone surface or audio transceiver exists.
- Evidence: `main.go`; the two-context Playwright test proves live video and zero audio transceivers before and after peer recovery.
- Next time: Inspect effective response security headers before debugging browser media code.
- Status: active

## 2026-08-30 - Pre-negotiate optional WebRTC voice, then replace tracks
- Scope: webrtc-voice
- Trigger: Both participants needed optional conversation without making microphone permission or a second signaling round part of session startup.
- Approach: Let the support offer establish one `sendrecv` audio section, explicitly request each local microphone on button click, and use `RTCRtpSender.replaceTrack` to enable or disable it. Preserve local audio streams across a peer rebuild so existing opt-in survives renegotiation; keep GoFastr responsible only for the controls and signaling.
- Evidence: `screens.go`, `web/static/app.js`, and the local/public two-browser Playwright flows prove voice is initially off, becomes two-way, returns after forced peer replacement, and detaches both outbound senders on opt-out.
- Next time: Negotiate an inactive media seam early when later opt-in must avoid renegotiation, but never treat SDP permission as user consent to capture.
- Status: superseded by the video-only product scope; do not restore the audio seam

## 2026-08-30 - Installable realtime shells should not imply offline authority
- Scope: iphone-pwa-shell
- Trigger: The product handoff described the operator as an iPhone browser/PWA, but the deployed page had no manifest, install icon, or Apple home-screen metadata.
- Approach: Serve the manifest and generated SVG/PNG icons through GoFastr's released `pluginhost.AssetServer`, emit favicon/theme metadata through `uihost`, and keep the authenticated app free of service-worker caching.
- Evidence: `fieldassist_plugin.go`, `web/static/manifest.webmanifest`, generated icon assets, and Playwright assertions for manifest metadata and both standard/Apple icons.
- Next time: Treat installability and offline behavior as separate decisions; a realtime shell can be installable while correctly requiring the live origin for authority and media.
- Status: verified locally and on the public deployment

## 2026-08-30 - Keep local tracking subordinate to calibrated shared state
- Scope: browser-cv-tracking
- Trigger: Normalized WAN guidance remained fixed when the operator camera drifted modestly, even though the product handoff called for known-object tracking where feasible.
- Approach: Build a 24×18 luminance template only during an active scene-bound approval, search a bounded 5×5 neighborhood, cap cumulative drift to 12% from the GoFastr calibration anchor, and apply confident matches only to the operator's local overlay. Use a visible calibrated fallback for low-texture views and re-baseline change detection after the tracker first acquires texture.
- Evidence: `web/static/app.js`, the GoFastr-rendered `operator-tracking-status` in `screens.go`, and Playwright's solid-frame fallback plus synthetic 4% camera-drift displacement assertion.
- Next time: Keep perception confidence, overlay presentation, shared scene truth, and human physical confirmation as four separate states.
- Status: verified locally and on the public deployment

## 2026-08-30 - Keep signaling credentials out of JavaScript
- Scope: session-security
- Trigger: Support and operator need different realtime authority without exposing reusable tokens to the app script.
- Approach: Exchange the one-time operator URL token for a role-specific HttpOnly cookie, remove it with a 303 redirect, and authenticate HTTP/WebSocket calls from cookies.
- Evidence: `handlers.go`; operator navigation ends without a token and cross-role browser contexts pass E2E.
- Next time: Reuse the cookie boundary and strict origin check before adding any realtime message type.
- Status: active

## 2026-08-30 - Treat STUN-only as an explicit deployment constraint
- Scope: webrtc-deployment
- Trigger: Direct WebRTC avoids relay cost but cannot cross every NAT/firewall combination.
- Approach: Keep media peer-to-peer with public STUN for the demo, expose ICE diagnostics, and add TURN only after an actual cross-network failure.
- Evidence: `web/static/app.js`, `docs/architecture.md`, and the Playwright direct-media test.
- Next time: Test phone-on-cellular to laptop-on-Wi-Fi before the demo and provision TURN if ICE never reaches connected/completed.
- Status: active

## 2026-08-30 - Treat runtime wiring and WebMCP availability as separate deployment gates
- Scope: deployment-and-demo-docs
- Trigger: Deployment variables require both validation and a real consumer; WebMCP also depends on the ChatGPT built-in browser and an eligible model.
- Approach: Parse and wire configuration at startup, serve ICE settings through an authenticated same-origin endpoint, and require GPT-5.6 Sol or Terra for the WebMCP recording path. Keep WebMCP distinct from standalone MCP and from the barcode service's REST QR endpoint.
- Evidence: `config.go`, `main.go`, `web/static/app.js`, `docs/deployment.md`, and the [official Site tools documentation](https://learn.chatgpt.com/docs/webmcp).
- Next time: Before claiming an environment variable or WebMCP demo works, check the consuming code, the final page tool manifest, the built-in browser model, and the exact two-device network path.
- Status: runtime wiring and final nineteen-tool in-app Browser discovery/invocation verified publicly; real-device media validation remains

## 2026-08-30 - Keep QR REST and barcode MCP as separate trust boundaries
- Scope: qr-and-agent-integration
- Trigger: The barcode service advertises both anonymous REST generation and an authenticated Streamable HTTP MCP endpoint.
- Approach: Proxy `POST /api/generate` server-side for image bytes and keep the copy-link fallback. Document `/mcp` for separately authenticated agent integrations; never expose an API key or a one-time join token to browser JavaScript.
- Evidence: `handlers.go`, `handlers_test.go`, live QR generation/decode check, and `https://barcode.donaldmurillo.com/.well-known/mcp.json`.
- Next time: Use REST for runtime binary assets and MCP for explicit agent tool calls; do not conflate discovery with anonymous access.
- Status: active

## 2026-08-30 - Physical changes require operator authority
- Scope: scene-action-loop
- Trigger: An AI highlight alone does not prove that a cable was physically moved.
- Approach: Let WebMCP inspect, annotate, request a close-up, capture, and compare; reserve the consequential LAN-to-WAN transition for the operator-only **Done — cable moved** control. Broadcast the resulting scene version and semantic after snapshot.
- Evidence: `session_store.go`, `handlers.go`, `web/static/app.js`, unit tests, and the Playwright two-browser flow.
- Next time: Keep observe/assist/direct action classes explicit and require human confirmation for physical state transitions.
- Status: active

## 2026-08-30 - Size the signaling service separately from peer media
- Scope: deployment-sizing
- Trigger: The demo needs a practical CPU/RAM target even though WebRTC media does not pass through the Go service.
- Approach: Ship the non-root distroless image, keep one replica for in-memory sessions, and start at 0.5 vCPU/512 MB for provider headroom. Treat the local idle observation as a floor signal, not a load benchmark.
- Evidence: Final image size was 6.53 MB; the container-level `/readyz` and `/healthz` smoke test passed while idle usage was about 15.2 MiB and 0.00% CPU.
- Next time: Measure peak memory and signaling/event load on the selected public provider; budget TURN relay capacity separately because it is outside this process.
- Status: local artifact measured; provider load validation remains

## 2026-08-30 - Scope WebMCP discovery to the accountable support surface
- Scope: webmcp-least-privilege
- Trigger: GoFastr's default script registrar injects a mounted WebMCP bridge into every full-page render, which made support tools discoverable on landing and operator pages even though server authorization rejected their execution.
- Approach: Mount the released GoFastr bridge with no global script registrar, keep its hashed route, and render the returned same-origin script URL only from `supportScreen` using GoFastr's HTML script helper. Force the support header's exit link through a full document navigation so a partial swap cannot retain already registered tools.
- Evidence: The built-in Codex browser first proved the scoped surface with ten tools, and the final public build now exposes nineteen; it executed `inspect_scene` and `highlight_object` and rendered `CONNECT HERE` in a paired operator tab. Landing and operator pages reported no WebMCP tools, including after leaving support through the header. The Playwright suite asserts the same document-level scope and hard-navigation boundary.
- Next time: Treat tool discovery itself as an authority surface; do not rely on endpoint rejection to compensate for advertising irrelevant capabilities.
- Status: verified locally in the actual built-in browser

## 2026-08-30 - Reconnect signaling and peer recovery are separate state machines
- Scope: webrtc-reliability
- Trigger: A WebSocket could reconnect while a stale local WebRTC offer remained, causing fresh operator readiness pulses to be ignored indefinitely.
- Approach: Preserve a connected peer across a signaling reconnect, but replace every non-connected peer, allow an explicit support-to-operator `webrtc.renegotiate` event, and make a fresh operator ready pulse authoritative. Clear stale SDP bookkeeping and the ended remote stream during replacement.
- Evidence: `web/static/app.js`, the socket event allowlist in `handlers.go`, and the two-browser Playwright flow that forcibly closes the support peer, verifies both sides create replacements, confirms media returns, and captures the selected candidate pair from `getStats()`.
- Next time: Test signaling recovery and media renegotiation independently; a restored session snapshot does not prove the camera track recovered.
- Status: verified locally with fake browser media

## 2026-08-30 - Normalized scene bounds belong to displayed media pixels
- Scope: overlay-correctness
- Trigger: `object-fit: contain` can letterbox portrait video while a full-stage overlay still interprets normalized bounds against the whole desktop stage.
- Approach: Derive the contained media rectangle from the video intrinsic dimensions and overlay client dimensions, then map normalized bounds into that rectangle. Re-render on metadata load and resize.
- Evidence: `web/static/app.js` and the mobile-operator Playwright assertion that the guidance box stays within displayed media pixels.
- Next time: Treat the media transform as part of the scene-coordinate contract whenever `object-fit`, cropping, rotation, or mirroring changes.
- Status: active

## 2026-08-30 - Bound every anonymous demo allocation path
- Scope: resource-safety
- Trigger: Anonymous session creation allocated a Hub and unbounded snapshot/annotation state until TTL cleanup.
- Approach: Apply GoFastr's released per-client session-creation limiter, cap the in-memory store at 64 active sessions, retain only 50 snapshots and 32 active annotations per session, and keep the existing 200-item timeline cap.
- Evidence: `handlers.go`, `session_store.go`, unit cap tests, race tests, and container smoke verification.
- Next time: Resource-limit both admission and per-tenant collections before exposing a no-account demo publicly.
- Status: active

## 2026-08-30 - Bind physical confirmation to human approval and scene state
- Scope: physical-action-safety
- Trigger: Hiding the operator confirmation button until guidance existed did not provide server-side authorization for the consequential cable transition.
- Approach: Let WebMCP inspect, recommend, and create reversible guidance; require a human support endpoint to issue a short-lived one-time approval bound to the guidance ID and scene version, then atomically consume it during operator confirmation.
- Evidence: `session_store.go`, `handlers.go`, `web/static/app.js`, focused unit tests, and the two-browser Playwright flow that proves premature confirmation fails.
- Next time: Treat visual UI state as presentation, never authorization; bind approvals to the exact resource revision they authorize.
- Status: verified locally and on the public deployment

## 2026-08-30 - Use GoFastr for semantic workflow chrome, browser code for media geometry
- Scope: gofastr-boundary
- Trigger: The case workflow needed richer structure without replacing the live JSON/WebSocket reducer or browser-only camera APIs.
- Approach: Render RecordSummary, MetricBand, ProgressSteps, Callout, StatusBadge, typed buttons, and CopyButton from released GoFastr v0.75.0; keep WebRTC, media permissions, calibration drag, and contained-video overlay math in the app-owned static asset.
- Evidence: `screens.go`, `web/static/app.js`, the absence of `gofastr-plugins` from the module graph, and Playwright acceptance.
- Next time: Prefer GoFastr for stable semantic structure and controls, but do not force server-rendered components to own realtime browser state they were not designed to reduce.
- Status: verified locally

## 2026-08-30 - Keep workflow resolution outside the agent capability surface
- Scope: case-workflow-safety
- Trigger: The physical transition advanced the case to verification, but the workflow had no accountable terminal transition.
- Approach: Add a support-authenticated `ResolveCase` command only after the scene relationship points from modem to WAN; reject WebMCP-attributed requests and mark the verification step complete exactly once. Let WebMCP request only bounded, reversible semantic camera views.
- Evidence: `session_store.go`, `handlers.go`, the Go unit tests, and the two-browser Playwright resolution flow.
- Next time: Distinguish agent recommendations and assistive presentation from human assertions that a physical repair was verified.
- Status: verified locally

## 2026-08-30 - Filter realtime state by authenticated participant role
- Scope: realtime-data-minimization
- Trigger: The operator UI hid support context, but a shared initial snapshot and broadcast hub still delivered case history over the operator transport.
- Approach: Keep GoFastr hubs per role, send an explicit minimal `OperatorSessionSnapshot`, and allowlist operator events with timeline and case fields removed. Continue sending the scene, annotations, participants, WebRTC signaling, and consumable approval required by the phone workflow.
- Evidence: `session_store.go`, `handlers.go`, and the local/public Playwright assertions that operator snapshots and event streams exclude case, timeline, observation, and snapshot history while WebRTC and overlays still work.
- Next time: Data hidden by UI is still disclosed; enforce least privilege at DTO and event-routing boundaries.
- Status: verified locally and on public deployment

## 2026-08-30 - Treat join links and authenticated GETs as non-cacheable capabilities
- Scope: session-capability-safety
- Trigger: The authenticated current-session response contains the one-time operator path, and the external QR renderer necessarily processes that capability.
- Approach: Send `private, no-store` plus credential `Vary` headers on every authenticated dynamic GET; expire the single-use operator join token after ten minutes; document `barcode.donaldmurillo.com` as a trusted processor whose request bodies must not be logged.
- Evidence: `handlers.go`, `session_store.go`, local/public Playwright cache-header assertions, and the public QR workflow.
- Next time: Accountless QR pairing makes the QR payload a bearer capability; either generate locally or explicitly minimize lifetime, caching, and processor logging.
- Status: verified locally and on public deployment

## 2026-08-30 - Submission captures must exclude pairing capabilities
- Scope: publication-safety
- Trigger: Browser automation artifacts and ordinary support screenshots can preserve a readable operator join URL or its QR representation.
- Approach: Keep generated browser state outside the publishable tree, ignore `.playwright-mcp`, `output`, and local hackathon state, and use `e2e/scripts/capture-submission.mjs` with synthetic media. The capture script removes the pairing and diagnostics panels before saving the support image.
- Evidence: `docs/assets/landing-desktop.png`, `docs/assets/support-console.png`, `docs/assets/operator-overlay.png`, `.gitignore`, and a publishable-file preflight with no generated state directories.
- Next time: Treat screenshots, traces, and browser snapshots as potential credential containers; use an explicit sanitized capture path rather than reusing debugging artifacts.
- Status: verified locally against the public deployment

## 2026-08-30 - Keep the runtime contract shared across hosting targets
- Scope: deployment-documentation
- Trigger: The deployment documentation mixed provider-specific packaging with the public application contract.
- Approach: Treat the root `Dockerfile`, Go source, environment variables, health endpoints, non-root runtime, and single-instance behavior as the provider-neutral contract for Railway and VPS hosting.
- Evidence: `railway.json`, `Dockerfile`, and the live `/healthz` and `/readyz` responses.
- Next time: Keep private deployment tooling out of the public repository and document only the portable runtime contract.
- Status: verified against the current repository and public deployment

## 2026-08-30 - Protect WebMCP discovery at the HTTP boundary
- Scope: webmcp-authorization
- Trigger: Rendering the bridge only on the support screen prevented page registration elsewhere, but the bridge script, manifest, and `get_app_info` endpoint still answered anonymous requests.
- Approach: Require the support-session cookie for both released GoFastr WebMCP asset routes and authenticate `get_app_info` like every other tool. Override the bridge's public immutable cache policy at write time so an intermediary cannot replay an authenticated asset anonymously.
- Evidence: `handlers.go`, the focused middleware test in `handlers_test.go`, and the Playwright acceptance case that receives 401 anonymously and the full nineteen-tool manifest after support authentication.
- Next time: UI-scoped script inclusion limits activation, not discovery; enforce capability boundaries on every underlying HTTP resource and consider their cache semantics together.
- Status: verified locally and on the public deployment

## 2026-08-30 - Treat browser CV as evidence, never authorization
- Scope: scene-understanding
- Trigger: The deterministic scene fallback completed the semantic loop but did not observe any camera-pixel change after the physical instruction.
- Approach: Use the host-page plugin for a dependency-free 32×24 luminance sample of only the calibrated WAN crop. Arm it only for an active scene-bound approval, require a changed frame to stabilize, and send one bounded score to an operator-authenticated GoFastr handler. Store the support-only event and timeline item without changing the scene or consuming approval.
- Evidence: `web/static/app.js`, `screens.go`, `handlers.go`, `session_store.go`, focused session tests, and the two-browser acceptance path.
- Next time: Keep detection confidence and human authorization as separate state machines; local pixels can suggest that something changed, but only the accountable participants assert what changed.
- Status: verified locally and on the public deployment

## 2026-08-30 - Keep local tracking telemetry transient and support-only
- Scope: local-tracking-observability
- Trigger: Real-phone WebMCP guidance tracked locally, but support stayed `Tracking idle`; when confidence collapsed, the stale pin remained visible.
- Approach: Bind telemetry to either the active approval or active object-bound guidance ID, keep it support-only and transient, and emit `reacquire_required` after durable loss so both views hide the stale pin. Never mutate scene bounds or infer physical completion.
- Evidence: `session_store.go`, `handlers.go`, `web/static/app.js`; `go test ./...`; Playwright live-scene and approved depth-tracking flows.
- Next time: Test operator-local rendering and support/server telemetry separately, then force target loss and require an explicit reacquisition state.
- Status: verified locally and on the public deployment

## 2026-08-30 - Treat apparent depth as a bounded visual estimate
- Scope: live-spatial-guidance
- Trigger: Translation-only guidance drifted when the phone moved toward or away from a target, while browser support could not guarantee metric depth or persistent WebXR anchors.
- Approach: Search the local luminance template across bounded translation and proportional scale, derive `relativeDepth = 1 / scale`, and keep the result ephemeral. Bind ordinary tracking telemetry to active guidance, but retain physical-change inference and consequential actions behind the approval boundary.
- Evidence: `web/static/app.js`, `session_store.go`, focused scale/depth tests, and the compact live-session Playwright flow.
- Next time: Call this relative monocular scale/depth, never meters or LiDAR. Add WebXR hit-test/anchors only as a capability-gated progressive enhancement on supported devices.
- Status: verified locally

## 2026-08-30 - Preserve the seeded submission while adding live scene ingestion
- Scope: submission-safe-productization
- Trigger: A hardcoded router scene proved the workflow but could not support the user's actual TV/controller scenario.
- Approach: Keep the router demo selected by default, add an explicit live session with an empty scene, and let accountable support create semantic objects from named normalized regions. Feed those objects to the existing WebMCP tools without uploading camera bytes.
- Evidence: `session_store.go`, `handlers.go`, `screens.go`, and the live-scene Playwright test.
- Next time: Keep deterministic fixtures selectable for judging, but never present them as camera detections.
- Status: verified locally

## 2026-08-30 - Keep the embedded copilot advisory and opt-in for vision
- Scope: embedded-agent-interface
- Trigger: The support console exposed browser WebMCP tools but no visible conversational surface for identifying an unfamiliar live device.
- Approach: Send bounded scene/case context through a server-side Responses client, include a JPEG only when support explicitly checks the frame option, set `store: false`, and return text without agent-callable actions. Keep the API key server-only and preserve WebMCP/human authorization boundaries.
- Evidence: `agent.go`, `handlers.go`, `screens.go`, `web/static/app.js`, and the mocked multimodal request tests.
- Next time: If action suggestions become structured tool calls, keep them proposed/reversible and require the same existing authorization gates before execution.
- Status: superseded by the Codex-only WebMCP architecture; do not restore an embedded model endpoint

## 2026-08-30 - Separate guidance delivery from physical completion
- Scope: annotation-delivery-accountability
- Trigger: A successful GoFastr broadcast proved only that guidance was sent, not that the operator document rendered it.
- Approach: Batch visible server-issued annotation IDs from the operator DOM, validate them against the current scene through an operator-only endpoint, and expose idempotent receipts only to support. Keep receipts out of the case timeline and approval state.
- Evidence: `session_store.go`, `handlers.go`, `web/static/app.js`, unit tests, and Playwright assertions for rendering, support restoration, role rejection, and operator event filtering.
- Next time: Treat delivered, seen, approved, and physically completed as four separate states with separate authority.
- Status: verified locally and on the public deployment

## 2026-08-30 - Log WebRTC categories and tool outcomes, never payloads
- Scope: demo-observability
- Trigger: Success-only tool logging and debug-only signaling events could not explain a failed demo, while raw payload logging would expose SDP, ICE addresses, credentials, notes, or tokens.
- Approach: Wrap all nineteen tool routes with status-aware invocation/outcome logs, parse only allowlisted candidate/state categories, and log scene/session transitions with bounded metadata. Test with secret-looking payloads and assert they never enter JSON logs.
- Evidence: `handlers.go`, `main.go`, `session_store.go`, `handlers_test.go`, `session_store_test.go`, and the local five-test Playwright suite.
- Next time: Add observability at the typed boundary and allowlist fields; never redact after serializing arbitrary payloads.
- Status: verified locally and on the public deployment

## 2026-08-30 - Debug the deployed WebMCP and phone loop through conditional tools
- Scope: deployed-webmcp-debugging
- Trigger: Reproducing a failure required a deployment, a signed-in built-in browser, and a separate phone, while ordinary health checks could not prove tool discovery, peer state, or overlay rendering.
- Approach: Gate `debug_connection_report` and `debug_ping_operator` behind `WEBMCP_DEBUG=false` by default. Retain only allowlisted connection/ICE states, candidate categories, relay classification, signal counts, timestamps, and delivery receipts. Use a visible reversible ping to prove Codex → GoFastr → WebSocket → operator DOM → acknowledgement.
- Evidence: `main.go`, `handlers.go`, `session_store.go`, and the debug-enabled Playwright acceptance flow.
- Next time: Enable the flag only during deployed development, run with `E2E_WEBMCP_DEBUG=1`, clear the ping, and disable the flag before recording or submission.
- Status: verified locally; public flag activation remains

## 2026-08-30 - Size admission limits against the repeated demo gate
- Scope: public-demo-admission
- Trigger: Four public suites passed, but the fifth consecutive run exhausted the 12-token per-IP session-creation burst and timed out on `/sessions/new`.
- Approach: Raise only the released GoFastr admission burst to 24, retain one-token-per-five-second refill and the independent 64-session process cap, then rerun five full public suites from the same client.
- Evidence: The original fifth run failed at session creation before camera recovery; `handlers.go` contains the bounded fix and the repeated public gate verifies it.
- Next time: Exercise rate limits with the full repeated demo workload; a single green flow cannot validate admission sizing.
- Status: verified by five consecutive public suites (25/25 tests)

## 2026-08-30 - Wait for hydrated capability links and connected participants
- Scope: public-webmcp-e2e
- Trigger: The debug flow read the operator link while it still contained the landing-page placeholder, then treated “waiting for operator” as a successful connection.
- Approach: Wait for `#operator-link` to match the tokenized operator route and for `#peer-status` to report “Operator joined” or “Operator camera live” before invoking connection diagnostics.
- Evidence: `e2e/tests/field-assist.spec.ts`; `E2E_BASE_URL=https://webmcp.donaldmurillo.com E2E_WEBMCP_DEBUG=1 pnpm exec playwright test --grep "debug tools prove"` passes publicly.
- Next time: Assert the final capability shape and positive connected state instead of checking only element presence or broad status keywords.
- Status: active

## 2026-08-30 - Drive browser tracking with a seekable prerecorded fixture
- Scope: browser-cv-e2e
- Trigger: Imperative canvas redraws proved translation but could not exercise repeatable video decoding, parallax, and scale-derived relative depth.
- Approach: Serve `e2e/fixtures/depth-parallax.webm` through Playwright with byte-range responses, pause on keyframed phases, and assert lock, overlay translation, scale growth, and `relativeDepth < 1` through the public UI/tool boundary.
- Evidence: `pnpm fixture:depth-parallax`; `pnpm exec playwright test --grep "creates a session, joins an operator"`.
- Next time: Use deterministic seekable media with explicit keyframes instead of external streaming video or timing-dependent canvas animation.
- Status: active

## 2026-08-30 - Recover stale sessions through the GoFastr 404 surface
- Scope: public-entry-and-error-layout
- Trigger: Expired support links ended in middleware-generated plain text, leaving no path back into a real session, while unknown routes had no Field Assist visual context.
- Approach: Use GoFastr's `WithNotFoundScreen` for truthful branded 404 responses, internally reroute unavailable session pages to a recovery variant, and reuse one create-session form across landing, `/new`, stale-session recovery, and 404. Keep the original stale URL, private no-store caching, and WebMCP exclusion intact.
- Evidence: `main.go`, `handlers.go`, `screens.go`, `screens_test.go`, responsive Playwright recovery coverage, and public deployment verification.
- Next time: Error pages are product surfaces; preserve HTTP semantics while giving the user a direct recovery action.
- Status: verified locally and on the public deployment

## 2026-08-30 - Let pairing respond to the camera stage, not the viewport
- Scope: support-pairing-layout-and-agent-discovery
- Trigger: At an 896 CSS-pixel window the support rail reduced the camera stage to about 506 pixels, so viewport breakpoints left the pairing copy, QR, and link competing across three cramped tracks.
- Approach: Make the video stage an inline-size container, give the QR and readable details their own sibling columns, and stack only when the stage itself becomes phone-narrow. Preserve a square fallback column when QR generation fails. Replace framework attribution copy with a public `/stack` inventory, and enable GoFastr's native llms tiers, per-screen Markdown, content negotiation, agent card, discovery headers, sitemap, robots, and content signals.
- Evidence: container geometry assertions at 390–1792 pixels, focused WebRTC/QR Playwright flow, `screens_test.go` agent-discovery endpoint coverage, and browser visual inspection at 896 and 390 pixels.
- Next time: Component breakpoints belong to the component's container; public agent docs must describe authorization boundaries and exclude private session URLs from crawl surfaces.
- Status: verified locally; deployment retest pending

## 2026-08-30 - Make tracking degradation an explicit Codex recovery state
- Scope: browser-cv-and-webmcp-recalibration
- Trigger: Phone testing showed a dark TV target could detach after direction/depth changes, and later fall to 2.5% confidence while stationary because its animated screen content changed inside otherwise stable geometry.
- Approach: Detect camera movement from spatially distributed 4×4 block changes while ignoring the noisiest 40%, require two stable frames, then reacquire with wider translation/scale search. Match a padded crop with heavy weight on the target outline/context, reject ambiguous runners-up, and promote two unreliable matches to `recalibration_required`; preserve `recalibrate_object` as Codex recovery.
- Evidence: `web/static/app.js`; translation/scale/loss/recovery plus large-local-animation and dynamic-interior Playwright assertions repeated three times. Public session `kZrFakFYrsXTPIZP` held an animated TV at 100% while stationary, safely suppressed wrong farther/closer estimates, and let Codex preserve `observed-wjF6UfeB` while re-anchoring scene v3 from vision.
- Next time: Treat local tracking as bounded advisory registration; after real perspective/depth change, let Codex re-detect and call `recalibrate_object` rather than trusting relative scale.
- Status: synthetic tracking and real-phone safe degradation/Codex recovery verified; robust perspective tracking remains future work

## 2026-08-30 - Treat the camera as the instruction surface
- Scope: live-guidance-and-silent-operator-input
- Trigger: Live testing proved spatial guidance worked, but small floating labels and status cards made the current instruction too easy to miss; voice also cannot be assumed in the field.
- Approach: Render only the newest instruction as a camera-wide amber command band, keep prior geometry as subdued registration, and terminate object guidance with leader arrows. Preserve explicit movement/view commands when tracking is uncertain, hide only the spatial marker, and express depth as `IN`/`OUT`; use hold/reacquire as the primary command only when no newer action is pending. For silent input, replace answered choices with a checkmarked receipt confirming the exact answer reached Codex and support.
- Evidence: `session_store.go`, `handlers.go`, `main.go`, `screens.go`, `web/static/app.js`, `web/static/app.css`; full normal/debug E2E suites; public phone sessions `j-JrjfoiiakNWMbz` and `kZrFakFYrsXTPIZP` verified answer receipt plus acknowledged `MOVE FARTHER / OUT` and `MOVE CLOSER / IN` commands even while tracking was uncertain.
- Next time: Keep instruction content separate from spatial registration, keep perception context separate from operator commands, and prefer bounded choices over arbitrary phone-to-agent text when audio is unavailable.
- Status: verified locally and on a real phone

## 2026-08-30 - Separate semantic recovery, planar tracking, and monocular depth
- Scope: browser-perception
- Trigger: Real-phone testing proved Canvas scale search could not keep a television anchored through large perspective and depth changes.
- Approach: Let Codex establish semantic identity, run immutable OpenCV ORB/RANSAC homography and revision-pinned Depth Anything V2 Small on the stronger support browser's peer-video copy, and keep a lightweight Canvas-only overlay fallback on the phone. Transmit scalar telemetry only; never relay frames through the server.
- Evidence: `web/static/perception.js`, both perception workers, the support-authenticated scalar telemetry path, the deterministic contract test, and the opt-in released-artifact smoke test. The real smoke test caught both OpenCV's worker-scoped `unsafe-eval` requirement and a non-owning `DMatch` binding that must not be deleted.
- Next time: Prefer the support computer for expensive peer-local inference, scope runtime compilation permissions to its dedicated workers, pin released artifacts and model revisions, preserve a safe phone fallback, and never describe monocular output as meters.
- Status: verified locally with the released OpenCV/ONNX/model artifacts; public deployment and real-device validation remain

## 2026-08-30 - Keep demo intent phone-owned and precise guidance arrow-only
- Scope: phone-selected-demo-and-spatial-control-guidance
- Trigger: Support/Codex could act on a seeded scenario before the operator stated the problem, while `draw_arrow` still rendered the target's rectangular marker and visually competed with the arrow.
- Approach: Store one bounded `operatorIssue` only after the phone explicitly selects the TV-controller preset or submits free-form text. Delay camera capture until that choice succeeds, expose the choice through `inspect_scene`, and let Codex register the television and a separate tight control target from vision. Use a temporary boxed cue for “THIS IS YOUR TV,” clear it, then render the final tracked arrow with an invisible keyed annotation box so delivery receipts and OpenCV/Depth Anything geometry remain stable without showing a square.
- Evidence: `session_store.go`, `handlers.go`, `main.go`, `screens.go`, `web/static/app.js`, `web/static/app.css`, focused unit coverage, and the live-scene Playwright flow covering preselection redaction, preset selection, object registration, cue clearing, arrow-only styles, stable DOM identity, and shared tracking updates.
- Next time: Treat issue selection, semantic identity, control localization, and spatial guidance as distinct states. Register devices and controls separately; never infer the operator's task from connection alone, and never use a broad device box as the final arrow target.
- Status: verified locally; public deployment and real-phone acceptance pending

## 2026-08-31 - Keep transient QR failures recoverable and tests quota-neutral
- Scope: pairing-qr
- Trigger: Live acceptance runs consumed the shared anonymous barcode minute/day budget, and an image error left each already-open support page permanently stuck on its copy-link fallback.
- Approach: Use server-only `BARCODE_API_KEY` with `/api/v1/generate` in deployed demos, cache one successful PNG per session, preserve upstream quota timing, retry the browser image on bounded backoff, and intercept the QR route in generic Playwright flows.
- Evidence: `config.go`, `handlers.go`, their focused tests, `web/static/app.js`, and `e2e/tests/field-assist.spec.ts`.
- Next time: Use the keyed route for shared server egress, keep broad E2E quota-neutral, and reserve the real service for one focused smoke path.
- Status: active

## 2026-08-31 - Project guidance from the object plane, not the screen
- Scope: object-relative-spatial-guidance
- Trigger: Real-phone testing showed a directionally correct arrow stayed screen-fixed through larger phone translation and depth changes.
- Approach: Store an extended object-relative arrow point, project it with the target's OpenCV homography, retain the four-corner/projected-point telemetry, run low-resolution OpenCV without depth on the phone, and use bounded DeviceOrientation only between fresh visual locks. Coalesce tracking jitter and remove duplicate full renders to keep WebMCP feedback responsive.
- Evidence: Go geometry/ownership tests, focused live-scene Playwright coverage for loss, homography point placement, DOM identity, and orientation correction, plus the opt-in released-runtime quad smoke assertion.
- Next time: Treat pose correction as interpolation, never SLAM; clear it on stale or lost visual evidence and keep frames, homographies, and raw IMU data peer-local.
- Status: superseded after real-phone testing proved homography projection still drifted under camera translation/depth change

## 2026-08-31 - Retry occluded calibration and make Mac depth authoritative
- Scope: support-console-perception
- Trigger: A live arrow was created while the phone stream was black, so the first featureless calibration permanently disabled OpenCV and left the phone on its 2D fallback.
- Approach: Keep the OpenCV worker alive after featureless frames, retry with bounded backoff, re-seed a lost homography from a confident Canvas candidate, and promote each trusted frame to the next ORB reference while carrying its projected quad/point forward. Run support tracking explicitly at 640px with Depth Anything enabled and prefer healthy Mac depth geometry while phone OpenCV + gyro interpolate between corrections.
- Evidence: The released runtime smoke starts black, observes `insufficient-features`, switches to video, and reaches a depth-backed homography lock; normal and debug E2E suites pass.
- Next time: Treat occlusion as transient input rather than runtime failure, and keep cross-device tracking authority explicit.
- Status: verified locally; deployment and real-phone movement validation pending

## 2026-08-31 - Fuse the model's depth field with planar tracking
- Scope: browser-local-spatial-fusion
- Trigger: Running OpenCV and Depth Anything independently still let plausible 2D homographies drift across the wrong physical plane or depth change.
- Approach: Start grayscale OpenCV immediately; asynchronously use a compact Depth Anything field to select calibration-plane features and validate quad plane/scale agreement. Send bounded, sequenced phone orientation only over an unordered peer data channel to guide the Mac search, and let fresh depth conflicts suppress all phone geometry.
- Evidence: Released OpenCV/ONNX/model smoke now requires fused provenance, a valid quad/point, plane agreement, and scale agreement; normal/debug Playwright plus Go tests and vet pass.
- Next time: Monocular depth constrains planar registration but does not create metric SLAM; use one final real-phone movement pass to tune the deliberately broad gates.
- Status: superseded after real-phone movement showed depth validation did not turn planar tracking into world anchoring

## 2026-08-31 - Require world-relative evidence before claiming spatial anchoring
- Scope: browser-local-spatial-fusion
- Trigger: Five live iterations reported high OpenCV confidence while the phone user repeatedly saw the arrow remain screen-relative during closer/farther movement.
- Approach: Pair the exact Depth Anything frame by frame ID, convert inverse depth to target-relative camera Z, back-project immutable room landmarks plus a canonical target plane, solve camera pose with OpenCV PnP, and project the same world anchor; retain homography only as fallback.
- Evidence: `web/static/depth-worker.js`, `web/static/opencv-worker.js`, and `cd e2e && pnpm test:perception-runtime` require stable `worldAnchor`, non-zero `cameraPoseDelta`, PnP inliers, and released runtime/model artifacts.
- Next time: Treat the real operator's physical verdict as ground truth; never equate homography confidence or depth agreement with camera-pose reconstruction.
- Status: verified locally; public deployment and real-phone movement acceptance pending

## 2026-08-31 - Separate paired-reference validity from live-result freshness
- Scope: browser-local-spatial-fusion
- Trigger: The released pose smoke passed, but a real Mac never promoted beyond homography because Depth Anything inference exceeded the four-second live-fusion TTL.
- Approach: Use exact frame ID equality plus retained pixels to validate immutable PnP reference creation; apply the short wall-clock TTL only when deciding whether a depth result may correct current live geometry.
- Evidence: `web/static/opencv-worker.js`; `cd e2e && pnpm test:perception-runtime` now ages the initial paired frame by six seconds and still requires stable world pose projection.
- Next time: Never reuse a live-observation TTL as a synchronization check for asynchronously completed reference data.
- Status: verified locally; deployment and real-phone acceptance pending

## 2026-08-31 - Keep one tracker authoritative across pose degradation
- Scope: cross-device-spatial-authority
- Trigger: Live telemetry alternated PnP, homography, and phone fallback while the operator saw the arrow detach or jump; the physical verdict was “No.”
- Approach: Keep support/Mac OpenCV authoritative through PnP-to-planar degradation, disable the phone's independent enhanced tracker, apply phone pose prediction only during the local bridge, require two continuous PnP candidates before promotion, and refresh the planar reference from every accepted world solve.
- Evidence: `web/static/app.js`, `web/static/opencv-worker.js`, `web/static/perception.js`; the released-runtime smoke injects two PnP failures and requires an explicit continuous planar bridge plus recovery.
- Next time: Diagnose geometry authority separately from solver confidence; never let two devices race to place one annotation, and retain enough capture-time summaries for delayed Depth Anything validation.
- Status: verified locally; real-phone acceptance pending

## 2026-08-31 - Preserve raw geometry when the target is partly cropped
- Scope: partial-visibility-spatial-tracking
- Trigger: Real-phone testing showed a directionally correct TV arrow fell to browser fallback every time any side of the television left the camera frame.
- Approach: Clip the projected quad against the viewport to compute a 20% visibility floor, but keep the bounded raw out-of-frame quad for OpenCV/PnP continuity and server validation. Draw only clipped bounds, hide an offscreen guidance point instead of pinning it to the edge, ignore offscreen depth samples, and clear immediately only after the target drops below the visibility floor. When a fast move invalidates the narrow pose-guided ROI, perform a bounded full-frame ORB recovery under unchanged descriptor, RANSAC, convexity, scale, aspect, and visibility gates while widening only the center-position envelope; otherwise the worker finds a correctly returned target and rejects it for moving more than 16% of the viewport.
- Evidence: Go geometry/handler coverage; `cd e2e && pnpm test:perception-runtime` covers partial tracking followed by full crop and a shifted, fully visible return; live session `3vdTR2TbbLcCC5Ee` proved partial PnP + Depth Anything at 96.6% visibility and exposed the strict-center recovery rejection with the TV plainly back in frame.
- Next time: Treat object visibility, guidance-point visibility, tracker validity, and telemetry freshness as separate states; cropping a target is not the same as losing it, and a failed narrow ROI is not proof the target left the scene.
- Status: partial tracking verified on a real phone; shifted full-loss recovery verified locally and deployed; final phone acceptance pending

## 2026-08-31 - Keep guidance and status backend-authoritative across surfaces
- Scope: cross-device-guidance-consistency
- Trigger: Tracking loss could replace Codex's `POWER BUTTON` headline locally, and local phone/Mac perception could repaint one role before the backend accepted the same state for the other.
- Approach: Keep annotation labels immutable; treat local perception as telemetry-only; render hints and tracking status exclusively from backend-returned or broadcast `sceneTracking`. Never write outgoing payloads optimistically into the UI snapshot.
- Evidence: `web/static/app.js`; two-browser Playwright holds operator and support tracking requests and requires both roles to retain the prior exact backend status until the accepted response advances both.
- Next time: Route all shared visible state through one backend record; separate local sensor diagnostics from user-facing status.
- Status: active

## 2026-08-31 - Track reflective displays by their physical perimeter
- Scope: reflective-plane-spatial-tracking
- Trigger: The strongest real-phone run still lost or drifted when approaching a reflective television because changing glass reflections dominated ORB features.
- Approach: Select a reflective-plane profile from scene-object semantics, exclude the central glass from ORB/PnP features, retain the bezel/bottom control band/context, skip reflection-sensitive depth feature gating, keep an immutable calibration reference for broad recovery beside the rolling reference, and never replace full-view recovery descriptors with a cropped sliver.
- Evidence: `web/static/app.js`, `web/static/perception.js`, `web/static/opencv-worker.js`; `cd e2e && E2E_PERCEPTION_RUNTIME=1 pnpm exec playwright test tests/perception-runtime-smoke.spec.ts --grep "reflective target"` uses a changing reflective interior, stable bezel, partial crop, complete loss, and shifted 1.18× close return.
- Next time: Treat display content and reflections as transient appearance, never physical registration evidence; preserve depth as a geometry validator rather than a glossy-surface feature gate.
- Status: locally verified; real-phone close-range acceptance pending

## 2026-08-31 - Debounce reflective visibility misses before reseeding
- Scope: reflective-plane-spatial-tracking
- Trigger: A real-phone close pass alternated lost, PnP, lost, homography, and PnP while the TV remained mostly visible.
- Approach: Hold the immutable OpenCV reference through two losses for every reason, including the visibility floor, and never let the Canvas appearance tracker reseed a reflective-plane target automatically.
- Evidence: Live session `3eCG4pK9BMoskoT6`; `web/static/perception.js`, `web/static/app.js`, and the reflective released-runtime Playwright smoke.
- Next time: Diagnose loss debounce and reference ownership before tuning ORB thresholds; never let one glossy or cropped frame trigger Canvas reseeding.
- Status: locally verified; real-phone redeploy acceptance pending

## 2026-08-31 - Keep hands-busy guidance in backend-synced banner state
- Scope: operator-guidance-and-tv-registration
- Trigger: In live session `3fc544OwBTd1Brwz`, chat-only movement instructions were unreadable while holding the phone, and a TV arrow at `y=1.04` landed on the media console.
- Approach: Use `send_operator_instruction` for the current phone banner independently of annotations. Register TVs from remote-video pixels around the bezel only, require semantic kinds, and reject TV anchors outside `[0,1]`.
- Evidence: Go session tests plus paired-browser WebMCP E2E cover banner replacement/reconnect state, arrow coexistence, and rejected below-TV anchors.
- Next time: Never make a hands-busy operator read agent chat; never extrapolate a television target beyond its physical plane.
- Status: implemented; deployed phone acceptance pending

## 2026-09-01 - Keep reflective homography references off adjacent furniture
- Scope: reflective-plane-spatial-tracking
- Trigger: Live session `J4IuPwUbryPb9B1w` correctly registered the LG television bezel and placed the arrow at its bottom-center control, but a close crop entered `reacquire_required`; the planar ROI's 22% padding had admitted the high-contrast media console beneath the TV.
- Approach: Keep the global PnP landmark path room-wide, but restrict reflective homography calibration and recovery references to 2% beyond the registered object. Retain a wide physical perimeter/control band inside the TV because a hairline bezel does not provide enough ORB keypoints at low video resolution.
- Evidence: The released-runtime Playwright fixture now adds an independently moving, feature-rich console immediately below the reflective TV and requires the final close-view anchor to remain within 5% of the known bezel anchor through partial crop, complete loss, shifted recovery, reflection changes, and scale jitter.
- Next time: Tune homography reference ownership before match thresholds; depth and global pose may use room context, but adjacent furniture must never define a reflective object's plane.
- Status: deployed; public released-runtime regression verified; final real-phone close-range acceptance pending

## 2026-09-01 - Keep starters outside assistant behavior
- Scope: session-context-and-conversation
- Trigger: Selecting the phone's TV starter caused `get_app_info` and support copy to switch into a hardcoded TV workflow, while the operator could answer only server-issued choices.
- Approach: Convert every starter to the same summary-only `OperatorIssue`, expose no preset metadata, keep app guidance generic, and synchronize a bounded role-attributed message thread through backend snapshots/events. Reserve the amber banner for hands-busy commands.
- Evidence: `e2e/tests/field-assist.spec.ts` proves operator, human support, and Codex messages across WebMCP, rejects cross-role writes, restores chat on reconnect, and asserts that agent flow contains no starter-specific terms.
- Next time: Treat starters as phone copy only; derive every assistant decision from user text, observable pixels, and registered scene state.
- Status: deployed; public conversation verification passed

## 2026-09-01 - Generate public tool discovery from bridge declarations
- Scope: webmcp-public-discovery
- Trigger: Users needed a visible inventory of every available tool without creating a second hardcoded list that could drift from the authenticated WebMCP manifest.
- Approach: Extract `fieldAssistWebMCPTools`, use it for both GoFastr registration and `/tools`, and render only public metadata while keeping paths, schemas, and execution support-authenticated.
- Evidence: `main.go`, `screens.go`, `/tools/llm.md`, and the normal/debug Playwright catalog test compare unique rendered names with the 25/27-tool acceptance manifests.
- Next time: Add or remove tools only in `fieldAssistWebMCPTools`; treat every other catalog and manifest as a projection of that source.
- Status: deployed at `4fa7b94`; public normal/debug catalog verification passed

## 2026-09-01 - Share one phone-banner authority between Codex and support
- Scope: support-console-guidance
- Trigger: The backend and Codex could replace the operator's amber instruction, but the human support console exposed only chat and had no visible way to send the same hands-busy guidance. Long telemetry badges also forced the narrow desktop sidebar into horizontal overflow.
- Approach: Add a prominent support-side phone-banner composer that calls the existing authenticated instruction command without the WebMCP actor marker. Keep the backend instruction as the sole rendering authority, and let scene badges wrap inside a container-sized status row.
- Evidence: Paired-browser Playwright coverage verifies human attribution and yellow-banner delivery to the operator; viewport geometry checks keep every visible scene badge within the support column at 896, 1024, and 1280 pixels.
- Next time: Add human controls to the same canonical command surface as Codex, never a parallel client-only state; test element geometry when telemetry copy can grow.
- Status: deployed at `9b79db2`; public paired-browser verification passed

## 2026-09-01 - Keep support focus mode functional without native fullscreen
- Scope: support-console-responsive-layout
- Trigger: The global header consumed live-workspace height, connection telemetry looked inert, and the pairing QR occupied less than one quarter of its desktop workspace.
- Approach: Toggle a CSS-backed `data-focus-mode` first, then request native fullscreen opportunistically; route the metric strip to the canonical diagnostics disclosure; reserve 50% of the pairing grid for the QR while reclaiming empty-state gutters for readable instructions.
- Evidence: `e2e/tests/field-assist.spec.ts` verifies header restoration, full-height pane geometry, keyboard diagnostics disclosure, a 50% QR column, and the existing 390–1792px paired-camera flow.
- Next time: Make fullscreen APIs an enhancement rather than the layout authority, and preserve both scan size and instruction width when resizing pairing UI.
- Status: superseded; focus mode was removed because its alternate viewport padding degraded the console layout, while QR behavior remains active

## 2026-09-01 - Keep the published stack aligned with runtime ownership
- Scope: public-stack-inventory
- Trigger: `/stack` claimed OpenCV and Depth Anything ran on the operator phone after enhanced perception authority had moved to the support computer.
- Approach: Group the shipped stack into eleven verifiable layers; state that support owns OpenCV/ONNX/depth, the phone owns Canvas/DeviceOrientation, and the console uses one responsive Grid/container-query layout.
- Evidence: `screens.go`, `README.md`, and `docs/architecture.md` agree; the recovery/stack Playwright test asserts row count, ownership copy, and absence of the stale phone-inference claim.
- Next time: Audit public architecture copy whenever computation ownership changes, and encode the corrected claim in E2E.
- Status: deployed at `a088485`; public stack verification passed

## 2026-09-01 - Keep live-workspace utilities contextual
- Scope: support-console-command-layout
- Trigger: Tool discovery navigated away from a live session, raw diagnostics occupied the activity rail, and the phone-banner composer was detached from the media it controls.
- Approach: Open tools and banner composition in native session-preserving dialogs, present only Signaling/ICE/Media in an anchored status popover, and make the media-adjacent amber button preview the backend-authoritative instruction.
- Evidence: `screens.go`, `web/static/app.js`, `web/static/app.css`, and Playwright cover keyboard access, 25/27 tools, popover status, full-width media alignment, and paired-phone banner delivery.
- Next time: Put live-session utilities beside the surface they affect; reserve the rail for case activity and expose raw diagnostics only through the bounded debug tool.
- Status: deployed at `9c082da`; public session-preserving dialog and status-popover verification passed

## 2026-09-01 - Make live telemetry earn its space
- Scope: support-console-scene-telemetry
- Trigger: Five idle scene badges and an always-open timeline dominated the support rail before a camera or scene existed, while support could publish but not remove the phone banner.
- Approach: Keep backend-authoritative scene state, but project its health as a top-right kebab HUD above amber guidance; hover/focus previews the icons and labels, click pins them open, and Escape collapses them. Reveal the full scene model only with live media, collapse timeline history by default, and clear banners through a support-authenticated server event.
- Evidence: Go state tests plus Playwright verify null-instruction propagation to both roles, HUD/banner z-order, media-gated scene controls, collapsed timeline count, and 896/1280px geometry.
- Next time: Preserve semantic state while progressively disclosing its controls; never let idle telemetry consume the primary work surface or clear shared UI locally.
- Status: deployed at `e56322e`; public HUD, banner-clear, and paired-role verification passed

## 2026-09-01 - Reject stale reconnect snapshots
- Scope: realtime-session-authority
- Trigger: A public paired-browser run cleared the backend phone banner while a reconnecting operator later restored the older banner from its initial WebSocket snapshot.
- Approach: Derive each WebSocket snapshot payload and envelope sequence from one immutable server snapshot, then reject snapshot messages whose sequence does not advance the browser's applied sequence.
- Evidence: Go asserts role payload/envelope sequence equality; paired-browser Playwright replays a captured pre-clear snapshot after the live clear event and requires the operator banner to remain absent.
- Next time: Treat snapshots and mutations as one ordered stream even when their socket writes use separate paths; never exempt snapshot hydration from stale-event checks.
- Status: deployed at `e56322e`; public paired-browser replay passed in three consecutive runs

## 2026-09-01 - Keep the operator phone as a camera viewport
- Scope: operator-mobile-layout
- Trigger: Safari could scroll the operator document and permanently exposed three large telemetry chips plus a generic “point the camera” instruction below the video.
- Approach: Lock only the operator document to the visual viewport, hide its idle footer, place Chat inside the camera stage, and disclose telemetry as compact rows from a single camera-overlay “Display status” control. Keep task instructions backend-driven and use neutral camera-permission copy.
- Evidence: iPhone-sized paired-browser acceptance checks hidden/click-disclosed status, absence of generic device-pointing copy, hidden body overflow, and document/app heights bounded to `visualViewport.height`; local 390×844 visual inspection confirms the collapsed and expanded overlay.
- Next time: Camera-first mobile surfaces should reserve document flow for active questions/actions only; diagnostics and secondary controls belong in overlays that do not resize the live view.
- Status: deployed at `e56322e`; public iPhone-sized viewport and disclosure verification passed

## 2026-09-01 - Evaluate Codex through the real WebMCP command boundary
- Scope: codex-webmcp-evals
- Trigger: UI/WebRTC E2E proved transport but not whether a cold Codex run would inspect first, choose grounded tools, deliver phone-visible guidance, and recover safely.
- Approach: Run three deterministic scene fixtures twice through an eval-only MCP adapter generated from `/__gofastr/webmcp/tools.json`; score sanitized calls plus `/api/session/current` backend state, never prompt-only output. Treat every legitimate phone-visible recovery command as delivery.
- Evidence: `node evals/run.mjs` with `gpt-5.6-terra` low passed 6/6, averaged 98/100 and 14.3s; `evals/baselines/terra-low-2026-09-01.json` records the sanitized baseline.
- Next time: Establish the unchanged baseline first, distinguish evaluator defects from agent defects, then rerun identical cases after changing tool descriptions or model settings.
- Status: active

## 2026-09-01 - Give judges a runnable path below the landing hero
- Scope: landing-hackathon-onboarding
- Trigger: The landing hero explained the product and exposed session creation, but a first-time hackathon judge still had to infer the two-device sequence, where Codex enters the loop, and that the support console must run in a WebMCP-capable browser.
- Approach: Add one full-width, three-step runbook below the hero with the expected duration, computer/phone roles, Codex WebMCP handoff, and direct demo/tool links. Surface the compatible-browser requirement before the headline instead of burying it in the final step.
- Evidence: `screens.go`, `web/static/app.css`, and the Playwright “hackathon judges” case assert the prominent Codex/WebMCP browser notice and responsive runbook; visual checks at 1280px and 390px are in `output/playwright/landing-hackathon-*.png`.
- Next time: Put judge-facing setup instructions on the public entry path, but keep detailed architecture and submission language on their dedicated pages.
- Status: deployed at `98a4ccd`; public 390/1280px landing verification passed

## 2026-09-01 - Make WebMCP discovery teach the operating contract
- Scope: codex-webmcp-discovery
- Trigger: Discovering tool names and schemas was not enough to tell a newly connected Codex run how to sequence inspection, user-visible guidance, target grounding, recalibration, and delivery verification.
- Approach: Make `get_app_info` explicitly first-use, return a structured `operatingExpectations` list, and make `inspect_scene` state when it must be refreshed. Keep individual overlay descriptions precise so the agent can choose arrow, label, or box intentionally.
- Evidence: The paired-browser Playwright flow asserts that discovery returns all six expectations before the agent-specific scene flow begins; the public full agent guide documents the same contract.
- Next time: Put cross-tool workflow rules in the first discovery response and keep per-tool descriptions focused on local semantics and safety.
- Status: deployed at `98a4ccd`; public authenticated manifest and paired-browser discovery verification passed with the deployed debug profile

## 2026-09-01 - Keep Codex model compatibility visible in-session
- Scope: support-session-onboarding
- Trigger: The public landing page named the required browser, but the authenticated support workspace did not remind users which Codex models can actually discover Site tools.
- Approach: Put one compact, persistent setup notice at the top of the support control rail: choose GPT-5.6 Terra or Sol, and state that Luna currently cannot use the page's WebMCP tools. Keep it out of the operator camera because the operator does not choose the support agent's model.
- Evidence: The live-workspace Playwright case asserts both the supported-model action and the Luna limitation inside the authenticated session.
- Next time: Surface compatibility constraints at the point where users configure the capability, not only on a pre-session marketing page.
- Status: deployed at `7606f64`; public authenticated-session verification passed with the deployed debug profile

## 2026-09-01 - Feed production WebMCP seams back into GoFastr
- Scope: framework-feedback
- Trigger: Field Assist completed a complex released-module deployment without a GoFastr fork, but accumulated reusable workarounds around private page-scoped tools, partial-navigation capability lifetime, agent operating instructions, diagnostics, and reconnect ordering.
- Approach: File focused GoFastr enhancement tickets with the production failure, minimal example, alternative API shapes, security constraints, and executable acceptance criteria: scoped WebMCP [#371](https://github.com/DonaldMurillo/gofastr/issues/371), capability lifetime [#372](https://github.com/DonaldMurillo/gofastr/issues/372), discovery metadata [#373](https://github.com/DonaldMurillo/gofastr/issues/373), observability [#374](https://github.com/DonaldMurillo/gofastr/issues/374), ordered realtime state [#375](https://github.com/DonaldMurillo/gofastr/issues/375), the bounded reference example [#376](https://github.com/DonaldMurillo/gofastr/issues/376), transport/protocol recovery [#377](https://github.com/DonaldMurillo/gofastr/issues/377), typed tool-handler registration [#378](https://github.com/DonaldMurillo/gofastr/issues/378), dynamic-screen recovery [#379](https://github.com/DonaldMurillo/gofastr/issues/379), and trusted worker CSP profiles [#380](https://github.com/DonaldMurillo/gofastr/issues/380).
- Evidence: All ten issues are open with the `enhancement` label in `DonaldMurillo/gofastr`; each cites the corresponding Field Assist production behavior without requiring this hackathon repository to become a framework dependency.
- Next time: Turn real integration pain into the smallest reusable framework contract; keep app-specific CV, QR, and visual-design concerns out of the framework backlog.
- Status: complete

## 2026-09-01 - Keep operator status in the camera viewport
- Scope: operator-status-overlay
- Trigger: The operator HUD sat in the top-right and exposed only scene/tracking/perception rows, while a bottom-anchored panel would clip if it opened downward.
- Approach: Keep the native keyboard-friendly `details` control, anchor its 44px trigger bottom-left above the safe area, open the status sheet upward with bounded internal scrolling, and add labeled rows for connection, visual check, tracking, spatial perception, and banner delivery.
- Evidence: `screens.go`, `web/static/app.js`, and `web/static/app.css` preserve existing operator IDs while adding live connection/banner state, Escape/outside-tap dismissal, and portrait/short-landscape safe-area rules; `node --check web/static/app.js` and `git diff --check` pass.
- Next time: Keep camera diagnostics inside the stage and make every new operator status fit the same progressive-disclosure sheet rather than adding document-flow chips.
- Status: active

## 2026-09-01 - Enforce app context and control-level arrows
- Scope: webmcp-guidance-contract
- Trigger: Codex tracked a broad PS4 appliance confidently but guessed the power-button anchor, proving that tracking confidence did not establish semantic localization.
- Approach: Make `get_app_info` return a session-bound context version plus the full operating protocol, require that version on WebMCP mutations, and reject `draw_arrow` unless the target is a verified `device-control`.
- Evidence: `webmcp_context.go`, `handlers.go`, and `e2e/tests/context-contract.spec.ts`; `go test ./...`, `pnpm test`, and `node --test evals/score.test.mjs` pass.
- Next time: Load app context first, use knowledge to form the hypothesis, verify the narrow control with vision, and never equate tracking lock with target localization.
- Status: active

## 2026-09-02 - Track the device plane, project the control
- Scope: spatial-guidance-runtime
- Trigger: A manually registered PS4 power-button rectangle stayed screen-relative and was reported with confidence `1` while the camera moved away.
- Approach: Treat registered bounds as provisional; bind nested controls to an explicit containing-device reference, track that larger plane with OpenCV/Depth Anything, project the child anchor, render only backend-accepted tracking, and clear geometry on durable loss.
- Evidence: `go test ./...`; focused Playwright context, perception-loss, and paired-role live-scene cases cover hidden-before-lock, parent reference telemetry, camera drift, partial occlusion, and fail-closed loss.
- Next time: Register the containing device before its control and never render a precision marker from untracked normalized-video coordinates.
- Status: active

## 2026-09-02 - Keep the strongest visible spatial result authoritative
- Scope: cross-runtime-spatial-authority
- Trigger: A phone test briefly achieved PnP + Depth Anything, then a later homography result replaced it, moved the PS4 button arrow several inches, and declared the target lost.
- Approach: Lease fresh tracking by source authority, refresh identical strong observations without event churn, sample the control's own relative depth for world projection, replace stale transient boxes when an arrow starts, and acknowledge only visible phone annotations.
- Evidence: Go authority tests plus the paired-browser live-scene E2E cover hidden-before-lock, arrow-only replacement, rendered delivery, loss, and reacquisition.
- Next time: Diagnose semantic localization, reference-plane choice, tracker authority, and phone rendering as separate confidence layers.
- Status: deployed at `7d4e3a3`; public context-contract and paired-browser spatial-guidance checks pass

## 2026-09-03 - Separate the editable video shell from captured evidence
- Scope: demo-video-tooling
- Trigger: Two 120fps recordings needed synchronized trimming, animated explanation, and repeatable iteration without modifying the source evidence.
- Approach: Keep source selects in `artifacts/video`, lead phone footage by the verified 15-second recording offset, and use the isolated `video/` Remotion project for the visual edit. Maintain narration as timestamped, independently replaceable cues in `video/narration/`; validate timing with a free macOS `say` pass before generating final ElevenLabs audio.
- Evidence: `video/node_modules/.bin/tsc --noEmit -p video/tsconfig.json`; the 164.43s `artifacts/video/output/field-assist-demo-elevenlabs-george.mp4` has ten non-overlapping George cues, 48kHz AAC, and measured integrated loudness of -16.6 LUFS.
- Next time: Generate ElevenLabs narration per cue, measure every clip against the next cue boundary, adjust only overrunning lines, and mux without re-encoding the video stream.
- Status: active

## 2026-09-03 - Audit the live submission surface, not only the local build
- Scope: submission-readiness
- Trigger: The local 25-tool release suite passed while the deployed app still exposed two debug tools, and the draft described an obsolete router fixture instead of the recorded PlayStation flow.
- Approach: Refresh Devpost requirements live, rewrite the packet from current evidence, scan tracked filenames/content for secrets, ignore private video work products, test local and deployed targets separately, and require `WEBMCP_DEBUG=false` for the public submission surface.
- Evidence: `go test ./...`, `go vet ./...`, `go mod verify`, video decode/typecheck, and local Playwright passed; public Playwright reported the isolated 27-versus-25 debug-manifest mismatch while 12 other cases passed.
- Next time: Run the same release suite against both local and public origins after changing deployment flags, and never infer the production tool count from a local build.
- Status: active

## 2026-09-03 - Verify the uploaded demo, not only the local master
- Scope: hackathon-submission-video
- Trigger: The final YouTube URL was available but scheduled for publication rather than immediately public.
- Approach: Record the stable YouTube URL, verify the loaded player title and 2:44 duration, then verify anonymous availability through YouTube's oEmbed endpoint after scheduled publication.
- Evidence: `https://youtu.be/Dm86Ycr2o_I`, YouTube oEmbed metadata, and `devpost-submission.md`.
- Next time: Treat a playable signed-in page and public anonymous availability as separate checks; never call a scheduled upload public early.
- Status: publicly playable

## 2026-09-03 - Make generated WebMCP registration visible in the public README
- Scope: hackathon-repository-readiness
- Trigger: The application declares tools in Go, while the event asks repositories to visibly demonstrate the browser-standard `document.modelContext.registerTool(...)` shape.
- Approach: Reproduce the event's exact `search_products` example in `README.md`, label it explicitly as illustrative rather than functional, and point to the real GoFastr-generated Field Assist declarations in `main.go`.
- Evidence: `README.md` contains the literal requested API shape and links directly to `fieldAssistWebMCPTools` in `main.go`.
- Next time: When framework code generates a required protocol surface, preserve the event's recognizable example while clearly separating it from the authoritative product implementation.
- Status: active

## 2026-09-03 - Answer event narrative prompts explicitly
- Scope: hackathon-submission-copy
- Trigger: The event lists four required narrative questions inside its description rather than as separate form inputs.
- Approach: Add a dedicated `Why WebMCP` section that answers each prompt verbatim in structure, then distinguish the pre-published GoFastr capability from the new Field Assist application.
- Evidence: `devpost-submission.md` contains the four labeled answers and the framework-to-hackathon origin story.
- Next time: Mirror narrative requirements visibly so judges never need to infer that scattered prose satisfies them.
- Status: active
