# Two-device demo runbook

Target duration: 60–90 seconds, one support desktop and one operator iPhone.
The support page is the page Codex uses in the desktop app's built-in browser; the
operator page is opened in iPhone Safari.

For the WebMCP leg, use a WebMCP-capable Codex model in the built-in browser.
Update the desktop app and check
the address-bar **Site tools** → **Available site tools** menu before starting.

For rehearsals, temporarily set `WEBMCP_DEBUG=true`. Codex can then call
`debug_connection_report` and `debug_ping_operator` to diagnose the deployed
browser/phone path without exposing raw signaling or credentials. Return the
flag to `false` before the submission recording so judges see the fixed
twenty-five-tool product surface.
WebMCP is a page-provided capability; it is not the same connection as an MCP
server. The [official Site tools documentation](https://learn.chatgpt.com/docs/webmcp)
describes this browser/model requirement.

The public deployment and automated two-browser fake-media path have passed at
`https://webmcp.donaldmurillo.com`; a real iPhone cellular run remains a manual
recording check. The checked-in manifest and automated browser suite verify
twenty-five WebMCP tools spanning app
orientation, scene/object/case inspection, semantic guidance, snapshots,
timeline observations, clearing, visible-object registration, and deterministic
next-step suggestion. The TV-controller flow uses only Codex, the live peer
video, and page-provided WebMCP tools. OpenCV and Depth Anything keep the final
arrow aligned without sending camera frames through the application server.

## Before the timer starts

1. Put a television with a visible manufacturer mark and accessible physical
   controls in the camera fixture. Know the real control location so the final
   arrow can be verified rather than merely admired.
2. Use the public HTTPS URL, not a LAN HTTP address. Put the iPhone on
   cellular with Wi-Fi off and put the support desktop on a different network.
3. Keep the support browser and iPhone visible to the presenter. Close other
   tabs that could steal camera permission. Have the copy-link fallback ready.
4. Inspect `/__gofastr/webmcp/tools.json` first and use the schemas
   returned by that manifest. Do not guess a payload from this document.
5. Do not confuse the barcode dependency with the page tools: although
   `barcode.donaldmurillo.com` may offer `/mcp`, this app's QR request is REST
   authenticated `POST /api/v1/generate` when `BARCODE_API_KEY` is configured,
   or anonymous `POST /api/generate` otherwise. A QR-service MCP endpoint does not make Field Assist
   WebMCP tools available.

## The 90-second path

| Time | Presenter action | Visible proof / narration |
| --- | --- | --- |
| 0:00–0:08 | On the support desktop, open the public landing page and create a session. | The support console starts with an empty scene and no assumed issue. |
| 0:08–0:18 | Scan the QR with the iPhone and follow the one-time link. | The phone asks how to start before camera capture. The support page knows only that an operator joined. |
| 0:18–0:25 | On the phone, choose **I lost my controller — help me control my TV**, then allow rear-camera access. | `inspect_scene({})` exposes only the resulting user words and conversation—not a preset ID or TV workflow switch. |
| 0:25–0:37 | Call `get_app_info`, keep its `contextVersion`, then use `send_operator_instruction` for every camera/hold step. Inspect the remote-video pixels and register only the television bezel with `register_scene_object`, excluding the wall, stand, and media console. | The app supplies its operating contract and live request directly through WebMCP. The backend-controlled instruction appears in the amber phone banner while the support scene gains a bezel-only television object. |
| 0:37–0:44 | If identification needs to be visible, call `annotate_object` with **THIS IS YOUR TV**; do not place a precision arrow on the broad television object. | A temporary label identifies the device without pretending that an actionable control has been localized. |
| 0:44–0:57 | Let Codex read the manufacturer/model when visible. If it is unclear, call `ask_operator` with bounded choices. Use Codex web research against official manufacturer guidance to locate the physical controls. | The operator's answer receives a visible delivered receipt; support also shows the received answer. |
| 0:57–1:07 | Register the confirmed physical control as its own `device-control`, even when it lies inside the television bezel, then call `draw_arrow` on that control with **POWER BUTTON**. | The phone shows the backend-controlled banner and one amber arrow anchored to the verified control rather than an estimated point on the parent device. |
| 1:07–1:20 | Move the phone closer, farther, and sideways while keeping the TV visible. | Desktop Depth Anything seeds a target-relative 3D reference; OpenCV PnP projects the same target-plane arrow as the camera moves. Phone OpenCV and DeviceOrientation bridge short gaps. On ambiguous geometry the arrow holds briefly, then disappears and requests reacquisition rather than drifting confidently. |
| 1:20–1:30 | Use the physical TV button, then answer a streamed verification question if needed. | Both operator and support visibly confirm the answer was delivered. End on the live arrow and accountable timeline. |

When a hands-busy instruction is finished, choose **Remove** beside **Compose**.
This clears the backend value on both devices; do not
leave stale movement guidance visible for the next step.

The first pass should fit in 90 seconds when the two tabs are prepared. Tool
latency, a camera prompt, or a failed network path is a reason to use the
fallback, not a reason to fabricate a success state.

For free-form rehearsals, create a fresh live session and enter a different
object problem each time. Use the phone chat bubble to add details, verify the
exact messages in `inspect_scene`, and reply with `send_operator_message`.
`get_app_info` and `suggest_next_step` remain identical across these sessions;
only user text, observed pixels, and registered objects change the work.

During tracked guidance, the second operator status pill may show **Guidance
tracking locked**, **Following camera drift**, or **Using calibrated region**.
These describe local overlay stabilization only; none is evidence that a
physical control was pressed.

### Tool-call reference

These calls are registered and covered by the current automated suite:

```text
context = get_app_info()
inspect_scene()
register_scene_object({ label: "Television", kind: "television", bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.7 }, baseSceneVersion: 1, contextVersion: context.contextVersion })
annotate_object({ objectId: "<television-id>", text: "THIS IS YOUR TV", contextVersion: context.contextVersion })
send_operator_instruction({ title: "SHOW THE CONTROLS", detail: "Keep the television's lower edge centered.", contextVersion: context.contextVersion })
register_scene_object({ label: "TV power button", kind: "device-control", bounds: { x: 0.72, y: 0.66, width: 0.04, height: 0.04 }, baseSceneVersion: 2, contextVersion: context.contextVersion })
draw_arrow({ objectId: "<power-control-id>", text: "POWER BUTTON", anchor: { x: 0.5, y: 0.5 }, contextVersion: context.contextVersion })
clear_annotations({ contextVersion: context.contextVersion })
```

Always call `get_app_info` before the first mutation. It is the app-provided
context handshake, not optional narration. The manifest is authoritative for spelling (`capture_snapshot`
versus another name) and for snapshot/compare inputs. Never put session tokens,
SDP, ICE credentials, or camera bytes into narration or a screen recording.

## Graceful fallback branch

Keep the audience-facing story intact while being honest about what failed:

- **QR image fails:** click **Copy**, open the copied secure link on the
  iPhone, and say “The QR provider is unavailable; the same one-time join link
  is still available.” The QR handler explicitly exposes this copy-link path.
- **Camera permission is blocked:** tap **Start rear camera**, allow access,
  and retry. If the iPhone still cannot provide a track, show the operator page
  and the semantic overlay/timeline only; label the media leg unverified.
- **WebMCP is unavailable:** use the visible support target builder and
  the manual controls. The human control and WebMCP mutation share the same
  authenticated HTTP boundary in the current build. Do not claim that Codex
  discovered a tool when it did not.
- **ICE remains `checking` or becomes `failed`:** open the connection-status
  popover and check Signaling, ICE, and Media. During debug builds, use
  `debug_connection_report` for the extended metadata-safe report. Continue
  with the join, structured scene, and overlay proof if the signaling path is
  alive, but call it a signaling/semantic fallback—not a direct WebRTC demo.
  Provision TURN before the next recording.
- **A tool fails at recording time:** use its visible manual control where
  available, show the returned error honestly, and finish the verified
  `inspect_scene` → `register_scene_object` → `draw_arrow` path.
- **Tracking becomes ambiguous:** return the physical controls to the frame and
  recalibrate the tight control target. Never leave a drifting arrow visible.

## Stop conditions and reset

- Do not reuse a stale join URL after the operator token has been consumed.
- Start a new session if the two roles are in different session IDs or if the
  two-hour in-memory session has expired.
- Close both pages after the take so their camera tracks and WebSockets stop.
- Record only states observed on screen. A healthy `/healthz` response does not
  prove camera connectivity, and a same-LAN WebRTC pass does not prove the
  cellular path.
