# Deployment guide

This application is a one-pair demo service. The root `Dockerfile` builds a
Go 1.27 binary and runs it as a non-root user in a distroless image. The
application serves the landing page, support console, operator page, HTTP API,
WebSocket signaling, and WebMCP assets from one origin.

The current VPS deployment is live at
`https://webmcp.donaldmurillo.com`. Automated HTTPS, WSS, QR-proxy, fake-media
WebRTC, and workflow checks pass there. Codex's actual in-app browser also
discovers all twenty-five WebMCP tools and successfully invokes `inspect_scene`.
Real iPhone/cellular and final recording checks remain deliberately separate
below.

## Deployment contract

- Run one application instance. Sessions, scene state, annotations, snapshots,
  and the case timeline are held in memory; a second replica cannot see the
  first replica's session.
- Do not add a volume for the demo. There is no application requirement for
  durable media or case storage, and the browser camera stream is not recorded
  by GoFastr.
- Use the same public origin for the support page, operator page, HTTP tools,
  and WebSocket signaling. The browser derives `wss://` from an HTTPS page.
- Forward WebSocket upgrades and keep the proxy connection open. A provider
  health check alone does not prove that a long-lived `/ws/sessions/...`
  connection works.
- Use the checked-in root `Dockerfile` for Railway or VPS deployments so every
  host builds and runs the same non-root container image.
- Retain the JSON structured logs for the demo window. Tool logs contain only
  names, source, status, outcome, and duration; WebRTC logs contain only roles,
  event types, allowlisted states/candidate categories, and byte counts. Never
  enable proxy request-body logging for the app or QR processor.
- The process admits at most 64 active sessions. Session creation is also
  rate-limited with GoFastr's released in-memory token bucket. Each session
  retains at most 50 semantic snapshots and 32 active annotations.

The checked-in provider files are:

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage Go build with a non-root distroless runtime; it exposes `8080` as metadata but does not set `PORT`. |
| `railway.json` | Dockerfile builder, `/readyz` health check, and restart policy for Railway. |

## Railway

1. Create a Railway service from the repository. If the repository is part of
   a larger project, set the service root to the directory containing the
   Dockerfile and `railway.json`.
2. Let Railway use the root Dockerfile. The checked-in `railway.json` selects
   the Dockerfile builder and configures `GET /readyz` as the health check with
   a 120-second timeout.
3. Generate or attach a public domain in the service Networking settings. Use
   that HTTPS origin for `PUBLIC_BASE_URL` and `ALLOWED_ORIGINS`.
4. Keep the service at one replica. Allocate at least the demo budget of
   roughly 0.5 vCPU and 512 MB RAM if those controls are available; this is a
   deliberately comfortable sizing recommendation. The final distroless image
   is about 6.53 MB and an idle local container smoke test used about 15.2 MiB;
   that observation is not a provider load benchmark.
5. Keep Railway's injected `PORT` value. The process must bind to the value
   Railway provides rather than to a hard-coded public port.
6. Add the runtime variables in the table below. Put TURN credentials and any
   other secrets in Railway's secret-variable mechanism, never in the
   repository or a video recording.
7. Deploy, then run the public smoke checks in this document. A successful
   deployment is not established until the HTTPS, WSS, QR, camera, and
   cross-network checks have been run.

Railway's deployment health check is `/readyz`; also check `/healthz` manually.
The health endpoints do not require an active demo session. The public domain
must pass WebSocket upgrades to `/ws/sessions/{sessionId}` without buffering or
an HTTP timeout that is shorter than the session.

## VPS hosting

1. Build the root `Dockerfile` for the VPS architecture and run exactly one
   container instance while session state remains in memory.
2. Supply `PORT` through the container environment; `EXPOSE 8080` is metadata,
   not a hard-coded listener override.
3. Put the container behind an HTTPS reverse proxy that forwards WebSocket
   upgrades and preserves long-lived connections to `/ws/sessions/...`.
4. Set the runtime variables below through the host's secret/environment
   mechanism. Never commit TURN credentials, barcode credentials, or tokens.
5. Check `/healthz` and `/readyz`, then test support and phone roles through the
   externally visible HTTPS origin. If signaling closes while idle, increase
   the reverse proxy's read/send timeouts and repeat the two-device test.

The origin in `PUBLIC_BASE_URL`, the QR link, and the browser address bar must
all agree on the externally visible HTTPS host.

## Runtime configuration

`config.go` parses these variables at startup. `main.go` applies them to the
listener, session store, public QR URL, WebSocket origin policy, authenticated
browser ICE configuration, demo scene, GoFastr JSON logger, and barcode client:

| Variable | Default and accepted form | Deployment guidance |
| --- | --- | --- |
| `PORT` | `8080`; integer `1`–`65535` | Let the hosting platform provide this when possible. The container must listen on `0.0.0.0:<PORT>`. |
| `PUBLIC_BASE_URL` | Unset; absolute HTTPS URL outside loopback, with no query or fragment | Set to the public HTTPS origin, for example `https://field-assist.example.com`. Plain HTTP is accepted only for `localhost` or a loopback IP. Use the origin, without a path, even though the parser permits a path when `requireNoPath` is false. |
| `ALLOWED_ORIGINS` | Unset; comma-separated absolute HTTP(S) origins, each with no path, query, or fragment | List exact trusted origins, such as `https://field-assist.example.com`. Do not use `*`; do not include a path. |
| `SESSION_TTL` | `2h`; Go duration from `5m` through `24h` | Keep `2h` for the demo unless a shorter test window is intentional. A session is ephemeral and in memory. |
| `ICE_SERVERS_JSON` | `[{"urls":"stun:global.stun.twilio.com:3478"}]`; one to eight server objects | Use compact JSON. Each server accepts one to eight `stun:`, `stuns:`, `turn:`, or `turns:` URLs. Keep TURN usernames and credentials out of source control. |
| `DEMO_MODE` | `true`; boolean | Keep `true` to offer both the default deterministic router story and explicitly selected live sessions. `false` forbids the seeded fixture and makes every session live/empty. |
| `LOG_LEVEL` | `info`; `debug`, `info`, `warn`, or `error` | Use `info` for a recording. Temporarily use `debug` only while diagnosing a test, and never log SDP, ICE credentials, join tokens, or camera bytes. |
| `BARCODE_SERVICE_URL` | `https://barcode.donaldmurillo.com`; absolute HTTPS URL outside loopback | This is the trusted QR processor; the handler sends it a ten-minute, single-use join URL through the keyed `/api/v1/generate` route when configured, or anonymous `/api/generate` otherwise. Disable request-body logging there. Plain HTTP is accepted only for local loopback development. |
| `BARCODE_API_KEY` | Unset; registered key beginning with `btk_` | Recommended for deployed demos. The server switches to `/api/v1/generate` and sends the key only as `Authorization: Bearer`; it is never exposed to either browser or logged. Keep anonymous mode for local development only. |
| `WEBMCP_DEBUG` | `false`; boolean | Set `true` only during deployed development to add `debug_connection_report` and `debug_ping_operator`. Set `false` before the submission recording to restore the fixed twenty-five-tool manifest. Debug reports exclude raw SDP, ICE addresses/candidates, TURN credentials, cookies, join tokens, and media. |

The configuration parser and runtime wiring are covered by Go tests. The
browser fetches ICE servers from authenticated `GET /api/session/ice-config`;
TURN credentials are not embedded in the public JavaScript asset. Replace the
TURN placeholders in this example with short-lived provider credentials:

```text
PORT=8080
PUBLIC_BASE_URL=https://field-assist.example.com
ALLOWED_ORIGINS=https://field-assist.example.com
SESSION_TTL=2h
ICE_SERVERS_JSON=[{"urls":["stun:global.stun.twilio.com:3478","turns:turn.example.net:5349?transport=tcp"],"username":"<ephemeral-user>","credential":"<ephemeral-credential>"}]
DEMO_MODE=true
LOG_LEVEL=info
BARCODE_SERVICE_URL=https://barcode.donaldmurillo.com
BARCODE_API_KEY=<registered-btk-key>
WEBMCP_DEBUG=false
```

If only the released public STUN path is available, omit the TURN object and
use:

```text
ICE_SERVERS_JSON=[{"urls":"stun:global.stun.twilio.com:3478"}]
```

## WebRTC, STUN, and TURN

The checked-in browser client starts with the released public Twilio STUN
endpoint `stun:global.stun.twilio.com:3478`. STUN helps the two browsers learn
server-reflexive candidates; it is not a media relay and cannot cross every
NAT, firewall, or carrier network. GoFastr carries signaling JSON over WSS;
the operator camera track is intended to travel directly between browsers.

For a reliable cellular/NAT demonstration, deploy or obtain a managed TURN
service before recording. Add `turn:` or `turns:` URLs and short-lived
credentials to the ICE configuration seam, prefer `turns:` when the service
supports TLS, and keep the credential lifetime long enough for a single
session. TURN relays media and therefore consumes relay bandwidth; budget and
secure it accordingly. Do not call a connection “direct” when diagnostics show
that a relay candidate was selected.

The decision rule is simple:

1. Test the exact iPhone-on-cellular and support-desktop-on-another-network
   pair.
2. If ICE reaches `connected`/`completed` and the support page receives a live
   track, open the connection-status popover and confirm Signaling, ICE, and
   Media. In a debug build, call `debug_connection_report` to record the
   metadata-safe candidate types and relay flag, then test again after
   reconnecting either tab.
3. If ICE remains `checking`, reaches `failed`, or only works on the same LAN,
   treat STUN-only as insufficient for that network pair. Provision TURN,
   configure it through the verified ICE path, and repeat the test.

Do not infer media connectivity from a healthy HTTP response. Check the support
console's Signaling, ICE, and Media statuses together.

## Public HTTPS/WSS smoke checks

Run these against the real public host after TLS is configured; replace
`PUBLIC_HOST` with the host only, not a path:

```sh
curl -fsS -o /dev/null -w '%{http_code}\n' https://PUBLIC_HOST/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' https://PUBLIC_HOST/readyz
```

Both commands should return a 2xx code. Then check in a real browser:

The complete fake-media two-browser acceptance suite can also target the
deployed origin without starting a local server:

```sh
cd e2e
E2E_BASE_URL=https://webmcp.donaldmurillo.com pnpm test
```

When the deployed app intentionally has `WEBMCP_DEBUG=true`, run the matching
twenty-five-tool acceptance contract instead:

```sh
cd e2e
E2E_BASE_URL=https://webmcp.donaldmurillo.com E2E_WEBMCP_DEBUG=1 pnpm test
```

Use `debug_connection_report` from Codex to inspect authenticated socket counts,
allowlisted peer/ICE states, direct-versus-relay candidate categories, recent
signal categories, scene/tracking state, and annotation delivery counts. Use
`debug_ping_operator`, verify the phone displays `DEBUG PING`, then call
`debug_connection_report` again and confirm guidance shows one acknowledged and
zero pending. Clear the ping with `clear_annotation` when finished.

- The landing page remains on `https://PUBLIC_HOST`; an HTTP request redirects
  to HTTPS if an HTTP listener is exposed.
- `window.isSecureContext` is `true`, and the operator page exposes
  `navigator.mediaDevices` before permission is requested.
- Creating a session opens the support console and loads the operator QR image.
  If the image fails, the visible copy link is the supported fallback.
- Scanning the QR link on the iPhone ends at
  `/session/<id>/operator` without the one-time `token` query parameter.
- Browser developer tools show a `101 Switching Protocols` upgrade for
  `wss://PUBLIC_HOST/ws/sessions/<id>?role=support` and for the operator role.
  There must be no mixed-content `ws://` request from the HTTPS page.
- The support console reports signaling open, ICE connected/completed, and
  media receiving only after the corresponding browser states are visible.
- The QR, WebSocket, health, and page requests all use the same public host;
  do not mix a provider hostname with a custom domain.

### WebMCP host and model check

WebMCP is a page capability, not the same thing as an MCP server. The support
page must be open in the built-in browser in the ChatGPT desktop app, where
ChatGPT Work or Codex can discover tools exposed by that page. For the current
Site tools rollout, use GPT-5.6 Sol or GPT-5.6 Terra; GPT-5.6 Luna has WebMCP
disabled. Update the desktop app before testing, and note that Site tools are
not available in Enterprise or Edu workspaces. Availability can also depend on
rollout and the tools offered by the page. See the [official Site tools
documentation](https://learn.chatgpt.com/docs/webmcp).

In the built-in browser, open the address-bar **Site tools** menu and inspect
**Available site tools**. If the page is exposing the expected bridge, the
top-level `document.modelContext` is available to the page and the final
manifest lists the tools used by the recording. This check proves WebMCP page
discovery; it does not prove the separate HTTP/WebSocket or WebRTC paths.

The QR dependency is separate as well. `barcode.donaldmurillo.com` may expose
an `/mcp` endpoint, but this application's QR handler calls its REST
`POST /api/v1/generate` endpoint through `BARCODE_SERVICE_URL` when
`BARCODE_API_KEY` is set, or anonymous `POST /api/generate` when it is not. Do not configure
the barcode `/mcp` endpoint as the Field Assist WebMCP bridge, and use the
copy-link fallback if the REST QR request fails.

These are checks to perform, not claims that the current repository has passed
them.

## iPhone and two-user checklist

Use a real iPhone Safari tab for the operator and a separate desktop browser
tab for the support representative. Keep their cookies and permissions
separate.

- [ ] Record the iPhone model, iOS/Safari version, desktop browser, and the
      exact public URL used.
- [ ] Turn Wi-Fi off on the iPhone so it is genuinely on cellular. Put the
      support desktop on an unrelated Wi-Fi or wired network; a same-LAN pass
      is not a cross-network proof.
- [ ] Open the public HTTPS landing page on the support desktop and create one
      new session.
- [ ] Confirm the QR image or copy-link fallback. Scan/open the operator link
      on the iPhone and verify the token disappears after the redirect.
- [ ] Grant camera permission, choose the rear/environment camera, and keep
      Safari in the foreground. If automatic permission is blocked, tap
      `Start rear camera`.
- [ ] Optionally use Safari's **Add to Home Screen**, launch the standalone
      Field Assist shell, and confirm it returns to the public landing page.
      Do not expect offline operation; session and media state require the live
      origin.
- [ ] Confirm both roles show a connected signaling state. Confirm the support
      view receives a live operator track and inspect the Signaling, ICE, and
      Media status popover.
- [ ] Confirm the seeded scene contains `wan-port`; do not describe it as
      computer-vision detection—the current scene is deterministic and
      manually calibrated.
- [ ] In the support page, verify WebMCP discovery in the built-in browser if
      available. If the browser lacks WebMCP, verify the visible human controls
      still perform the same-origin command path.
- [ ] Run the highlight/overlay step, then test the close-up, snapshot,
      comparison, and cable-moved steps only if they appear in the final tool
      manifest and UI.
- [ ] Repeat once after closing/reopening one tab or forcing a WebSocket
      reconnect; note whether the session state returns from memory.
- [ ] Capture the result as “verified” only after it has been observed on the
      exact networks and devices intended for the video.

## Operational gaps to close before submission

- VPS hosting, TLS, the public hostname, and the live URL are established at
  `https://webmcp.donaldmurillo.com`; `/readyz` is checked after each deployment.
- Five consecutive synthetic-media public suites pass from one client (25/25
  tests), including WebRTC, WebSocket recovery, WebMCP/manual tool paths,
  annotation delivery receipts, CV tracking, and camera-denial recovery.
- Cellular-to-unrelated-network direct ICE has not been established by this
  document. STUN-only may fail; TURN is the reliability path.
- Cross-network TURN-backed recovery (only if the target network needs it)
  remains an external validation item until someone records the result. The
  real iPhone camera path is verified, and the final twenty-five-tool WebMCP surface is
  discovered and callable in Codex's in-app browser; record that existing proof
  in the submission take.
