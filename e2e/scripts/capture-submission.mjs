import { chromium, devices } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const baseURL = (process.env.E2E_BASE_URL || "https://webmcp.donaldmurillo.com").replace(/\/$/, "");
const outputDir = fileURLToPath(new URL("../../docs/assets/", import.meta.url));

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    "--enable-blink-features=WebMCP",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const supportContext = await browser.newContext({
  ...devices["Desktop Chrome"],
  viewport: { width: 1440, height: 1000 },
  permissions: ["camera"],
});
const support = await supportContext.newPage();
let operatorContext;

try {
  await support.goto(baseURL, { waitUntil: "networkidle" });
  await support.screenshot({ path: `${outputDir}/landing-desktop.png`, fullPage: true });

  await Promise.all([
    support.waitForURL(/\/session\/[^/]+$/),
    support.locator("#create-session").click(),
  ]);
  await support.locator("#operator-link").waitFor({ state: "visible" });
  await support.waitForFunction(() => document.querySelector("#signal-status")?.textContent?.includes("open"));

  const operatorHref = await support.locator("#operator-link").getAttribute("href");
  if (!operatorHref) throw new Error("support page did not produce an operator link");

  operatorContext = await browser.newContext({
    ...devices["iPhone 13"],
    permissions: ["camera"],
  });
  const operator = await operatorContext.newPage();
  await operator.goto(new URL(operatorHref, support.url()).toString());
  await operator.locator("#operator-app").waitFor({ state: "visible" });
  const startCamera = operator.locator("#start-camera");
  if (await startCamera.isVisible()) await startCamera.click();

  await operator.waitForFunction(() => {
    const video = document.querySelector("#local-video");
    return Boolean(video?.srcObject?.getVideoTracks?.().some((track) => track.readyState === "live"));
  });
  await support.waitForFunction(() => {
    const video = document.querySelector("#remote-video");
    return Boolean(video?.srcObject?.getVideoTracks?.().some((track) => track.readyState === "live"));
  }, undefined, { timeout: 45_000 });

  const highlighted = await support.evaluate(async () => {
    const response = await fetch("/api/tools/highlight-object", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ objectId: "wan-port" }),
    });
    return response.ok;
  });
  if (!highlighted) throw new Error("highlight request failed");
  await operator.locator("#operator-overlay").getByText("CONNECT HERE").waitFor();
  await support.locator("#support-overlay").getByText("CONNECT HERE").waitFor();

  await support.locator("#approve-cable-move").click();
  await operator.locator("#confirm-cable-moved").waitFor({ state: "visible" });
  const activityRecorded = await operator.evaluate(async () => {
    const currentResponse = await fetch("/api/session/current", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const current = await currentResponse.json();
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
    return response.ok;
  });
  if (!activityRecorded) throw new Error("visual-change activity request failed");
  await support.locator("#support-scene-activity-status").getByText("Visual change detected").waitFor();
  await support.waitForTimeout(500);

  // Submission screenshots must never contain a reusable join capability.
  await support.evaluate(() => {
	document.querySelector("#video-empty")?.remove();
    window.scrollTo(0, 0);
  });
  await operator.evaluate(() => window.scrollTo(0, 0));
  await support.screenshot({ path: `${outputDir}/support-console.png`, fullPage: true });
  await operator.screenshot({ path: `${outputDir}/operator-overlay.png`, fullPage: true });
} finally {
  await operatorContext?.close();
  await supportContext.close();
  await browser.close();
}

console.log(`submission screenshots written to ${outputDir}`);
