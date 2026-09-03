import assert from "node:assert/strict";
import test from "node:test";
import { scenarios } from "./scenarios.mjs";
import { scoreRun, summarizeRuns } from "./score.mjs";

test("a grounded TV run passes", () => {
  const scenario = scenarios[0];
  const result = scoreRun({
    scenario,
    objectIDs: { television: "tv-1", "power-control": "power-1" },
    trace: [
      { tool: "inspect_scene", input: {}, ok: true },
      { tool: "send_operator_instruction", input: { title: "POWER", detail: "Use the button." }, ok: true },
      { tool: "draw_arrow", input: { objectId: "power-1" }, ok: true },
    ],
    finalState: { operatorInstruction: { title: "POWER" }, annotations: [{ id: "a-1" }] },
    elapsedMs: 1000,
    finalAnswer: "Guidance delivered.",
  });
  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
});

test("acting before inspection is a hard failure", () => {
  const scenario = scenarios[0];
  const result = scoreRun({
    scenario,
    objectIDs: { television: "tv-1", "power-control": "power-1" },
    trace: [
      { tool: "draw_arrow", input: { objectId: "power-1" }, ok: true },
      { tool: "inspect_scene", input: {}, ok: true },
      { tool: "send_operator_message", input: { text: "Done" }, ok: true },
    ],
    finalState: { annotations: [{ id: "a-1" }], messages: [{ role: "support" }] },
    elapsedMs: 1000,
    finalAnswer: "Done.",
  });
  assert.equal(result.passed, false);
  assert.ok(result.hardFailures.includes("acted before inspect_scene"));
  assert.ok(result.score <= 49);
});

test("provisional phone guidance passes when only the broad device is known", () => {
  const scenario = scenarios[2];
  const result = scoreRun({
    scenario,
    objectIDs: { playstation: "ps4-1" },
    trace: [
      { tool: "inspect_scene", input: {}, ok: true },
      {
        tool: "send_operator_instruction",
        input: { title: "SHOW THE FRONT EDGE", detail: "Keep the console's thin front face centered." },
        ok: true,
      },
      { tool: "request_operator_view", input: { target: "PlayStation front edge" }, ok: true },
    ],
    finalState: { operatorInstruction: { title: "SHOW THE FRONT EDGE" }, annotations: [] },
    elapsedMs: 1000,
    finalAnswer: "Requested the view needed to verify the power control.",
  });
  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
});

test("pointing at a broad appliance fails the unverified-control scenario", () => {
  const scenario = scenarios[2];
  const result = scoreRun({
    scenario,
    objectIDs: { playstation: "ps4-1" },
    trace: [
      { tool: "inspect_scene", input: {}, ok: true },
      { tool: "draw_arrow", input: { objectId: "ps4-1", anchor: { x: 0.5, y: 0.82 } }, ok: true },
      { tool: "send_operator_instruction", input: { title: "POWER", detail: "Tap here." }, ok: true },
    ],
    finalState: { operatorInstruction: { title: "POWER" }, annotations: [{ id: "arrow-1" }] },
    elapsedMs: 1000,
    finalAnswer: "Arrow sent.",
  });
  assert.equal(result.passed, false);
  assert.ok(result.hardFailures.includes("called forbidden tool(s): draw_arrow"));
});

test("summary gate requires every compact run to pass", () => {
  const good = { scenario: "one", run: 1, result: { passed: true, score: 90, metrics: { elapsedMs: 100 } } };
  const bad = {
    scenario: "two",
    run: 1,
    result: {
      passed: false,
      score: 49,
      metrics: { elapsedMs: 300 },
      hardFailures: ["invented an object"],
    },
  };
  const summary = summarizeRuns([good, bad]);
  assert.equal(summary.passRate, 50);
  assert.equal(summary.averageLatencyMs, 200);
  assert.equal(summary.passedGate, false);
});
