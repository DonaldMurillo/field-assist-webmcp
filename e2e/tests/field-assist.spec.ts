import {
  chromium,
  devices,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WEBMCP_DEBUG = process.env.E2E_WEBMCP_DEBUG === "1";
const DEPTH_PARALLAX_VIDEO = readFileSync(
  fileURLToPath(new URL("../fixtures/depth-parallax.webm", import.meta.url)),
);
const QR_TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function routeDepthParallaxVideo(page: Page): Promise<void> {
  await page.route("**/__e2e__/depth-parallax.webm", async (route) => {
    const range = route.request().headers().range;
    const match = range?.match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      const start = Number(match[1]);
      const requestedEnd = match[2] ? Number(match[2]) : DEPTH_PARALLAX_VIDEO.length - 1;
      const end = Math.min(requestedEnd, DEPTH_PARALLAX_VIDEO.length - 1);
      const body = DEPTH_PARALLAX_VIDEO.subarray(start, end + 1);
      await route.fulfill({
        status: 206,
        body,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(body.length),
          "Content-Range": `bytes ${start}-${end}/${DEPTH_PARALLAX_VIDEO.length}`,
          "Content-Type": "video/webm",
        },
      });
      return;
    }
    await route.fulfill({
      body: DEPTH_PARALLAX_VIDEO,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(DEPTH_PARALLAX_VIDEO.length),
        "Content-Type": "video/webm",
      },
    });
  });
}

type PerceptionE2EMode = "opencv-unavailable" | "mock-ready" | "depth-model-failure";

type MockPerceptionResult = {
  bounds: { x: number; y: number; width: number; height: number };
  quad?: Array<{ x: number; y: number }>;
  anchor?: { x: number; y: number };
  confidence: number;
  moved?: boolean;
  source?: string;
  depthScore?: number;
  depthConfidence?: number;
  depthRelative?: number;
  modelRelativeDepth?: number;
  depthSource?: string;
};

type PerceptionE2EConfig = {
  mode: PerceptionE2EMode;
  results?: MockPerceptionResult[];
};

async function installPerceptionE2E(
  target: BrowserContext | Page,
  config: PerceptionE2EConfig,
): Promise<void> {
  await target.addInitScript((value: PerceptionE2EConfig) => {
    (window as Window & { __fieldAssistPerceptionE2E?: PerceptionE2EConfig })
      .__fieldAssistPerceptionE2E = value;
  }, config);
}

async function loadDepthParallaxFixture(
  page: Page,
  selector = "#local-video",
  initialTime = 0.25,
): Promise<void> {
  await page.evaluate(async ({ selector: videoSelector, seconds }) => {
    const video = document.querySelector<HTMLVideoElement>(videoSelector);
    if (!video) throw new Error("Perception fixture video was unavailable");
    video.pause();
    video.srcObject = null;
    video.src = "/__e2e__/depth-parallax.webm";
    video.loop = false;
    video.muted = true;
    video.preload = "auto";
    video.load();
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(video.error), { once: true });
      });
    }
    const seek = async (targetTime: number) => {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("seeked", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(video.error), { once: true });
        video.currentTime = targetTime;
      });
      video.pause();
    };
    await seek(seconds);
    (window as Window & {
      __fieldAssistTrackingFixture?: { seek: (targetTime: number) => Promise<void> };
    }).__fieldAssistTrackingFixture = { seek };
  }, { selector, seconds: initialTime });
  await expect
    .poll(
      () => page.locator(selector).evaluate((element) => {
        const video = element as HTMLVideoElement;
        return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          video.videoWidth === 640 && video.videoHeight === 360;
      }),
      { timeout: 10_000, message: "the prerecorded depth fixture should decode" },
    )
    .toBe(true);
}

const SUBMISSION_TOOL_NAMES = [
  "get_app_info",
  "inspect_scene",
  "inspect_object",
  "recalibrate_object",
  "register_scene_object",
  "highlight_object",
  "annotate_object",
  "send_operator_instruction",
  "send_operator_message",
  "request_closeup",
  "request_different_angle",
  "draw_arrow",
  "show_region",
  "request_move",
  "request_operator_view",
  "capture_snapshot",
  "compare_snapshots",
  "clear_annotation",
  "clear_annotations",
  "record_observation",
  "update_room_context",
  "ask_operator",
  "get_case_context",
  "get_case_timeline",
  "suggest_next_step",
] as const;

const DEBUG_TOOL_NAMES = [
  "debug_connection_report",
  "debug_ping_operator",
] as const;

const TOOL_NAMES = WEBMCP_DEBUG
  ? [...SUBMISSION_TOOL_NAMES, ...DEBUG_TOOL_NAMES]
  : [...SUBMISSION_TOOL_NAMES];

const TOOL_ENDPOINTS: Record<string, string> = {
  get_app_info: "/api/tools/app-info",
  inspect_scene: "/api/tools/inspect-scene",
  inspect_object: "/api/tools/inspect-object",
  recalibrate_object: "/api/tools/recalibrate-object",
  register_scene_object: "/api/tools/register-scene-object",
  highlight_object: "/api/tools/highlight-object",
  annotate_object: "/api/tools/annotate-object",
  send_operator_instruction: "/api/tools/send-operator-instruction",
  send_operator_message: "/api/tools/send-operator-message",
  request_closeup: "/api/tools/request-closeup",
  request_different_angle: "/api/tools/request-different-angle",
  draw_arrow: "/api/tools/draw-arrow",
  show_region: "/api/tools/show-region",
  request_move: "/api/tools/request-move",
  request_operator_view: "/api/tools/request-operator-view",
  capture_snapshot: "/api/tools/capture-snapshot",
  compare_snapshots: "/api/tools/compare-snapshots",
  clear_annotation: "/api/tools/clear-annotation",
  clear_annotations: "/api/tools/clear-annotations",
  record_observation: "/api/tools/record-observation",
  update_room_context: "/api/tools/update-room-context",
  ask_operator: "/api/tools/ask-operator",
  get_case_context: "/api/tools/case-context",
  get_case_timeline: "/api/tools/case-timeline",
  suggest_next_step: "/api/tools/suggest-next-step",
  debug_connection_report: "/api/tools/debug/connection-report",
  debug_ping_operator: "/api/tools/debug/ping-operator",
};

const TOOL_METHODS: Record<string, "GET" | "POST"> = {
  get_app_info: "GET",
  inspect_scene: "POST",
  inspect_object: "POST",
  recalibrate_object: "POST",
  register_scene_object: "POST",
  highlight_object: "POST",
  annotate_object: "POST",
  send_operator_instruction: "POST",
  send_operator_message: "POST",
  request_closeup: "POST",
  request_different_angle: "POST",
  draw_arrow: "POST",
  show_region: "POST",
  request_move: "POST",
  request_operator_view: "POST",
  capture_snapshot: "POST",
  compare_snapshots: "POST",
  clear_annotation: "POST",
  clear_annotations: "POST",
  record_observation: "POST",
  update_room_context: "POST",
  ask_operator: "POST",
  get_case_context: "GET",
  get_case_timeline: "GET",
  suggest_next_step: "GET",
  debug_connection_report: "GET",
  debug_ping_operator: "POST",
};

type ToolManifest = {
  tools: Array<{
    name: string;
    description: string;
    method: string;
    path: string;
    inputSchema: Record<string, unknown>;
  }>;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

// Mutating WebMCP commands carry the app-context revision that the agent
// received from load_field_assist_context. Keeping this in the acceptance
// helper lets the older, longer live-workspace flows exercise the new server
// precondition without obscuring the individual assertions with boilerplate.
const CONTEXT_REQUIRED_TOOL_NAMES = new Set([
  "update_room_context",
  "recalibrate_object",
  "register_scene_object",
  "highlight_object",
  "annotate_object",
  "send_operator_instruction",
  "send_operator_message",
  "request_closeup",
  "request_different_angle",
  "draw_arrow",
  "show_region",
  "request_move",
  "request_operator_view",
  "ask_operator",
  "capture_snapshot",
  "clear_annotation",
  "clear_annotations",
  "record_observation",
  "debug_ping_operator",
]);

async function assertManifest(page: Page): Promise<ToolManifest> {
  const response = await page.request.get("/__gofastr/webmcp/tools.json");
  expect(response.ok(), "WebMCP manifest request should succeed").toBe(true);
  expect(response.headers()["content-type"]).toContain("application/json");

  const manifest = (await response.json()) as ToolManifest;
  expect(manifest.tools).toHaveLength(TOOL_NAMES.length);
  expect(manifest.tools.map((tool) => tool.name).sort()).toEqual(
    [...TOOL_NAMES].sort(),
  );
  for (const tool of manifest.tools) {
    expect(tool.description, `${tool.name} should be described`).toBeTruthy();
    expect(tool.path, `${tool.name} should use a same-origin API path`).toMatch(
      /^\/api\/tools\//,
    );
    expect(tool.method, `${tool.name} should declare its actual HTTP method`).toBe(
      TOOL_METHODS[tool.name],
    );
    expect(tool.inputSchema, `${tool.name} should publish an object input schema`).toMatchObject({
      type: "object",
    });
  }
  return manifest;
}

async function modelContextAvailable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const documentContext = (document as Document & { modelContext?: unknown })
      .modelContext;
    const navigatorContext = (navigator as Navigator & { modelContext?: unknown })
      .modelContext;
    return Boolean(documentContext || navigatorContext);
  });
}

async function waitForModelContextTool(page: Page, name: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async (toolName) => {
          const documentContext = (
            document as Document & { modelContext?: { getTools?: () => Promise<unknown[]> } }
          ).modelContext;
          const navigatorContext = (
            navigator as Navigator & { modelContext?: { getTools?: () => Promise<unknown[]> } }
          ).modelContext;
          const context = documentContext || navigatorContext;
          if (!context?.getTools) return false;
          try {
            const tools = await context.getTools();
            return tools.some(
              (tool) =>
                Boolean(tool) &&
                typeof tool === "object" &&
                "name" in tool &&
                (tool as { name?: unknown }).name === toolName,
            );
          } catch {
            return false;
          }
        }, name),
      { timeout: 15_000, message: `${name} should be registered in modelContext` },
    )
    .toBe(true);
}

function decodeToolResult(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function invokeToolDefinition(
  page: Page,
  name: string,
  input: Record<string, unknown>,
  endpoint: string,
  method: "GET" | "POST",
  preferModelContext = true,
): Promise<unknown> {
  if (preferModelContext && await modelContextAvailable(page)) {
    await waitForModelContextTool(page, name);
    const raw = await page.evaluate(
      async ({ toolName, toolInput }) => {
        const documentContext = (
          document as Document & {
            modelContext?: {
              getTools: () => Promise<Array<{ name: string }>>;
              executeTool: (tool: unknown, input: string) => Promise<unknown>;
            };
          }
        ).modelContext;
        const navigatorContext = (
          navigator as Navigator & {
            modelContext?: {
              getTools: () => Promise<Array<{ name: string }>>;
              executeTool: (tool: unknown, input: string) => Promise<unknown>;
            };
          }
        ).modelContext;
        const context = documentContext || navigatorContext;
        if (!context) throw new Error("WebMCP modelContext disappeared before invocation");
        const tools = await context.getTools();
        const tool = tools.find((candidate) => candidate.name === toolName);
        if (!tool) throw new Error(`WebMCP tool ${toolName} was not registered`);
        return context.executeTool(tool, JSON.stringify(toolInput));
      },
      { toolName: name, toolInput: input },
    );
    const result = decodeToolResult(raw) as ToolResult;
    expect(result?.isError, `${name} WebMCP call should succeed`).not.toBe(true);
    expect(result?.content?.[0]?.type).toBe("text");
    return decodeToolResult(result?.content?.[0]?.text);
  }

  // Chromium versions predating the WebMCP origin trial still exercise the
  // exact same-origin command boundary. The manifest assertion above keeps
  // the declaration contract covered; this fallback keeps the realtime
  // acceptance proof runnable on those browsers.
  const response = await page.evaluate(
    async ({ requestPath, requestInput, requestMethod }) => {
      const response = await fetch(requestPath, {
        method: requestMethod,
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(requestMethod === "POST" ? { "Content-Type": "application/json" } : {}),
          "X-Gofastr-WebMCP": "1",
        },
        body: requestMethod === "POST" ? JSON.stringify(requestInput) : undefined,
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      };
    },
    { requestPath: endpoint, requestInput: input, requestMethod: method },
  );
  expect(response.ok, `${name} command should return 2xx (got ${response.status})`).toBe(true);
  return JSON.parse(response.body);
}

async function manifestTool(page: Page, name: string): Promise<ToolManifest["tools"][number]> {
  const response = await page.request.get("/__gofastr/webmcp/tools.json");
  expect(response.ok(), "the authenticated WebMCP manifest should be available").toBe(true);
  const manifest = (await response.json()) as ToolManifest;
  const tool = manifest.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No WebMCP manifest entry for ${name}`);
  return tool;
}

async function loadFieldAssistContextVersion(page: Page): Promise<unknown> {
  // get_app_info is the app-provided operating-context loader. Keep the
  // optional name as a compatibility seam if the framework later exposes a
  // dedicated loader without changing the acceptance helper contract.
  let tool: ToolManifest["tools"][number];
  try {
    tool = await manifestTool(page, "load_field_assist_context");
  } catch {
    tool = await manifestTool(page, "get_app_info");
  }
  // Use the authenticated same-origin endpoint for bootstrapping. This keeps
  // the helper useful in Chromium builds without modelContext while still
  // asserting the exact tool path and schema through the manifest.
  const raw = await invokeToolDefinition(
    page,
    tool.name,
    {},
    tool.path,
    tool.method as "GET" | "POST",
    false,
  );
  if (!raw || typeof raw !== "object") {
    throw new Error("the app context loader returned no context payload");
  }
  const result = raw as Record<string, unknown>;
  const nestedContext = result.context;
  const nestedVersion = nestedContext && typeof nestedContext === "object"
    ? (nestedContext as Record<string, unknown>).contextVersion
    : undefined;
  const version = result.contextVersion ?? nestedVersion;
  if (version === undefined || version === null) {
    throw new Error("the app context loader returned no contextVersion");
  }
  return version;
}

async function invokeTool(page: Page, name: string, input: Record<string, unknown>): Promise<unknown> {
  let endpoint = TOOL_ENDPOINTS[name];
  let method = TOOL_METHODS[name];
  if (name === "load_field_assist_context") {
    const tool = await manifestTool(page, name);
    endpoint = tool.path;
    method = tool.method as "GET" | "POST";
  }
  if (!endpoint || !method) throw new Error(`No acceptance endpoint mapping for ${name}`);

  const effectiveInput = { ...input };
  if (CONTEXT_REQUIRED_TOOL_NAMES.has(name) && effectiveInput.contextVersion === undefined) {
    effectiveInput.contextVersion = await loadFieldAssistContextVersion(page);
  }
  return invokeToolDefinition(page, name, effectiveInput, endpoint, method);
}

async function createInternalFixtureSession(page: Page): Promise<void> {
  await Promise.all([
    page.waitForURL(/\/session\/[^/]+$/),
    page.evaluate(() => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/sessions/new";
      const mode = document.createElement("input");
      mode.type = "hidden";
      mode.name = "mode";
      mode.value = "demo";
      form.appendChild(mode);
      document.body.appendChild(form);
      form.submit();
    }),
  ]);
}

async function expectConnected(status: Locator, description: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await status.getAttribute("data-state");
        const text = await status.textContent();
        return `${state ?? ""} ${text ?? ""}`;
      },
      { timeout: 45_000, message: `${description} should report a connected state` },
    )
    .toMatch(/open|connected|online|ready|live|receiving|active|complete/i);
}

async function hasLiveVideoTrack(video: Locator): Promise<boolean> {
  return video.evaluate((element) => {
    const media = element as HTMLVideoElement;
    const stream = media.srcObject;
    return Boolean(stream?.getVideoTracks().some((track) => track.readyState === "live"));
  });
}

async function imageDimensions(page: Page, src: string): Promise<{ width: number; height: number }> {
  return page.evaluate((imageSrc) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error(`Could not load ${imageSrc}`));
    image.src = imageSrc;
  }), src);
}

async function installPeerConnectionProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection;
    if (typeof NativePeerConnection !== "function") return;
    const records: RTCPeerConnection[] = [];
    function ProbedPeerConnection(configuration?: RTCConfiguration): RTCPeerConnection {
      const peer = new NativePeerConnection(configuration);
      records.push(peer);
      return peer;
    }
    ProbedPeerConnection.prototype = NativePeerConnection.prototype;
    Object.setPrototypeOf(ProbedPeerConnection, NativePeerConnection);
    (window as Window & { __fieldAssistPeerConnections?: RTCPeerConnection[] })
      .__fieldAssistPeerConnections = records;
    window.RTCPeerConnection = ProbedPeerConnection as unknown as typeof RTCPeerConnection;
  });
}

async function peerConnectionCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    ((window as Window & { __fieldAssistPeerConnections?: RTCPeerConnection[] })
      .__fieldAssistPeerConnections ?? []).length
  );
}

async function hasAudioTransceiver(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const peers = (window as Window & { __fieldAssistPeerConnections?: RTCPeerConnection[] })
      .__fieldAssistPeerConnections ?? [];
    const active = peers.slice().reverse().find((peer) => peer.connectionState !== "closed");
    return Boolean(active?.getTransceivers().some((transceiver) =>
      transceiver.sender.track?.kind === "audio" || transceiver.receiver.track?.kind === "audio"
    ));
  });
}

type ProbedSocket = {
  readyState: number;
  messages: string[];
};

async function installWebSocketProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeWebSocket = window.WebSocket;
    const records: Array<{ socket: WebSocket; messages: string[] }> = [];

    function ProbedWebSocket(
      url: string | URL,
      protocols?: string | string[],
    ): WebSocket {
      const socket = protocols === undefined
        ? new nativeWebSocket(url)
        : new nativeWebSocket(url, protocols);
      const record = { socket, messages: [] as string[] };
      records.push(record);
      socket.addEventListener("message", (event) => {
        record.messages.push(String(event.data));
      });
      return socket;
    }

    // Preserve the constructor/prototype and static ready-state constants so
    // the production client cannot distinguish the probe from WebSocket.
    ProbedWebSocket.prototype = nativeWebSocket.prototype;
    Object.setPrototypeOf(ProbedWebSocket, nativeWebSocket);
    (window as Window & {
      __fieldAssistSocketRecords?: Array<{ socket: WebSocket; messages: string[] }>;
    }).__fieldAssistSocketRecords = records;
    window.WebSocket = ProbedWebSocket as unknown as typeof WebSocket;
  });
}

async function probedSockets(page: Page): Promise<ProbedSocket[]> {
  return page.evaluate(() => {
    const records = (window as Window & {
      __fieldAssistSocketRecords?: Array<{ socket: WebSocket; messages: string[] }>;
    }).__fieldAssistSocketRecords ?? [];
    return records.map((record) => ({
      readyState: record.socket.readyState,
      messages: record.messages.slice(),
    }));
  });
}

async function disableWebMCP(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The dedicated fallback browser is launched without the WebMCP Blink
    // feature. These defensive instance/prototype shadows also keep this
    // test deterministic if a future Chromium build enables the API by
    // default.
    const hide = (target: object) => {
      try {
        Object.defineProperty(target, "modelContext", {
          configurable: true,
          value: undefined,
        });
      } catch {
        // A browser-owned non-configurable property is handled by the launch
        // flag; the fallback request remains independently testable.
      }
    };
    hide(document);
    hide(navigator);
    hide(Document.prototype);
    hide(Navigator.prototype);
  });
}

test.describe("Field Assist acceptance", () => {
  test.beforeEach(async ({ context, page }) => {
    await installPerceptionE2E(page, { mode: "opencv-unavailable" });
    await context.route("**/api/session/operator-qr*", async (route) => {
      await route.fulfill({
        status: 200,
        body: QR_TEST_PNG,
        headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
      });
    });
  });

  test("recovers the pairing QR after a transient service failure", async ({ context, page }) => {
    await context.unroute("**/api/session/operator-qr*");
    let requests = 0;
    await context.route("**/api/session/operator-qr*", async (route) => {
      requests += 1;
      if (requests === 1) {
        await route.fulfill({
          status: 429,
          body: "busy",
          headers: { "Content-Type": "text/plain", "Retry-After": "2" },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        body: QR_TEST_PNG,
        headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
      });
    });

    await page.goto("/");
    await Promise.all([
      page.waitForURL(/\/session\/[^/]+$/),
      page.locator("#create-session").click(),
    ]);

    await expect(page.locator("#qr-status")).toContainText("Ready to scan", {
      timeout: 8_000,
    });
    expect(requests).toBe(2);
  });

  test("turns stale links and unknown routes into responsive recovery screens", async ({ page }) => {
    const staleResponse = await page.goto("/session/expired-field-session");
    expect(staleResponse?.status()).toBe(404);
    await expect(page.locator("#session-unavailable-app")).toBeVisible();
    await expect(page.getByRole("heading", { name: "That field session has packed up." })).toBeVisible();
    await expect(page.locator("#create-session-form")).toBeVisible();
    await expect(page.locator('script[src*="/__gofastr/webmcp.js"]')).toHaveCount(0);

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 844 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const geometry = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>("#new-session")?.getBoundingClientRect();
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          cardLeft: card?.left ?? -1,
          cardRight: card?.right ?? Number.POSITIVE_INFINITY,
        };
      });
      expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      expect(geometry.cardLeft).toBeGreaterThanOrEqual(0);
      expect(geometry.cardRight).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await Promise.all([
      page.waitForURL(/\/session\/[^/]+$/),
      page.locator("#create-session").click(),
    ]);
    await expect(page.locator("#support-app")).toBeVisible();

    const missingResponse = await page.goto("/definitely-not-a-field-assist-route");
    expect(missingResponse?.status()).toBe(404);
    await expect(page.locator("#not-found-app")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Nothing is connected here." })).toBeVisible();
    await expect(page.locator("#create-session-form")).toBeVisible();
    await expect(page.locator('script[src*="/__gofastr/webmcp.js"]')).toHaveCount(0);

    const newResponse = await page.goto("/new");
    expect(newResponse?.status()).toBe(200);
    await expect(page.locator("#new-session-app")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open a live workspace." })).toBeVisible();

    const stackResponse = await page.goto("/stack");
    expect(stackResponse?.status()).toBe(200);
    await expect(page.locator("#stack-app")).toBeVisible();
    await expect(page.locator(".stack-row")).toHaveCount(11);
    await expect(page.getByRole("heading", { name: "GoFastr WebMCP" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "OpenCV 5 + HTML Canvas" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "ONNX Runtime Web + Depth Anything V2 Small" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "DeviceOrientation + Canvas" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "VPS hosting" })).toBeVisible();
    await expect(page.locator("#stack-app")).toContainText(
      "The support computer owns enhanced tracking and publishes bounded geometry",
    );
    await expect(page.locator("#stack-app")).toContainText(
      "The phone keeps a lightweight Canvas tracker",
    );
    await expect(page.locator("#stack-app")).not.toContainText(
      "run locally on the operator phone",
    );
    await expect(page.locator('script[src*="/__gofastr/webmcp.js"]')).toHaveCount(0);
  });

  test("serves the complete tool manifest only from the support WebMCP surface", async ({ page }) => {
    const landingResponse = await page.goto("/");
    expect(landingResponse?.headers()["permissions-policy"]).toContain("microphone=()");
    expect(landingResponse?.headers()["content-security-policy"]).not.toContain("unsafe-eval");
    await expect(page.locator("#landing-app")).toBeVisible();
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/__gofastr/plugin/field-assist/manifest.webmanifest",
    );
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0d1715");
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
      "content",
      "yes",
    );
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      "href",
      "/__gofastr/plugin/field-assist/apple-touch-icon.png",
    );
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("sizes", "180x180");

    const appManifestResponse = await page.request.get(
      "/__gofastr/plugin/field-assist/manifest.webmanifest",
    );
    expect(appManifestResponse.ok()).toBe(true);
    expect(appManifestResponse.headers()["content-type"]).toContain("application/manifest+json");
    expect(appManifestResponse.headers()["cache-control"]).toContain("no-store");
    const appManifest = (await appManifestResponse.json()) as {
      id?: string;
      name?: string;
      display?: string;
      start_url?: string;
      icons?: Array<{ src?: string; type?: string; purpose?: string }>;
    };
    expect(appManifest).toMatchObject({
      id: "/",
      name: "GoFastr Field Assist",
      display: "standalone",
      start_url: "/",
    });
    expect(appManifest.icons).toContainEqual(expect.objectContaining({
      src: "/__gofastr/plugin/field-assist/icon-512.png",
      type: "image/png",
    }));
    const iconResponse = await page.request.get("/__gofastr/plugin/field-assist/icon-512.png");
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()["content-type"]).toContain("image/png");
    const appleIconResponse = await page.request.get(
      "/__gofastr/plugin/field-assist/apple-touch-icon.png",
    );
    expect(appleIconResponse.ok()).toBe(true);
    expect(appleIconResponse.headers()["content-type"]).toContain("image/png");
    await expect(imageDimensions(page, "/__gofastr/plugin/field-assist/icon-192.png")).resolves.toEqual({
      width: 192,
      height: 192,
    });
    await expect(imageDimensions(page, "/__gofastr/plugin/field-assist/icon-512.png")).resolves.toEqual({
      width: 512,
      height: 512,
    });
    await expect(imageDimensions(page, "/__gofastr/plugin/field-assist/apple-touch-icon.png")).resolves.toEqual({
      width: 180,
      height: 180,
    });
    const openCVWorker = await page.request.get(
      "/__gofastr/plugin/field-assist/opencv-worker.js",
    );
    expect(openCVWorker.ok()).toBe(true);
    expect(openCVWorker.headers()["content-security-policy"]).toContain("'unsafe-eval'");

    const anonymousManifest = await page.request.get("/__gofastr/webmcp/tools.json");
    expect(anonymousManifest.status()).toBe(401);
    const anonymousBridge = await page.request.get("/__gofastr/webmcp.js");
    expect(anonymousBridge.status()).toBe(401);
    const anonymousAppInfo = await page.request.get("/api/tools/app-info");
    expect(anonymousAppInfo.status()).toBe(401);
    await expect(page.locator('script[src*="/__gofastr/webmcp.js"]')).toHaveCount(0);

    await Promise.all([
      page.waitForURL(/\/session\/[^/]+$/),
      page.locator("#create-session").click(),
    ]);
    await expect(page.locator("#support-app")).toBeVisible();
    const manifest = await assertManifest(page);
    expect(manifest.tools).toHaveLength(TOOL_NAMES.length);
    const appInfoTool = manifest.tools.find((tool) => tool.name === "get_app_info");
    expect(appInfoTool?.description).toContain("Call this first");
    expect(appInfoTool?.description).toContain("operating expectations");
    const inspectSceneTool = manifest.tools.find((tool) => tool.name === "inspect_scene");
    expect(inspectSceneTool?.description).toContain("Call after get_app_info");
    expect(inspectSceneTool?.description).toContain("do not guide an unverified target");
    const authenticatedBridge = await page.request.get("/__gofastr/webmcp.js");
    expect(authenticatedBridge.ok()).toBe(true);
    expect(authenticatedBridge.headers()["cache-control"]).toContain("private");
    expect(authenticatedBridge.headers()["cache-control"]).toContain("no-store");
    await expect(page.locator('script[src*="/__gofastr/webmcp.js"]')).toHaveCount(1);
    if (!WEBMCP_DEBUG) {
      const disabledDebugRoute = await page.request.get("/api/tools/debug/connection-report");
      expect(disabledDebugRoute.status()).toBe(404);
    }

    // Leaving the authority-bearing support document must be a hard
    // navigation. A GoFastr partial swap would keep browser-registered tools
    // alive even after their script element disappeared.
    await Promise.all([
      page.waitForURL(/\/$/),
      page.locator(".app-header .brand-lockup").click(),
    ]);
    await expect(page.locator("#landing-app")).toBeVisible();
    await expect(page.locator('script[src*="/__gofastr/webmcp.js"]')).toHaveCount(0);
  });

  test("gives hackathon judges a responsive three-step demo path", async ({ page }) => {
    await page.goto("/");

    const guide = page.locator("#demo-guide");
    await expect(guide).toBeVisible();
    await expect(guide.getByText("HACKATHON DEMO · 2–3 MINUTES")).toBeVisible();
    await expect(guide.getByText("OPEN THIS SITE IN")).toBeVisible();
    await expect(
      guide.getByText("Codex’s built-in browser or another WebMCP-enabled browser"),
    ).toBeVisible();
    await expect(guide.locator(".demo-guide-step")).toHaveCount(3);
    await expect(guide.getByRole("link", { name: "Start the live demo" })).toHaveAttribute(
      "href",
      "/new",
    );
    await expect(guide.getByRole("link", { name: "View WebMCP tools" })).toHaveAttribute(
      "href",
      "/tools",
    );

    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const box = await guide.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
    }
  });

  test("publishes every available WebMCP tool from a responsive header action", async ({ page }) => {
    await page.goto("/");
    const toolsLink = page.getByRole("link", { name: "View tools" });
    await expect(toolsLink).toBeVisible();
    await expect(toolsLink).toHaveAttribute("href", "/tools");
    await Promise.all([
      page.waitForURL(/\/tools$/),
      toolsLink.click(),
    ]);

    await expect(page.locator("#tools-app")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Everything Codex can do here." })).toBeVisible();
    await expect(page.locator(".tool-row")).toHaveCount(TOOL_NAMES.length);
    const catalogNames = await page.locator(".tool-row").evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-tool-name")),
    );
    expect(catalogNames).toHaveLength(new Set(catalogNames).size);
    expect([...catalogNames].sort()).toEqual([...TOOL_NAMES].sort());
    await expect(page.locator('script[src*="/__gofastr/webmcp.js"]')).toHaveCount(0);
    await expect(page.locator("#tools-app")).toContainText(
      "Schemas and invocation stay inside an authenticated support session.",
    );

    if (WEBMCP_DEBUG) {
      await expect(page.locator('.tool-row[data-tool-name="debug_connection_report"]')).toContainText(
        "Debug only",
      );
      await expect(page.locator('.tool-row[data-tool-name="debug_ping_operator"]')).toContainText(
        "Debug only",
      );
    }

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 844 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const geometry = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        headerWidth: document.querySelector<HTMLElement>(".app-header")?.scrollWidth ?? 0,
        headerClientWidth: document.querySelector<HTMLElement>(".app-header")?.clientWidth ?? 0,
        toolsRight: document.querySelector<HTMLElement>('.app-header a[href="/tools"]')
          ?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
      }));
      expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.innerWidth + 1);
      expect(geometry.headerWidth).toBeLessThanOrEqual(geometry.headerClientWidth + 1);
      expect(geometry.toolsRight).toBeLessThanOrEqual(geometry.innerWidth + 1);
    }
  });

  test("keeps tools, connection status, and phone guidance inside the live workspace", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await Promise.all([
      page.waitForURL(/\/session\/[^/]+$/),
      page.locator("#create-session").click(),
    ]);
    await expect(page.locator("#support-app")).toBeVisible();
    const modelRequirement = page.locator(".session-model-requirement");
    await expect(modelRequirement).toBeVisible();
    await expect(modelRequirement).toContainText("Choose GPT-5.6 Terra or Sol in Codex.");
    await expect(modelRequirement).toContainText(
      "Luna currently cannot use this page’s WebMCP tools.",
    );
    const timelineDetails = page.locator("#case-timeline-details");
    await expect(timelineDetails).not.toHaveAttribute("open", "");
    await expect(page.locator("#timeline-count")).toHaveText(/\d+ events?/);
    await timelineDetails.locator("summary").click();
    await expect(timelineDetails).toHaveAttribute("open", "");

    const supportURL = page.url();
    const toolsTrigger = page.getByRole("button", { name: "View tools" });
    await expect(toolsTrigger).toHaveAttribute("aria-controls", "tools-dialog");
    await toolsTrigger.click();
    await expect(page.locator("#tools-dialog")).toBeVisible();
    await expect(page.locator("#tools-dialog .tool-row")).toHaveCount(TOOL_NAMES.length);
    expect(page.url()).toBe(supportURL);
    await page.getByRole("button", { name: "Close tool catalog" }).click();
    await expect(page.locator("#tools-dialog")).toBeHidden();

    const pairingGeometry = await page.evaluate(() => {
      const pairing = document.querySelector<HTMLElement>("#stage-pairing")?.getBoundingClientRect();
      const qr = document.querySelector<HTMLElement>("#stage-pairing .qr-card")?.getBoundingClientRect();
      return {
        pairingWidth: pairing?.width ?? 0,
        qrWidth: qr?.width ?? 0,
      };
    });
    expect(pairingGeometry.qrWidth).toBeGreaterThanOrEqual(pairingGeometry.pairingWidth * 0.5 - 1);

    await expect(page.locator("#support-focus-toggle")).toHaveCount(0);
    await expect(page.locator("#support-app")).not.toHaveAttribute("data-focus-mode");
    await expect(page.locator("#support-app > .app-header")).toBeVisible();
    const consoleGeometry = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>("#support-app > .app-header")?.getBoundingClientRect();
      const grid = document.querySelector<HTMLElement>(".console-grid")?.getBoundingClientRect();
      const caseColumn = document.querySelector<HTMLElement>(".case-column")?.getBoundingClientRect();
      return {
        headerBottom: header?.bottom ?? -1,
        gridTop: grid?.top ?? -1,
        caseTop: caseColumn?.top ?? -1,
      };
    });
    expect(consoleGeometry.gridTop).toBeCloseTo(consoleGeometry.headerBottom, 0);
    expect(consoleGeometry.caseTop).toBeCloseTo(consoleGeometry.headerBottom, 0);

    const connectionStatus = page.locator("#peer-status");
    await expect(connectionStatus).toHaveAttribute("popovertarget", "connection-status-popover");
    await connectionStatus.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#connection-status-popover")).toBeVisible();
    await expect(page.locator("#connection-status-popover")).toContainText("Signaling");
    await expect(page.locator("#connection-status-popover")).toContainText("ICE");
    await expect(page.locator("#connection-status-popover")).toContainText("Media");
    await expect(page.locator("#connection-diagnostics, #diagnostics-output")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("#connection-status-popover")).toBeHidden();

    const bannerTrigger = page.locator("#support-banner-dialog-trigger");
    await expect(bannerTrigger).toBeVisible();
    const cameraHUD = page.locator("#camera-status-hud");
    await expect(cameraHUD).toBeVisible();
    await expect(cameraHUD.locator(".camera-status-control")).toHaveCount(5);
    await expect(page.locator("#camera-status-toggle")).toBeVisible();
    await expect(cameraHUD.locator(".camera-status-items")).toBeHidden();
    await page.locator("#camera-status-toggle").hover();
    await expect(cameraHUD.locator(".camera-status-items")).toBeVisible();
    await cameraHUD.locator(".camera-status-control").first().hover();
    await expect(page.locator("#support-guidance-delivery-status")).toBeVisible();
    await expect(page.locator("#support-guidance-delivery-status")).toHaveText("Guidance idle");
    await expect(page.locator(".scene-panel")).toBeHidden();
    await expect(page.locator(".case-column #support-banner-composer")).toHaveCount(0);
    const actionGeometry = await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>("#support-stage")?.getBoundingClientRect();
      const bannerBar = document.querySelector<HTMLElement>(".phone-banner-bar")?.getBoundingClientRect();
      const hud = document.querySelector<HTMLElement>("#camera-status-hud")?.getBoundingClientRect();
      const overlay = document.querySelector<HTMLElement>("#support-overlay");
      const hudElement = document.querySelector<HTMLElement>("#camera-status-hud");
      return {
        stageBottom: stage?.bottom ?? 0,
        triggerTop: bannerBar?.top ?? 0,
        stageWidth: stage?.width ?? 0,
        triggerWidth: bannerBar?.width ?? 0,
        hudInsideStage: Boolean(stage && hud && hud.left >= stage.left && hud.right <= stage.right && hud.top >= stage.top),
        hudZ: Number(hudElement ? getComputedStyle(hudElement).zIndex : 0),
        overlayZ: Number(overlay ? getComputedStyle(overlay).zIndex : 0),
      };
    });
    expect(actionGeometry.triggerTop).toBeGreaterThanOrEqual(actionGeometry.stageBottom - 1);
    expect(actionGeometry.triggerWidth).toBeCloseTo(actionGeometry.stageWidth, 0);
    expect(actionGeometry.hudInsideStage).toBe(true);
    expect(actionGeometry.hudZ).toBeGreaterThan(actionGeometry.overlayZ);
    await bannerTrigger.click();
    await expect(page.locator("#support-banner-dialog")).toBeVisible();
    await expect(page.locator("#support-banner-clear")).toBeHidden();
    await expect(page.locator("#support-banner-title")).toHaveAttribute("required", "");
    await expect(page.locator("#support-banner-detail")).toHaveAttribute("required", "");
    await expect(page.locator("#support-banner-dialog")).toContainText("Both fields are required");
    await page.getByRole("button", { name: "Close phone banner" }).click();
    await expect(page.locator("#support-banner-dialog")).toBeHidden();
  });

  test("keeps starter scenarios out of agent behavior and synchronizes two-way chat", async ({
    browser,
    page: supportPage,
  }) => {
    await supportPage.goto("/");
    await Promise.all([
      supportPage.waitForURL(/\/session\/[^/]+$/),
      supportPage.locator("#create-session").click(),
    ]);
    await assertManifest(supportPage);
    const operatorHref = await supportPage.locator("#operator-link").getAttribute("href");
    if (!operatorHref) throw new Error("Support page did not expose an operator join URL");

    const operatorContext = await browser.newContext({ ...devices["iPhone 13"] });
    try {
      const operatorPage = await operatorContext.newPage();
      await installWebSocketProbe(operatorPage);
      await operatorPage.goto(new URL(operatorHref, supportPage.url()).toString());

      // Conversation is useful before camera permission or a starter selection.
      await expect(supportPage.locator("#video-empty")).toBeVisible();
      await expect(supportPage.locator("#support-conversation")).toBeVisible();
      await operatorPage.locator("#operator-chat-toggle").click();
      await operatorPage.locator("#operator-chat-input").fill(
        "I want to describe an unfamiliar object before sharing video.",
      );
      await operatorPage.locator("#operator-chat-form").getByRole("button", { name: "Send" }).click();
      await expect(supportPage.locator("#support-message-list")).toContainText(
        "I want to describe an unfamiliar object before sharing video.",
      );
      await operatorPage.locator("#operator-chat-close").click();

      await operatorPage.locator("#operator-tv-demo").click();
      await expect(operatorPage.locator("#operator-issue-chooser")).toBeHidden();
      const operatorStatusHUD = operatorPage.locator("#operator-status-hud");
      await expect(operatorStatusHUD).toBeVisible();
      await expect(operatorStatusHUD).not.toHaveAttribute("open", "");
      await expect(operatorPage.locator("#operator-scene-activity-status")).toBeHidden();
      await expect(operatorPage.getByText("Point the camera at the device and wait for guidance.", {
        exact: true,
      })).toHaveCount(0);
      await expect(operatorPage.getByText("Point your camera at the equipment", {
        exact: true,
      })).toHaveCount(0);
      await operatorStatusHUD.locator("summary").click();
      await expect(operatorStatusHUD).toHaveAttribute("open", "");
      await expect(operatorPage.locator("#operator-scene-activity-status")).toBeVisible();
      await expect(operatorPage.locator("#operator-instruction")).toHaveText("No active instruction.");
      const mobileShell = await operatorPage.evaluate(() => ({
        viewportHeight: window.visualViewport?.height ?? window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        bodyOverflow: getComputedStyle(document.body).overflow,
        appHeight: document.querySelector<HTMLElement>("#operator-app")?.getBoundingClientRect().height ?? 0,
      }));
      expect(mobileShell.bodyOverflow).toBe("hidden");
      expect(mobileShell.documentHeight).toBeLessThanOrEqual(mobileShell.viewportHeight + 1);
      expect(mobileShell.appHeight).toBeLessThanOrEqual(mobileShell.viewportHeight + 1);
      await operatorStatusHUD.locator("summary").click();
      await expect(operatorStatusHUD).not.toHaveAttribute("open", "");

      const appInfo = (await invokeTool(supportPage, "get_app_info", {})) as {
        demoFlow?: string[];
        operatingExpectations?: string[];
      };
      expect(appInfo.demoFlow?.join(" ")).not.toMatch(/\b(tv|television|controller|manufacturer)\b/i);
      expect(appInfo.operatingExpectations).toHaveLength(6);
      expect(appInfo.operatingExpectations?.join(" ")).toContain(
        "Inspect the current scene before choosing or changing guidance",
      );
      expect(appInfo.operatingExpectations?.join(" ")).toContain(
        "Put every hands-busy movement or hold instruction",
      );
      expect(appInfo.operatingExpectations?.join(" ")).toContain(
        "Use draw_arrow for a precise point",
      );

      const selectedScene = (await invokeTool(supportPage, "inspect_scene", {})) as {
        operatorIssue?: { summary?: string; mode?: string; presetId?: string };
        messages?: Array<{ text?: string; sender?: string }>;
      };
      expect(selectedScene.operatorIssue).toEqual(expect.objectContaining({
        summary: "I lost my controller. How do I control my TV?",
      }));
      expect(selectedScene.operatorIssue).not.toHaveProperty("mode");
      expect(selectedScene.operatorIssue).not.toHaveProperty("presetId");
      expect(selectedScene.messages).toContainEqual(expect.objectContaining({
        sender: "operator",
        text: "I lost my controller. How do I control my TV?",
      }));

      await operatorPage.locator("#operator-chat-toggle").click();
      await expect(operatorPage.locator("#operator-chat-panel")).toBeVisible();
      await operatorPage.locator("#operator-chat-input").fill(
        "The screen has one physical button below the logo.",
      );
      await operatorPage.locator("#operator-chat-form").getByRole("button", { name: "Send" }).click();
      await expect(operatorPage.locator("#operator-message-list")).toContainText(
        "The screen has one physical button below the logo.",
      );
      await expect(operatorPage.locator("#operator-chat-status")).toContainText("Sent");
      await expect(supportPage.locator("#support-message-list")).toContainText(
        "The screen has one physical button below the logo.",
      );

      await invokeTool(supportPage, "send_operator_message", {
        text: "Thanks. Point the camera at that button when you are ready.",
      });
      await expect(operatorPage.locator("#operator-message-list")).toContainText(
        "Thanks. Point the camera at that button when you are ready.",
      );
      await expect(supportPage.locator("#support-message-list")).toContainText(
        "Thanks. Point the camera at that button when you are ready.",
      );

      await supportPage.locator("#support-chat-input").fill("Human support can reply here too.");
      await supportPage.locator("#support-chat-form").getByRole("button", { name: "Send" }).click();
      await expect(operatorPage.locator("#operator-message-list")).toContainText(
        "Human support can reply here too.",
      );

      await supportPage.locator("#support-banner-dialog-trigger").click();
      await expect(supportPage.locator("#support-banner-dialog")).toBeVisible();
      await supportPage.locator("#support-banner-title").fill("HOLD THE CAMERA STILL");
      await supportPage.locator("#support-banner-detail").fill(
        "Keep the control centered while I check the next step.",
      );
      await supportPage.locator("#support-banner-form").getByRole("button", {
        name: "Send yellow banner",
      }).click();
      await expect(supportPage.locator("#support-banner-dialog")).toBeHidden();
      await expect(supportPage.locator("#support-banner-clear")).toBeVisible();
      await expect(supportPage.locator("#support-banner-status")).toContainText("Visible on operator phone");
      await expect(supportPage.locator("#support-instruction-label")).toHaveText("SUPPORT PHONE BANNER");
      await expect(supportPage.locator("#support-instruction-title")).toHaveText("HOLD THE CAMERA STILL");
      const humanCommand = operatorPage.locator("#operator-overlay .guidance-command");
      await expect(humanCommand.locator(".guidance-command-title")).toHaveText(
        "HOLD THE CAMERA STILL",
      );
      const humanBannerScene = (await invokeTool(supportPage, "inspect_scene", {})) as {
        operatorInstruction?: { id?: string; title?: string; detail?: string; sentBy?: string };
      };
      expect(humanBannerScene.operatorInstruction).toMatchObject({
        title: "HOLD THE CAMERA STILL",
        detail: "Keep the control centered while I check the next step.",
        sentBy: "Support representative",
      });
      await expect(humanCommand).toHaveAttribute("data-source", "SUPPORT");
      await expect(humanCommand).toHaveAttribute("data-instruction-id", humanBannerScene.operatorInstruction?.id ?? "");
      await expect(humanCommand).toHaveAttribute("role", "status");
      await expect(humanCommand).toHaveAttribute("aria-live", "assertive");
      expect(await humanCommand.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toMatch(
        /^(transparent|rgba\(0, 0, 0, 0\))$/,
      );

      const operatorCannotUseSupportAuthority = await operatorPage.evaluate(async () => {
        const response = await fetch("/api/support/messages", {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ text: "spoofed support" }),
        });
        return response.status;
      });
      expect([401, 403]).toContain(operatorCannotUseSupportAuthority);
      const supportCannotUseOperatorAuthority = await supportPage.evaluate(async () => {
        const response = await fetch("/api/operator/messages", {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ text: "spoofed operator" }),
        });
        return response.status;
      });
      expect([401, 403]).toContain(supportCannotUseOperatorAuthority);

      const conversation = (await invokeTool(supportPage, "inspect_scene", {})) as {
        messages?: Array<{ text?: string; sender?: string; actor?: string }>;
      };
      expect(conversation.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ sender: "operator", text: "The screen has one physical button below the logo." }),
        expect.objectContaining({
          sender: "support",
          actor: "Codex via WebMCP",
          text: "Thanks. Point the camera at that button when you are ready.",
        }),
        expect.objectContaining({ sender: "support", text: "Human support can reply here too." }),
      ]));

      await operatorPage.reload();
      await expect(operatorPage.locator("#operator-overlay .guidance-command-title")).toHaveText(
        "HOLD THE CAMERA STILL",
      );
      await operatorPage.locator("#operator-chat-toggle").click();
      await expect(operatorPage.locator("#operator-message-list")).toContainText(
        "The screen has one physical button below the logo.",
      );
      await expect(operatorPage.locator("#operator-message-list")).toContainText(
        "Human support can reply here too.",
      );

      const staleOperatorSnapshot = await operatorPage.evaluate(async () => {
        const response = await fetch("/api/session/current", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`Could not capture operator snapshot: ${response.status}`);
        const body = await response.json() as { snapshot?: { sequence?: number } };
        if (!body.snapshot?.sequence) throw new Error("Operator snapshot did not include a sequence");
        return body.snapshot;
      });

      await supportPage.locator("#support-banner-clear").click();
      await expect(supportPage.locator("#support-banner-status")).toContainText("Removed from operator phone");
      await expect(supportPage.locator("#support-banner-preview")).toHaveText("No active instruction");
      await expect(supportPage.locator("#support-banner-clear")).toBeHidden();
      await expect(operatorPage.locator("#operator-overlay .guidance-command")).toHaveCount(0);

      // The socket's initial snapshot and hub broadcasts are independent
      // writes. Replaying the pre-clear snapshot after the newer clear event
      // deterministically protects the reconnect race seen in production.
      await operatorPage.evaluate((snapshot) => {
        const records = (window as Window & {
          __fieldAssistSocketRecords?: Array<{ socket: WebSocket; messages: string[] }>;
        }).__fieldAssistSocketRecords ?? [];
        const socket = records.slice().reverse().find((record) =>
          record.socket.readyState === WebSocket.OPEN
        )?.socket;
        if (!socket) throw new Error("No open operator socket was available for stale replay");
        socket.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({
            id: "acceptance-stale-snapshot",
            type: "session.snapshot",
            sequence: snapshot.sequence,
            payload: snapshot,
          }),
        }));
      }, staleOperatorSnapshot);
      await expect(operatorPage.locator("#operator-overlay .guidance-command")).toHaveCount(0);

      const clearedBannerScene = (await invokeTool(supportPage, "inspect_scene", {})) as {
        operatorInstruction?: unknown;
      };
      expect(clearedBannerScene.operatorInstruction).toBeUndefined();
    } finally {
      await operatorContext.close();
    }
  });

  test("creates a session, joins an operator, and propagates a highlight", async ({
    browser,
    page: supportPage,
  }) => {
    await installPeerConnectionProbe(supportPage);
    await supportPage.goto("/");
    await expect(supportPage.locator("#landing-app")).toBeVisible();
	await createInternalFixtureSession(supportPage);
	await expect(supportPage.locator("#support-app")).toBeVisible();
	await assertManifest(supportPage);
	await expect(supportPage.locator("#video-empty")).toBeVisible();
	await expect(supportPage.locator("#video-empty #stage-pairing")).toBeVisible();
	await expect(supportPage.locator("#video-empty .qr-card")).toBeVisible();
	await expect(supportPage.locator("#video-empty #operator-link")).toBeVisible();
	await expect(supportPage.locator("#qr-status")).toContainText(/Ready to scan|QR unavailable/);
	await expect(supportPage.locator(".pairing-panel")).toHaveCount(0);
	await expect(supportPage.locator("#agent-form")).toHaveCount(0);
	for (const viewport of [
	  { width: 390, height: 844 },
	  { width: 600, height: 844 },
	  { width: 768, height: 844 },
	  { width: 896, height: 844 },
	  { width: 1024, height: 768 },
	  { width: 1280, height: 800 },
	  { width: 1792, height: 1000 },
	]) {
	  await supportPage.setViewportSize(viewport);
	  const pairingGeometry = await supportPage.evaluate(() => {
		const stage = document.querySelector<HTMLElement>("#support-stage")?.getBoundingClientRect();
		const qr = document.querySelector<HTMLElement>(".qr-card")?.getBoundingClientRect();
		const details = document.querySelector<HTMLElement>(".stage-pairing-details")?.getBoundingClientRect();
		const link = document.querySelector<HTMLElement>("#operator-link")?.getBoundingClientRect();
		const copy = document.querySelector<HTMLElement>("#copy-operator-link")?.getBoundingClientRect();
		return {
		  innerWidth: window.innerWidth,
		  documentWidth: document.documentElement.scrollWidth,
		  stage: stage && { left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom },
		  qr: qr && { left: qr.left, right: qr.right, top: qr.top, bottom: qr.bottom },
		  details: details && { left: details.left, right: details.right, top: details.top, bottom: details.bottom, width: details.width },
		  link: link && { left: link.left, right: link.right, top: link.top, bottom: link.bottom },
		  copy: copy && { left: copy.left, right: copy.right, top: copy.top, bottom: copy.bottom },
		};
	  });
	  expect(pairingGeometry.documentWidth).toBeLessThanOrEqual(pairingGeometry.innerWidth + 1);
	  expect(pairingGeometry.qr?.left).toBeGreaterThanOrEqual(pairingGeometry.stage?.left ?? 0);
	  expect(pairingGeometry.qr?.right).toBeLessThanOrEqual(pairingGeometry.stage?.right ?? 0);
	  expect(pairingGeometry.details?.right).toBeLessThanOrEqual(pairingGeometry.stage?.right ?? 0);
	  expect(pairingGeometry.link?.right).toBeLessThanOrEqual(pairingGeometry.stage?.right ?? 0);
	  expect(pairingGeometry.copy?.right).toBeLessThanOrEqual(pairingGeometry.stage?.right ?? 0);
	  if (viewport.width >= 600) {
		expect(pairingGeometry.qr?.right).toBeLessThanOrEqual(pairingGeometry.details?.left ?? 0);
		expect(pairingGeometry.details?.width).toBeGreaterThanOrEqual(220);
	  } else {
		expect(pairingGeometry.qr?.bottom).toBeLessThanOrEqual(pairingGeometry.details?.top ?? 0);
	  }
	}
	await supportPage.setViewportSize({ width: 1280, height: 720 });
	for (const path of [
	  "/api/session/current",
	  "/api/session/ice-config",
	  "/api/tools/case-context",
	  "/api/tools/case-timeline",
	  "/api/tools/suggest-next-step",
	]) {
	  const response = await supportPage.request.get(path);
	  expect(response.ok(), `${path} should succeed for support`).toBe(true);
	  expect(response.headers()["cache-control"], `${path} must not be cached`).toContain("no-store");
	  expect(response.headers()["vary"], `${path} must vary by credentials`).toContain("Cookie");
	}

    const operatorLink = supportPage.locator("#operator-link");
    await expect(operatorLink).toHaveAttribute(
      "href",
      /\/session\/[^/]+\/operator\?token=[^#]+/,
    );
    const operatorHref = await operatorLink.getAttribute("href");
    if (!operatorHref) throw new Error("Support page did not expose an operator join URL");
    await expect(supportPage.locator("#copy-operator-link")).toHaveAttribute(
      "data-fui-copy-text-from",
      "#operator-link",
    );
    await expect(
      supportPage.locator('[data-field-copy-control="operator-link"]'),
    ).toBeVisible();

    // Keep operator cookies and support cookies isolated just as they are on
    // two real devices. The browser-level fake-media flags live in the config;
    // this context explicitly grants the camera permission for this origin.
    const operatorContext = await browser.newContext({
      ...devices["iPhone 13"],
      permissions: ["camera"],
    });
    try {
      await installPerceptionE2E(operatorContext, { mode: "opencv-unavailable" });
      await operatorContext.addInitScript(() => {
        const NativePeerConnection = window.RTCPeerConnection;
        if (typeof NativePeerConnection !== "function") return;
        const records: RTCPeerConnection[] = [];
        function ProbedPeerConnection(configuration?: RTCConfiguration): RTCPeerConnection {
          const peer = new NativePeerConnection(configuration);
          records.push(peer);
          return peer;
        }
        ProbedPeerConnection.prototype = NativePeerConnection.prototype;
        Object.setPrototypeOf(ProbedPeerConnection, NativePeerConnection);
        (window as Window & { __fieldAssistPeerConnections?: RTCPeerConnection[] })
          .__fieldAssistPeerConnections = records;
        window.RTCPeerConnection = ProbedPeerConnection as unknown as typeof RTCPeerConnection;
      });
      const operatorPage = await operatorContext.newPage();
      await routeDepthParallaxVideo(operatorPage);
      await installWebSocketProbe(operatorPage);
      await operatorPage.goto(new URL(operatorHref, supportPage.url()).toString());
      await expect(operatorPage.locator("#operator-app")).toBeVisible();
      await expect(operatorPage.locator("#operator-issue-chooser")).toBeVisible();
      const sceneBeforeIssueSelection = (await invokeTool(supportPage, "inspect_scene", {})) as {
        operatorIssue?: unknown;
      };
      expect(sceneBeforeIssueSelection).not.toHaveProperty("operatorIssue");
      await operatorPage.locator("#operator-freeform-issue").fill(
        "The router acceptance test needs visual guidance.",
      );
      await operatorPage.locator("#operator-freeform-issue-form").getByRole("button", {
        name: "Start free-form help",
      }).click();
      await expect(operatorPage.locator("#operator-issue-chooser")).toBeHidden();
      const sceneAfterIssueSelection = (await invokeTool(supportPage, "inspect_scene", {})) as {
        operatorIssue?: { mode?: string; summary?: string; presetId?: string };
      };
      expect(sceneAfterIssueSelection.operatorIssue).toMatchObject({
        summary: "The router acceptance test needs visual guidance.",
      });
      await expect(operatorPage.locator('link[rel="manifest"]')).toHaveAttribute(
        "href",
        "/__gofastr/plugin/field-assist/manifest.webmanifest",
      );
      await expect(operatorPage).toHaveURL(/\/session\/[^/]+\/operator$/);
      await expect(operatorPage.locator('script[src*="/__gofastr/webmcp.js"]')).toHaveCount(0);
	  const operatorSnapshotKeys = await operatorPage.evaluate(async () => {
		const response = await fetch('/api/session/current', { credentials: 'same-origin' });
		const current = await response.json();
		return Object.keys(current.snapshot || {}).sort();
	  });
	  expect(operatorSnapshotKeys).not.toEqual(expect.arrayContaining([
		'caseContext', 'timeline', 'snapshots', 'sceneTracking', 'annotationReceipts',
	  ]));

      // The operator client attempts camera access as soon as the session
      // snapshot arrives. On a fake-media Chromium that may finish before
      // the navigation settles; retain the button as the explicit retry path
      // without making the test race that automatic attempt.
      const startCamera = operatorPage.locator("#start-camera");
      if (await startCamera.isVisible()) await startCamera.click();
      await expect
        .poll(() => hasLiveVideoTrack(operatorPage.locator("#local-video")), {
          timeout: 30_000,
          message: "fake rear camera should produce a live local video track",
        })
        .toBe(true);

      await expectConnected(
        operatorPage.locator("#operator-status"),
        "operator status",
      );
      await expectConnected(supportPage.locator("#signal-status"), "signaling status");
      await expectConnected(supportPage.locator("#ice-status"), "ICE status");
      await expectConnected(supportPage.locator("#media-status"), "media status");
      await expect
        .poll(() => hasLiveVideoTrack(supportPage.locator("#remote-video")), {
          timeout: 45_000,
          message: "support should receive the operator's fake camera track",
        })
        .toBe(true);

      await expect(supportPage.locator("#support-enable-voice, #support-voice-status, #support-remote-audio")).toHaveCount(0);
      await expect(operatorPage.locator("#operator-enable-voice, #operator-voice-status, #operator-remote-audio")).toHaveCount(0);
      expect(await hasAudioTransceiver(supportPage)).toBe(false);
      expect(await hasAudioTransceiver(operatorPage)).toBe(false);
      await expect(supportPage.locator("#media-status")).toHaveText(/receiving/i);
      await expect(supportPage.locator("#peer-status")).toHaveText(/camera live/i);
	  await expect(supportPage.locator("#video-empty")).toBeHidden();
      await expect(supportPage.locator(".scene-panel")).toBeVisible();
      await supportPage.locator("#peer-status").click();
      await expect(supportPage.locator("#connection-status-popover")).toBeVisible();
      await expect(supportPage.locator("#signal-status")).toHaveText(/open/i);
      await expect(supportPage.locator("#ice-status")).toHaveText(/connected|complete/i);
      await expect(supportPage.locator("#media-status")).toHaveText(/receiving/i);

      const supportPeersBeforeRecovery = await peerConnectionCount(supportPage);
      const operatorPeersBeforeRecovery = await peerConnectionCount(operatorPage);
      await supportPage.evaluate(() => {
        const peers = (window as Window & { __fieldAssistPeerConnections?: RTCPeerConnection[] })
          .__fieldAssistPeerConnections ?? [];
        const active = peers.slice().reverse().find((peer) => peer.connectionState !== "closed");
        if (!active) throw new Error("No active support peer connection was available to fail");
        active.close();
        active.onconnectionstatechange?.(new Event("connectionstatechange"));
      });
      await expect
        .poll(() => peerConnectionCount(supportPage), {
          timeout: 20_000,
          message: "support should create a replacement peer after failure",
        })
        .toBeGreaterThan(supportPeersBeforeRecovery);
      await expect
        .poll(() => peerConnectionCount(operatorPage), {
          timeout: 20_000,
          message: "operator should replace its peer for renegotiation",
        })
        .toBeGreaterThan(operatorPeersBeforeRecovery);
      await expect
        .poll(() => hasLiveVideoTrack(supportPage.locator("#remote-video")), {
          timeout: 30_000,
          message: "support should receive video again after peer renegotiation",
        })
        .toBe(true);
      expect(await hasAudioTransceiver(supportPage)).toBe(false);
      expect(await hasAudioTransceiver(operatorPage)).toBe(false);

      const appInfo = (await invokeTool(supportPage, "get_app_info", {})) as {
        name?: string;
        runtime?: string;
      };
      expect(appInfo.name).toBe("GoFastr Field Assist");
      expect(appInfo.runtime).toContain("GoFastr");

      const beforeCapture = (await invokeTool(supportPage, "capture_snapshot", {
        label: "before-cable-move",
      })) as { snapshot?: { id?: string; scene?: { version?: number } } };
      expect(beforeCapture.snapshot?.id, "before snapshot should have a stable id").toBeTruthy();

      const scene = (await invokeTool(supportPage, "inspect_scene", {})) as {
        objects?: Array<{ id: string; label: string }>;
      };
      const wanPort = scene.objects?.find(
        (object) => object.id === "wan-port" || /WAN port/i.test(object.label),
      );
      expect(wanPort, "inspect_scene should return the seeded WAN port").toBeTruthy();

      const inspected = (await invokeTool(supportPage, "inspect_object", {
        objectId: wanPort?.id ?? "wan-port",
      })) as { object?: { id?: string; bounds?: { width?: number } } };
      expect(inspected.object?.id).toBe("wan-port");
      expect(inspected.object?.bounds?.width).toBeGreaterThan(0);

      await supportPage.locator("#calibrate-wan").click();
      await expect(supportPage.locator("#support-overlay")).toHaveClass(/calibration-active/);
      const calibrationBox = await supportPage.locator("#support-overlay").boundingBox();
      if (!calibrationBox) throw new Error("Support overlay was not measurable for calibration");
      await supportPage.mouse.move(
        calibrationBox.x + calibrationBox.width * 0.62,
        calibrationBox.y + calibrationBox.height * 0.48,
      );
      await supportPage.mouse.down();
      await supportPage.mouse.move(
        calibrationBox.x + calibrationBox.width * 0.82,
        calibrationBox.y + calibrationBox.height * 0.7,
        { steps: 5 },
      );
      await supportPage.mouse.up();
      await expect(supportPage.locator("#scene-action-status")).toContainText(/calibrated/i);
      await expect(supportPage.locator("#support-overlay")).not.toHaveClass(/calibration-active/);
      const calibratedWAN = (await invokeTool(supportPage, "inspect_object", {
        objectId: "wan-port",
      })) as { object?: { bounds?: { x?: number; y?: number; width?: number; height?: number } } };
      expect(calibratedWAN.object?.bounds?.width).toBeGreaterThan(0);

      const calibratedScene = (await invokeTool(supportPage, "inspect_scene", {})) as {
        version?: number;
      };
      const roomContext = (await invokeTool(supportPage, "update_room_context", {
        summary: "A home media area with the network equipment below the display.",
        observations: [
          { label: "Television", detail: "Large display centered above the equipment" },
          { label: "Network shelf", detail: "Router and modem sit directly below the display" },
        ],
        baseSceneVersion: calibratedScene.version,
      })) as { roomContext?: { summary?: string; observations?: unknown[] } };
      expect(roomContext.roomContext?.observations).toHaveLength(2);
      await expect(supportPage.locator("#room-context-summary")).toContainText("home media area");
      await expect(supportPage.locator("#room-context-observations")).toContainText("Television");
      await expect(operatorPage.locator("body")).not.toContainText("home media area");

      const caseContext = (await invokeTool(supportPage, "get_case_context", {})) as {
        case?: { currentStepId?: string; steps?: Array<{ requiresApproval?: boolean }> };
      };
      expect(caseContext.case?.currentStepId).toBe("move-modem-cable-to-wan");
      expect(caseContext.case?.steps?.some((step) => step.requiresApproval)).toBe(true);

      const suggestion = (await invokeTool(supportPage, "suggest_next_step", {})) as {
        suggestion?: { stepId?: string; targetObjectId?: string; requiresSupportApproval?: boolean };
      };
      expect(suggestion.suggestion).toMatchObject({
        stepId: "choose-guidance-target",
        requiresSupportApproval: false,
      });

      const asked = (await invokeTool(supportPage, "ask_operator", {
        question: "Is the power light on?",
        options: ["Yes", "No", "Not sure"],
      })) as { question?: { id?: string; status?: string } };
      expect(asked.question?.status).toBe("pending");
      await expect(operatorPage.locator("#operator-question")).toBeVisible();
      await expect(operatorPage.locator("#operator-question-prompt")).toHaveText("Is the power light on?");
      await expect(operatorPage.locator(".operator-question-option")).toHaveCount(3);
      await operatorPage.getByRole("button", { name: "Yes", exact: true }).click();
      await expect(operatorPage.locator("#operator-question-source")).toHaveText("RESPONSE DELIVERED");
      await expect(operatorPage.locator(".operator-answer-receipt")).toContainText("“Yes” sent");
      await expect(operatorPage.locator(".operator-answer-receipt")).toContainText("Codex and support received your answer.");
      await expect(operatorPage.locator(".operator-question-option")).toHaveCount(0);
      await expect(supportPage.locator("#support-question-label")).toHaveText("OPERATOR ANSWER RECEIVED");
      await expect(supportPage.locator("#support-question-status")).toContainText("Yes · received");
      const answeredScene = (await invokeTool(supportPage, "inspect_scene", {})) as {
        activeQuestion?: { id?: string; status?: string; answer?: string };
      };
      expect(answeredScene.activeQuestion).toMatchObject({
        id: asked.question?.id,
        status: "answered",
        answer: "Yes",
      });

      const arrow = (await invokeTool(supportPage, "draw_arrow", {
        objectId: "wan-port",
        text: "Blue uplink",
      })) as { annotation?: { id?: string; kind?: string } };
      expect(arrow.annotation).toMatchObject({ kind: "arrow" });
      await expect(operatorPage.locator("#operator-overlay")).toContainText("Blue uplink");
      await expect(operatorPage.locator("#operator-overlay .guidance-command")).toHaveAttribute("data-source", "CODEX");
      await expect(operatorPage.locator("#operator-overlay .field-annotation-leader")).toHaveCount(1);

      await invokeTool(supportPage, "request_different_angle", { objectId: "wan-port" });
      await invokeTool(supportPage, "show_region", {
        bounds: { x: 0.6, y: 0.48, width: 0.3, height: 0.28 },
        text: "Router uplink area",
      });
      await invokeTool(supportPage, "request_move", { direction: "right" });
      await expect(operatorPage.locator("#operator-overlay")).toContainText("MOVE RIGHT");

      const requestedView = (await invokeTool(supportPage, "request_operator_view", {
        target: "port-panel",
      })) as { annotation?: { kind?: string; label?: string } };
      expect(requestedView.annotation).toMatchObject({ kind: "view", label: "SHOW PORT PANEL" });
      await expect(operatorPage.locator("#operator-overlay")).toContainText("SHOW PORT PANEL");

      await invokeTool(supportPage, "clear_annotation", { annotationId: arrow.annotation?.id });
      await expect(operatorPage.locator("#operator-overlay")).not.toContainText("Blue uplink");
      await expect(operatorPage.locator("#operator-overlay")).toContainText("SHOW PORT PANEL");

      await invokeTool(supportPage, "annotate_object", {
        objectId: "wan-port",
        text: "Use this blue port",
      });
      await expect(operatorPage.locator("#operator-overlay")).toContainText("Use this blue port");

      const latestOperatorMarker = operatorPage.locator("#operator-overlay .field-annotation").last();
      const operatorCommand = operatorPage.locator("#operator-overlay .guidance-command");
      await latestOperatorMarker.evaluate((element) => {
        element.setAttribute("data-e2e-stability-marker", "preserved");
      });
      await operatorCommand.evaluate((element) => {
        element.setAttribute("data-e2e-stability-marker", "preserved");
      });
      await operatorPage.evaluate(() => window.dispatchEvent(new Event("resize")));
      await expect(latestOperatorMarker).toHaveAttribute("data-e2e-stability-marker", "preserved");
      await expect(operatorCommand).toHaveAttribute("data-e2e-stability-marker", "preserved");

      await invokeTool(supportPage, "record_observation", {
        text: "WAN port is empty before the guided cable move.",
      });
      await expect(supportPage.locator("#timeline")).toContainText("WAN port is empty");
      await expect(latestOperatorMarker).toHaveAttribute("data-e2e-stability-marker", "preserved");
      await expect(operatorCommand).toHaveAttribute("data-e2e-stability-marker", "preserved");
      const caseTimeline = (await invokeTool(supportPage, "get_case_timeline", {})) as {
        timeline?: Array<{ message?: string }>;
      };
      expect(caseTimeline.timeline?.some((item) => /WAN port is empty/.test(item.message ?? ""))).toBe(true);

      await invokeTool(supportPage, "clear_annotations", {});
      await expect(operatorPage.locator("#operator-overlay")).not.toContainText("Use this blue port");

      await invokeTool(supportPage, "highlight_object", {
        objectId: wanPort?.id ?? "wan-port",
      });
      await expect(operatorPage.locator("#operator-overlay")).toContainText("CONNECT HERE");
      await expect(supportPage.locator("#support-guidance-delivery-status")).toContainText(
        /operator sees guidance/i,
        { timeout: 10_000 },
      );
      const deliverySnapshot = await supportPage.evaluate(async () => {
        const response = await fetch('/api/session/current', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const current = await response.json() as {
          snapshot?: {
            scene?: { version?: number };
            annotations?: Array<{ id?: string; objectId?: string }>;
            annotationReceipts?: Array<{
              annotationId?: string;
              objectId?: string;
              sceneVersion?: number;
              source?: string;
            }>;
          };
        };
        return current.snapshot;
      });
      const deliveredWAN = deliverySnapshot?.annotations?.find(
        (annotation) => annotation.objectId === 'wan-port' &&
          deliverySnapshot.annotationReceipts?.some(
            (receipt) => receipt.annotationId === annotation.id,
          ),
      );
      expect(deliveredWAN, 'support snapshot should retain the rendered WAN receipt').toBeTruthy();
      expect(deliverySnapshot?.annotationReceipts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          objectId: 'wan-port',
          sceneVersion: deliverySnapshot?.scene?.version,
          source: 'operator-rendered-overlay',
        }),
      ]));
      const forgedSupportReceiptStatus = await supportPage.evaluate(async (snapshot) => {
        const annotationId = snapshot?.annotations?.find(
          (annotation) => annotation.objectId === 'wan-port',
        )?.id;
        const response = await fetch('/api/operator/annotation-acknowledgements', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            annotationIds: annotationId ? [annotationId] : [],
            sceneVersion: snapshot?.scene?.version,
          }),
        });
        return response.status;
      }, deliverySnapshot);
      expect(forgedSupportReceiptStatus).toBe(401);

      const overlayAlignment = await operatorPage.locator("#operator-overlay").evaluate((overlay) => {
        const video = document.querySelector<HTMLVideoElement>("#local-video");
        const box = overlay.querySelector<HTMLElement>(".field-annotation");
        if (!video || !box || !video.videoWidth || !video.videoHeight) return null;
        const overlayRect = overlay.getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        const scale = Math.min(
          overlayRect.width / video.videoWidth,
          overlayRect.height / video.videoHeight,
        );
        const mediaWidth = video.videoWidth * scale;
        const mediaHeight = video.videoHeight * scale;
        const mediaLeft = overlayRect.left + (overlayRect.width - mediaWidth) / 2;
        const mediaTop = overlayRect.top + (overlayRect.height - mediaHeight) / 2;
        return {
          inside:
            boxRect.left >= mediaLeft - 1 &&
            boxRect.top >= mediaTop - 1 &&
            boxRect.right <= mediaLeft + mediaWidth + 1 &&
            boxRect.bottom <= mediaTop + mediaHeight + 1,
        };
      });
      expect(overlayAlignment?.inside, "guidance should stay inside the contained video pixels").toBe(true);
      await expect(supportPage.locator("#timeline")).toContainText(
        /Highlighted (WAN port|CONNECT HERE)/i,
      );

      await invokeTool(supportPage, "request_closeup", { objectId: "wan-port" });
      await expect(operatorPage.locator("#operator-overlay")).toContainText("MOVE CAMERA CLOSER");

      await expect(operatorPage.locator("#confirm-cable-moved")).toBeHidden();
      const prematureConfirmation = await operatorPage.evaluate(async () => {
        const response = await fetch("/api/operator/confirm-cable-moved", {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId: "not-approved" }),
        });
        return response.status;
      });
      expect(prematureConfirmation).toBe(409);

      await operatorPage.evaluate(async () => {
        const video = document.querySelector<HTMLVideoElement>("#local-video");
        if (!video) throw new Error("Local video was unavailable for the tracking fixture");
        video.pause();
        video.srcObject = null;
        video.src = "/__e2e__/depth-parallax.webm";
        video.loop = false;
        video.muted = true;
        video.preload = "auto";
        video.load();
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise<void>((resolve, reject) => {
            video.addEventListener("loadedmetadata", () => resolve(), { once: true });
            video.addEventListener("error", () => reject(video.error), { once: true });
          });
        }
        const seek = async (seconds: number) => {
          await new Promise<void>((resolve, reject) => {
            const done = () => resolve();
            video.addEventListener("seeked", done, { once: true });
            video.addEventListener("error", () => reject(video.error), { once: true });
            video.currentTime = seconds;
          });
          video.pause();
        };
        await seek(0.25);
        (window as Window & {
          __fieldAssistTrackingFixture?: { seek: (seconds: number) => Promise<void> };
        }).__fieldAssistTrackingFixture = { seek };
      });
      await expect
        .poll(
          () => operatorPage.locator("#local-video").evaluate((element) => {
            const video = element as HTMLVideoElement;
            return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              video.videoWidth === 640 && video.videoHeight === 360;
          }),
          { timeout: 10_000, message: "the prerecorded depth fixture should decode" },
        )
        .toBe(true);

      await expect(supportPage.locator("#approve-cable-move")).toBeEnabled();
      await supportPage.locator("#approve-cable-move").click();
      await expect(supportPage.locator("#approve-cable-move")).toContainText(/approved/i);
      await expect(operatorPage.locator("#confirm-cable-moved")).toBeVisible();
      await expect(operatorPage.locator("#operator-scene-activity-status")).toContainText(
        /Watching|Visual change|View changed/i,
      );
      await expect(operatorPage.locator("#operator-tracking-status")).toContainText(
        /tracking locked/i,
        { timeout: 10_000 },
      );
      await expect(supportPage.locator("#support-tracking-status")).toContainText(
        /tracking locked/i,
        { timeout: 10_000 },
      );
      const trackedAnnotation = operatorPage.locator("#operator-overlay .field-annotation").first();
      const trackedBefore = await trackedAnnotation.boundingBox();
      if (!trackedBefore) throw new Error("Tracked guidance was not measurable before camera drift");
      let releaseTrackingRequest: (() => void) | undefined;
      let observeTrackingRequest: (() => void) | undefined;
      const trackingRequestHeld = new Promise<void>((resolve) => { releaseTrackingRequest = resolve; });
      const trackingRequestObserved = new Promise<void>((resolve) => { observeTrackingRequest = resolve; });
      await operatorPage.route("**/api/operator/scene-tracking", async (route) => {
        observeTrackingRequest?.();
        await trackingRequestHeld;
        await route.continue();
      });
      await operatorPage.evaluate(async () => {
        const fixture = (window as Window & {
          __fieldAssistTrackingFixture?: { seek: (seconds: number) => Promise<void> };
        }).__fieldAssistTrackingFixture;
        if (!fixture) throw new Error("Tracking fixture disappeared");
        await fixture.seek(1.25);
      });
      await trackingRequestObserved;
      await operatorPage.waitForTimeout(350);
      await expect(operatorPage.locator("#operator-tracking-status")).toContainText(/tracking locked/i);
      await expect(supportPage.locator("#support-tracking-status")).toContainText(/tracking locked/i);
      releaseTrackingRequest?.();
      await expect(operatorPage.locator("#operator-tracking-status")).toContainText(
        /following camera drift/i,
        { timeout: 10_000 },
      );
      await expect(supportPage.locator("#support-tracking-status")).toContainText(
        /following camera drift/i,
        { timeout: 10_000 },
      );
      await expect
        .poll(async () => (await trackedAnnotation.boundingBox())?.x ?? 0, {
          timeout: 10_000,
          message: "operator guidance should follow prerecorded parallax drift",
        })
        .toBeGreaterThan(trackedBefore.x + 4);
      const trackedShifted = await trackedAnnotation.boundingBox();
      if (!trackedShifted) throw new Error("Tracked guidance was not measurable after parallax drift");
      await operatorPage.evaluate(async () => {
        const fixture = (window as Window & {
          __fieldAssistTrackingFixture?: { seek: (seconds: number) => Promise<void> };
        }).__fieldAssistTrackingFixture;
        if (!fixture) throw new Error("Tracking fixture disappeared before depth step");
        await fixture.seek(2.25);
      });
      await expect
        .poll(async () => Boolean(await trackedAnnotation.boundingBox()), {
          timeout: 10_000,
          message: "the lightweight phone bridge should keep guidance visible while the Mac is unavailable",
        })
        .toBe(true);
      const sharedWANAfterTracking = (await invokeTool(supportPage, "inspect_object", {
        objectId: "wan-port",
      })) as {
        object?: { bounds?: { x?: number; y?: number; width?: number; height?: number } };
        tracking?: {
          status?: string;
          confidence?: number;
          bounds?: { x?: number; y?: number; width?: number; height?: number };
          source?: string;
          scale?: number;
          relativeDepth?: number;
          scaleSource?: string;
          poseState?: string;
        };
      };
      expect(sharedWANAfterTracking.object?.bounds).toEqual(calibratedWAN.object?.bounds);
      expect(sharedWANAfterTracking.tracking).toMatchObject({
        status: "following_camera_drift",
        source: "browser-multiscale-template",
        scaleSource: "visual-relative",
        poseState: "unavailable",
      });
      expect(sharedWANAfterTracking.tracking?.confidence).toBeGreaterThan(0);
      expect(sharedWANAfterTracking.tracking?.bounds?.x).not.toBe(
        calibratedWAN.object?.bounds?.x,
      );
      expect(sharedWANAfterTracking.tracking?.scale).toBeGreaterThan(0);
      expect(sharedWANAfterTracking.tracking?.relativeDepth).toBeGreaterThan(0);
      const sceneActivity = await operatorPage.evaluate(async () => {
        const currentResponse = await fetch("/api/session/current", {
          credentials: "same-origin",
          cache: "no-store",
        });
        const current = await currentResponse.json() as {
          snapshot?: {
            activeApproval?: { id?: string };
            scene?: { version?: number };
          };
        };
        const response = await fetch("/api/operator/scene-activity", {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            approvalId: current.snapshot?.activeApproval?.id,
            baseSceneVersion: current.snapshot?.scene?.version,
            changeScore: 0.2,
          }),
        });
        return {
          ok: response.ok,
          status: response.status,
          body: await response.json() as {
            success?: boolean;
            activity?: { objectId?: string; source?: string };
          },
        };
      });
      expect(sceneActivity.ok, `scene activity should return 2xx (got ${sceneActivity.status})`).toBe(true);
      expect(sceneActivity.body).toMatchObject({
        success: true,
        activity: { objectId: "wan-port", source: "browser-frame-difference" },
      });
      await expect(supportPage.locator("#support-scene-activity-status")).toContainText(
        "Visual change detected",
      );
      await expect(supportPage.locator("#timeline")).toContainText(
        "Browser detected a visual change near the WAN port",
      );
      await operatorPage.locator("#confirm-cable-moved").click();
      await expect(operatorPage.locator("#confirm-status")).toContainText(/confirmed|WAN/i);
      await expect(supportPage.locator("#scene-state")).toContainText(/WAN connected/i);
      const confirmationItem = supportPage
        .locator("#timeline .timeline-item")
        .filter({ hasText: "Operator confirmed modem cable moved from LAN to WAN" });
      await expect(confirmationItem).toHaveCount(1);
      await expect(confirmationItem.locator(".timeline-meta")).toContainText("Operator");

      const afterCapture = (await invokeTool(supportPage, "capture_snapshot", {
        label: "verified-after-cable-move",
      })) as { snapshot?: { id?: string; scene?: { version?: number } } };
      expect(afterCapture.snapshot?.id, "after snapshot should have a stable id").toBeTruthy();
      expect(afterCapture.snapshot?.scene?.version).toBeGreaterThan(
        beforeCapture.snapshot?.scene?.version ?? 0,
      );

      const comparison = (await invokeTool(supportPage, "compare_snapshots", {
        beforeSnapshotId: beforeCapture.snapshot?.id,
        afterSnapshotId: afterCapture.snapshot?.id,
      })) as {
        comparison?: { same?: boolean; sceneChanged?: boolean; changed?: Array<{ id?: string }> };
      };
      expect(comparison.comparison?.same).toBe(false);
      expect(comparison.comparison?.sceneChanged).toBe(true);
      expect(comparison.comparison?.changed?.map((change) => change.id)).toEqual(
        expect.arrayContaining(["ethernet-cable-1", "lan-port", "wan-port", "modem-1"]),
      );

      await expect(supportPage.locator("#resolve-case")).toBeVisible();
      await supportPage.locator("#resolve-case").click();
      await expect(supportPage.locator("#case-status")).toContainText("Resolved");
      await expect(supportPage.locator("#timeline")).toContainText(
        "Support representative resolved the WAN connection case",
      );
      const resolvedCase = (await invokeTool(supportPage, "get_case_context", {})) as {
        case?: { status?: string; currentStepId?: string; steps?: Array<{ id?: string; status?: string }> };
      };
      expect(resolvedCase.case?.status).toBe("resolved");
      expect(resolvedCase.case?.currentStepId).toBe("");
      expect(resolvedCase.case?.steps?.find((step) => step.id === "verify-wan-connection")?.status)
        .toBe("complete");

	  await invokeTool(supportPage, "clear_annotations", {});
	  await invokeTool(supportPage, "draw_arrow", {
		objectId: "wan-port",
		text: "FINAL TARGET",
	  });
	  const instruction = (await invokeTool(supportPage, "send_operator_instruction", {
		title: "MOVE CLOSER SLOWLY",
		detail: "Take eight seconds, then hold still.",
	  })) as { instruction?: { id?: string; title?: string; detail?: string; sentBy?: string } };
	  expect(instruction.instruction).toMatchObject({
		title: "MOVE CLOSER SLOWLY",
		detail: "Take eight seconds, then hold still.",
		sentBy: "Codex via WebMCP",
	  });
	  await expect(operatorPage.locator("#operator-overlay .guidance-command-title")).toHaveText("MOVE CLOSER SLOWLY");
	  await expect(operatorPage.locator("#operator-overlay .guidance-command-hint")).toHaveText("Take eight seconds, then hold still.");
	  await expect(operatorPage.locator("#operator-overlay .guidance-command")).toHaveAttribute("data-instruction-id", instruction.instruction?.id || "");
	  await expect(operatorPage.locator("#operator-overlay .field-annotation--arrow")).toHaveCount(1);
	  await expect(supportPage.locator("#support-instruction-title")).toHaveText("MOVE CLOSER SLOWLY");
	  await expect(supportPage.locator("#support-instruction-detail")).toHaveText("Take eight seconds, then hold still.");
	  const instructionScene = (await invokeTool(supportPage, "inspect_scene", {})) as {
		operatorInstruction?: { id?: string; title?: string; detail?: string };
	  };
	  expect(instructionScene.operatorInstruction).toMatchObject({
		id: instruction.instruction?.id,
		title: "MOVE CLOSER SLOWLY",
		detail: "Take eight seconds, then hold still.",
	  });
	  const operatorEventTypes = (await probedSockets(operatorPage)).flatMap((socket) =>
		socket.messages.flatMap((raw) => {
		  try { return [JSON.parse(raw).type as string]; } catch { return []; }
		}),
	  );
	  expect(operatorEventTypes).not.toEqual(expect.arrayContaining([
		'case.resolved', 'observation.created', 'snapshot.created', 'scene.activity_detected',
		'annotation.acknowledged',
	  ]));
    } finally {
      await operatorContext.close();
    }
  });

  test("reports enhanced perception and falls back when the depth model cannot load", async ({
    browser,
    page: supportPage,
  }) => {
    await installPerceptionE2E(supportPage, {
      mode: "mock-ready",
      results: [
        {
          bounds: { x: 0.67, y: 0.55, width: 0.17, height: 0.16 },
          quad: [
            { x: 0.67, y: 0.55 }, { x: 0.84, y: 0.55 },
            { x: 0.84, y: 0.71 }, { x: 0.67, y: 0.71 },
          ],
          anchor: { x: 0.755, y: 0.71 },
          confidence: 0.94,
          moved: false,
          source: "opencv-homography+depth-anything",
          depthScore: 0.72,
          depthConfidence: 0.88,
          depthRelative: 1,
          modelRelativeDepth: 1,
          depthSource: "depth-anything-v2-small-q4f16",
        },
        {
          bounds: { x: 0.71, y: 0.55, width: 0.17, height: 0.16 },
          quad: [
            { x: 0.71, y: 0.55 }, { x: 0.88, y: 0.55 },
            { x: 0.88, y: 0.71 }, { x: 0.71, y: 0.71 },
          ],
          anchor: { x: 0.795, y: 0.71 },
          confidence: 0.9,
          moved: true,
          source: "opencv-homography+depth-anything",
          depthScore: 0.7,
          depthConfidence: 0.86,
          depthRelative: 0.94,
          modelRelativeDepth: 0.94,
          depthSource: "depth-anything-v2-small-q4f16",
        },
      ],
    });
    await supportPage.goto("/");
    await createInternalFixtureSession(supportPage);
    await expect(supportPage.locator("#support-app")).toBeVisible();

    await expect(supportPage.locator("#operator-link")).toHaveAttribute(
      "href",
      /\/session\/[^/]+\/operator\?token=[^#]+/,
    );
    const operatorHref = await supportPage.locator("#operator-link").getAttribute("href");
    if (!operatorHref) throw new Error("Support page did not expose an operator join URL");

    const operatorContext = await browser.newContext({
      ...devices["iPhone 13"],
      permissions: ["camera"],
    });
    await installPerceptionE2E(operatorContext, {
      mode: "opencv-unavailable",
    });

    const operatorPage = await operatorContext.newPage();
    const pageErrors: string[] = [];
    supportPage.on("pageerror", (error) => pageErrors.push(`support: ${error.message}`));
    operatorPage.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await operatorPage.goto(new URL(operatorHref, supportPage.url()).toString());
      await expect(operatorPage.locator("#operator-app")).toBeVisible();
      await operatorPage.locator("#operator-freeform-issue").fill("Track the visible device target.");
      await operatorPage.locator("#operator-freeform-issue-form").getByRole("button", {
        name: "Start free-form help",
      }).click();
      await expect(operatorPage.locator("#operator-issue-chooser")).toBeHidden();
      await invokeTool(supportPage, "highlight_object", { objectId: "wan-port" });
      await expect(supportPage.locator("#support-overlay")).toContainText("CONNECT HERE");
      await expect(supportPage.locator("#support-perception-status")).toHaveAttribute(
        "data-state",
        "ready",
        { timeout: 10_000 },
      );
      await expect(supportPage.locator("#support-perception-status")).toHaveAttribute(
        "data-source",
        "opencv-depth-anything",
      );

      let enhancedTracking: {
        tracking?: {
          source?: string;
          depthSource?: string;
          depthScore?: number;
          depthConfidence?: number;
          modelRelativeDepth?: number;
        };
      } = {};
      await expect
        .poll(
          async () => {
            enhancedTracking = (await invokeTool(supportPage, "inspect_object", {
              objectId: "wan-port",
            })) as typeof enhancedTracking;
            return enhancedTracking.tracking?.source ?? "";
          },
          { timeout: 15_000, message: "enhanced tracking telemetry should reach support" },
        )
        .toBe("opencv-homography+depth-anything");
      expect(enhancedTracking.tracking).toMatchObject({
        source: "opencv-homography+depth-anything",
        depthSource: "depth-anything-v2-small-q4f16",
      });
      expect(enhancedTracking.tracking?.depthScore).toBeGreaterThan(0);
      expect(enhancedTracking.tracking?.depthConfidence).toBeGreaterThan(0);
      expect(enhancedTracking.tracking?.modelRelativeDepth).toBeGreaterThan(0);

      const backendTrackingStatus = (await supportPage.locator("#support-tracking-status").textContent())?.trim();
      expect(backendTrackingStatus).toMatch(/tracking locked|following camera drift/i);
      await expect(operatorPage.locator("#operator-tracking-status")).toHaveText(backendTrackingStatus as string);
      let releaseSupportTrackingRequest: (() => void) | undefined;
      let observeSupportTrackingRequest: (() => void) | undefined;
      const supportTrackingRequestHeld = new Promise<void>((resolve) => { releaseSupportTrackingRequest = resolve; });
      const supportTrackingRequestObserved = new Promise<void>((resolve) => { observeSupportTrackingRequest = resolve; });
      await supportPage.route("**/api/support/scene-tracking", async (route) => {
        observeSupportTrackingRequest?.();
        await supportTrackingRequestHeld;
        await route.continue();
      });

      await supportPage.evaluate(() => {
        const config = (window as Window & {
          __fieldAssistPerceptionE2E?: PerceptionE2EConfig;
        }).__fieldAssistPerceptionE2E;
        if (!config) throw new Error("Perception E2E configuration was not installed");
        config.results = [{
          bounds: { x: 0.71, y: 0.55, width: 0.17, height: 0.16 },
          confidence: 0,
          lost: true,
          source: "opencv-homography",
          reason: "insufficient-matches",
        }];
      });
      await supportTrackingRequestObserved;
      await supportPage.waitForTimeout(350);
      await expect(operatorPage.locator("#operator-tracking-status")).toHaveText(backendTrackingStatus as string);
      await expect(supportPage.locator("#support-tracking-status")).toHaveText(backendTrackingStatus as string);
      releaseSupportTrackingRequest?.();
      await expect.poll(async () => {
        const inspected = (await invokeTool(supportPage, "inspect_object", {
          objectId: "wan-port",
        })) as { tracking?: { status?: string; source?: string } };
        return `${inspected.tracking?.status ?? ""}:${inspected.tracking?.source ?? ""}`;
      }, {
        timeout: 10_000,
        message: "enhanced loss must replace stale locked telemetry",
      }).toBe("reacquire_required:opencv-homography");

      await supportPage.evaluate(() => {
        const config = (window as Window & {
          __fieldAssistPerceptionE2E?: PerceptionE2EConfig;
        }).__fieldAssistPerceptionE2E;
        if (!config) throw new Error("Perception E2E configuration was not installed");
        config.mode = "depth-model-failure";
      });
      await invokeTool(supportPage, "clear_annotations", {});
      await expect(supportPage.locator("#support-overlay")).not.toContainText("CONNECT HERE");
      await invokeTool(supportPage, "highlight_object", { objectId: "wan-port" });
      await expect(supportPage.locator("#support-perception-status")).toHaveAttribute(
        "data-state",
        "fallback",
      );
      await expect(supportPage.locator("#support-perception-status")).toHaveAttribute(
        "data-source",
        "opencv-homography",
      );
      await expect(supportPage.locator("#support-perception-status")).toHaveAttribute(
        "data-reason",
        "model-load-failed",
      );
      await expect(supportPage.locator("#support-perception-status")).toContainText(
        /depth model unavailable/i,
      );
      await expect(supportPage.locator("#support-overlay")).toContainText("CONNECT HERE");
      expect(pageErrors, pageErrors.join("\n")).toEqual([]);
    } finally {
      await operatorContext.close();
    }
  });

  test("reconnects the support socket and restores the current session snapshot", async ({
    page,
  }) => {
    await installWebSocketProbe(page);
    await page.goto("/");
    await expect(page.locator("#landing-app")).toBeVisible();
	await createInternalFixtureSession(page);
    await expect(page.locator("#support-app")).toBeVisible();
    await expect(page.locator("#signal-status")).toHaveText(/open/i);

    const highlight = (await invokeTool(page, "highlight_object", {
      objectId: "wan-port",
    })) as { annotation?: { id?: string; label?: string } };
    expect(highlight.annotation?.id, "highlight should return a durable annotation id").toBeTruthy();
    await expect(page.locator("#support-overlay")).toContainText("CONNECT HERE");
    await expect(page.locator("#timeline")).toContainText(/Highlighted (WAN port|CONNECT HERE)/i);
	const banner = (await invokeTool(page, "send_operator_instruction", {
	  title: "HOLD STEADY",
	  detail: "Keep the full device in view.",
	})) as { instruction?: { id?: string } };
	expect(banner.instruction?.id).toBeTruthy();
	await expect(page.locator("#support-instruction-title")).toHaveText("HOLD STEADY");

    const before = await probedSockets(page);
    expect(before.length, "the support page should have an open socket").toBeGreaterThan(0);

    await page.evaluate(() => {
      const records = (window as Window & {
        __fieldAssistSocketRecords?: Array<{ socket: WebSocket; messages: string[] }>;
      }).__fieldAssistSocketRecords ?? [];
      const open = records.find((record) => record.socket.readyState === WebSocket.OPEN);
      if (!open) throw new Error("No open support WebSocket was available to close");
      open.socket.close(1000, "acceptance reconnect");
    });

    await expect
      .poll(() => probedSockets(page).then((sockets) => sockets.length), {
        timeout: 15_000,
        message: "the support client should create a replacement WebSocket",
      })
      .toBeGreaterThan(before.length);
    await expect(page.locator("#signal-status")).toHaveText(/open/i, { timeout: 15_000 });

    await expect
      .poll(
        async () => {
          const sockets = await probedSockets(page);
          const reconnectSockets = sockets.slice(before.length);
          const snapshots = reconnectSockets.flatMap((socket) =>
            socket.messages.flatMap((raw) => {
              try {
                const event = JSON.parse(raw) as {
                  type?: string;
                  payload?: unknown;
                };
                return event.type === "session.snapshot" ? [event] : [];
              } catch {
                return [];
              }
            }),
          );
          const latest = snapshots[snapshots.length - 1];
          if (!latest) return false;
          const snapshot = typeof latest.payload === "string"
              ? JSON.parse(latest.payload) as {
                annotations?: Array<{ label?: string; objectId?: string }>;
				operatorInstruction?: { id?: string; title?: string };
                timeline?: Array<{ message?: string }>;
              }
            : latest.payload as {
                annotations?: Array<{ label?: string; objectId?: string }>;
				operatorInstruction?: { id?: string; title?: string };
                timeline?: Array<{ message?: string }>;
              };
          return Boolean(
            snapshot.annotations?.some(
              (annotation) => annotation.objectId === "wan-port" && annotation.label === "CONNECT HERE",
			) && snapshot.operatorInstruction?.id === banner.instruction?.id &&
			snapshot.operatorInstruction?.title === "HOLD STEADY" &&
			snapshot.timeline?.some((item) => /Highlighted WAN port/i.test(item.message ?? "")),
          );
        },
        {
          timeout: 15_000,
          message: "the reconnect snapshot should contain the existing annotation and timeline",
        },
      )
      .toBe(true);

    // The snapshot assertion above proves server-side restoration; this
    // assertion proves the restored state is still rendered to the operator
    // of the support console after the replacement socket opens.
	await expect(page.locator(`[data-annotation-id="${highlight.annotation?.id}"]`)).toBeVisible();
	await expect(page.locator("#support-instruction-title")).toHaveText("HOLD STEADY");
    await expect(page.locator("#timeline")).toContainText(/Highlighted WAN port/i);
  });

  test("recovers from denied camera permission through the visible retry", async ({
    browser,
    page: supportPage,
  }) => {
    await supportPage.goto("/");
	await createInternalFixtureSession(supportPage);
    await expect(supportPage.locator("#support-app")).toBeVisible();

    await expect(supportPage.locator("#operator-link")).toHaveAttribute(
      "href",
      /\/session\/[^/]+\/operator\?token=[^#]+/,
    );
    const operatorHref = await supportPage.locator("#operator-link").getAttribute("href");
    if (!operatorHref) throw new Error("Support page did not expose an operator join URL");

    const operatorContext = await browser.newContext({
      ...devices["iPhone 13"],
      permissions: [],
    });
    try {
      await installPerceptionE2E(operatorContext, { mode: "opencv-unavailable" });
      await operatorContext.addInitScript(() => {
        if (!(window as Window & { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent) {
          Object.defineProperty(window, "DeviceOrientationEvent", { value: function DeviceOrientationEvent() {} });
        }
      });
      const operatorPage = await operatorContext.newPage();
      await operatorPage.addInitScript(() => {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
          throw new Error("Camera test requires navigator.mediaDevices.getUserMedia");
        }
        const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        let denied = true;
        const control = {
          setDenied(value: boolean) {
            denied = value;
          },
        };
        Object.defineProperty(
          window,
          "__fieldAssistCameraControl",
          { configurable: true, value: control },
        );
        const deniedGetUserMedia = (constraints: MediaStreamConstraints) => {
          if (denied) {
            return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
          }
          return originalGetUserMedia(constraints);
        };
        // Chromium exposes getUserMedia on MediaDevices.prototype. Define an
        // own property first, then fall back to the prototype for engines
        // that make the instance method non-writable.
        try {
          Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
            configurable: true,
            writable: true,
            value: deniedGetUserMedia,
          });
        } catch {
          Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getUserMedia", {
            configurable: true,
            writable: true,
            value: deniedGetUserMedia,
          });
        }
      });
      await operatorPage.goto(new URL(operatorHref, supportPage.url()).toString());
      await expect(operatorPage.locator("#operator-app")).toBeVisible();
      await operatorPage.locator("#operator-tv-demo").click();
      await expect(operatorPage.locator("#operator-issue-chooser")).toBeHidden();

      await expect(operatorPage.locator("#operator-instruction")).toContainText(
        /Camera permission was denied/i,
        { timeout: 15_000 },
      );
      await expect(operatorPage.locator("#camera-permission")).toBeVisible();
	  await expect(supportPage.locator("#support-stage")).toHaveAttribute("data-state", "joined");
	  await expect(supportPage.locator("#stage-joined")).toBeVisible();
	  await expect(supportPage.locator("#stage-pairing")).toBeHidden();
      const retry = operatorPage.locator("#start-camera");
      await expect(retry).toBeVisible();
      await expect(retry).toBeEnabled();

      await operatorPage.evaluate(() => {
        const control = (window as Window & {
          __fieldAssistCameraControl?: { setDenied(value: boolean): void };
        }).__fieldAssistCameraControl;
        if (!control) throw new Error("Camera denial control was not installed");
        control.setDenied(false);
      });
      await retry.click();

      await expect
        .poll(() => hasLiveVideoTrack(operatorPage.locator("#local-video")), {
          timeout: 30_000,
          message: "retrying after permission denial should produce a live local track",
        })
        .toBe(true);
      await expect(operatorPage.locator("#camera-permission")).toBeHidden();
      await expect(operatorPage.locator("#operator-instruction")).not.toContainText(
        /permission was denied/i,
      );
	  await expect(supportPage.locator("#support-stage")).toHaveAttribute("data-state", "live", {
		timeout: 30_000,
	  });
    } finally {
      await operatorContext.close();
    }
  });

  test("builds a live scene from observed targets and keeps the compact operator shell bounded", async ({
    browser,
    page: supportPage,
  }) => {
	await installPerceptionE2E(supportPage, {
	  mode: "mock-ready",
	  results: [{
		bounds: { x: 0.16, y: 0.14, width: 0.68, height: 0.58 },
		quad: [
		  { x: 0.16, y: 0.14 }, { x: 0.84, y: 0.14 },
		  { x: 0.84, y: 0.72 }, { x: 0.16, y: 0.72 },
		],
		anchor: { x: 0.72, y: 0.6956 },
		confidence: 0.94,
		moved: false,
		source: "opencv-homography+depth-anything",
		depthScore: 0.72,
		depthConfidence: 0.88,
		depthRelative: 1,
		modelRelativeDepth: 1,
		depthSource: "depth-anything-v2-small-q4f16",
	  }],
	});
    await supportPage.goto("/");
    await Promise.all([
      supportPage.waitForURL(/\/session\/[^/]+$/),
      supportPage.locator("#create-session").click(),
    ]);
    await expect(supportPage.locator("#support-app")).toBeVisible();
    await expect(supportPage.locator("#scene-state")).toHaveText(/awaiting observation/i);
    await expect(supportPage.locator("#demo-object-row")).toBeHidden();
    await expect(supportPage.locator("#webmcp-status")).toHaveText(/WebMCP supported|manual controls/i);

    await expect(supportPage.locator("#operator-link")).toHaveAttribute(
      "href",
      /\/session\/[^/]+\/operator\?token=[^#]+/,
    );
    const operatorHref = await supportPage.locator("#operator-link").getAttribute("href");
    if (!operatorHref) throw new Error("Support page did not expose an operator join URL");
    const operatorContext = await browser.newContext({
      baseURL: supportPage.url(),
      viewport: { width: 320, height: 568 },
      permissions: ["camera"],
    });
    try {
      await installPerceptionE2E(operatorContext, { mode: "opencv-unavailable" });
      await operatorContext.addInitScript(() => {
        if (!(window as Window & { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent) {
          Object.defineProperty(window, "DeviceOrientationEvent", { value: function DeviceOrientationEvent() {} });
        }
      });
      const operatorPage = await operatorContext.newPage();
      await routeDepthParallaxVideo(operatorPage);
      await operatorPage.goto(new URL(operatorHref, supportPage.url()).toString());
      await expect(operatorPage.locator("#operator-app")).toBeVisible();
      await expect(operatorPage.locator("#operator-issue-chooser")).toBeVisible();
      const pendingScene = (await invokeTool(supportPage, "inspect_scene", {})) as {
        operatorIssue?: unknown;
        objects?: unknown[];
      };
      expect(pendingScene).not.toHaveProperty("operatorIssue");
      expect(pendingScene.objects).toHaveLength(0);
      await operatorPage.locator("#operator-tv-demo").click();
      await expect(operatorPage.locator("#operator-issue-chooser")).toBeHidden();
      const selectedScene = (await invokeTool(supportPage, "inspect_scene", {})) as {
        version: number;
        operatorIssue?: { mode?: string; presetId?: string; summary?: string };
      };
      expect(selectedScene.operatorIssue).toMatchObject({
        summary: "I lost my controller. How do I control my TV?",
      });
      await expect(supportPage.locator("#operator-issue-summary")).toBeVisible();
      await expect(supportPage.locator("#operator-issue-title")).toContainText("lost my controller");
      await expect
        .poll(() => hasLiveVideoTrack(operatorPage.locator("#local-video")), {
          timeout: 30_000,
          message: "the TV demo choice should start the rear camera",
        })
        .toBe(true);
      await operatorPage.evaluate(async () => {
        const video = document.querySelector<HTMLVideoElement>("#local-video");
        if (!video) throw new Error("Local video was unavailable for generic tracking");
        video.pause();
        video.srcObject = null;
        video.src = "/__e2e__/depth-parallax.webm";
        video.loop = false;
        video.muted = true;
        video.preload = "auto";
        video.load();
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise<void>((resolve, reject) => {
            video.addEventListener("loadedmetadata", () => resolve(), { once: true });
            video.addEventListener("error", () => reject(video.error), { once: true });
          });
        }
        const seek = async (seconds: number) => {
          await new Promise<void>((resolve, reject) => {
            video.addEventListener("seeked", () => resolve(), { once: true });
            video.addEventListener("error", () => reject(video.error), { once: true });
            video.currentTime = seconds;
          });
          video.pause();
        };
        await seek(0.25);
      });

      const television = (await invokeTool(supportPage, "register_scene_object", {
        label: "Television",
        kind: "television",
        bounds: { x: 0.16, y: 0.14, width: 0.68, height: 0.58 },
        baseSceneVersion: selectedScene.version,
      })) as { object?: { id?: string }; scene?: { version?: number } };
      expect(television.object?.id).toMatch(/^observed-/);
	  const outsideTelevisionArrow = await supportPage.evaluate(async ({ objectId, contextVersion }) => {
		const response = await fetch("/api/tools/draw-arrow", {
		  method: "POST",
		  credentials: "same-origin",
		  headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Gofastr-WebMCP": "1",
		  },
		  body: JSON.stringify({
			objectId,
			text: "WRONG TARGET",
			anchor: { x: 0.5, y: 0.5 },
			contextVersion,
		  }),
		});
		return { ok: response.ok, status: response.status, body: await response.text() };
	  }, {
		objectId: television.object?.id,
		contextVersion: await loadFieldAssistContextVersion(supportPage),
	  });
	  expect(outsideTelevisionArrow.ok).toBe(false);
	  expect(outsideTelevisionArrow.status).toBe(422);
	  expect(outsideTelevisionArrow.body).toMatch(/verified device-control|specific control/i);

      const sceneAfterCue = (await invokeTool(supportPage, "inspect_scene", {})) as { version: number };
      const control = (await invokeTool(supportPage, "register_scene_object", {
        label: "TV power button",
        kind: "device-control",
        bounds: { x: 0.62, y: 0.48, width: 0.2, height: 0.22 },
        baseSceneVersion: sceneAfterCue.version,
      })) as { object?: { id?: string; label?: string; confidence?: number; attributes?: Record<string, unknown> } };
      expect(control.object).toMatchObject({
        label: "TV power button",
        attributes: expect.objectContaining({
          localizationStatus: "provisional",
          trackingReferenceObjectId: television.object?.id,
        }),
      });
      expect(control.object?.confidence).toBeLessThan(1);
      const objectID = control.object?.id;
      expect(objectID).toMatch(/^observed-/);
      await expect(supportPage.locator("#scene-object-list")).toContainText("TV power button");
      await expect(supportPage.locator("#scene-object-list .scene-object-recalibrate")).toHaveCount(2);
	  const outsideControlArrow = await supportPage.evaluate(async ({ objectId, contextVersion }) => {
		const response = await fetch("/api/tools/draw-arrow", {
		  method: "POST",
		  credentials: "same-origin",
		  headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Gofastr-WebMCP": "1",
		  },
		  body: JSON.stringify({ objectId, text: "OUTSIDE TARGET", anchor: { x: 0.5, y: 1.04 }, contextVersion }),
		});
		return { ok: response.ok, status: response.status, body: await response.text() };
	  }, {
		objectId: objectID,
		contextVersion: await loadFieldAssistContextVersion(supportPage),
	  });
	  expect(outsideControlArrow.ok).toBe(false);
	  expect(outsideControlArrow.status).toBe(400);
	  expect(outsideControlArrow.body).toContain("registered object");

      const transientCloseup = (await invokeTool(supportPage, "request_closeup", {
        objectId: television.object?.id,
      })) as { annotation?: { id?: string } };
      expect(transientCloseup.annotation?.id).toEqual(expect.any(String));
      await expect(operatorPage.locator("#operator-overlay .field-annotation--closeup")).toHaveCount(1);

      const arrow = (await invokeTool(supportPage, "draw_arrow", {
        objectId: objectID,
        text: "POWER BUTTON",
        anchor: { x: 0.5, y: 0.98 },
      })) as { annotation?: { id?: string; kind?: string; anchor?: { x?: number; y?: number } } };
      expect(arrow.annotation).toMatchObject({ kind: "arrow", anchor: { x: 0.5, y: 0.98 } });
      await expect(operatorPage.locator("#operator-overlay .field-annotation--closeup")).toHaveCount(0);
      await expect(supportPage.locator("#support-overlay")).toContainText("POWER BUTTON");
      await expect(operatorPage.locator("#operator-overlay")).toContainText("POWER BUTTON");
      const operatorArrow = operatorPage.locator(`[data-annotation-id="${arrow.annotation?.id}"]`);
      await expect(operatorArrow).toHaveClass(/field-annotation--arrow/);
      await expect(operatorArrow).toHaveCSS("border-top-width", "0px");
	  await expect(operatorArrow).toBeHidden();
	  await expect(operatorArrow).toHaveAttribute("aria-hidden", "true");
	  await expect(operatorArrow.locator(".field-annotation-leader")).toHaveCount(0);
      const arrowVisuals = await operatorArrow.evaluate((element) => ({
        before: getComputedStyle(element, "::before").display,
        after: getComputedStyle(element, "::after").display,
        boxShadow: getComputedStyle(element).boxShadow,
      }));
      expect(arrowVisuals).toEqual({ before: "none", after: "none", boxShadow: "none" });
      const supportSnapshot = async () => {
        const response = await supportPage.request.get("/api/session/current");
        expect(response.ok()).toBe(true);
        const body = await response.json() as {
          snapshot?: {
            annotations?: Array<{ id?: string }>;
            annotationReceipts?: Array<{ annotationId?: string }>;
          };
        };
        return body.snapshot ?? {};
      };
      const deliveryBeforeLock = await supportSnapshot();
      expect(deliveryBeforeLock.annotationReceipts ?? []).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ annotationId: arrow.annotation?.id }),
      ]));
      await operatorArrow.evaluate((element) => {
        element.setAttribute("data-e2e-stability-marker", "preserved");
      });
      await expect(operatorPage.locator("#operator-tracking-status")).toContainText(
        /tracking locked/i,
        { timeout: 10_000 },
      );
      await expect(supportPage.locator("#support-tracking-status")).toContainText(
        /tracking locked/i,
        { timeout: 10_000 },
      );
	  await expect(operatorArrow).not.toHaveClass(/field-annotation--suppressed/);
      await expect(operatorArrow).not.toHaveAttribute("aria-hidden", "true");
	  await expect(operatorArrow.locator(".field-annotation-leader")).toHaveCount(1);
      await expect(operatorArrow).toHaveAttribute("data-e2e-stability-marker", "preserved");
      await expect.poll(async () => {
        const snapshot = await supportSnapshot();
        return snapshot.annotationReceipts?.some((receipt) => receipt.annotationId === arrow.annotation?.id) ?? false;
      }).toBe(true);
      await expect(supportPage.locator(`[data-object-id="${objectID}"]`).getByRole("button", { name: "Recalibrate" })).toBeVisible();
      const lockedObject = (await invokeTool(supportPage, "inspect_object", {
        objectId: objectID,
      })) as {
        object?: { bounds?: { x?: number; y?: number; width?: number; height?: number } };
        tracking?: { status?: string; guidanceId?: string; referenceObjectId?: string };
      };
      expect(lockedObject.tracking).toMatchObject({
        status: "locked",
        guidanceId: expect.any(String),
        referenceObjectId: television.object?.id,
      });

      await operatorPage.evaluate(async (bounds) => {
        const video = document.querySelector<HTMLVideoElement>("#local-video");
        if (!video) throw new Error("Local video disappeared before the dynamic-content test");
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Dynamic-content canvas was unavailable");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        video.pause();
        video.removeAttribute("src");
        video.srcObject = canvas.captureStream(10);
        await video.play();
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        // A large animated display can change a substantial part of the frame
        // without the phone moving. It must not trip the global camera-motion
        // guard or suppress guidance for a stable nearby target.
        context.fillStyle = "#5734d1";
        context.fillRect(
          canvas.width * 0.1,
          canvas.height * 0.08,
          canvas.width * 0.8,
          canvas.height * 0.32,
        );
        const insetX = bounds.width * 0.2;
        const insetY = bounds.height * 0.2;
        context.fillStyle = "#f5a623";
        context.fillRect(
          (bounds.x + insetX) * canvas.width,
          (bounds.y + insetY) * canvas.height,
          (bounds.width - insetX * 2) * canvas.width,
          (bounds.height - insetY * 2) * canvas.height,
        );
      }, lockedObject.object?.bounds as { x: number; y: number; width: number; height: number });
      await expect(operatorPage.locator("#operator-tracking-status")).toContainText(
        /tracking locked|following camera drift/i,
        { timeout: 5_000 },
      );
      const dynamicContentObject = (await invokeTool(supportPage, "inspect_object", {
        objectId: objectID,
      })) as { tracking?: { status?: string; needsRecalibration?: boolean } };
      expect(dynamicContentObject.tracking?.status).toMatch(/locked|following_camera_drift/);
      expect(dynamicContentObject.tracking?.needsRecalibration).not.toBe(true);

      const lossReport = await supportPage.evaluate(async ({ objectId, referenceObjectId, guidanceId, baseSceneVersion, bounds }) => {
        const response = await fetch("/api/support/scene-tracking", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Gofastr-Request": "1",
          },
          body: JSON.stringify({
            guidanceId,
            objectId,
			referenceObjectId,
            baseSceneVersion,
            status: "reacquire_required",
            confidence: 0,
            bounds,
            source: "opencv-homography+depth-anything",
            depthSource: "depth-anything-v2-small-q4f16",
            depthScore: 0.72,
            depthConfidence: 0.88,
            modelRelativeDepth: 1,
          }),
        });
        return { ok: response.ok, status: response.status, body: await response.json() };
      }, {
        objectId: objectID as string,
		referenceObjectId: television.object?.id as string,
        guidanceId: lockedObject.tracking?.guidanceId as string,
        baseSceneVersion: (await invokeTool(supportPage, "inspect_scene", {}) as { version: number }).version,
		bounds: { x: 0.16, y: 0.14, width: 0.68, height: 0.58 },
      });
      expect(lossReport.ok, `loss telemetry should return 2xx (got ${lossReport.status})`).toBe(true);
      expect(lossReport.body.tracking).not.toHaveProperty("quad");
      expect(lossReport.body.tracking).not.toHaveProperty("anchor");
      await expect(operatorPage.locator("#operator-tracking-status")).toContainText(
        /tracking lost/i,
        { timeout: 10_000 },
      );
      await expect(supportPage.locator("#support-tracking-status")).toContainText(
        /recalibration recommended/i,
        { timeout: 10_000 },
      );
      await supportPage.locator("#camera-status-toggle").click();
      await expect(supportPage.locator("#camera-status-items")).toBeVisible();
      for (const viewport of [
        { width: 896, height: 844 },
        { width: 1024, height: 768 },
        { width: 1280, height: 800 },
      ]) {
        await supportPage.setViewportSize(viewport);
        const supportGeometry = await supportPage.evaluate(() => {
          const columnElement = document.querySelector<HTMLElement>(".case-column");
          const column = columnElement?.getBoundingClientRect();
          const stage = document.querySelector<HTMLElement>("#support-stage")?.getBoundingClientRect();
          const statuses = document.querySelector<HTMLElement>("#camera-status-hud");
          const badges = Array.from(document.querySelectorAll<HTMLElement>("#camera-status-hud .camera-status-control"))
            .map((badge) => {
              const rect = badge.getBoundingClientRect();
              return {
                left: rect.left,
                right: rect.right,
                width: rect.width,
                clientWidth: badge.clientWidth,
                scrollWidth: badge.scrollWidth,
              };
            });
          return {
            innerWidth: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
            column: column && {
              left: column.left,
              right: column.right,
              width: column.width,
              clientWidth: columnElement?.clientWidth ?? 0,
              scrollWidth: columnElement?.scrollWidth ?? 0,
            },
            statuses: statuses && {
              left: statuses.getBoundingClientRect().left,
              right: statuses.getBoundingClientRect().right,
              clientWidth: statuses.clientWidth,
              scrollWidth: statuses.scrollWidth,
            },
            stage: stage && { left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom },
            badges,
          };
        });
        expect(supportGeometry.documentWidth).toBeLessThanOrEqual(supportGeometry.innerWidth + 1);
        expect(supportGeometry.bodyWidth).toBeLessThanOrEqual(supportGeometry.innerWidth + 1);
        expect(supportGeometry.badges.length).toBeGreaterThan(0);
        expect(supportGeometry.column?.scrollWidth).toBeLessThanOrEqual((supportGeometry.column?.clientWidth ?? 0) + 1);
        expect(supportGeometry.statuses?.scrollWidth).toBeLessThanOrEqual((supportGeometry.statuses?.clientWidth ?? 0) + 1);
        for (const badge of supportGeometry.badges) {
          expect(badge.left).toBeGreaterThanOrEqual((supportGeometry.stage?.left ?? 0) - 1);
          expect(badge.right).toBeLessThanOrEqual((supportGeometry.stage?.right ?? viewport.width) + 1);
          expect(badge.left).toBeGreaterThanOrEqual((supportGeometry.statuses?.left ?? 0) - 1);
          expect(badge.right).toBeLessThanOrEqual((supportGeometry.statuses?.right ?? viewport.width) + 1);
          expect(badge.width).toBeLessThanOrEqual((supportGeometry.column?.width ?? viewport.width) + 1);
          expect(badge.scrollWidth).toBeLessThanOrEqual(badge.clientWidth + 1);
        }
      }
      await supportPage.setViewportSize({ width: 1280, height: 720 });
      await expect(operatorPage.locator("#operator-overlay .guidance-command-title")).toHaveText("POWER BUTTON");
      await expect(supportPage.locator("#support-overlay .guidance-command-title")).toHaveText("POWER BUTTON");
      await expect(operatorPage.locator("#operator-overlay .guidance-command-hint")).toContainText(
        "marked device is visible",
      );
      await expect(supportPage.locator("#support-overlay .guidance-command-hint")).toContainText(
        "marked device is visible",
      );
      await expect(operatorArrow).toBeHidden();
      await expect(operatorArrow).toHaveAttribute("aria-hidden", "true");
      await expect(operatorArrow.locator(".field-annotation-leader")).toHaveCount(0);
      const lostObject = (await invokeTool(supportPage, "inspect_object", {
        objectId: objectID,
      })) as { tracking?: { status?: string; confidence?: number; needsRecalibration?: boolean } };
      expect(lostObject.tracking).toMatchObject({
        status: "reacquire_required",
        confidence: 0,
        needsRecalibration: true,
      });
      const deliveryAfterLoss = await supportSnapshot();
      expect(deliveryAfterLoss.annotationReceipts ?? []).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ annotationId: arrow.annotation?.id }),
      ]));
      await invokeTool(supportPage, "request_move", { direction: "closer" });
      await expect(operatorPage.locator(".guidance-command-title")).toHaveText("MOVE CLOSER");
      await expect(operatorPage.locator(".guidance-command-hint")).toContainText(
        "target marker paused until the camera settles",
      );
      await expect(operatorPage.locator(".guidance-direction")).toHaveText("IN");

      await operatorPage.evaluate(() => {
        const event = new Event("deviceorientation");
        Object.defineProperties(event, {
          alpha: { value: 12 },
          beta: { value: 58 },
          gamma: { value: 2 },
        });
        window.dispatchEvent(event);
      });
	  const sharedBounds = { x: 0.18, y: 0.15, width: 0.68, height: 0.58 };
      const sharedQuad = [
		{ x: 0.18, y: 0.15 },
		{ x: 0.86, y: 0.15 },
		{ x: 0.86, y: 0.73 },
		{ x: 0.18, y: 0.73 },
      ];
	  const sharedAnchor = { x: 0.735, y: 0.70 };
      const sharedTracking = await supportPage.evaluate(async ({
        objectID: trackedObjectID,
		referenceObjectID,
        guidanceID,
        sceneVersion,
        bounds,
        quad,
        anchor,
      }) => {
        const response = await fetch("/api/support/scene-tracking", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Gofastr-Request": "1",
          },
          body: JSON.stringify({
            guidanceId: guidanceID,
            objectId: trackedObjectID,
			referenceObjectId: referenceObjectID,
            baseSceneVersion: sceneVersion,
            status: "locked",
            confidence: 0.91,
            bounds,
            quad,
            anchor,
            source: "opencv-homography+depth-anything",
            depthSource: "depth-anything-v2-small-q4f16",
            depthScore: 0.73,
            depthConfidence: 0.87,
            modelRelativeDepth: 0.96,
          }),
        });
        return { ok: response.ok, status: response.status, body: await response.json() };
      }, {
        objectID: objectID as string,
		referenceObjectID: television.object?.id as string,
        guidanceID: lockedObject.tracking?.guidanceId as string,
        sceneVersion: (await invokeTool(supportPage, "inspect_scene", {}) as { version: number }).version,
        bounds: sharedBounds,
        quad: sharedQuad,
        anchor: sharedAnchor,
      });
      expect(
        sharedTracking.ok,
        `shared support tracking should return 2xx (got ${sharedTracking.status}: ${JSON.stringify(sharedTracking.body)})`,
      ).toBe(true);
      expect(sharedTracking.body.tracking).toMatchObject({
        quad: sharedQuad,
        anchor: sharedAnchor,
      });
      await expect(operatorPage.locator("#operator-tracking-status")).toContainText(
        /tracking locked/i,
        { timeout: 10_000 },
      );
      await expect(operatorArrow).not.toHaveClass(
        /field-annotation--suppressed/,
      );
      const sharedOperatorBounds = await operatorArrow.evaluate((element) => {
        const overlay = document.querySelector<HTMLElement>("#operator-overlay");
        const video = document.querySelector<HTMLVideoElement>("#local-video");
        if (!overlay || !video) throw new Error("Operator media geometry was unavailable");
        const elementRect = element.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        const videoRatio = video.videoWidth / video.videoHeight;
        const overlayRatio = overlayRect.width / overlayRect.height;
        const mediaWidth = videoRatio > overlayRatio ? overlayRect.width : overlayRect.height * videoRatio;
        const mediaHeight = videoRatio > overlayRatio ? overlayRect.width / videoRatio : overlayRect.height;
        const mediaLeft = overlayRect.left + (overlayRect.width - mediaWidth) / 2;
        const mediaTop = overlayRect.top + (overlayRect.height - mediaHeight) / 2;
        return {
          x: (elementRect.left - mediaLeft) / mediaWidth,
          y: (elementRect.top - mediaTop) / mediaHeight,
          width: elementRect.width / mediaWidth,
          height: elementRect.height / mediaHeight,
        };
      });
      expect(sharedOperatorBounds.x).toBeCloseTo(sharedAnchor.x, 1);
      expect(sharedOperatorBounds.y).toBeCloseTo(sharedAnchor.y, 1);
      expect(sharedOperatorBounds.width).toBeCloseTo(0, 1);
      expect(sharedOperatorBounds.height).toBeCloseTo(0, 1);
      await expect(operatorArrow).toHaveAttribute("data-anchor-space", "object-homography");
      await expect(operatorArrow).toHaveAttribute("data-e2e-stability-marker", "preserved");
      await expect.poll(async () => {
        const snapshot = await supportSnapshot();
        return snapshot.annotationReceipts?.some((receipt) => receipt.annotationId === arrow.annotation?.id) ?? false;
      }).toBe(true);
      const baselineOperatorPosition = await operatorArrow.boundingBox();
      expect(baselineOperatorPosition).not.toBeNull();

      await operatorPage.evaluate(() => {
        const event = new Event("deviceorientation");
        Object.defineProperties(event, {
          alpha: { value: 18 },
          beta: { value: 54 },
          gamma: { value: 2 },
        });
        window.dispatchEvent(event);
      });
      await expect(operatorArrow).toHaveAttribute("data-pose-predicted", "true");
      const predictedOperatorPosition = await operatorArrow.boundingBox();
      expect(predictedOperatorPosition).not.toBeNull();
      expect(predictedOperatorPosition!.x).toBeLessThan(baselineOperatorPosition!.x - 10);
      await operatorPage.evaluate(() => {
        const event = new Event("deviceorientation");
        Object.defineProperties(event, {
          alpha: { value: 12 },
          beta: { value: 58 },
          gamma: { value: 2 },
        });
        window.dispatchEvent(event);
      });
      await expect(operatorArrow).toHaveAttribute("data-pose-predicted", "false");
      const authoritativeObject = (await invokeTool(supportPage, "inspect_object", {
        objectId: objectID,
      })) as { object?: { bounds?: unknown } };
      expect(authoritativeObject.object?.bounds).toEqual(lockedObject.object?.bounds);

      await operatorPage.evaluate(async () => {
        const video = document.querySelector<HTMLVideoElement>("#local-video");
        if (!video) throw new Error("Local video disappeared before recalibration");
        video.pause();
        video.srcObject = null;
        video.src = "/__e2e__/depth-parallax.webm";
        video.loop = false;
        video.muted = true;
        video.preload = "auto";
        video.load();
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise<void>((resolve, reject) => {
            video.addEventListener("loadedmetadata", () => resolve(), { once: true });
            video.addEventListener("error", () => reject(video.error), { once: true });
          });
        }
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(video.error), { once: true });
          video.currentTime = 0.25;
        });
        video.pause();
      });
      const sceneBeforeRecalibration = (await invokeTool(supportPage, "inspect_scene", {})) as {
        version: number;
        objects: Array<{ id: string }>;
      };
      const recalibratedBounds = { x: 0.6, y: 0.46, width: 0.22, height: 0.24 };
      const recalibrated = (await invokeTool(supportPage, "recalibrate_object", {
        objectId: objectID,
        bounds: recalibratedBounds,
        baseSceneVersion: sceneBeforeRecalibration.version,
      })) as {
        scene?: { version?: number; objects?: Array<{ id?: string; bounds?: unknown; attributes?: Record<string, unknown> }> };
        timelineItem?: { actor?: string; type?: string };
      };
      expect(recalibrated.scene?.version).toBe(sceneBeforeRecalibration.version + 1);
      expect(recalibrated.scene?.objects).toHaveLength(sceneBeforeRecalibration.objects.length);
      expect(recalibrated.scene?.objects).toContainEqual(expect.objectContaining({
        id: objectID,
        bounds: recalibratedBounds,
        attributes: expect.objectContaining({ boundsSource: "codex-vision" }),
      }));
      expect(recalibrated.timelineItem).toMatchObject({
        actor: "Codex via WebMCP",
        type: "scene.calibrated",
      });
      await expect(operatorPage.locator("#operator-tracking-status")).toContainText(
        /tracking locked/i,
        { timeout: 10_000 },
      );
      await expect(supportPage.locator("#support-tracking-status")).toContainText(
        /tracking locked/i,
        { timeout: 10_000 },
      );
      const reacquiredObject = (await invokeTool(supportPage, "inspect_object", {
        objectId: objectID,
      })) as {
        object?: { id?: string; bounds?: unknown };
        sceneVersion?: number;
        tracking?: { status?: string; baseSceneVersion?: number; needsRecalibration?: boolean };
      };
      expect(reacquiredObject.object).toMatchObject({ id: objectID, bounds: recalibratedBounds });
      expect(reacquiredObject.tracking).toMatchObject({
        status: "locked",
        baseSceneVersion: reacquiredObject.sceneVersion,
        needsRecalibration: false,
      });
      const geometry = await operatorPage.evaluate(() => ({
        innerHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        appHeight: document.querySelector<HTMLElement>("#operator-app")?.getBoundingClientRect().height ?? 0,
        footerOverflow: getComputedStyle(document.querySelector<HTMLElement>(".operator-footer")!).overflowY,
      }));
      expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.innerHeight + 1);
      expect(geometry.appHeight).toBeLessThanOrEqual(geometry.innerHeight + 1);
      expect(geometry.footerOverflow).toBe("auto");
    } finally {
      await operatorContext.close();
    }
  });

  test("debug tools prove the authenticated WebMCP-to-phone delivery loop without exposing transport payloads", async ({
    browser,
    page: supportPage,
  }) => {
    test.skip(!WEBMCP_DEBUG, "WEBMCP_DEBUG is disabled for the submission manifest");

    await supportPage.goto("/");
	await createInternalFixtureSession(supportPage);
    await expect(supportPage.locator("#operator-link")).toHaveAttribute(
      "href",
      /\/session\/[^/]+\/operator\?token=[^#]+/,
    );
    const operatorHref = await supportPage.locator("#operator-link").getAttribute("href");
    if (!operatorHref) throw new Error("Support page did not expose an operator join URL");

    const operatorContext = await browser.newContext({
      baseURL: supportPage.url(),
      viewport: { width: 390, height: 844 },
      permissions: ["camera"],
    });
    try {
      await installPerceptionE2E(operatorContext, { mode: "opencv-unavailable" });
      const operatorPage = await operatorContext.newPage();
      await operatorPage.goto(new URL(operatorHref, supportPage.url()).toString());
      await expect(operatorPage.locator("#operator-app")).toBeVisible();
      await operatorPage.locator("#operator-freeform-issue").fill("Verify the debug delivery path.");
      await operatorPage.locator("#operator-freeform-issue-form").getByRole("button", {
        name: "Start free-form help",
      }).click();
      await expect(operatorPage.locator("#operator-issue-chooser")).toBeHidden();
      await expect(supportPage.locator("#peer-status")).toContainText(/operator (camera live|joined)/i);

      const before = (await invokeTool(supportPage, "debug_connection_report", {})) as {
        debugMode?: boolean;
        session?: { id?: string; participants?: { support?: number; operator?: number } };
        webRTC?: Record<string, { signalCounts?: Record<string, number> }>;
        guidance?: { active?: number; acknowledged?: number; pending?: number };
      };
      expect(before.debugMode).toBe(true);
      expect(before.session?.id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(before.session?.participants).toMatchObject({ support: 1, operator: 1 });
      expect(JSON.stringify(before)).not.toMatch(/candidate:|credential|password|token|sdp/i);

      const ping = (await invokeTool(supportPage, "debug_ping_operator", {
        objectId: "wan-port",
      })) as { annotation?: { id?: string; objectId?: string; label?: string } };
      expect(ping.annotation).toMatchObject({
        objectId: "wan-port",
        label: "DEBUG PING",
      });
      await expect(operatorPage.locator("#operator-overlay")).toContainText("DEBUG PING");
      await expect(supportPage.locator("#support-guidance-delivery-status")).toContainText(
        /operator sees guidance/i,
      );

      await expect.poll(async () => {
        const after = (await invokeTool(supportPage, "debug_connection_report", {})) as {
          guidance?: { active?: number; acknowledged?: number; pending?: number };
        };
        return after.guidance;
      }).toMatchObject({ active: 1, acknowledged: 1, pending: 0 });

      if (ping.annotation?.id) {
        await invokeTool(supportPage, "clear_annotation", { annotationId: ping.annotation.id });
      }
      await expect(operatorPage.locator("#operator-overlay")).not.toContainText("DEBUG PING");
    } finally {
      await operatorContext.close();
    }
  });

  test("keeps the manual same-origin tool path usable without WebMCP", async ({}, testInfo) => {
    // Use a separate browser process so the normal suite's WebMCP-enabled
    // Chromium launch cannot leak the feature into this unsupported-browser
    // acceptance case.
    const unsupportedBrowser = await chromium.launch({
      args: ["--disable-blink-features=WebMCP"],
    });
    try {
      const context = await unsupportedBrowser.newContext({
        baseURL: String(testInfo.project.use.baseURL),
      });
      const page = await context.newPage();
      await disableWebMCP(page);
      await page.goto("/");
      await expect(page.locator("#landing-app")).toBeVisible();
	  await createInternalFixtureSession(page);
      await expect(page.locator("#support-app")).toBeVisible();
      expect(await modelContextAvailable(page)).toBe(false);
      await assertManifest(page);

      const inspect = await invokeTool(page, "inspect_scene", {}) as {
        objects?: Array<{ id?: string }>;
      };
      expect(inspect.objects?.some((object) => object.id === "wan-port")).toBe(true);

      const highlight = await invokeTool(page, "highlight_object", {
        objectId: "wan-port",
      }) as {
        annotation?: { objectId?: string; actor?: string; label?: string };
      };
      expect(highlight.annotation).toMatchObject({
        objectId: "wan-port",
        actor: "Codex via WebMCP",
        label: "CONNECT HERE",
      });
      await expect(page.locator("#support-overlay")).toContainText("CONNECT HERE");
      await expect(page.locator("#timeline")).toContainText(/Highlighted (WAN port|CONNECT HERE)/i);
      await context.close();
    } finally {
      await unsupportedBrowser.close();
    }
  });
});
