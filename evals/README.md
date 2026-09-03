# Codex behavioral evals

This compact suite runs the account-authenticated Codex CLI against the exact
WebMCP declarations and authenticated HTTP commands used by the support page.
It does not add a model API to Field Assist.

The default baseline is three scenarios with two independent runs each using
`gpt-5.6-terra` at low reasoning:

- lost TV controller;
- free-form network-port guidance;
- recovery when a known target needs to be reacquired.

Run everything locally:

```sh
node evals/run.mjs
```

Run one scenario once while iterating:

```sh
EVAL_SCENARIO=lost-tv-controller EVAL_REPEATS=1 node evals/run.mjs
```

Test the deployed application instead of starting an ephemeral local server:

```sh
EVAL_BASE_URL=https://webmcp.donaldmurillo.com node evals/run.mjs
```

Override the Codex baseline only for a deliberate comparison:

```sh
EVAL_MODEL=gpt-5.6-terra EVAL_REASONING_EFFORT=medium node evals/run.mjs
```

Results are written to `evals/results/latest.json` and
`evals/results/latest.md`. The JSON includes the sanitized tool trace, scores,
latency, and final structured answer. Cookies, join tokens, media, and raw tool
responses are never written to the report.

A run passes at 85/100 and must have no hard failure. Hard failures are acting
before `inspect_scene`, using an unknown object id, taking a scenario-forbidden
action, or failing to leave guidance in backend-authoritative state.

The suite intentionally pre-registers visible objects as its deterministic
vision fixture. It evaluates Codex's WebMCP discovery, decision order,
grounding, communication channel, and recovery behavior. The Playwright suite
remains responsible for the real WebRTC, rendering, operator delivery, and
OpenCV/Depth Anything browser runtime boundaries.

