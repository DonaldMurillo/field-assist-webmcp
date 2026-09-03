import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = readFileSync(fileURLToPath(new URL("../fixtures/depth-parallax.webm", import.meta.url)));

test("loads the released OpenCV and ONNX perception runtimes", async ({ page }) => {
  test.skip(process.env.E2E_PERCEPTION_RUNTIME !== "1", "opt-in released-artifact smoke test");
  test.setTimeout(180_000);
  await page.route("**/__e2e__/depth-parallax.webm", (route) => route.fulfill({
    body: fixture,
    headers: { "Content-Type": "video/webm" },
  }));
  await page.goto("/");
  await page.evaluate(async () => {
    (window as Window & { __fieldAssistPerceptionE2E?: { depthReferenceAgeMs: number } })
      .__fieldAssistPerceptionE2E = { depthReferenceAgeMs: 6_000 };
    const blackFrame = document.createElement("canvas");
    blackFrame.width = 640;
    blackFrame.height = 360;
    blackFrame.getContext("2d")?.fillRect(0, 0, blackFrame.width, blackFrame.height);
    const video = document.createElement("video");
    video.id = "runtime-smoke-video";
    video.muted = true;
    video.loop = true;
    video.srcObject = blackFrame.captureStream(10);
    document.body.appendChild(video);
    await video.play();
    const runtime = window as Window & {
      FieldAssistPerception?: {
        PerceptionEngine: new (
          video: HTMLVideoElement,
          result: (value: unknown) => void,
          status: (value: unknown) => void,
        ) => {
          start: (bounds: unknown, anchor?: unknown) => void;
          sample: () => void;
          recalibrate: (bounds: unknown, anchor?: unknown) => boolean;
          destroy: () => void;
        };
      };
      __runtimeSmoke?: {
        engine: {
          sample: () => void;
          recalibrate: (bounds: unknown, anchor?: unknown) => boolean;
          destroy: () => void;
        };
        statuses: unknown[];
        results: unknown[];
      };
    };
    if (!runtime.FieldAssistPerception) throw new Error("Perception coordinator was unavailable");
    const statuses: unknown[] = [];
    const results: unknown[] = [];
    const engine = new runtime.FieldAssistPerception.PerceptionEngine(
      video,
      (result) => results.push(result),
      (status) => statuses.push(status),
    );
    runtime.__runtimeSmoke = { engine, statuses, results };
    engine.start(
      { x: 0.65, y: 0.52, width: 0.22, height: 0.22 },
      { x: 0.76, y: 0.75 },
    );
    window.setInterval(() => engine.sample(), 180);
  });
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as Window & {
      __runtimeSmoke?: { statuses: Array<{ reason?: string }> };
    }).__runtimeSmoke;
    return state?.statuses.some((status) => status.reason === "insufficient-features") ?? false;
  }), { timeout: 160_000 }).toBe(true);
  await page.evaluate(async () => {
    const video = document.querySelector<HTMLVideoElement>("#runtime-smoke-video");
    if (!video) throw new Error("Runtime smoke video was unavailable");
    video.pause();
    video.srcObject?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    video.src = "/__e2e__/depth-parallax.webm";
    video.loop = true;
    video.load();
    await video.play();
  });
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as Window & { __runtimeSmoke?: { statuses: Array<{ state?: string }> } }).__runtimeSmoke;
    return state?.statuses.at(-1)?.state ?? "missing";
  }), { timeout: 160_000 }).toBe("ready");
  const reseeded = await page.evaluate(() => {
    const state = (window as Window & {
      __runtimeSmoke?: {
        engine: { recalibrate: (bounds: unknown, anchor?: unknown) => boolean };
        statuses: unknown[];
      };
    }).__runtimeSmoke;
    if (!state) throw new Error("Runtime smoke state was unavailable");
    const statusCount = state.statuses.length;
    return {
      accepted: state.engine.recalibrate(
        { x: 0.64, y: 0.51, width: 0.23, height: 0.23 },
        { x: 0.755, y: 0.74 },
      ),
      statusCount,
    };
  });
  expect(reseeded.accepted).toBe(true);
  await expect.poll(async () => page.evaluate((statusCount) => {
    const state = (window as Window & {
      __runtimeSmoke?: { statuses: Array<{ state?: string }> };
    }).__runtimeSmoke;
    return state?.statuses.slice(statusCount).some((status) => status.state === "ready") ?? false;
  }, reseeded.statusCount), { timeout: 160_000 }).toBe(true);
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as Window & {
      __runtimeSmoke?: { results: Array<{
        source?: string;
        moved?: boolean;
        anchorSpace?: string;
        cameraPoseDelta?: { x?: number; y?: number; z?: number };
        depthAgreement?: number | null;
        fusionConfidence?: number | null;
      }> };
    }).__runtimeSmoke;
    const projected = state?.results.filter((result) => result.source?.startsWith("opencv-homography")) ?? [];
    const worldRelative = state?.results.filter((result) => result.anchorSpace === "world-relative") ?? [];
    const cameraMoved = worldRelative.some((result) => Math.hypot(
      Number(result.cameraPoseDelta?.x),
      Number(result.cameraPoseDelta?.y),
      Number(result.cameraPoseDelta?.z),
    ) > 0.001);
    const depthValidated = state?.results.some((result) =>
      result.depthAgreement !== null && result.depthAgreement !== undefined &&
      result.fusionConfidence !== null && result.fusionConfidence !== undefined
    ) ?? false;
    return projected.some((result) => result.moved) && worldRelative.length >= 2 && cameraMoved && depthValidated
      ? projected.length
      : 0;
  }), { timeout: 160_000 }).toBeGreaterThanOrEqual(4);
  const pnpFailureWindow = await test.step(
    "holds world-relative authority through transient PnP failures",
    async () => {
      const startIndex = await page.evaluate(() => {
        const state = (window as Window & {
          __runtimeSmoke?: {
            engine: unknown;
            results: unknown[];
            pnpFailureInjection?: { target: number; injected: number; recovered: boolean };
          };
        }).__runtimeSmoke;
        if (!state) throw new Error("Runtime smoke state was unavailable");
        const worker = (state.engine as {
          openCVWorker?: { onmessage?: ((event: MessageEvent) => void) | null };
        }).openCVWorker;
        if (!worker || typeof worker.onmessage !== "function") {
          throw new Error("OpenCV worker was unavailable for transient PnP simulation");
        }
        const original = worker.onmessage;
        const injection = { target: 2, injected: 0, recovered: false };
        state.pnpFailureInjection = injection;
        worker.onmessage = (event: MessageEvent) => {
          const data = event.data && typeof event.data === "object"
            ? event.data as Record<string, unknown>
            : {};
          const isWorldRelative = data.type === "tracked" &&
            data.anchorSpace === "world-relative" && data.worldAnchor && data.cameraPoseDelta;
          if (isWorldRelative && injection.injected < injection.target) {
            injection.injected += 1;
            const weakened = { ...data };
            delete weakened.anchorSpace;
            delete weakened.worldAnchor;
            delete weakened.cameraPoseDelta;
            weakened.poseAccepted = false;
            weakened.poseFailureReason = "pose-transient-test-failure";
            original.call(worker, { data: weakened } as MessageEvent);
            return;
          }
          original.call(worker, event);
          if (isWorldRelative && injection.injected >= injection.target) injection.recovered = true;
        };
        return state.results.length;
      });
      await expect.poll(async () => page.evaluate(() => {
        const state = (window as Window & {
          __runtimeSmoke?: {
            pnpFailureInjection?: { injected: number; recovered: boolean };
          };
        }).__runtimeSmoke;
        return {
          injected: state?.pnpFailureInjection?.injected ?? 0,
          recovered: state?.pnpFailureInjection?.recovered ?? false,
        };
      }), { timeout: 160_000 }).toEqual({ injected: 2, recovered: true });
      return { startIndex };
    },
  );
  const evidence = await page.evaluate(() => {
    const state = (window as Window & {
      __runtimeSmoke?: { engine: { destroy: () => void }; statuses: unknown[]; results: unknown[] };
    }).__runtimeSmoke;
    state?.engine.destroy();
    return { statuses: state?.statuses, results: state?.results };
  });
  expect(evidence.results?.length).toBeGreaterThan(0);
  const projected = (evidence.results as Array<{
    source?: string;
    quad?: Array<{ x?: number; y?: number }>;
    anchor?: { x?: number; y?: number };
  }> | undefined)?.find((result) => result.source?.startsWith("opencv-homography"));
  expect(projected, "released OpenCV runtime should emit homography geometry").toBeTruthy();
  expect(projected?.quad).toHaveLength(4);
  for (const point of projected?.quad ?? []) {
    expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.x).toBeLessThanOrEqual(1);
    expect(point.y).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeLessThanOrEqual(1);
  }
  expect(projected?.anchor).toEqual(expect.objectContaining({
    x: expect.any(Number),
    y: expect.any(Number),
  }));

  type FusedResult = {
    source?: string;
    quad?: Array<{ x?: number; y?: number }> | null;
    anchor?: { x?: number; y?: number } | null;
    lost?: boolean;
    recalibrationRequired?: boolean;
    depthAgreement?: number | null;
    fusionConfidence?: number | null;
    depthConfidence?: number;
    depthSource?: string;
    depthImageScale?: number | null;
    depthExpectedScale?: number | null;
    depthScaleLogError?: number | null;
    anchorSpace?: string;
    worldAnchor?: { x?: number; y?: number; z?: number } | null;
    cameraPoseDelta?: { x?: number; y?: number; z?: number } | null;
    poseState?: string;
    poseFailureReason?: string;
  };
  const fusedResults = (evidence.results as FusedResult[] | undefined)?.filter(
    (result) => result.source === "opencv-homography+depth-anything" ||
      result.source === "opencv-pnp+depth-anything",
  ) ?? [];
  expect(
    fusedResults.length,
    "released Depth Anything must promote at least one OpenCV geometry sample",
  ).toBeGreaterThan(0);
  for (const fused of fusedResults) {
    expect(fused.lost).toBe(false);
    expect(fused.recalibrationRequired).toBe(false);
    expect(fused.quad, "depth-promoted geometry should retain the OpenCV quad").toHaveLength(4);
    expect(fused.anchor, "depth-promoted geometry should retain the projected anchor").toEqual(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
    expect(fused.depthSource).toMatch(/^depth-anything-v2-small-(q4f16|int8)$/);
    expect(fused.depthConfidence).toBeGreaterThanOrEqual(
      fused.source === "opencv-pnp+depth-anything" ? 0.25 : 0.35,
    );
  }
  const validatedFused = fusedResults.find(
    (result) => result.depthAgreement !== null && result.fusionConfidence !== null,
  );
  expect(
    validatedFused,
    "a depth-promoted sample should expose the local depth/geometry validation",
  ).toBeTruthy();
  expect(validatedFused?.depthAgreement).toBeGreaterThanOrEqual(0.45);
  expect(validatedFused?.fusionConfidence).toBeGreaterThanOrEqual(0.35);
  expect(validatedFused?.depthImageScale).toBeGreaterThan(0);
  expect(validatedFused?.depthExpectedScale).toBeGreaterThan(0);
  expect(validatedFused?.depthScaleLogError).toBeLessThanOrEqual(Math.log(1.8));

  const postFailureResults = (evidence.results as Array<FusedResult & {
    anchor?: { x?: number; y?: number } | null;
  }> | undefined)?.slice(pnpFailureWindow.startIndex) ?? [];
  expect(
    postFailureResults.some((result) => result.source === "opencv-pnp+depth-anything"),
    "PnP should regain authority after the injected transient failures",
  ).toBe(true);
  const explicitPlanarBridgeResults = postFailureResults.filter((result) =>
    (result.source === "opencv-homography" || result.source === "opencv-homography+depth-anything") &&
    !result.lost && !result.recalibrationRequired && result.anchor,
  );
  expect(
    explicitPlanarBridgeResults.length,
    "a transient PnP failure should retain visible planar geometry",
  ).toBeGreaterThanOrEqual(2);
  const injectedPlanarBridgeResults = explicitPlanarBridgeResults.filter(
    (result) => result.poseFailureReason === "pose-transient-test-failure",
  );
  expect(
    injectedPlanarBridgeResults.length,
    "both injected PnP failures should retain visible planar geometry",
  ).toBeGreaterThanOrEqual(2);
  for (const result of injectedPlanarBridgeResults) {
    expect(result.poseState).toBe("degraded");
    expect(result.poseFailureReason).toBe("pose-transient-test-failure");
  }
  for (let index = 1; index < injectedPlanarBridgeResults.length; index += 1) {
    const previous = injectedPlanarBridgeResults[index - 1]?.anchor;
    const current = injectedPlanarBridgeResults[index]?.anchor;
    expect(Math.hypot(
      Number(current?.x) - Number(previous?.x),
      Number(current?.y) - Number(previous?.y),
    ), "the planar bridge must remain continuous rather than detach").toBeLessThan(0.12);
  }

  type Vector3 = { x?: number; y?: number; z?: number };
  type PoseProjectedResult = FusedResult & {
    anchorSpace?: string;
    worldAnchor?: Vector3 | null;
    cameraPoseDelta?: Vector3 | null;
  };
  const poseProjectedResults = (fusedResults as PoseProjectedResult[]).filter(
    (result) => result.anchorSpace === "world-relative" && result.worldAnchor && result.cameraPoseDelta,
  );
  expect(
    poseProjectedResults.length,
    "released parallax tracking must expose world-relative camera-pose projection",
  ).toBeGreaterThanOrEqual(2);
  for (const result of poseProjectedResults) {
    expect(result.worldAnchor).toEqual(expect.objectContaining({
      x: expect.any(Number),
      y: expect.any(Number),
      z: expect.any(Number),
    }));
    expect(result.cameraPoseDelta).toEqual(expect.objectContaining({
      x: expect.any(Number),
      y: expect.any(Number),
      z: expect.any(Number),
    }));
  }
  const referenceWorldAnchor = poseProjectedResults[0]?.worldAnchor as Vector3;
  const worldAnchorDrift = poseProjectedResults.map((result) => {
    const anchor = result.worldAnchor as Vector3;
    return Math.hypot(
      Number(anchor.x) - Number(referenceWorldAnchor.x),
      Number(anchor.y) - Number(referenceWorldAnchor.y),
      Number(anchor.z) - Number(referenceWorldAnchor.z),
    );
  });
  expect(
    Math.max(...worldAnchorDrift),
    "the world anchor should stay stable while the parallax fixture changes camera pose",
  ).toBeLessThan(0.08);
  expect(
    Math.max(...poseProjectedResults.map((result) => {
      const pose = result.cameraPoseDelta as Vector3;
      return Math.hypot(Number(pose.x), Number(pose.y), Number(pose.z));
    })),
    "the parallax fixture should produce a non-zero relative camera translation",
  ).toBeGreaterThan(0.001);
});

test("retains and reacquires a reflective target after crop and close movement", async ({ page }) => {
  test.skip(process.env.E2E_PERCEPTION_RUNTIME !== "1", "opt-in released-artifact smoke test");
  test.setTimeout(180_000);
  await page.route("**/__e2e__/depth-parallax.webm", (route) => route.fulfill({
    body: fixture,
    headers: { "Content-Type": "video/webm" },
  }));
  await page.goto("/");
  await page.evaluate(async () => {
    const blackFrame = document.createElement("canvas");
    blackFrame.width = 640;
    blackFrame.height = 360;
    blackFrame.getContext("2d")?.fillRect(0, 0, blackFrame.width, blackFrame.height);
    const video = document.createElement("video");
    video.id = "partial-visibility-runtime-video";
    video.muted = true;
    video.playsInline = true;
    video.srcObject = blackFrame.captureStream(10);
    document.body.appendChild(video);
    await video.play();
    const runtime = window as Window & {
      FieldAssistPerception?: {
        PerceptionEngine: new (
          video: HTMLVideoElement,
          result: (value: unknown) => void,
          status: (value: unknown) => void,
        ) => {
          start: (bounds: unknown, anchor?: unknown, featureProfile?: string) => void;
          destroy: () => void;
        };
      };
      __partialVisibilitySmoke?: {
        engine: unknown;
        statuses: unknown[];
        results: unknown[];
        controls?: { offsetX: number; scale: number };
      };
    };
    if (!runtime.FieldAssistPerception) throw new Error("Perception coordinator was unavailable");
    const statuses: unknown[] = [];
    const results: unknown[] = [];
    const engine = new runtime.FieldAssistPerception.PerceptionEngine(
      video,
      (result) => results.push(result),
      (status) => statuses.push(status),
    );
    runtime.__partialVisibilitySmoke = { engine, statuses, results };
    engine.start(
      { x: 0.04, y: 0.51, width: 0.23, height: 0.23 },
      { x: 0.155, y: 0.74 },
      "reflective-plane",
    );
    window.setInterval(() => engine.sample(), 180);
  });
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: { statuses: Array<{ reason?: string }> };
    }).__partialVisibilitySmoke;
    return state?.statuses.some((status) => status.reason === "insufficient-features") ?? false;
  }), { timeout: 160_000 }).toBe(true);
  const setup = await page.evaluate(async () => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: unknown[];
        controls?: { offsetX: number; scale: number };
      };
    }).__partialVisibilitySmoke;
    if (!state) throw new Error("Partial-visibility smoke state was unavailable");
    const source = document.createElement("video");
    source.id = "partial-visibility-fixture-source";
    source.muted = true;
    source.playsInline = true;
    source.src = "/__e2e__/depth-parallax.webm";
    source.load();
    document.body.appendChild(source);
    if (source.readyState < 2) {
      await new Promise<void>((resolve, reject) => {
        source.addEventListener("loadeddata", () => resolve(), { once: true });
        source.addEventListener("error", () => reject(new Error("Partial-visibility fixture failed to load")), { once: true });
      });
    }
    await source.play();
    await new Promise<void>((resolve) => {
      source.addEventListener("seeked", () => resolve(), { once: true });
      source.currentTime = 0.2;
    });
    source.pause();
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Partial-visibility canvas was unavailable");
    const controls = { offsetX: -0.60, scale: 1 };
    const draw = () => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = "#596164";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.setTransform(controls.scale, 0, 0, controls.scale, controls.offsetX * canvas.width, 0);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      context.setTransform(1, 0, 0, 1, 0, 0);
      const targetX = (0.64 * controls.scale + controls.offsetX) * canvas.width;
      const targetY = 0.51 * controls.scale * canvas.height;
      const targetWidth = 0.23 * controls.scale * canvas.width;
      const targetHeight = 0.23 * controls.scale * canvas.height;
      context.fillStyle = "#080b10";
      context.fillRect(targetX, targetY, targetWidth, targetHeight);
      // Reflections change with camera pose instead of flickering on an
      // unrelated timer; hold each pose long enough for deterministic samples.
      const phase = Math.floor(controls.scale * 100 + controls.offsetX * 80);
      const columns = 5;
      const rows = 3;
      const insetX = targetWidth * 0.1;
      const insetY = targetHeight * 0.12;
      const cellWidth = targetWidth * 0.8 / columns;
      const cellHeight = targetHeight * 0.7 / rows;
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const active = (column * 3 + row * 5 + phase) % 7 < 3;
          context.fillStyle = active ? "#f5f7ff" : "#111827";
          context.fillRect(
            targetX + insetX + column * cellWidth,
            targetY + insetY + row * cellHeight,
            cellWidth + 0.5,
            cellHeight + 0.5,
          );
        }
      }
      // The changing center behaves like glass reflecting the moving phone.
      // The perimeter is a stable physical bezel/control band and must remain
      // the actual registration evidence.
      context.strokeStyle = "#f8fafc";
      context.lineWidth = Math.max(3, targetWidth * 0.018);
      context.strokeRect(targetX + 2, targetY + 2, targetWidth - 4, targetHeight - 4);
      for (let marker = 0; marker < 9; marker += 1) {
        const markerX = targetX + targetWidth * (0.08 + marker * 0.105);
        context.fillStyle = marker % 2 === 0 ? "#f8fafc" : "#334155";
        context.fillRect(
          markerX,
          targetY + targetHeight * (0.02 + (marker % 3) * 0.014),
          targetWidth * (0.022 + (marker % 4) * 0.008),
          targetHeight * (0.045 + (marker % 5) * 0.009),
        );
      }
      context.fillStyle = "#f8fafc";
      context.font = `bold ${Math.max(8, targetHeight * 0.105)}px monospace`;
      context.fillText("TV  POWER  01", targetX + targetWidth * 0.12, targetY + targetHeight * 0.955);

      // A feature-rich media console sits immediately below the TV but moves
      // with different parallax. Reflective tracking must not promote these
      // adjacent, non-object features into the television plane.
      const consoleScale = 1 + (controls.scale - 1) * 0.45;
      const consoleX = (0.64 * consoleScale + controls.offsetX * 0.72) * canvas.width;
      const consoleY = 0.748 * consoleScale * canvas.height;
      const consoleWidth = 0.27 * consoleScale * canvas.width;
      const consoleHeight = 0.045 * consoleScale * canvas.height;
      context.fillStyle = "#020617";
      context.fillRect(consoleX, consoleY, consoleWidth, consoleHeight);
      for (let marker = 0; marker < 18; marker += 1) {
        context.fillStyle = marker % 2 === 0 ? "#ffffff" : "#0f172a";
        context.fillRect(
          consoleX + (marker / 18) * consoleWidth,
          consoleY + (marker % 3) * consoleHeight * 0.18,
          consoleWidth * 0.04,
          consoleHeight * 0.62,
        );
      }
      window.requestAnimationFrame(draw);
    };
    draw();
    const video = document.querySelector<HTMLVideoElement>("#partial-visibility-runtime-video");
    if (!video) throw new Error("Partial-visibility runtime video was unavailable");
    video.pause();
    video.srcObject?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    video.removeAttribute("src");
    video.srcObject = canvas.captureStream(10);
    await video.play();
    state.controls = controls;
    return state.results.length;
  });
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: { statuses: Array<{ state?: string }> };
    }).__partialVisibilitySmoke;
    return state?.statuses.at(-1)?.state ?? "missing";
  }), { timeout: 160_000 }).toBe("ready");
  await expect.poll(async () => page.evaluate((resultCount) => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: { results: Array<{ source?: string; quad?: unknown; lost?: boolean }> };
    }).__partialVisibilitySmoke;
    return state?.results.slice(resultCount).some((result) =>
      result.source?.startsWith("opencv-") && !result.lost && Array.isArray(result.quad)
    ) ?? false;
  }, setup), { timeout: 160_000 }).toBe(true);
  const partialStart = await page.evaluate(async () => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: unknown[];
        controls?: { offsetX: number; scale: number };
      };
    }).__partialVisibilitySmoke;
    if (!state?.controls) throw new Error("Partial-visibility controls were unavailable");
    const resultCount = state.results.length;
    for (let step = 1; step <= 8; step += 1) {
      const progress = step / 8;
      state.controls.offsetX = -0.60 - 0.075 * progress;
      state.controls.scale = 1;
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
    return resultCount;
  });
  await expect.poll(async () => page.evaluate((resultCount) => {
    const state = (window as Window & { __partialVisibilitySmoke?: { results: unknown[] } }).__partialVisibilitySmoke;
    return (state?.results.length ?? 0) >= resultCount + 2;
  }, partialStart), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => page.evaluate((resultCount) => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: Array<{
          source?: string;
          featureProfile?: string;
          quad?: unknown;
          anchor?: { x?: number; y?: number } | null;
          lost?: boolean;
          recalibrationRequired?: boolean;
          partialVisibility?: boolean;
          anchorVisible?: boolean;
        }>;
      };
    }).__partialVisibilitySmoke;
    return state?.results.slice(resultCount).some((result) => {
      const anchor = result.anchor;
      return result.source?.startsWith("opencv-") &&
        result.featureProfile === "reflective-plane" &&
        !result.lost && !result.recalibrationRequired && result.partialVisibility === true &&
        result.anchorVisible !== false && Array.isArray(result.quad) && result.quad.length === 4 &&
        Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y);
    }) ?? false;
  }, partialStart), { timeout: 30_000 }).toBe(true);

  const cropLossStart = await page.evaluate(() => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: unknown[];
        controls?: { offsetX: number; scale: number };
      };
    }).__partialVisibilitySmoke;
    if (!state?.controls) throw new Error("Partial-visibility controls were unavailable");
    const resultCount = state.results.length;
    // Move the fixture far enough in one frame to remove the target from the
    // viewport, exercising the real OpenCV loss path before returning to the
    // known-good partial crop below.
    state.controls.offsetX = -1.5;
    return resultCount;
  });
  await expect.poll(async () => page.evaluate((resultCount) => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: Array<{ lost?: boolean }>;
      };
    }).__partialVisibilitySmoke;
    return state?.results.slice(resultCount).some((result) => result.lost === true) ?? false;
  }, cropLossStart), { timeout: 30_000 }).toBe(true);

  const recoveryStart = await page.evaluate(() => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: unknown[];
        controls?: { offsetX: number; scale: number };
      };
    }).__partialVisibilitySmoke;
    if (!state?.controls) throw new Error("Partial-visibility controls were unavailable");
    // Return the target at a materially different screen position. A full-frame
    // recovery search is useless if its acceptance envelope still rejects the
    // correct target merely because the phone came back at another angle.
    state.controls.offsetX = -0.45;
    state.controls.scale = 1;
    return state.results.length;
  });
  await expect.poll(async () => page.evaluate((resultCount) => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: Array<{
          source?: string;
          featureProfile?: string;
          quad?: unknown;
          anchor?: { x?: number; y?: number } | null;
          lost?: boolean;
          recalibrationRequired?: boolean;
          partialVisibility?: boolean;
          anchorVisible?: boolean;
        }>;
      };
    }).__partialVisibilitySmoke;
    return state?.results.slice(resultCount).filter((result) => {
      const anchor = result.anchor;
      return result.source?.startsWith("opencv-") &&
        result.featureProfile === "reflective-plane" &&
        !result.lost && !result.recalibrationRequired && result.partialVisibility !== true &&
        result.anchorVisible !== false && Array.isArray(result.quad) && result.quad.length === 4 &&
        Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y);
    }).length ?? 0;
  }, recoveryStart), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

  const closeStart = await page.evaluate(async () => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: unknown[];
        controls?: { offsetX: number; scale: number };
      };
    }).__partialVisibilitySmoke;
    if (!state?.controls) throw new Error("Partial-visibility controls were unavailable");
    const resultCount = state.results.length;
    for (let step = 1; step <= 10; step += 1) {
      const progress = step / 10;
      state.controls.offsetX = -0.45 - 0.136 * progress;
      state.controls.scale = 1 + 0.18 * progress;
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
    return resultCount;
  });
  await expect.poll(async () => page.evaluate((resultCount) => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: Array<{
          source?: string;
          featureProfile?: string;
          bounds?: { width?: number };
          quad?: unknown;
          lost?: boolean;
          recalibrationRequired?: boolean;
        }>;
      };
    }).__partialVisibilitySmoke;
    return state?.results.slice(resultCount).filter((result) =>
      result.source?.startsWith("opencv-") &&
      result.featureProfile === "reflective-plane" &&
      !result.lost && !result.recalibrationRequired &&
      Array.isArray(result.quad) && result.quad.length === 4 &&
      Number(result.bounds?.width ?? 0) >= 0.25
    ).length ?? 0;
  }, closeStart), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

  const jitterStart = await page.evaluate(async () => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: unknown[];
        controls?: { offsetX: number; scale: number };
      };
    }).__partialVisibilitySmoke;
    if (!state?.controls) throw new Error("Partial-visibility controls were unavailable");
    const resultCount = state.results.length;
    // Hold several nearby poses long enough for independent worker samples;
    // the deterministic jitter changes the reflective interior without
    // taking the physical bezel out of view.
    const nearFrames = [
      { offsetX: -0.586, scale: 1.180 },
      { offsetX: -0.581, scale: 1.175 },
      { offsetX: -0.591, scale: 1.185 },
      { offsetX: -0.584, scale: 1.178 },
      { offsetX: -0.588, scale: 1.182 },
      { offsetX: -0.586, scale: 1.180 },
    ];
    for (const frame of nearFrames) {
      state.controls.offsetX = frame.offsetX;
      state.controls.scale = frame.scale;
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    }
    return resultCount;
  });
  await expect.poll(async () => page.evaluate((resultCount) => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: {
        results: Array<{
          source?: string;
          featureProfile?: string;
          quad?: unknown;
          anchor?: { x?: number; y?: number } | null;
          lost?: boolean;
          recalibrationRequired?: boolean;
        }>;
      };
    }).__partialVisibilitySmoke;
    return state?.results.slice(resultCount).filter((result) =>
      result.source?.startsWith("opencv-") &&
      result.featureProfile === "reflective-plane" &&
      !result.lost && !result.recalibrationRequired &&
      Array.isArray(result.quad) && result.quad.length === 4 &&
      Number.isFinite(result.anchor?.x) && Number.isFinite(result.anchor?.y)
    ).length ?? 0;
  }, jitterStart), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);

  const evidence = await page.evaluate(() => {
    const state = (window as Window & {
      __partialVisibilitySmoke?: { engine: { destroy: () => void }; results: unknown[] };
    }).__partialVisibilitySmoke;
    state?.engine.destroy();
    return state?.results ?? [];
  });
  type PartialResult = {
    source?: string;
    featureProfile?: string;
    quad?: Array<{ x?: number; y?: number }> | null;
    anchor?: { x?: number; y?: number } | null;
    lost?: boolean;
    recalibrationRequired?: boolean;
    partialVisibility?: boolean;
  };
  const jitterResults = (evidence as PartialResult[]).slice(jitterStart);
  const isUsableReflectiveTracking = (result: PartialResult) =>
    result.source?.startsWith("opencv-") && result.featureProfile === "reflective-plane" &&
    !result.lost && !result.recalibrationRequired && result.quad?.length === 4 &&
    Number.isFinite(result.anchor?.x) && Number.isFinite(result.anchor?.y);
  let longestUsableStreak = 0;
  let usableStreak = 0;
  let lossRecoveryPairs = 0;
  let lossSeen = false;
  for (const result of jitterResults) {
    if (result.lost === true) {
      lossSeen = true;
      usableStreak = 0;
      continue;
    }
    if (!isUsableReflectiveTracking(result)) {
      usableStreak = 0;
      continue;
    }
    usableStreak += 1;
    longestUsableStreak = Math.max(longestUsableStreak, usableStreak);
    if (lossSeen) {
      lossRecoveryPairs += 1;
      lossSeen = false;
    }
  }
  expect(
    jitterResults.filter((result) => !result.source?.startsWith("opencv-")).length,
    "reflective-TV recovery must not switch to browser fallback during near-view jitter",
  ).toBe(0);
  expect(
    longestUsableStreak,
    "reflective-TV recovery should maintain consecutive usable OpenCV results",
  ).toBeGreaterThanOrEqual(4);
  expect(
    lossRecoveryPairs,
    "reflective-TV tracking should not alternate between lost and recovered more than once",
  ).toBeLessThanOrEqual(1);
  const finalUsable = jitterResults.filter(isUsableReflectiveTracking).at(-1);
  expect(finalUsable, "reflective tracking should produce a final usable result").toBeDefined();
  const expectedFinalAnchor = {
    x: 0.755 * 1.18 - 0.586,
    y: 0.74 * 1.18,
  };
  expect(
    Math.hypot(
      Number(finalUsable?.anchor?.x) - expectedFinalAnchor.x,
      Number(finalUsable?.anchor?.y) - expectedFinalAnchor.y,
    ),
    "adjacent console features must not pull the TV anchor off its bezel plane",
  ).toBeLessThan(0.05);
  const recoveryResults = (evidence as PartialResult[]).slice(recoveryStart);
  const reacquiredResults = recoveryResults.filter((result) => {
    const anchor = result.anchor;
    const quad = result.quad;
    const hasVisibleAnchor = Boolean(anchor) &&
      Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y) &&
      Number(anchor?.x) >= 0 && Number(anchor?.x) <= 1 &&
      Number(anchor?.y) >= 0 && Number(anchor?.y) <= 1;
    const fullyVisibleQuad = Array.isArray(quad) && quad.every((point) =>
      Number(point.x) >= 0 && Number(point.x) <= 1 &&
      Number(point.y) >= 0 && Number(point.y) <= 1
    );
    return result.partialVisibility !== true && result.source?.startsWith("opencv-") &&
      result.featureProfile === "reflective-plane" &&
      !result.lost && !result.recalibrationRequired && quad?.length === 4 &&
      hasVisibleAnchor && fullyVisibleQuad;
  });
  expect(
    reacquiredResults.length,
    "a shifted fully visible target should reacquire after a complete crop",
  ).toBeGreaterThanOrEqual(2);
});

test("holds a reflective anchor through an isolated visibility-floor miss", async ({ page }) => {
  await page.goto("/");
  const results = await page.evaluate(() => {
    (window as Window & { __fieldAssistPerceptionE2E?: { mode: string } })
      .__fieldAssistPerceptionE2E = { mode: "mock-ready" };
    const runtime = window as Window & {
      FieldAssistPerception?: {
        PerceptionEngine: new (
          video: HTMLVideoElement,
          result: (value: unknown) => void,
          status: (value: unknown) => void,
        ) => {
          start: (bounds: unknown, anchor?: unknown, profile?: string) => void;
          handleOpenCVMessage: (message: unknown) => void;
          destroy: () => void;
        };
      };
    };
    if (!runtime.FieldAssistPerception) throw new Error("Perception coordinator was unavailable");
    const emitted: Array<{ lost?: boolean; source?: string }> = [];
    const engine = new runtime.FieldAssistPerception.PerceptionEngine(
      document.createElement("video"),
      (result) => emitted.push(result as { lost?: boolean; source?: string }),
      () => {},
    );
    const bounds = { x: 0.18, y: 0.29, width: 0.7, height: 0.27 };
    const anchor = { x: 0.5, y: 0.56 };
    const quad = [
      { x: 0.18, y: 0.29 },
      { x: 0.88, y: 0.29 },
      { x: 0.88, y: 0.56 },
      { x: 0.18, y: 0.56 },
    ];
    engine.start(bounds, anchor, "reflective-plane");
    engine.handleOpenCVMessage({
      type: "lost",
      reason: "projection-below-visible-floor",
      confidence: 0,
    });
    engine.handleOpenCVMessage({
      type: "tracked",
      bounds,
      quad,
      anchor,
      confidence: 0.82,
      moved: false,
      featureProfile: "reflective-plane",
      partialVisibility: false,
      visibleFraction: 1,
      anchorVisible: true,
    });
    engine.handleOpenCVMessage({
      type: "lost",
      reason: "projection-below-visible-floor",
      confidence: 0,
    });
    engine.destroy();
    return emitted;
  });

  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ lost: false, source: "opencv-homography" });
});

test("keeps camera motion and partial occlusion explicit before durable loss", async ({ page }) => {
  await page.goto("/");
  const evidence = await page.evaluate(() => {
    const runtime = window as Window & {
      FieldAssistPerception?: {
        PerceptionEngine: new (
          video: HTMLVideoElement,
          result: (value: unknown) => void,
          status: (value: unknown) => void,
        ) => {
          start: (bounds: unknown, anchor?: unknown, profile?: string) => void;
          handleOpenCVMessage: (message: unknown) => void;
          destroy: () => void;
        };
      };
    };
    if (!runtime.FieldAssistPerception) throw new Error("Perception coordinator unavailable");
    const results: Array<Record<string, unknown>> = [];
    const engine = new runtime.FieldAssistPerception.PerceptionEngine(
      document.createElement("video"),
      (result) => results.push(result as Record<string, unknown>),
      () => {},
    );
    const full = { x: 0.16, y: 0.22, width: 0.56, height: 0.46 };
    const moved = { x: 0.24, y: 0.20, width: 0.56, height: 0.46 };
    const partial = { x: -0.04, y: 0.20, width: 0.56, height: 0.46 };
    engine.start(full, { x: 0.44, y: 0.62 }, "reflective-plane");
    engine.handleOpenCVMessage({
      type: "tracked", bounds: full, quad: [
        { x: 0.16, y: 0.22 }, { x: 0.72, y: 0.22 },
        { x: 0.72, y: 0.68 }, { x: 0.16, y: 0.68 },
      ], anchor: { x: 0.44, y: 0.62 }, confidence: 0.9, moved: false,
    });
    engine.handleOpenCVMessage({
      type: "tracked", bounds: moved, quad: [
        { x: 0.24, y: 0.20 }, { x: 0.80, y: 0.20 },
        { x: 0.80, y: 0.66 }, { x: 0.24, y: 0.66 },
      ], anchor: { x: 0.52, y: 0.60 }, confidence: 0.82, moved: true,
    });
    engine.handleOpenCVMessage({
      type: "tracked", bounds: partial, quad: [
        { x: -0.04, y: 0.20 }, { x: 0.52, y: 0.20 },
        { x: 0.52, y: 0.66 }, { x: -0.04, y: 0.66 },
      ], anchor: { x: 0.24, y: 0.60 }, confidence: 0.74,
      moved: true, partialVisibility: true, visibleFraction: 0.93, anchorVisible: true,
    });
    const beforeLoss = results.length;
    for (let index = 0; index < 2; index += 1) {
      engine.handleOpenCVMessage({ type: "lost", reason: "occluded", confidence: 0 });
    }
    const afterTransientLoss = results.length;
    engine.handleOpenCVMessage({ type: "lost", reason: "occluded", confidence: 0 });
    engine.destroy();
    return { results, beforeLoss, afterTransientLoss };
  });

  expect(evidence.beforeLoss).toBe(3);
  expect(evidence.afterTransientLoss).toBe(3);
  expect(evidence.results).toHaveLength(4);
  expect(evidence.results[1]).toMatchObject({ moved: true, lost: false });
  expect(evidence.results[2]).toMatchObject({ partialVisibility: true, anchorVisible: true, lost: false });
  expect((evidence.results[2].quad as Array<{ x: number }>)[0].x).toBeLessThan(0);
  expect(evidence.results[2].bounds).toMatchObject({ x: 0 });
  expect(evidence.results[3]).toMatchObject({ lost: true, confidence: 0, quad: null, anchor: null });
});
