# Demo video script

Target: 75–90 seconds, one continuous take if possible. Record the support
desktop and the iPhone separately or use a picture-in-picture layout. Use
`https://webmcp.donaldmurillo.com` for the landing shot. Hide the QR URL/token
from the final cut.

The close-up, snapshot/compare, and operator-confirmed cable-moved shots are in
the checked-in build and automated browser suite. Keep the fallback shot ready
for public-network or device-specific failures.

| Time | Shot | Presenter line / on-screen proof |
| --- | --- | --- |
| 0:00–0:07 | Support desktop: public landing page → **Start a field session**. | “Field Assist opens an ephemeral shared support case.” |
| 0:07–0:17 | Split shot: support QR, iPhone scans, operator page redirects, camera permission. | “The operator joins with a one-time link; the token leaves the address bar.” |
| 0:17–0:29 | iPhone points at router; support console shows remote video and the connection-status popover. | “The camera is negotiated browser-to-browser; the server carries signaling.” Show Signaling open, ICE connected/completed, and Media receiving only if observed. |
| 0:29–0:37 | Codex on support page calls `inspect_scene`. | “The copilot receives structured objects, including `wan-port`.” |
| 0:37–0:44 | Codex calls `highlight_object({objectId: "wan-port"})`; cut to iPhone overlay. | “It places `CONNECT HERE` where the operator needs to act.” Show timeline attribution. |
| 0:44–0:52 | Call `request_closeup({objectId: "wan-port"})`; iPhone moves closer. | “The copilot asks for the view it needs.” |
| 0:52–1:00 | Capture `before-cable-move` and show its ID/label. | “We keep a semantic before state, not a continuous recording.” |
| 1:00–1:10 | iPhone close-up: modem cable moves LAN → blue WAN; operator taps **Done — cable moved**. | “The human confirms the physical step.” |
| 1:10–1:20 | Support captures after snapshot; Codex compares the two returned snapshots. | “The comparison reports the object-level change.” Show only fields the final tool returns. |
| 1:20–1:30 | Timeline and both screens; clear guidance. | “Visible guidance, an accountable operator, and a structured case record.” |

## Fallback shot

If QR, camera, WebMCP, ICE, or a tool fails, keep the take
truthful:

1. Show **Copy** for QR failure, or **Start rear camera** for a blocked camera.
2. Use the visible **Highlight** button for a browser without WebMCP.
3. Show `inspect_scene` → `highlight_object` and the `CONNECT HERE` overlay if
   signaling is alive.
4. If ICE never connects, label the media leg “not verified” and do not call it
   direct WebRTC. If close-up/snapshot/compare is absent, omit those shots and
   say the build demonstrates the seeded-scene highlight path.

## Recording notes

- Use the same public HTTPS host, iPhone model, iOS/Safari version, and network
  pair documented in the deployment checklist.
- Keep the support page and iPhone in the foreground; camera permission prompts
  are easier to understand than an unexplained black video tile.
- Avoid showing session tokens, private URLs, TURN credentials, browser
  developer-console secrets, SDP, or ICE candidate details.
- Add captions for `inspect_scene`, `highlight_object`, and the overlay so the
  WebMCP-to-physical link is legible without audio.
