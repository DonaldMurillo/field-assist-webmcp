# Architecture Notes

## Released GoFastr only

The application pins `github.com/DonaldMurillo/gofastr v0.75.0` in `go.mod`. Development may inspect published module source for API documentation, but the build must not use a sibling checkout, an absolute `replace`, or a committed `go.work` file. This keeps Railway, VPS hosting, CI, and another developer's machine on the same framework artifact.

The `gofastr-plugins v0.4.1` release was reviewed only as a reference for its established boundary: Go owns the server-rendered document and same-origin asset delivery, while browser-only behavior ships as embedded assets. Field Assist does not import that module. Its own trusted host-page plugin uses GoFastr `pluginhost.AssetServer` and `uihost.WithExtraScripts` for the camera/WebRTC/overlay bundle because those APIs require the top-level page.

The same released plugin asset server owns the web app manifest, SVG/PNG app
icons, and Apple home-screen icon. GoFastr `uihost` owns the favicon, theme
color, and safe head injection. There is intentionally no service worker:
offline caching cannot preserve the authenticated session, WebSocket, or
WebRTC contract and could retain a stale authority-bearing page.

## GoFastr-owned surfaces

- UI host, page routes, and semantic HTML screens
- Trusted host-page plugin registration, static-asset embedding, and same-origin delivery
- Typed HTTP request binding and JSON responses
- WebSocket upgrade implementation and signaling transport
- Health and readiness endpoints
- Graceful shutdown and lifecycle hooks
- Browser WebMCP registration bridge
- Accessible copy-to-clipboard control and its lazy runtime behavior

## Browser-owned surfaces

- `getUserMedia` rear-camera capture with microphone access denied by policy
- `RTCPeerConnection` media negotiation
- ICE candidates with authenticated environment-driven STUN/TURN configuration
- Media element attachment
- Normalized-coordinate annotation overlays
- Capability-gated OpenCV homography tracking with Canvas template fallback
- Local Depth Anything V2 Small inference through ONNX Runtime Web
- A compact support status popover for signaling, ICE, and media state
- Extended debug-tool diagnostics derived from `RTCPeerConnection.getStats()` without exposing SDP, addresses, or credentials

This is not a second application framework. The browser script calls the same typed Go commands used by WebMCP and receives the same GoFastr event envelopes as every participant.

## Session security

Each session receives independent 256-bit support and persistent operator tokens plus a separate 256-bit one-time operator join token. The support token is set directly in an HTTP-only cookie when the session is created. The join token appears in the URL exactly once, is atomically consumed server-side, exchanged for the distinct persistent operator cookie, and removed from the visible URL by a `303` redirect.

WebMCP handlers authorize the support cookie rather than trusting the `X-Gofastr-WebMCP` marker. The marker is used only to attribute successful actions to Codex in the timeline. GoFastr mounts the bridge and hashed asset route, but the returned script URL is rendered only by the authenticated support screen; landing and operator documents advertise no executable tools. The public `/tools` catalog and `/tools/llm.md` discovery page are generated from the same Go declarations, but omit invocation paths and input schemas. WebSocket connections authenticate the same role cookies before upgrading and accept only an explicit WebRTC signaling event allowlist.

Cookie-authenticated POST routes also require the request `Origin` (or a
same-origin `Referer` fallback) to match the externally visible request origin.
Anonymous session creation uses GoFastr's released rate limiter, the store caps
active sessions at 64, and per-session semantic collections are bounded.

## Media boundary

GoFastr transports signaling JSON, scene state, annotations, and case activity. It does not receive or relay camera frames. After signaling, the operator's video track moves from the phone browser to the support browser. The peer connection negotiates video only, and the response header explicitly denies microphone access.

The default build uses Twilio's public STUN endpoint. `ICE_SERVERS_JSON` can add managed TURN without changing the session protocol. The browser retrieves this configuration from an authenticated same-origin endpoint so TURN credentials are not compiled into the public asset. Real cellular-to-Wi-Fi validation still determines whether the final demo can be described as direct or requires relay.

## Live scene and Codex boundaries

The explicitly selected router mode preserves the deterministic submission fixture. A live
session is the default and starts with an empty, versioned scene and a generic support
workflow. Support can name a target and drag a normalized region over the
incoming video. GoFastr stores only the resulting label, kind, and coordinates;
the camera frame remains peer-to-peer and is not used to invent server-side
object identity. The new object is then available to the same authenticated
WebMCP inspection and annotation tools as seeded objects.

Codex operates only through the authenticated WebMCP tools registered by the
support page. The application has no embedded model endpoint and never uploads
camera frames to a separate inference service. Reversible visual actions remain
on the WebMCP/manual command surface, while human-only physical approval and
case resolution remain unavailable to Codex.

The operator's starter choice is a phone-only convenience. The server converts
it to the same plain `OperatorIssue` summary used by free-form entry and does
not expose preset IDs or scenario modes to support or Codex. There is no
scenario-specific branch in `get_app_info` or `suggest_next_step`; live-session
behavior comes from user text, the live frame, and registered scene objects.

Both roles receive a bounded, backend-authoritative conversation of up to 64
messages. The phone posts through an operator-only route, human support through
a support-only route, and Codex replies with `send_operator_message`; sender and
actor attribution are derived from session authority rather than client input.
`inspect_scene` exposes the same ordered messages to Codex. Reconnect snapshots
restore the thread, while camera media remains peer-to-peer and unrecorded.

Codex can publish a concise, scene-version-bound room summary and up to eight
factual landmarks after inspecting the live frame. That context stays on the
authenticated support surface and is intentionally excluded from operator
snapshots and events. It helps Codex keep spatial reasoning coherent without
claiming server-side perception or transmitting a camera frame through the Go
service.

`ask_operator` can publish one pending question with two to four server-issued
choices. The phone can return only one of those choice IDs through its
operator-authenticated endpoint; free-form replies use the separate conversation
route. A question is single-answer, is shared in both role snapshots, and
must be answered before Codex can replace it. The response is recorded in the
support timeline. On receipt, the phone replaces the choices with an explicit
delivery acknowledgement naming the selected answer and confirming that Codex
and support received it; the support surface independently changes to an
answer-received state.

`send_operator_instruction` owns a separate current session value for the
amber phone banner. Codex uses it for every hands-busy movement, timing, and
hold instruction instead of relying on chat; the support console exposes a
human composer over the same authenticated command, with server-derived actor
attribution. Both role snapshots and the
`operator.instruction_updated` event carry the same bounded title and detail,
so reconnects restore the banner and tracking or annotation clearing cannot
silently replace it. Human support can also remove the current banner through
the support-authenticated control beside Compose; that mutation clears the
canonical session value and broadcasts the same event with a null instruction
so both surfaces remove it together.

Explicit movement and view instructions remain the phone's primary command even
while spatial tracking is uncertain. In that state the object marker is hidden,
the instruction explains that tracking is paused until the camera settles, and
depth movement uses the unambiguous words `IN` and `OUT` instead of bare plus or
minus symbols. Every assistant-authored annotation keeps the same command title
on the support and operator surfaces for its whole lifetime. Local tracking
is telemetry input only: the backend validates, stores, and broadcasts the
canonical `sceneTracking` record, and both UIs derive command hints and tracking
status exclusively from that record. No optimistic client status may replace
the canonical instruction or masquerade as a backend-confirmed transition.

Every object is registered from remote-video pixels and must hug only the
physical target, excluding adjacent structures. Those bounds are a provisional
localization seed with confidence below `1`; they are never rendered as precision
truth before browser tracking locks and the backend accepts the telemetry. A
registered `device-control` automatically records the smallest explicitly
registered containing device as its tracking reference. OpenCV and Depth Anything
track that feature-rich device plane while projecting the child control point,
so a tiny button does not become the visual template. Every arrow remains
constrained to its registered control's `[0,1]` coordinate square. On durable
loss, the runtime emits no quad or anchor and both roles suppress the marker
instead of falling back to its original screen coordinates. Reflective display
kinds select a tracking profile optimized for changing glass, but they do not
select an assistant flow.

## Semantic physical-action loop

The explicitly selected deterministic test fixture models a router, modem, cable, occupied LAN port,
empty WAN port, explicit relationships, and versioned normalized calibration.
WebMCP can inspect, annotate, point, request a bounded semantic operator view,
request camera movement, publish room context, ask bounded operator questions, capture structured
snapshots, compare them, and reason over a bounded case workflow. Codex cannot
approve the physical action: human support approves one active WAN guidance
item. When guidance is actually rendered, the operator document batches its
server-issued annotation IDs into an operator-authenticated acknowledgement.
GoFastr validates the current scene version and publishes delivery receipts
only to support; these receipts prove UI delivery, not human compliance or a
physical result. During active object-bound guidance, the support console lazily loads
the official OpenCV 5.0.0 browser release in a dedicated worker. ORB feature
matches first feed a RANSAC homography for fast planar fallback. Once a paired
Depth Anything inference frame is ready, the support browser back-projects its
global ORB landmarks into an immutable target-relative 3D reference and solves
each later camera pose with `solvePnPRansac`. `projectPoints` then projects the
same target-plane corners and guidance point into the current camera view. The
pose path requires at least ten spatially distributed inliers, a 45% inlier
ratio, bounded reprojection RMS, a convex quad with at least 20% and 0.6% of the
frame area still visible, and an unchanged video aspect ratio. Projected corners
may extend one frame width beyond the viewport so a partly cropped target stays
world-relative. The raw quad remains available to the solver while only its
viewport intersection is drawn. If the guidance point itself leaves the view,
the arrow is hidden instead of being clamped to a screen edge. One or two
consecutive failed samples, including visibility-floor misses, hold the last
good anchor; a third failure clears it. Reflective-plane targets also keep
their immutable OpenCV recovery reference instead of letting the appearance-
based Canvas fallback reseed it after a durable loss. Homography remains the
fallback, not a claim of world anchoring. If a fast move rejects an otherwise
valid pose or leaves the IMU-guided search region stale, one full-frame ORB
recovery pass runs with the
same inlier, convexity, visibility, scale, and aspect gates. During that bounded
recovery only, the center-position envelope expands to permit the target to
return elsewhere in the frame; normal tracking keeps the strict center gate. A
successful fully visible match is re-sampled from the trusted target
neighborhood before it becomes the next rolling planar reference. Partial views
retain the last fully visible descriptor set for later reacquisition; an unsafe
match stays lost. A separate immutable calibration descriptor set is reserved
for broad recovery, so gradual rolling updates cannot erase the richer view
needed after a complete crop or occlusion. Scene
objects identified as televisions, monitors, displays, screens, or reflective
surfaces use a reflective-plane feature profile. That profile removes the
changing glass interior from both homography and pose feature selection. The
homography reference is limited to the registered object's perimeter and wider
bottom control band, with only 2% padding, so nearby furniture cannot become
part of the display plane. The separate global PnP path intentionally retains
room context outside the display to avoid a coplanar pose solve; accepted pose
geometry is still checked against the registered target. The profile also
avoids using monocular depth as a calibration feature mask on glossy glass,
where a reflection can receive a misleading depth; depth still validates the
accepted geometry.
All OpenCV heap allocations are explicitly released after each sample.

Alongside the immediate OpenCV lock, a second worker initializes the released ONNX Runtime Web
1.29.0 runtime and a revision-pinned community ONNX conversion of the official
Apache-2.0 Depth Anything V2 Small model. Capable browsers try the 19 MB q4f16
graph through WebGPU; other browsers use
the 27 MB int8 graph through single-threaded WASM. Inference runs at most once
every 2.2 seconds on a 518-wide, multiple-of-14 RGB frame. Each inference is
reduced to a 24-column target-relative camera-Z field: the selected target
median is `Z=1`, while all other values remain non-metric relative depth. The
exact inference pixels and field share a frame ID before transfer to separate
workers. That paired frame seeds room landmarks plus a canonical target plane;
later OpenCV pose solves move the camera around that immutable local reference.
The field also masks ordinary homography calibration features and asynchronously
checks five interior quad samples. The reflective-plane profile uses stable
perimeter/context features instead of applying that calibration mask. A fixed
initial quad lets the fallback fusion layer
compare image scale with the model's relative-depth change. Two consecutive fresh conflicts suppress
the arrow and request recalibration; missing or low-confidence depth leaves an
honest OpenCV-only result. Only bounded overlay geometry—the four projected
corners, which may extend at most one viewport beyond the frame, and the
projected object-relative guidance point—plus target depth, confidence, and a relative
depth cue may join tracking telemetry. Frames, depth maps, feature descriptors, and
homographies, world landmarks, and camera poses never leave the support browser.

The original Canvas tracker remains active on the support console while OpenCV
loads and whenever advanced perception is unavailable. The phone keeps only its
lightweight Canvas fallback and bounded orientation bridge. Tracking sources use
an explicit authority order: fresh PnP + depth geometry wins over homography +
depth, homography, and Canvas. Repeated identical observations refresh a
three-second lease without broadcasting redundant geometry; when that lease
expires, the next weaker source can take over. This prevents a delayed healthy
planar sample from replacing a fresh world-relative arrow; an explicit durable
loss still fails closed immediately.
For an arrow, its object-relative point uses the paired Depth Anything sample at
the control when confidence and depth bounds are trustworthy; the containing
device corners remain on the normalized reference plane. Non-reflective controls
use this depth-aware path; reflective targets retain the stable plane fallback.
This preserves parallax
for controls on a front lip or button face instead of incorrectly forcing them
onto the device's top plane. When pose is unavailable,
the same point uses the target homography fallback. A bounded,
short-lived DeviceOrientation correction bridges only the interval between
fresh Mac visual corrections; it clears on loss, staleness, and teardown. Bounded
orientation samples use an unordered, latest-only WebRTC data channel with
sequence and backpressure guards; they are never stored, broadcast, or sent to
the Go server.
No support timeline, room context, diagnostic payload, or image data crosses
that role boundary. Canvas
samples a 24×18 luminance template over
a bounded translation/scale search and uses distributed whole-frame motion to
suppress unsafe geometry. Canvas and fully visible homography paths retain their
narrow envelope. A partially visible homography may translate farther only while
its raw quad keeps the calibrated scale/aspect and passes the server's
independently recomputed visibility floor. The validated PnP source may traverse
more of the normalized frame and 0.3–3× target scale. Shared
`relativeDepth = 1 / scale` remains
a non-metric apparent-depth value; model depth is separately identified as an
advisory monocular estimate, never meters, WebXR anchoring, or device LiDAR.
The support console reports only enhanced engine provenance, tracking status,
confidence, clipped visible bounds, bounded raw quad/projected point, visible
fraction, visual scale, and scalar relative-depth
evidence to a typed support endpoint. The phone's typed operator endpoint remains
limited to its local Canvas geometry and bounded DeviceOrientation bridge without
OpenCV or depth inference.
GoFastr binds that ephemeral telemetry to the current approval and scene
version, shares only the bounded overlay record with the operator, and includes
it beside (not in place of) the authoritative object in `inspect_object`. Two consecutive unreliable
matches become an explicit `recalibration_required` state: either confidence is
below 0.5, or it is below 0.72 while the candidate also makes a large center or
scale jump. Total loss becomes `reacquire_required`. Both suppress the
potentially misplaced overlay.
Codex can inspect the live view and call `recalibrate_object` with corrected
normalized bounds. That mutation preserves the semantic object ID and graph
relationships, advances the scene version, and invalidates tracking, visual
activity, delivery receipts, and any approval bound to the previous geometry.
The detector separately reports
one stable-change signal, which GoFastr records while human confirmation is
still pending.
The operator then consumes the scene-bound approval exactly once. That two-party
handoff updates the graph and relationship, broadcasts
`scene.updated`, captures `after-cable-move`, and leaves an accountable timeline
record. A support-authenticated manual verification command then resolves the
case; final resolution is deliberately absent from WebMCP. This is a role/tool-
surface boundary, not cryptographic proof of a human gesture or general object
recognition. No camera bytes or CV crops are transmitted or stored.

## Persistence and scaling

Sessions expire after two hours and live in memory. That is deliberate for the one-pair hackathon demo: it removes a database from the failure surface and keeps case/video data ephemeral. The process caps active sessions, semantic snapshots, annotations, and timeline items so an anonymous demo cannot grow memory without bound. The deployment must run one replica. Multiple replicas require a shared session/event store and are explicitly deferred.

## Verified implementation notes

Non-obvious framework and deployment lessons are kept in [`agent-notes.md`](agent-notes.md). In particular, preserve the GoFastr dynamic-screen `SetParams` contract, same-origin camera permission, and denied microphone policy when extending routes or security headers.
