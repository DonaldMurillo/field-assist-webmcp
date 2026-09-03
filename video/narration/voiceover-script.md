# Field Assist demo voiceover

Target: 2:44 master, conversational delivery, approximately 155–165 words per minute.

The timestamps are cue starts, not hard cuts. Each paragraph should sound like one complete thought. The temporary render uses the macOS Samantha voice; the final ElevenLabs performance can replace these cues without changing the picture edit.

## 00:00.6 — Problem and promise

Words fail when remote support asks, “Which button?” Field Assist lets an agent see, confirm, and point directly into the live view.

## 00:10.6 — Connect

A support session begins with a secure QR code. The operator scans it on their phone and shares the camera peer to peer—without installing an app, creating an account, or streaming the video through the application server.

## 00:26.6 — Identify

Here, the operator needs help finding the power control on a PlayStation. Codex inspects the live scene through WebMCP and turns what it sees into a specific, testable identification.

## 00:39.4 — Confirm

Before acting on the physical world, the operator confirms the detected object. That human checkpoint prevents the assistant from confidently guiding someone toward the wrong device.

## 00:52.2 — Track

Once confirmed, the support console starts visual tracking and spatial perception. OpenCV follows image features, Depth Anything estimates scene structure, and phone orientation data helps compensate as the camera moves.

## 01:18.6 — Guide

Codex uses its product knowledge and the live visual context to locate the likely power control. It then sends one clear instruction to the phone, where it is impossible to miss while the operator is holding the camera.

## 01:37.0 — Anchor

The arrow is not merely pinned to screen coordinates. Field Assist continually corrects it against the tracked object and scene geometry as the operator changes position. The support agent can verify the placement, recalibrate when confidence drops, and keep the instruction synchronized across both screens.

## 02:05.2 — Broader applications

The same interaction applies far beyond consumer electronics: equipment repair, device setup, field service, accessibility, independent living, remote care, warehouse picking, inspections, and safety training. Anywhere pointing is clearer than describing, remote expertise can become actionable.

## 02:25.5 — How it works

The stack combines Codex and WebMCP with GoFastr, WebRTC, OpenCV, Depth Anything, ONNX Runtime Web, and phone orientation—all in one web app.

## 02:39.0 — Close

Field Assist turns remote expertise into guidance anchored to the real world.

## ElevenLabs delivery notes

Use a warm, confident, technically credible voice. Keep the pace energetic but not promotional. Emphasize “WebMCP,” “peer to peer,” “human checkpoint,” and “not merely pinned to screen coordinates.” Leave the short pauses between cues intact so the visual chapter cards can breathe.
