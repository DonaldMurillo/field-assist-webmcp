'use strict';

var ortRuntime = null;
var depthSession = null;
var baselineTargetDepth = 0;
var initializing = false;
var activeModel = '';

function clamp(value, minimum, maximum) {
  value = Number(value);
  if (!isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function quantile(values, fraction) {
  if (!values.length) return 0;
  values.sort(function (left, right) { return left - right; });
  return values[Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * fraction)))];
}

function summarizeDepth(data, width, height, bounds) {
  bounds = bounds || { x: 0, y: 0, width: 1, height: 1 };
  var left = clamp(Math.floor(bounds.x * width), 0, width - 1);
  var top = clamp(Math.floor(bounds.y * height), 0, height - 1);
  var right = clamp(Math.ceil((bounds.x + bounds.width) * width), left + 1, width);
  var bottom = clamp(Math.ceil((bounds.y + bounds.height) * height), top + 1, height);
  var frame = [];
  var target = [];
  var ring = [];
  var padX = Math.max(2, Math.round((right - left) * 0.2));
  var padY = Math.max(2, Math.round((bottom - top) * 0.2));
  var ringLeft = Math.max(0, left - padX);
  var ringTop = Math.max(0, top - padY);
  var ringRight = Math.min(width, right + padX);
  var ringBottom = Math.min(height, bottom + padY);
  for (var y = 0; y < height; y += 2) {
    for (var x = 0; x < width; x += 2) {
      var value = Number(data[y * width + x]);
      if (!isFinite(value)) continue;
      frame.push(value);
      if (x >= left && x < right && y >= top && y < bottom) target.push(value);
      else if (x >= ringLeft && x < ringRight && y >= ringTop && y < ringBottom) ring.push(value);
    }
  }
  if (!frame.length || !target.length) return null;
  var low = quantile(frame.slice(), 0.1);
  var high = quantile(frame.slice(), 0.9);
  var range = Math.max(0.000001, high - low);
  var targetMedian = quantile(target.slice(), 0.5);
  var targetLow = quantile(target.slice(), 0.25);
  var targetHigh = quantile(target.slice(), 0.75);
  var ringMedian = ring.length ? quantile(ring.slice(), 0.5) : targetMedian;
  var score = clamp((targetMedian - low) / range, 0, 1);
  var coherence = clamp(1 - (targetHigh - targetLow) / range, 0, 1);
  var separation = clamp(Math.abs(targetMedian - ringMedian) / range * 2.5, 0, 1);
  var confidence = clamp(coherence * 0.65 + separation * 0.35, 0, 1);
  if (!baselineTargetDepth && targetMedian > 0) baselineTargetDepth = targetMedian;
  var relativeDepth = baselineTargetDepth > 0 && targetMedian > 0
    ? clamp(baselineTargetDepth / targetMedian, 0.25, 4)
    : 1;
  var targetNear = targetHigh > 0 ? targetMedian / targetHigh : 1;
  var targetFar = targetLow > 0 ? targetMedian / targetLow : 1;
  return {
    score: score,
    confidence: confidence,
    relativeDepth: relativeDepth,
    low: low,
    high: high,
    targetMedian: targetMedian,
    planeSpread: clamp(Math.max(Math.abs(targetNear - 1), Math.abs(targetFar - 1)), 0, 1)
  };
}

function buildDepthField(data, width, height, targetMedian) {
  var gridWidth = 24;
  var gridHeight = Math.max(14, Math.min(48, Math.round(gridWidth * height / width)));
  var values = new Float32Array(gridWidth * gridHeight);
  for (var gridY = 0; gridY < gridHeight; gridY += 1) {
    var sourceY = Math.min(height - 1, Math.round((gridY + 0.5) / gridHeight * height));
    for (var gridX = 0; gridX < gridWidth; gridX += 1) {
      var sourceX = Math.min(width - 1, Math.round((gridX + 0.5) / gridWidth * width));
      var inverseDepth = Number(data[sourceY * width + sourceX]);
      values[gridY * gridWidth + gridX] = inverseDepth > 0
        ? clamp(targetMedian / inverseDepth, 0.25, 4)
        : 4;
    }
  }
  return { width: gridWidth, height: gridHeight, values: values };
}

function rgbaToNormalizedNCHW(pixels, width, height) {
  var plane = width * height;
  var tensor = new Float32Array(plane * 3);
  var mean = [0.485, 0.456, 0.406];
  var standardDeviation = [0.229, 0.224, 0.225];
  for (var index = 0; index < plane; index += 1) {
    var source = index * 4;
    tensor[index] = (pixels[source] / 255 - mean[0]) / standardDeviation[0];
    tensor[plane + index] = (pixels[source + 1] / 255 - mean[1]) / standardDeviation[1];
    tensor[plane * 2 + index] = (pixels[source + 2] / 255 - mean[2]) / standardDeviation[2];
  }
  return tensor;
}

function configureWasm(runtime, runtimeRoot, webGPU) {
  runtime.env.wasm.numThreads = 1;
  runtime.env.wasm.wasmPaths = {
    mjs: runtimeRoot + '/ort-wasm-simd-threaded' + (webGPU ? '.jsep' : '') + '.mjs',
    wasm: runtimeRoot + '/ort-wasm-simd-threaded' + (webGPU ? '.jsep' : '') + '.wasm'
  };
}

async function createEstimator(message) {
  if (initializing || depthSession) return;
  initializing = true;
  var preferWebGPU = Boolean(message.preferWebGPU && self.navigator && self.navigator.gpu);
  try {
    ortRuntime = await import(preferWebGPU ? message.webGPURuntimeURL : message.wasmRuntimeURL);
    configureWasm(ortRuntime, message.runtimeRoot, preferWebGPU);
    var device = preferWebGPU ? 'webgpu' : 'wasm';
    activeModel = preferWebGPU ? 'depth-anything-v2-small-q4f16' : 'depth-anything-v2-small-int8';
    try {
      depthSession = await ortRuntime.InferenceSession.create(
        preferWebGPU ? message.webGPUModelURL : message.wasmModelURL,
        { executionProviders: [device], graphOptimizationLevel: 'all' }
      );
    } catch (webGPUError) {
      if (!preferWebGPU) throw webGPUError;
      ortRuntime = await import(message.wasmRuntimeURL);
      configureWasm(ortRuntime, message.runtimeRoot, false);
      depthSession = await ortRuntime.InferenceSession.create(message.wasmModelURL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
      device = 'wasm';
      activeModel = 'depth-anything-v2-small-int8';
    }
    initializing = false;
    self.postMessage({ type: 'ready', device: device, model: activeModel });
  } catch (_error) {
    initializing = false;
    self.postMessage({ type: 'error', reason: 'model-load-failed' });
  }
}

async function infer(message) {
  if (!depthSession || !ortRuntime) {
    self.postMessage({ type: 'error', reason: 'model-not-ready' });
    return;
  }
  try {
    var pixels = new Uint8ClampedArray(message.pixels);
    var inputData = rgbaToNormalizedNCHW(pixels, message.width, message.height);
    var feeds = { pixel_values: new ortRuntime.Tensor('float32', inputData, [1, 3, message.height, message.width]) };
    var output = await depthSession.run(feeds);
    var predicted = output.predicted_depth;
    if (!predicted || !predicted.data || !predicted.dims || predicted.dims.length < 2) throw new Error('Depth output was empty');
    var height = Number(predicted.dims[predicted.dims.length - 2]);
    var width = Number(predicted.dims[predicted.dims.length - 1]);
    var summary = summarizeDepth(predicted.data, width, height, message.bounds);
    if (!summary) throw new Error('Depth output could not be summarized');
    // Depth Anything emits relative inverse depth. Convert it to target-relative
    // camera Z so OpenCV can back-project pixels into one stable 3D reference.
    // The target median is Z=1; this is relative geometry, never metric distance.
    var field = buildDepthField(predicted.data, width, height, summary.targetMedian);
    self.postMessage({
      type: 'depth',
      score: summary.score,
      confidence: summary.confidence,
      relativeDepth: summary.relativeDepth,
      planeSpread: summary.planeSpread,
      targetDepth: 1,
      gridWidth: field.width,
      gridHeight: field.height,
      grid: field.values.buffer,
      frameId: Number(message.frameId || 0),
      capturedAt: Number(message.capturedAt || Date.now()),
      model: activeModel
    }, [field.values.buffer]);
  } catch (_error) {
    self.postMessage({ type: 'error', reason: 'inference-failed' });
  }
}

self.onmessage = function (event) {
  var message = event.data || {};
  if (message.type === 'init') createEstimator(message);
  else if (message.type === 'infer') infer(message);
  else if (message.type === 'reset') baselineTargetDepth = 0;
};
