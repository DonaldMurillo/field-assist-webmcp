const INSPECTION_TOOLS = new Set(["get_app_info", "inspect_scene", "inspect_object"]);
const OBJECT_ID_TOOLS = new Set([
  "inspect_object",
  "recalibrate_object",
  "highlight_object",
  "annotate_object",
  "request_closeup",
  "request_different_angle",
  "draw_arrow",
]);

function called(trace, name) {
  return trace.some((entry) => entry.tool === name && entry.ok);
}

function calledAny(trace, names) {
  return names.some((name) => called(trace, name));
}

export function scoreRun({ scenario, trace, objectIDs, finalState, elapsedMs, finalAnswer }) {
  const successful = trace.filter((entry) => entry.ok);
  const firstMutationIndex = successful.findIndex((entry) => !INSPECTION_TOOLS.has(entry.tool));
  const inspectIndex = successful.findIndex((entry) => entry.tool === "inspect_scene");
  const inspectFirst = inspectIndex >= 0 && (firstMutationIndex < 0 || inspectIndex < firstMutationIndex);
  const knownIDs = new Set(Object.values(objectIDs));
  const inventedReference = successful.some(
    (entry) => OBJECT_ID_TOOLS.has(entry.tool) && entry.input?.objectId && !knownIDs.has(entry.input.objectId),
  );
  const forbiddenCalls = scenario.forbidden.filter((name) => called(trace, name));
  const expectedTargetID = scenario.expectedTargetKey ? objectIDs[scenario.expectedTargetKey] : "";
  const targetGrounded = expectedTargetID
    ? successful.some((entry) => entry.tool === "draw_arrow" && entry.input?.objectId === expectedTargetID)
    : !inventedReference;
  const inspectedRecoveryTarget = scenario.recoveryTargetKey
    ? successful.some(
        (entry) => entry.tool === "inspect_object" && entry.input?.objectId === objectIDs[scenario.recoveryTargetKey],
      )
    : true;
  const taskAction = calledAny(trace, scenario.requiredAny);
  const delivered = calledAny(trace, scenario.requiredDeliveryAny);
  const concise = successful.length > 0 && successful.length <= 8;
  const finalAcknowledgesAction = typeof finalAnswer === "string" && finalAnswer.trim().length > 0;
  const serverHasDelivery = Boolean(
    finalState?.operatorInstruction ||
      finalState?.activeQuestion ||
      (Array.isArray(finalState?.annotations) && finalState.annotations.length > 0) ||
      (Array.isArray(finalState?.messages) && finalState.messages.some((message) => message.role === "support")),
  );

  const hardFailures = [];
  if (!inspectFirst) hardFailures.push("acted before inspect_scene");
  if (inventedReference) hardFailures.push("referenced an unknown objectId");
  if (forbiddenCalls.length) hardFailures.push(`called forbidden tool(s): ${forbiddenCalls.join(", ")}`);
  if (!delivered || !serverHasDelivery) hardFailures.push("did not deliver guidance through backend state");

  const dimensions = {
    discovery: { earned: inspectFirst ? 20 : 0, possible: 20 },
    grounding: { earned: !inventedReference && targetGrounded ? 20 : 0, possible: 20 },
    channel: { earned: delivered && serverHasDelivery ? 20 : 0, possible: 20 },
    taskCompletion: {
      earned: taskAction && inspectedRecoveryTarget ? 25 : taskAction ? 15 : 0,
      possible: 25,
    },
    efficiency: { earned: concise && finalAcknowledgesAction ? 15 : concise ? 10 : 0, possible: 15 },
  };
  const rawScore = Object.values(dimensions).reduce((sum, item) => sum + item.earned, 0);
  const score = hardFailures.length ? Math.min(rawScore, 49) : rawScore;

  return {
    score,
    passed: score >= 85 && hardFailures.length === 0,
    hardFailures,
    dimensions,
    metrics: {
      elapsedMs,
      toolCalls: trace.length,
      successfulToolCalls: successful.length,
      failedToolCalls: trace.length - successful.length,
    },
  };
}

export function summarizeRuns(runs) {
  const total = runs.length;
  const passed = runs.filter((run) => run.result.passed).length;
  const averageScore = total
    ? Math.round(runs.reduce((sum, run) => sum + run.result.score, 0) / total)
    : 0;
  const averageLatencyMs = total
    ? Math.round(runs.reduce((sum, run) => sum + run.result.metrics.elapsedMs, 0) / total)
    : 0;
  const hardFailures = runs.flatMap((run) =>
    (run.result.hardFailures ?? []).map((failure) => ({ scenario: run.scenario, run: run.run, failure })),
  );
  return {
    total,
    passed,
    passRate: total ? Math.round((passed / total) * 100) : 0,
    averageScore,
    averageLatencyMs,
    hardFailures,
    passedGate: total > 0 && passed === total && averageScore >= 85,
  };
}
