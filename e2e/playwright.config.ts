import { defineConfig, devices } from "@playwright/test";

const TEST_PORT = 4173;
const deployedBaseURL = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const baseURL = deployedBaseURL || `http://127.0.0.1:${TEST_PORT}`;
const webMCPDebug = process.env.E2E_WEBMCP_DEBUG === "1";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  reporter: process.env.CI ? [["dot"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    browserName: "chromium",
    permissions: ["camera"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      // WebMCP is still experimental, while fake media makes the WebRTC
      // peer path deterministic in CI and on developer machines.
      args: [
        "--enable-blink-features=WebMCP",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: deployedBaseURL ? undefined : {
    command: "go run .",
    cwd: "..",
    env: {
      PORT: String(TEST_PORT),
      BARCODE_SERVICE_URL: "http://127.0.0.1:9",
      // Keep GoFastr's normal isolation behavior while honoring the explicit
      // test port in linked worktrees.
      GOFASTR_ISOLATION_REWRITE: "0",
      WEBMCP_DEBUG: webMCPDebug ? "true" : "false",
    },
    url: `http://127.0.0.1:${TEST_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
