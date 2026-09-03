import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const width = 640;
const height = 360;
const frameRate = 12;
const seconds = 4;
const outputPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/depth-parallax.webm",
);

function rgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function fillRect(frame, x, y, boxWidth, boxHeight, color) {
  const left = Math.max(0, Math.round(x));
  const top = Math.max(0, Math.round(y));
  const right = Math.min(width, Math.round(x + boxWidth));
  const bottom = Math.min(height, Math.round(y + boxHeight));
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const index = (row * width + column) * 3;
      frame[index] = color[0];
      frame[index + 1] = color[1];
      frame[index + 2] = color[2];
    }
  }
}

function drawBackground(frame, phase) {
  fillRect(frame, 0, 0, width, height, rgb("#596164"));
  const farOffset = phase === 0 ? 0 : phase === 1 ? -4 : -8;
  const nearOffset = phase === 0 ? 0 : phase === 1 ? -10 : -18;
  for (let x = farOffset; x < width; x += 64) {
    fillRect(frame, x, 0, 2, height, rgb("#697276"));
  }
  for (let y = 0; y < height; y += 45) {
    fillRect(frame, 0, y, width, 2, rgb("#50585b"));
  }
  fillRect(frame, 42 + nearOffset, 60, 86, 210, rgb("#4a5255"));
  fillRect(frame, 58 + nearOffset, 80, 12, 170, rgb("#7b8589"));
}

function drawTarget(frame, x, y, boxWidth, boxHeight) {
  fillRect(frame, x, y, boxWidth, boxHeight, rgb("#f0b900"));
  fillRect(frame, x + boxWidth * 0.12, y + boxHeight * 0.18, boxWidth * 0.22, boxHeight * 0.64, rgb("#101817"));
  fillRect(frame, x + boxWidth * 0.48, y + boxHeight * 0.18, boxWidth * 0.40, boxHeight * 0.24, rgb("#101817"));
  fillRect(frame, x + boxWidth * 0.48, y + boxHeight * 0.58, boxWidth * 0.40, boxHeight * 0.24, rgb("#50d8c0"));
  fillRect(frame, x + boxWidth * 0.39, y + boxHeight * 0.08, boxWidth * 0.04, boxHeight * 0.84, rgb("#fff1a8"));
}

const frames = [];
for (let frameIndex = 0; frameIndex < frameRate * seconds; frameIndex += 1) {
  const phase = Math.floor(frameIndex / frameRate);
  const frame = Buffer.alloc(width * height * 3);
  drawBackground(frame, phase);
  if (phase === 0) {
    drawTarget(frame, 0.67 * width, 0.55 * height, 0.17 * width, 0.16 * height);
  } else if (phase === 1) {
    drawTarget(frame, 0.71 * width, 0.55 * height, 0.17 * width, 0.16 * height);
  } else if (phase === 2) {
    const scaledWidth = 0.17 * width * 1.10;
    const scaledHeight = 0.16 * height * 1.10;
    const centerX = 0.71 * width + 0.17 * width / 2;
    const centerY = 0.55 * height + 0.16 * height / 2;
    drawTarget(
      frame,
      centerX - scaledWidth / 2,
      centerY - scaledHeight / 2,
      scaledWidth,
      scaledHeight,
    );
  } else {
    fillRect(frame, 0.60 * width, 0.44 * height, 0.36 * width, 0.38 * height, rgb("#596164"));
  }
  frames.push(frame);
}

mkdirSync(dirname(outputPath), { recursive: true });
const result = spawnSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "rawvideo",
    "-pixel_format", "rgb24",
    "-video_size", `${width}x${height}`,
    "-framerate", String(frameRate),
    "-i", "pipe:0",
    "-an",
    "-c:v", "libvpx-vp9",
    "-lossless", "1",
    "-pix_fmt", "yuv420p",
    "-g", String(frameRate),
    "-keyint_min", String(frameRate),
    "-deadline", "good",
    "-y",
    outputPath,
  ],
  { input: Buffer.concat(frames), encoding: "utf8" },
);

if (result.status !== 0) {
  throw new Error(result.stderr || `ffmpeg exited with status ${result.status}`);
}

console.log(outputPath);
