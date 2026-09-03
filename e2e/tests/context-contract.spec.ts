import { expect, test, type Page } from "@playwright/test";

const QR_TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type ManifestTool = {
  name: string;
  description: string;
  method: string;
  path: string;
  inputSchema: {
    required?: string[];
    [key: string]: unknown;
  };
};

type ToolManifest = { tools: ManifestTool[] };

type APIResult = {
  ok: boolean;
  status: number;
  body: unknown;
  text: string;
};

const MUTATING_TOOLS = [
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
] as const;

function staleContextVersion(version: unknown): unknown {
  if (typeof version === "number") return version + 1;
  if (typeof version === "string") return `${version}-stale`;
  throw new Error("Field Assist contextVersion must be a string or number");
}

async function createSupportSession(page: Page): Promise<void> {
  await page.goto("/");
  await Promise.all([
    page.waitForURL(/\/session\/[^/]+$/),
    page.locator("#create-session").click(),
  ]);
  await expect(page.locator("#support-app")).toBeVisible();
}

async function loadManifest(page: Page): Promise<ToolManifest> {
  const response = await page.request.get("/__gofastr/webmcp/tools.json");
  expect(response.ok(), "the authenticated WebMCP manifest should be available").toBe(true);
  return (await response.json()) as ToolManifest;
}

async function callEndpoint(
  page: Page,
  tool: ManifestTool,
  input: Record<string, unknown> = {},
): Promise<APIResult> {
  return page.evaluate(async ({ path, method, input: requestInput }) => {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "X-Gofastr-WebMCP": "1",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(requestInput) : undefined,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep the plain response text available for useful failure messages.
    }
    return { ok: response.ok, status: response.status, body, text };
  }, { path: tool.path, method: tool.method, input });
}

function objectFromResult(result: APIResult): Record<string, any> {
  if (!result.body || typeof result.body !== "object") {
    throw new Error(`Expected JSON response, got ${result.text}`);
  }
  return result.body as Record<string, any>;
}

test.describe("WebMCP context contract and operator status", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/session/operator-qr*", async (route) => {
      await route.fulfill({
        status: 200,
        body: QR_TEST_PNG,
        headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
      });
    });
  });

  test("loads a versioned app context before mutations and rejects missing or stale context", async ({
    page,
  }) => {
    await createSupportSession(page);
    const manifest = await loadManifest(page);
    const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    // get_app_info is the app-provided operating-context loader. Accept the
    // future dedicated name too, if the WebMCP framework grows one.
    const contextTool = byName.get("load_field_assist_context") ?? byName.get("get_app_info");
    expect(contextTool, "the support manifest should expose the app context loader").toBeTruthy();
    expect(contextTool?.description).toMatch(/first|context|operat/i);

    for (const name of MUTATING_TOOLS) {
      const tool = byName.get(name);
      expect(tool, `${name} should remain discoverable`).toBeTruthy();
      expect(tool?.inputSchema.required, `${name} should require the context version`).toContain(
        "contextVersion",
      );
    }

    const mutation = byName.get("send_operator_message");
    expect(mutation).toBeTruthy();

    const missingContext = await callEndpoint(page, mutation!, {
      text: "This must not be accepted before app context is loaded.",
    });
    expect(missingContext.ok).toBe(false);
    expect([400, 409, 428, 422]).toContain(missingContext.status);
    expect(missingContext.text).toMatch(/context|first|version/i);

    const contextResult = await callEndpoint(page, contextTool!);
    expect(contextResult.ok, contextResult.text).toBe(true);
    const context = objectFromResult(contextResult);
    expect(context.contextVersion).toEqual(expect.any(String));
    expect(context.contextVersion).toMatch(/^field-assist\/v\d+:/);
    expect(context.protocolVersion).toBe(context.protocol?.version);
    expect(context.protocol).toMatchObject({
      sequence: expect.arrayContaining([
        expect.stringMatching(/contextVersion/i),
        expect.stringMatching(/model knowledge|vision/i),
        expect.stringMatching(/identity.*localization.*tracking.*delivery/i),
      ]),
      confidenceDefinitions: expect.objectContaining({
        identity: expect.any(String),
        localization: expect.any(String),
        tracking: expect.any(String),
        delivery: expect.any(String),
      }),
      targetingRules: expect.arrayContaining([
        expect.stringMatching(/draw_arrow.*device-control/i),
        expect.stringMatching(/register.*containing device.*track.*control anchor/i),
      ]),
      mutationRules: expect.arrayContaining([
        expect.stringMatching(/every WebMCP mutation.*contextVersion/i),
        expect.stringMatching(/missing.*contextVersion/i),
        expect.stringMatching(/stale.*contextVersion/i),
      ]),
    });
    expect(context.workflows).toEqual(expect.arrayContaining([
      expect.stringMatching(/inspect.*scene/i),
      expect.stringMatching(/register.*(control|target)/i),
      expect.stringMatching(/guidance/i),
    ]));
    expect(context.liveSession).toMatchObject({ scene: expect.any(Object) });

    const contextVersion = context.contextVersion;
    const validMutation = await callEndpoint(page, mutation!, {
      text: "Context loaded; this message should be accepted.",
      contextVersion,
    });
    expect(validMutation.ok, validMutation.text).toBe(true);

    const staleContext = await callEndpoint(page, mutation!, {
      text: "This stale context must not mutate the session.",
      contextVersion: staleContextVersion(contextVersion),
    });
    expect(staleContext.ok).toBe(false);
    expect([400, 409, 428, 422]).toContain(staleContext.status);
    expect(staleContext.text).toMatch(/context|stale|version|reload|refresh/i);

    const sceneTool = byName.get("inspect_scene");
    expect(sceneTool).toBeTruthy();
    const scene = objectFromResult(await callEndpoint(page, sceneTool!));
    expect(scene.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Context loaded; this message should be accepted." }),
    ]));
    expect(scene.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "This stale context must not mutate the session." }),
    ]));
  });

  test("keeps arrows on verified device controls instead of broad appliances", async ({ page }) => {
    await createSupportSession(page);
    const manifest = await loadManifest(page);
    const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    const contextTool = byName.get("load_field_assist_context") ?? byName.get("get_app_info");
    const inspectSceneTool = byName.get("inspect_scene");
    const registerTool = byName.get("register_scene_object");
    const inspectObjectTool = byName.get("inspect_object");
    const drawArrowTool = byName.get("draw_arrow");
    expect(contextTool && inspectSceneTool && registerTool && inspectObjectTool && drawArrowTool).toBeTruthy();

    const context = objectFromResult(await callEndpoint(page, contextTool!));
    const contextVersion = context.contextVersion;
    const initialScene = objectFromResult(await callEndpoint(page, inspectSceneTool!));

    const applianceResult = await callEndpoint(page, registerTool!, {
      label: "Wall appliance",
      kind: "appliance",
      bounds: { x: 0.12, y: 0.14, width: 0.72, height: 0.62 },
      baseSceneVersion: initialScene.version,
      contextVersion,
    });
    expect(applianceResult.ok, applianceResult.text).toBe(true);
    const appliance = objectFromResult(applianceResult).object;
    expect(appliance).toMatchObject({ kind: "appliance", confidence: expect.any(Number) });

    const broadArrow = await callEndpoint(page, drawArrowTool!, {
      objectId: appliance.id,
      text: "Do not point at the whole appliance",
      anchor: { x: 0.5, y: 0.5 },
      contextVersion,
    });
    expect(broadArrow.ok).toBe(false);
    expect([400, 409, 422]).toContain(broadArrow.status);
    expect(broadArrow.text).toMatch(/device-control|precise|control|target|appliance/i);

    const controlScene = objectFromResult(await callEndpoint(page, inspectSceneTool!));
    expect(controlScene.annotations ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: appliance.id }),
    ]));

    const controlResult = await callEndpoint(page, registerTool!, {
      label: "Power control",
      kind: "device-control",
      bounds: { x: 0.65, y: 0.60, width: 0.12, height: 0.10 },
      baseSceneVersion: controlScene.version,
      contextVersion,
    });
    expect(controlResult.ok, controlResult.text).toBe(true);
    const control = objectFromResult(controlResult).object;
    expect(control).toMatchObject({
      kind: "device-control",
      confidence: expect.any(Number),
      attributes: expect.objectContaining({
        localizationStatus: "provisional",
        trackingReferenceObjectId: appliance.id,
      }),
    });
    expect(control.confidence).toBeLessThan(1);

    const inspectedControl = objectFromResult(await callEndpoint(page, inspectObjectTool!, {
      objectId: control.id,
    }));
    expect(inspectedControl.object).toMatchObject({
      id: control.id,
      kind: "device-control",
      confidence: expect.any(Number),
    });
    expect(inspectedControl.object.confidence).toBeGreaterThan(0);

    const controlArrow = await callEndpoint(page, drawArrowTool!, {
      objectId: control.id,
      text: "PRESS POWER",
      anchor: { x: 0.5, y: 0.5 },
      contextVersion,
    });
    expect(controlArrow.ok, controlArrow.text).toBe(true);
    expect(objectFromResult(controlArrow).annotation).toMatchObject({
      kind: "arrow",
      objectId: control.id,
    });
    const provisionalArrow = page.locator(`[data-annotation-id="${objectFromResult(controlArrow).annotation.id}"]`);
    await expect(provisionalArrow).toBeHidden();
    await expect(provisionalArrow).toHaveAttribute("aria-hidden", "true");
  });

  test("displays status at the bottom-left of the phone camera without page overflow", async ({
    browser,
    page: supportPage,
  }) => {
    await createSupportSession(supportPage);
    const operatorLink = supportPage.locator("#operator-link");
    await expect(operatorLink).toHaveAttribute("href", /\/operator\?token=/);
    const operatorHref = await operatorLink.getAttribute("href");
    expect(operatorHref).toBeTruthy();

    const operatorContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      permissions: ["camera"],
    });
    try {
      const operatorPage = await operatorContext.newPage();
      await operatorPage.goto(new URL(operatorHref!, supportPage.url()).toString());
      await expect(operatorPage.locator("#operator-app")).toBeVisible();
      await operatorPage.locator("#operator-tv-demo").click();
      await expect(operatorPage.locator("#operator-issue-chooser")).toBeHidden();

      const statusHUD = operatorPage.locator("#operator-status-hud");
      await expect(statusHUD).toBeVisible();
      await expect(statusHUD.locator("summary")).toHaveText("Display status");

      const geometry = await operatorPage.evaluate(() => {
        const stage = document.querySelector<HTMLElement>("#operator-stage")?.getBoundingClientRect();
        const hud = document.querySelector<HTMLElement>("#operator-status-hud")?.getBoundingClientRect();
        const trigger = document.querySelector<HTMLElement>("#operator-status-hud summary")?.getBoundingClientRect();
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        return {
          innerWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          viewportHeight,
          bodyOverflow: getComputedStyle(document.body).overflow,
          position: hud ? getComputedStyle(document.querySelector<HTMLElement>("#operator-status-hud")!).position : "",
          stage,
          hud,
          trigger,
        };
      });
      expect(geometry.position).toMatch(/absolute|fixed/);
      expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.innerWidth + 1);
      expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight + 1);
      expect(geometry.bodyOverflow).toBe("hidden");
      expect(geometry.hud).not.toBeNull();
      expect(geometry.stage).not.toBeNull();
      expect(geometry.hud!.left).toBeGreaterThanOrEqual(geometry.stage!.left - 1);
      expect(geometry.hud!.left).toBeLessThanOrEqual(geometry.stage!.left + 1.5 * 16);
      expect(geometry.hud!.bottom).toBeLessThanOrEqual(geometry.stage!.bottom + 1);
      expect(geometry.hud!.bottom).toBeGreaterThanOrEqual(geometry.stage!.bottom - 1.5 * 16);
      expect(geometry.trigger!.right).toBeLessThanOrEqual(geometry.innerWidth + 1);

      await statusHUD.locator("summary").click();
      await expect(statusHUD).toHaveAttribute("open", "");
      const panelGeometry = await operatorPage.locator("#operator-status-hud .operator-status-panel").evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          viewportWidth: window.innerWidth,
          viewportHeight: window.visualViewport?.height ?? window.innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
        };
      });
      expect(panelGeometry.left).toBeGreaterThanOrEqual(0);
      expect(panelGeometry.right).toBeLessThanOrEqual(panelGeometry.viewportWidth + 1);
      expect(panelGeometry.top).toBeGreaterThanOrEqual(0);
      expect(panelGeometry.bottom).toBeLessThanOrEqual(panelGeometry.viewportHeight + 1);
      expect(panelGeometry.documentWidth).toBeLessThanOrEqual(panelGeometry.viewportWidth + 1);
      expect(panelGeometry.documentHeight).toBeLessThanOrEqual(panelGeometry.viewportHeight + 1);
    } finally {
      await operatorContext.close();
    }
  });
});
