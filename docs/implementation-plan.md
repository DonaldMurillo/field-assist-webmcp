# GoFastr Field Assist Implementation Plan

## Outcome

Ship one reliable, public demo in which:

1. A support representative creates a session on the desktop support console.
2. An operator joins from an iPhone using the generated one-time link.
3. The operator's rear camera reaches the support console over video-only peer-to-peer WebRTC.
4. Codex, running beside the support console in ChatGPT's built-in browser, discovers the page's WebMCP tools.
5. Codex inspects a deterministic scene and invokes `highlight_object("wan-port")`.
6. GoFastr propagates the annotation to the operator over the session channel.
7. The operator sees a stable `CONNECT HERE` overlay on the iPhone.
8. The application records the action in the case timeline.
9. Codex requests a close-up and captures a semantic before snapshot.
10. The operator moves the cable and explicitly confirms the physical action.
11. Codex captures and compares the after scene, proving the LAN-to-WAN state change.

The target is a repeatable 60–90 second demonstration, not a generalized remote-support platform.

## Fixed Architecture Decisions

### Deployment

- Keep one provider-neutral application source and runtime contract.
- Use the root multi-stage `Dockerfile` for both Railway and VPS hosting so the
  same released GoFastr source and non-root runtime are deployed everywhere.
- Run exactly one GoFastr application instance for the hackathon demo.
- Serve the support console, operator interface, API, WebSocket endpoint, and WebMCP-enabled page from the same public origin.
- Use HTTPS/WSS everywhere. Both candidate hosts terminate TLS in front of the container.
- Do not attach a persistent volume for the first version. Demo sessions are short-lived and may be held in memory.
- Add persistent storage only if a demonstrated requirement survives the MVP cut.

The VPS deployment is live at `webmcp.donaldmurillo.com`. Railway remains a
source-building alternative; switching hosts does not change the application
code or runtime contract.

### Media and realtime transport

- Send camera media directly from the operator browser to the support browser using `RTCPeerConnection`.
- Use GoFastr WebSockets only for session events and WebRTC signaling: offers, answers, ICE candidates, connection state, scene updates, and annotations.
- Never relay continuous video through GoFastr.
- Configure public STUN for the initial direct peer-to-peer demo. Keep the ICE configuration injectable so an external TURN service can be added later if real-device testing proves it necessary.
- Keep camera video one-way from operator to support and deny microphone access by policy.
- Target 1280×720 at approximately 24 fps, but allow the browser to negotiate down on weak networks.

### AI and WebMCP

- Use Codex with GPT-5.6 Sol or Terra as the demo's interactive AI copilot.
- Run Codex from ChatGPT's built-in browser while the support console page is open.
- Register WebMCP tools in the support page and have their handlers call the same typed application functions used by the human controls.
- Keep WebMCP page tools distinct from GoFastr's server-side MCP endpoint. The demo is about the browser page exposing semantic actions to the agent.
- The completed page-tool surface is:
  - `get_app_info`
  - `inspect_scene`
  - `inspect_object`
  - `highlight_object`
  - `annotate_object`
  - `send_operator_instruction`
  - `send_operator_message`
  - `request_closeup`
  - `request_different_angle`
  - `draw_arrow`
  - `show_region`
  - `request_move`
  - `request_operator_view`
  - `capture_snapshot`
  - `compare_snapshots`
  - `clear_annotation`
  - `clear_annotations`
  - `record_observation`
  - `get_case_context`
  - `get_case_timeline`
  - `suggest_next_step`

The support-only approval/resolution commands and operator-only cable
confirmation remain outside WebMCP by design.

### Scene understanding

- Complete the vertical slice with a seeded scene graph and deterministic object IDs before adding computer vision.
- Keep the operator overlay real even when scene localization is manually calibrated.
- Run tracking and lightweight CV in the operator browser.
- Send structured scene state and occasional compressed snapshots, never a continuous frame stream, to the server or external models.

## Runtime Topology

```text
Operator iPhone (Safari/PWA)
  ├── getUserMedia: rear camera
  ├── local overlay and optional CV
  ├── WebRTC media ───────────────────────────────┐
  └── WSS session/signaling ──────┐               │
                                  ▼               ▼
                         GoFastr single container
                         ├── HTTPS routes and assets
                         ├── session registry
                         ├── WebSocket hub
                         ├── signaling relay
                         ├── scene + annotation state
                         └── case timeline
                                  ▲               ▲
                                  │ WSS/HTTPS      │ WebRTC media
                                  │               │
Support console in ChatGPT built-in browser ──────┘
  ├── live operator view
  ├── human controls
  └── WebMCP tools discovered and invoked by Codex
```

## Capacity Target

For one operator/support pair with peer-to-peer video:

- Minimum: 0.25 vCPU and 256 MB RAM.
- Recommended demo allocation: 0.5 vCPU and 512 MB RAM.
- Optional snapshot/model-proxy headroom: 1 vCPU and 1 GB RAM.

The capacity budget assumes no server-side video transcoding and no server-side continuous CV. Media bandwidth flows directly between browsers. The GoFastr server handles two WebSocket clients plus small JSON messages.

## Application Boundaries

### Public routes

```text
GET  /                              landing/demo entry
GET  /session/:sessionId            support console
GET  /session/:sessionId/operator   operator camera interface
GET  /healthz                       process health
GET  /readyz                        readiness for new sessions
```

### Session and tool API

```text
POST /sessions/new                  native form session creation + redirect
POST /api/sessions                  JSON session creation
GET  /api/session/current           authenticated role-specific snapshot
GET  /api/session/operator-qr       authenticated QR proxy for the join link
GET  /api/session/ice-config        authenticated STUN/TURN configuration
GET  /api/tools/app-info            application orientation
POST /api/tools/inspect-scene       deterministic scene inspection
POST /api/tools/inspect-object      inspect one semantic object
POST /api/tools/highlight-object    create shared visual guidance
POST /api/tools/annotate-object     create custom visible guidance
POST /api/tools/request-closeup     request a closer operator view
POST /api/tools/request-operator-view request a bounded semantic camera composition
POST /api/tools/capture-snapshot    store a semantic scene snapshot
POST /api/tools/compare-snapshots   compare two semantic snapshots
POST /api/tools/clear-annotations   clear shared visual guidance
POST /api/tools/record-observation  append a factual timeline note
POST /api/support/approve-action    support-authenticated scene-bound approval (not WebMCP)
POST /api/support/resolve-case      support-authenticated manual resolution (not WebMCP)
POST /api/operator/annotation-acknowledgements operator-render delivery receipts
POST /api/operator/scene-tracking   transient local tracking telemetry (support-only output)
POST /api/operator/scene-activity   advisory visual-change telemetry
POST /api/operator/confirm-cable-moved operator-only physical transition
```

### WebSocket endpoint

```text
GET /ws/sessions/:sessionId?role=support|operator
```

The WebSocket authenticates the role-specific HttpOnly cookie. The one-time operator token is accepted only on the initial page URL and removed by redirect before browser JavaScript runs.

Initial event envelope:

```json
{
  "id": "event-id",
  "type": "annotation.created",
  "sessionId": "session-id",
  "sequence": 12,
  "timestamp": "2026-08-30T00:00:00Z",
  "payload": {}
}
```

Required event types:

- `participant.joined`
- `participant.left`
- `webrtc.offer`
- `webrtc.answer`
- `webrtc.ice_candidate`
- `webrtc.state_changed`
- `scene.updated`
- `annotation.created`
- `annotation.removed`
- `annotation.acknowledged` (support-only)
- `observation.created`

Every client tracks the last received sequence locally. On reconnect, the
server returns an authoritative current-state snapshot; a durable event replay
system is out of scope.

## Session and Security Model

- Generate high-entropy, non-sequential session IDs.
- Create separate short-lived support and operator join tokens.
- Put the operator token only in the one-time join URL, exchange it for an HttpOnly cookie, and remove it from the visible URL immediately.
- Authorize every API, WebSocket event, and WebMCP-triggered mutation against the caller's role.
- Allow only configured production and local-development origins.
- Treat WebMCP tool inputs as untrusted and validate them server-side.
- Do not record camera media by default.
- Avoid logging SDP bodies, ICE credentials, join tokens, image bytes, or sensitive case content.
- Expire inactive sessions automatically after a configurable TTL.
- Permit a burst of 24 anonymous session creations per client with one token
  refilled every five seconds, while retaining the independent 64-session
  process cap. This supports five consecutive scripted demo cycles without
  leaving allocation unbounded.
- Preserve the observe/assist/direct capability classes. Direct or consequential actions require visible support-representative approval.

## Build Sequence and Verification Gates

### Milestone 0 — Released framework reconnaissance

Work:

- Resolve the latest published GoFastr release through the Go module proxy/GitHub.
- Inspect its established app layout, asset pipeline, WebSocket primitives, session/auth conventions, and experimental WebMCP package from the released module artifact.
- Pin the exact release in `go.mod`; do not commit a local `replace` or `go.work` dependency.
- Record the release version and checksum used for the submission.

Gate:

- A clean module download and application build pass without a sibling checkout.
- The intended application entry point and frontend build path are known.
- No framework rewrite is proposed.

Resolved: GoFastr `v0.75.0`, downloaded as a published module release.

### Milestone 1 — Deployable shell

Work:

- Create the GoFastr application shell with `/healthz`, `/readyz`, support, and operator routes.
- Add a multi-stage Dockerfile producing a small non-root runtime image.
- Bind to `0.0.0.0` and the environment-provided `PORT`.
- Add graceful shutdown for HTTP and WebSocket connections.
- Deploy the shell publicly to the selected provider.

Gate:

- The public HTTPS URL loads on desktop and iPhone Safari.
- Health checks pass during deployment.
- The operator page can request rear-camera permission from the secure origin.

### Milestone 2 — Realtime session pairing

Work:

- Add session creation, copy/open-link pairing, role tokens, and the session WebSocket hub.
- Maintain connected-state, scene, annotation, and timeline snapshots in memory.
- Add reconnect/backoff and current-state resynchronization.

Gate:

- Creating a session produces a one-time operator link that can be copied or opened on the phone.
- Scanning it joins the operator without an account.
- Both screens show connected state.
- A support-side test annotation appears on the iPhone in under 500 ms on a normal connection.

### Milestone 3 — WebMCP vertical slice

Work:

- Prove `get_app_info()` through the existing experimental package or direct browser registration.
- Seed `router-1` and `wan-port` in the scene graph.
- Implement `inspect_scene()` and `highlight_object(object_id)`.
- Route both the human Highlight button and WebMCP tool through the same application command.
- Return structured, verifiable results from each tool.

Gate:

- Codex Sol or Terra discovers the tools in ChatGPT's built-in browser.
- Codex calls `inspect_scene()` and receives the seeded objects.
- Codex calls `highlight_object("wan-port")`.
- The iPhone displays `CONNECT HERE` over the calibrated WAN region.
- The support console attributes the action to Codex and adds it to the timeline.

This is the first complete WebMCP/realtime proof. Tag it before adding media complexity.

### Milestone 4 — WebRTC video

Work:

- Capture the operator's rear camera.
- Exchange offer, answer, and ICE candidates through GoFastr.
- Render the remote stream in the support console.
- Add ICE and peer-connection state diagnostics suitable for demo troubleshooting.
- Configure STUN through the browser ICE configuration and keep the structure ready for optional TURN URLs later.

Gate:

- Video works between two local browser pages.
- Video works from an iPhone on Wi-Fi to the deployed support console.
- Video works with the iPhone on cellular and the support console on another network.
- The selected ICE candidate pair is reported in diagnostics so failed cross-network tests are actionable.
- Reconnecting either client restores the session without creating a new case.

Do not treat a same-LAN success as proof that the direct WebRTC demo is deployable. Test Wi-Fi-to-cellular early; if the real demo networks cannot establish a direct candidate pair, add managed TURN through the existing ICE configuration seam rather than changing application architecture.

### Milestone 5 — Operator and support experience

Work:

- Make the operator view full-screen, touch-safe, and minimal.
- Ship a GoFastr-hosted manifest and iPhone home-screen metadata for a
  standalone operator shell, without caching authenticated pages offline.
- Make the support console show the live stream, connection health, scene summary, AI actions, and case timeline.
- Add clear loading, permission-denied, disconnected, reconnecting, and unsupported-WebMCP states.
- Add manual calibration or fixed-fixture controls for the demo scene.

Gate:

- A new operator can join and understand what to do without verbal setup.
- The support representative can recover from a dropped connection.
- The complete seeded-scene demo finishes consistently in under 90 seconds.

### Milestone 6 — CV enhancement, only after the vertical slice

Work:

- Add only the smallest local detection/tracking capability that makes the demo better.
- Track the approved known region with a small explainable luminance template
  and a strict drift envelope; fall back to calibrated bounds when texture or
  confidence is insufficient.
- Preserve manual calibration as a fallback.
- Escalate only explicit stills or crops to an external multimodal model.

Gate:

- CV improves the demo success rate rather than reducing it.
- The core highlight flow still works when CV is disabled.
- No continuous frame upload occurs.

### Milestone 7 — Deployment and demo hardening

Work:

- Add structured logs keyed by session ID and event type.
- Expose connection counts and ICE connection state without exposing credentials.
- Validate graceful shutdown and reconnect behavior across a deployment.
- Freeze the demo fixture, browser versions, device orientation, network plan, and fallback procedure.
- Write deployment, testing, and demo-runbook documentation.

Gate:

- Run the full demo five consecutive times without intervention outside the scripted flow.
- Run once with the iPhone on cellular and the support console on an unrelated network.
- Run once after restarting the GoFastr container.
- Verify the public repository, license, live URL, and testing instructions from an incognito session.

## Test Strategy

Acceptance behavior is covered at the closest real boundary. Do not create an integration-only test lane.

### Automated end-to-end tests

Run the actual app and use Playwright for:

- support creates a session and operator joins;
- two browser pages connect to the same session;
- WebSocket reconnect restores current scene and annotations;
- seeded `highlight_object` propagates from support to operator;
- WebMCP registration exposes the expected schemas when the API is available;
- two synthetic browser peers complete offer/answer/ICE and receive a test video track;
- permission-denied and unsupported-browser states remain usable.
- low-texture tracking remains usable through the visible calibrated fallback,
  and synthetic camera drift moves guidance without mutating shared scene state.

Use fake browser media for repeatability in CI. Keep one manual real-device matrix for iPhone Safari, ChatGPT's built-in browser, and cross-network direct ICE behavior.

### Unit tests

Use focused unit tests only for pure behavior such as:

- session state transitions;
- event sequence/resynchronization logic;
- role authorization;
- scene and annotation validation;
- normalized-coordinate transforms;
- WebMCP input/output mapping.

## Deployment Contract

### Container

- Multi-stage build.
- Final image contains only the GoFastr binary, required templates/assets, CA certificates, and timezone data if needed.
- Run as a non-root user.
- One HTTP listener serves regular requests and WebSocket upgrades.
- Implement `/healthz` and `/readyz` without dependencies on an active demo session.

### Environment variables

```text
PORT
PUBLIC_BASE_URL
ALLOWED_ORIGINS
SESSION_SIGNING_KEY
SESSION_TTL
ICE_SERVERS_JSON
DEMO_MODE
LOG_LEVEL
```

The current build embeds only Twilio's free public STUN URL in the browser client. `ICE_SERVERS_JSON` is reserved for the later configuration seam; if TURN is added, it must carry short-lived credentials rather than a committed provider secret.

### Railway profile

- Deploy from the root Dockerfile.
- Bind to `0.0.0.0:$PORT`.
- Generate or attach a public domain with automatic TLS.
- Configure `/readyz` as the deployment health check.
- Start with one replica and no volume.
- Allow clients to reconnect and rejoin after a deployment or network interruption.

### VPS profile

- Build and run the root Dockerfile on the target architecture.
- Supply the container HTTP port through `PORT`; the application defaults to
  `8080` when the host does not inject one.
- Terminate HTTPS at a reverse proxy and forward WebSocket upgrades.
- Keep one instance for in-memory session ownership.
- Increase proxy read/send timeouts only if long-lived WebSockets disconnect in testing.
- Do not add persistent storage until the application truly needs disk durability.

## Observability Required for the Demo

Log these transitions as structured events:

- session created/expired;
- support/operator joined, left, and reconnected;
- WebSocket opened/closed with reason;
- WebRTC offer/answer received;
- ICE candidate types observed: host, server-reflexive, relay;
- peer connection and ICE state changes;
- scene version changed;
- WebMCP tool invoked, succeeded, or failed;
- annotation delivered and acknowledged.

The support console should expose a compact session-health panel so a demo failure is diagnosable without opening server logs.

Implemented logs deliberately retain only bounded operational metadata:
session ID, role, event/tool name, HTTP outcome, duration, scene version,
allowlisted WebRTC state, candidate category, and payload byte count. They do
not record request bodies, observation/note text, SDP, candidate addresses,
TURN credentials, join tokens, media, or CV samples.

## Explicitly Deferred

- Native iOS application
- WebXR, SLAM, LiDAR, or spatial mapping
- Generalized object recognition
- Server-side video processing or transcoding
- Multi-party rooms
- Multiple GoFastr replicas, Redis pub/sub, or distributed session state
- Durable case history and organization/account management
- Billing, analytics, and generalized support workflows
- A polished reusable WebMCP framework abstraction
- Multi-party or recorded audio

## First Build Slice

The first coding slice should stop after proving this chain:

```text
public GoFastr deployment
  -> create session
  -> operator joins over WSS
  -> seeded wan-port scene
  -> Codex discovers inspect_scene + highlight_object
  -> highlight appears on iPhone
```

WebRTC video is developed immediately after the realtime pairing works, then included before declaring the vertical slice demo-ready. Computer vision comes last. This ordering protects the WebMCP/realtime proof from the two least deterministic parts of the product: camera networking and visual detection.

## Remaining external validation inputs

- The preferred deployment target: the existing VPS, with Railway as an alternative.
- The iPhone model/iOS version and the desktop ChatGPT app version used for the demo.
- The actual Wi-Fi/cellular networks planned for the recording, so direct ICE can be proven before submission day.

## Primary References

- [OpenAI Site tools / WebMCP](https://learn.chatgpt.com/docs/webmcp)
- [GoFastr repository](https://github.com/DonaldMurillo/gofastr)
- [Railway WebSocket deployment guidance](https://docs.railway.com/guides/socketio)
- [Railway health checks](https://docs.railway.com/deployments/healthchecks)
- [Railway Dockerfile deployment](https://docs.railway.com/builds/dockerfiles)
