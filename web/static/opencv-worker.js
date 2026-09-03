'use strict';

var cvRuntime = null;
var reference = null;
var recoveryReference = null;
var depthField = null;
var poseReference = null;
var pendingPoseFrame = null;
var runtimeLoading = false;
var poseDiagnostic = { attempted: false, accepted: false, reason: 'pose-not-ready' };
var poseLocked = false;
var poseCandidateCount = 0;
var planarRecoveryFrames = 0;
var planarLossFrames = 0;

function clamp(value, minimum, maximum) {
  value = Number(value);
  if (!isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedBounds(bounds) {
  bounds = bounds || {};
  var x = clamp(bounds.x, 0, 1);
  var y = clamp(bounds.y, 0, 1);
  var width = clamp(bounds.width, 0, 1 - x);
  var height = clamp(bounds.height, 0, 1 - y);
  return { x: x, y: y, width: width, height: height };
}

function normalizedPoint(point) {
  if (!point || !isFinite(Number(point.x)) || !isFinite(Number(point.y))) return null;
  return { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) };
}

function shortestAngle(from, to) {
  var delta = Number(to || 0) - Number(from || 0);
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function normalizedPose(pose) {
  if (!pose || !isFinite(Number(pose.alpha)) || !isFinite(Number(pose.beta)) || !isFinite(Number(pose.gamma))) return null;
  return { alpha: Number(pose.alpha), beta: Number(pose.beta), gamma: Number(pose.gamma) };
}

function poseGuidedBounds(bounds, fromPose, toPose) {
  bounds = normalizedBounds(bounds);
  fromPose = normalizedPose(fromPose);
  toPose = normalizedPose(toPose);
  if (!fromPose || !toPose) return bounds;
  var yaw = shortestAngle(fromPose.alpha, toPose.alpha);
  var pitch = toPose.beta - fromPose.beta;
  var roll = toPose.gamma - fromPose.gamma;
  var shiftX = clamp(-yaw / 90 - roll / 240, -0.08, 0.08);
  var shiftY = clamp(-pitch / 65, -0.08, 0.08);
  return normalizedBounds({
    x: bounds.x + shiftX,
    y: bounds.y + shiftY,
    width: bounds.width,
    height: bounds.height
  });
}

function deleteAll(values) {
  values.forEach(function (value) {
    if (value && typeof value.delete === 'function') value.delete();
  });
}

function resetReference() {
  if (!reference) return;
  deleteAll([reference.gray, reference.keypoints, reference.descriptors]);
  reference = null;
}

function resetRecoveryReference() {
  if (!recoveryReference) return;
  deleteAll([recoveryReference.keypoints, recoveryReference.descriptors]);
  recoveryReference = null;
}

function resetPoseReference() {
  if (poseReference) deleteAll([poseReference.descriptors]);
  poseReference = null;
  pendingPoseFrame = null;
  poseDiagnostic = { attempted: false, accepted: false, reason: 'pose-not-ready' };
  poseLocked = false;
  poseCandidateCount = 0;
  planarRecoveryFrames = 0;
  planarLossFrames = 0;
}

function rejectWorldProjection(reason, fields) {
  poseDiagnostic = Object.assign({
    attempted: Boolean(poseReference),
    accepted: false,
    reason: String(reason || 'pose-rejected')
  }, fields || {});
  return null;
}

function usableDepthField() {
  return depthField && depthField.values &&
    depthField.values.length === depthField.width * depthField.height;
}

function freshDepthField() {
  return usableDepthField() && Date.now() - Number(depthField.capturedAt || 0) <= 4000;
}

function depthAt(point, allowStale) {
  if (!(allowStale ? usableDepthField() : freshDepthField()) || !point) return null;
  if (!isFinite(Number(point.x)) || !isFinite(Number(point.y)) ||
      Number(point.x) < 0 || Number(point.x) > 1 || Number(point.y) < 0 || Number(point.y) > 1) return null;
  var x = clamp(Math.round(Number(point.x) * (depthField.width - 1)), 0, depthField.width - 1);
  var y = clamp(Math.round(Number(point.y) * (depthField.height - 1)), 0, depthField.height - 1);
  var value = Number(depthField.values[y * depthField.width + x]);
  return isFinite(value) ? value : null;
}

function depthGeometryAgreement(geometry) {
  if (!freshDepthField() || Number(depthField.confidence || 0) < 0.25 || !geometry || !geometry.quad) return null;
  var center = geometry.quad.reduce(function (result, point) {
    result.x += point.x / geometry.quad.length;
    result.y += point.y / geometry.quad.length;
    return result;
  }, { x: 0, y: 0 });
  var points = [center];
  geometry.quad.forEach(function (point) {
    points.push({ x: point.x * 0.7 + center.x * 0.3, y: point.y * 0.7 + center.y * 0.3 });
  });
  var tolerance = Math.max(0.08, Number(depthField.planeSpread || 0) * 2.5);
  var agreements = points.map(function (point) {
    var value = depthAt(point);
    if (value === null) return null;
    return clamp(1 - Math.abs(value - depthField.targetDepth) / tolerance, 0, 1);
  }).filter(function (value) { return value !== null; });
  if (!agreements.length) return null;
  return agreements.reduce(function (sum, value) { return sum + value; }, 0) / agreements.length;
}

function imageDataFromMessage(message) {
  return new ImageData(new Uint8ClampedArray(message.pixels), message.width, message.height);
}

function grayFromMessage(message) {
  var rgba = cvRuntime.matFromImageData(imageDataFromMessage(message));
  var gray = new cvRuntime.Mat();
  cvRuntime.cvtColor(rgba, gray, cvRuntime.COLOR_RGBA2GRAY);
  rgba.delete();
  return gray;
}

function expandedPixelBounds(bounds, width, height, featureProfile) {
  bounds = normalizedBounds(bounds);
  var reflective = normalizedFeatureProfile(featureProfile) === 'reflective-plane';
  // A generic object benefits from nearby visual context. A reflective plane
  // does not: the shelf, console, or wall beneath a display can move with
  // different parallax and pull its homography away from the physical bezel.
  var padRatio = reflective ? 0.02 : 0.22;
  var minimumPad = reflective ? 1 : 8;
  var padX = Math.max(minimumPad, bounds.width * width * padRatio);
  var padY = Math.max(minimumPad, bounds.height * height * padRatio);
  var left = clamp(bounds.x * width - padX, 0, width - 1);
  var top = clamp(bounds.y * height - padY, 0, height - 1);
  var right = clamp((bounds.x + bounds.width) * width + padX, left + 1, width);
  var bottom = clamp((bounds.y + bounds.height) * height + padY, top + 1, height);
  return {
    left: Math.floor(left),
    top: Math.floor(top),
    right: Math.ceil(right),
    bottom: Math.ceil(bottom)
  };
}

function normalizedFeatureProfile(value) {
  return String(value || '') === 'reflective-plane' ? 'reflective-plane' : 'default';
}

function excludeReflectiveInterior(mask, bounds, width, height) {
  bounds = normalizedBounds(bounds);
  if (bounds.width <= 0 || bounds.height <= 0) return;
  // Reflections and on-screen motion are not fixed object features. Preserve
  // the physical perimeter plus a wider bottom control strip, while excluding
  // both the changing glass interior and nearby furniture from planar tracking.
  // ORB needs more than a hairline bezel at low camera resolutions, so the
  // retained band extends inward while still remaining inside the TV bounds.
  var left = clamp((bounds.x + bounds.width * 0.18) * width, 0, width - 1);
  var top = clamp((bounds.y + bounds.height * 0.20) * height, 0, height - 1);
  var right = clamp((bounds.x + bounds.width * 0.82) * width, left + 1, width);
  var bottom = clamp((bounds.y + bounds.height * 0.72) * height, top + 1, height);
  cvRuntime.rectangle(
    mask,
    new cvRuntime.Point(Math.floor(left), Math.floor(top)),
    new cvRuntime.Point(Math.ceil(right), Math.ceil(bottom)),
    new cvRuntime.Scalar(0),
    -1
  );
}

function featureMask(bounds, width, height, useDepth, featureProfile, targetBounds) {
  featureProfile = normalizedFeatureProfile(featureProfile);
  var mask = cvRuntime.Mat.zeros(height, width, cvRuntime.CV_8UC1);
  var region = expandedPixelBounds(bounds, width, height, featureProfile);
  cvRuntime.rectangle(
    mask,
    new cvRuntime.Point(region.left, region.top),
    new cvRuntime.Point(region.right, region.bottom),
    new cvRuntime.Scalar(255),
    -1
  );
  // Monocular depth on glossy glass is useful as a geometry check, but not as
  // a feature-selection gate: reflections can be assigned another depth and
  // erase the physical bezel/context we actually want to retain.
  if (useDepth && featureProfile !== 'reflective-plane' && freshDepthField() && Number(depthField.confidence || 0) >= 0.25) {
    var tolerance = Math.max(0.08, Number(depthField.planeSpread || 0) * 2.5);
    var gridMask = new Uint8Array(depthField.width * depthField.height);
    for (var index = 0; index < gridMask.length; index += 1) {
      gridMask[index] = Math.abs(Number(depthField.values[index]) - depthField.targetDepth) <= tolerance ? 255 : 0;
    }
    var small = cvRuntime.matFromArray(depthField.height, depthField.width, cvRuntime.CV_8UC1, gridMask);
    var expanded = new cvRuntime.Mat();
    var gated = new cvRuntime.Mat();
    try {
      cvRuntime.resize(small, expanded, new cvRuntime.Size(width, height), 0, 0, cvRuntime.INTER_NEAREST);
      cvRuntime.bitwise_and(mask, expanded, gated);
      if (cvRuntime.countNonZero(gated) >= 64) {
        mask.delete();
        mask = gated;
        gated = null;
      }
    } finally {
      deleteAll([small, expanded, gated]);
    }
  }
  if (featureProfile === 'reflective-plane') {
    excludeReflectiveInterior(mask, targetBounds || bounds, width, height);
  }
  return mask;
}

function detectFeatures(gray, bounds, useDepth, featureProfile, targetBounds) {
  var mask = featureMask(bounds, gray.cols, gray.rows, useDepth, featureProfile, targetBounds);
  var keypoints = new cvRuntime.KeyPointVector();
  var descriptors = new cvRuntime.Mat();
  var normalizedSearch = normalizedBounds(bounds);
  var fullFrameSearch = normalizedSearch.width * normalizedSearch.height >= 0.8;
  // Full-frame reacquisition competes with every high-contrast edge in the
  // room (and any returned reflection). Spend the larger ORB budget only on
  // that bounded recovery path; steady-state target tracking stays lightweight.
  var orb = fullFrameSearch && normalizedFeatureProfile(featureProfile) === 'reflective-plane'
    ? new cvRuntime.ORB(1400)
    : new cvRuntime.ORB();
  try {
    orb.detectAndCompute(gray, mask, keypoints, descriptors);
  } finally {
    mask.delete();
    orb.delete();
  }
  return { keypoints: keypoints, descriptors: descriptors };
}

function detectGlobalFeatures(gray, featureProfile, targetBounds) {
  var mask = cvRuntime.Mat.zeros(gray.rows, gray.cols, cvRuntime.CV_8UC1);
  cvRuntime.rectangle(
    mask,
    new cvRuntime.Point(0, 0),
    new cvRuntime.Point(gray.cols, gray.rows),
    new cvRuntime.Scalar(255),
    -1
  );
  if (normalizedFeatureProfile(featureProfile) === 'reflective-plane') {
    excludeReflectiveInterior(mask, targetBounds, gray.cols, gray.rows);
  }
  var keypoints = new cvRuntime.KeyPointVector();
  var descriptors = new cvRuntime.Mat();
  // Global pose is desktop-side and infrequent relative to the planar loop.
  // A larger landmark budget keeps the physical room/perimeter represented
  // even when a reflective display contains many transient corners.
  var orb = normalizedFeatureProfile(featureProfile) === 'reflective-plane'
    ? new cvRuntime.ORB(1400)
    : new cvRuntime.ORB();
  try {
    orb.detectAndCompute(gray, mask, keypoints, descriptors);
  } finally {
    mask.delete();
    orb.delete();
  }
  return { keypoints: keypoints, descriptors: descriptors };
}

function cameraParameters(width, height) {
  var focal = Math.max(width, height) * 0.9;
  return { fx: focal, fy: focal, cx: width / 2, cy: height / 2 };
}

function backproject(point, z, camera, width, height) {
  var pixelX = Number(point.x) * width;
  var pixelY = Number(point.y) * height;
  return {
    x: (pixelX - camera.cx) / camera.fx * z,
    y: (pixelY - camera.cy) / camera.fy * z,
    z: z
  };
}

function worldPointAt(point, camera, width, height) {
  // Exact frame IDs pair this field with the retained reference pixels. Model
  // latency does not make that immutable geometry stale after inference ends.
  var z = depthAt(point, true);
  return z === null ? null : backproject(point, z, camera, width, height);
}

function poseReferenceGeometry(frame, camera) {
  var bounds = normalizedBounds(frame.bounds);
  var anchor = normalizedPoint(frame.anchor) || {
    x: bounds.x + bounds.width * 0.5,
    y: bounds.y + bounds.height * 0.88
  };
  var quad = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height }
  ];
  // Depth Anything normalizes the selected target median to Z=1. Keep the
  // reference corners on that canonical plane, but preserve the sampled
  // control depth when it is trustworthy. Controls on a front lip/button
  // plane otherwise accumulate visible parallax error during camera motion.
  var worldQuad = quad.map(function (point) {
    return backproject(point, 1, camera, frame.width, frame.height);
  });
  var sampledAnchorDepth = depthAt(anchor, true);
  var anchorDepth = normalizedFeatureProfile(frame.featureProfile) !== 'reflective-plane' &&
    Number(depthField.confidence || 0) >= 0.25 && sampledAnchorDepth !== null &&
    sampledAnchorDepth >= 0.5 && sampledAnchorDepth <= 1.5
    ? sampledAnchorDepth
    : 1;
  var worldAnchor = backproject(anchor, anchorDepth, camera, frame.width, frame.height);
  if (!worldAnchor || worldQuad.some(function (point) { return !point; })) return null;
  return { worldQuad: worldQuad, worldAnchor: worldAnchor };
}

function tryInitializePoseReference() {
  if (poseReference || !cvRuntime || !pendingPoseFrame || !usableDepthField()) return false;
  if (Number(pendingPoseFrame.frameId || 0) !== Number(depthField.frameId || 0)) return false;
  var gray = grayFromMessage(pendingPoseFrame);
  var featureProfile = normalizedFeatureProfile(pendingPoseFrame.featureProfile);
  var features = detectGlobalFeatures(gray, featureProfile, pendingPoseFrame.bounds);
  var camera = cameraParameters(pendingPoseFrame.width, pendingPoseFrame.height);
  var geometry = poseReferenceGeometry(pendingPoseFrame, camera);
  var objectPoints = [];
  try {
    if (!geometry || features.keypoints.size() < 20 || features.descriptors.empty()) return false;
    for (var index = 0; index < features.keypoints.size(); index += 1) {
      var pixel = features.keypoints.get(index).pt;
      var normalized = { x: pixel.x / pendingPoseFrame.width, y: pixel.y / pendingPoseFrame.height };
      var world = worldPointAt(normalized, camera, pendingPoseFrame.width, pendingPoseFrame.height);
      objectPoints.push(world);
    }
    poseReference = {
      descriptors: features.descriptors,
      objectPoints: objectPoints,
      worldQuad: geometry.worldQuad,
      worldAnchor: geometry.worldAnchor,
      width: pendingPoseFrame.width,
      height: pendingPoseFrame.height,
      frameId: Number(pendingPoseFrame.frameId || 0),
      featureProfile: featureProfile,
      cameraOrigin: null
    };
    features.descriptors = null;
    self.postMessage({
      type: 'pose-ready',
      anchorSpace: 'world-relative',
      worldAnchor: poseReference.worldAnchor,
      featureProfile: poseReference.featureProfile,
      featureCount: objectPoints.length,
      frameId: poseReference.frameId,
      capturedAt: Number(pendingPoseFrame.capturedAt || Date.now())
    });
    pendingPoseFrame = null;
    return true;
  } finally {
    deleteAll([gray, features.keypoints, features.descriptors]);
  }
}

function projectedWorldGeometry(projected, width, height) {
  var data = projected.data64F;
  if (!data || data.length < 10) return null;
  var quad = [];
  var minX = Infinity;
  var minY = Infinity;
  var maxX = -Infinity;
  var maxY = -Infinity;
  for (var index = 0; index < 4; index += 1) {
    var point = { x: data[index * 2] / width, y: data[index * 2 + 1] / height };
    if (!isFinite(point.x) || !isFinite(point.y)) return null;
    quad.push(point);
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  var anchor = { x: data[8] / width, y: data[9] / height };
  return {
    quad: quad,
    anchor: anchor,
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  };
}

function estimateWorldProjection(gray, message) {
  if (!poseReference) return rejectWorldProjection('pose-not-ready');
  poseDiagnostic = { attempted: true, accepted: false, reason: 'pose-started' };
  var referenceAspect = poseReference.width / poseReference.height;
  var currentAspect = message.width / message.height;
  if (Math.abs(referenceAspect - currentAspect) > 0.02) {
    return rejectWorldProjection('pose-aspect-mismatch');
  }
  var featureProfile = normalizedFeatureProfile(poseReference.featureProfile || message.featureProfile);
  var features = detectGlobalFeatures(gray, featureProfile, message.bounds || reference.bounds);
  var matcher = new cvRuntime.BFMatcher(cvRuntime.NORM_HAMMING, false);
  var matches = new cvRuntime.DMatchVectorVector();
  var objectCoordinates = [];
  var imageCoordinates = [];
  var objectMat = null;
  var imageMat = null;
  var cameraMat = null;
  var distortion = null;
  var rvec = null;
  var tvec = null;
  var inlierIndices = null;
  var worldGeometryMat = null;
  var projected = null;
  var reprojectedMatches = null;
  var rotation = null;
  try {
    if (features.keypoints.size() < 12 || features.descriptors.empty()) {
      return rejectWorldProjection('pose-insufficient-features', {
        featureCount: features.keypoints.size()
      });
    }
    matcher.knnMatch(poseReference.descriptors, features.descriptors, matches, 2);
    for (var index = 0; index < matches.size(); index += 1) {
      var pair = matches.get(index);
      if (pair.size() < 2) {
        pair.delete();
        continue;
      }
      var best = pair.get(0);
      var second = pair.get(1);
      var world = poseReference.objectPoints[best.queryIdx];
      if (world && best.distance < second.distance * 0.78 && best.distance < 76) {
        var image = features.keypoints.get(best.trainIdx).pt;
        objectCoordinates.push(world.x, world.y, world.z);
        imageCoordinates.push(image.x, image.y);
      }
      pair.delete();
    }
    var matchCount = objectCoordinates.length / 3;
    if (matchCount < 12) {
      return rejectWorldProjection('pose-insufficient-matches', {
        featureCount: features.keypoints.size(),
        matchCount: matchCount
      });
    }
    var camera = cameraParameters(message.width, message.height);
    objectMat = cvRuntime.matFromArray(matchCount, 1, cvRuntime.CV_64FC3, objectCoordinates);
    imageMat = cvRuntime.matFromArray(matchCount, 1, cvRuntime.CV_64FC2, imageCoordinates);
    cameraMat = cvRuntime.matFromArray(3, 3, cvRuntime.CV_64F, [
      camera.fx, 0, camera.cx,
      0, camera.fy, camera.cy,
      0, 0, 1
    ]);
    distortion = cvRuntime.Mat.zeros(1, 5, cvRuntime.CV_64F);
    rvec = cvRuntime.Mat.zeros(3, 1, cvRuntime.CV_64F);
    tvec = cvRuntime.Mat.zeros(3, 1, cvRuntime.CV_64F);
    inlierIndices = new cvRuntime.Mat();
    var solved = cvRuntime.solvePnPRansac(
      objectMat, imageMat, cameraMat, distortion, rvec, tvec,
      false, 100, Math.max(4, message.width * 0.012), 0.99, inlierIndices,
      cvRuntime.SOLVEPNP_ITERATIVE
    );
    var inliers = inlierIndices.rows;
    var inlierRatio = matchCount ? inliers / matchCount : 0;
    var confidence = clamp(Math.min(inlierRatio, inliers / 24, matchCount / 36), 0, 1);
    var poseFields = {
      featureCount: features.keypoints.size(),
      matchCount: matchCount,
      poseInliers: inliers,
      poseInlierRatio: inlierRatio,
      confidence: confidence
    };
    if (!solved) return rejectWorldProjection('pose-solve-failed', poseFields);
    if (inliers < 10) return rejectWorldProjection('pose-insufficient-inliers', poseFields);
    if (inlierRatio < 0.45) return rejectWorldProjection('pose-low-inlier-ratio', poseFields);
    if (confidence < 0.42) return rejectWorldProjection('pose-low-confidence', poseFields);
    reprojectedMatches = new cvRuntime.Mat();
    cvRuntime.projectPoints(objectMat, rvec, tvec, cameraMat, distortion, reprojectedMatches);
    var reprojectionData = reprojectedMatches.data64F;
    var inlierData = inlierIndices.data32S;
    var squaredError = 0;
    var minImageX = message.width;
    var minImageY = message.height;
    var maxImageX = 0;
    var maxImageY = 0;
    for (var inlierIndex = 0; inlierIndex < inliers; inlierIndex += 1) {
      var matchIndex = inlierData[inlierIndex];
      var errorX = reprojectionData[matchIndex * 2] - imageCoordinates[matchIndex * 2];
      var errorY = reprojectionData[matchIndex * 2 + 1] - imageCoordinates[matchIndex * 2 + 1];
      squaredError += errorX * errorX + errorY * errorY;
      minImageX = Math.min(minImageX, imageCoordinates[matchIndex * 2]);
      minImageY = Math.min(minImageY, imageCoordinates[matchIndex * 2 + 1]);
      maxImageX = Math.max(maxImageX, imageCoordinates[matchIndex * 2]);
      maxImageY = Math.max(maxImageY, imageCoordinates[matchIndex * 2 + 1]);
    }
    var reprojectionRMS = Math.sqrt(squaredError / Math.max(1, inliers));
    poseFields.reprojectionRMS = reprojectionRMS;
    if (reprojectionRMS > Math.max(4, message.width * 0.012)) {
      return rejectWorldProjection('pose-high-reprojection-error', poseFields);
    }
    if (maxImageX - minImageX < message.width * 0.12 || maxImageY - minImageY < message.height * 0.12) {
      return rejectWorldProjection('pose-clustered-inliers', poseFields);
    }
    var worldGeometry = poseReference.worldQuad.concat([poseReference.worldAnchor]);
    var coordinates = [];
    worldGeometry.forEach(function (point) { coordinates.push(point.x, point.y, point.z); });
    worldGeometryMat = cvRuntime.matFromArray(5, 1, cvRuntime.CV_64FC3, coordinates);
    projected = new cvRuntime.Mat();
    cvRuntime.projectPoints(worldGeometryMat, rvec, tvec, cameraMat, distortion, projected);
    var geometry = projectedWorldGeometry(projected, message.width, message.height);
    var visibility = geometryVisibility(geometry);
    if (!geometry || !convexQuad(geometry.quad) || !visibility.trackable) {
      poseFields.visibleFraction = visibility.visibleFraction;
      return rejectWorldProjection('pose-projection-not-visible', poseFields);
    }
    geometry.partialVisibility = visibility.partial;
    geometry.visibleFraction = visibility.visibleFraction;
    geometry.anchorVisible = visibility.anchorVisible;
    rotation = new cvRuntime.Mat();
    cvRuntime.Rodrigues(rvec, rotation);
    var matrix = rotation.data64F;
    var translation = tvec.data64F;
    if (!matrix || matrix.length < 9 || !translation || translation.length < 3) {
      return rejectWorldProjection('pose-invalid-transform', poseFields);
    }
    var cameraCenter = {
      x: -(matrix[0] * translation[0] + matrix[3] * translation[1] + matrix[6] * translation[2]),
      y: -(matrix[1] * translation[0] + matrix[4] * translation[1] + matrix[7] * translation[2]),
      z: -(matrix[2] * translation[0] + matrix[5] * translation[1] + matrix[8] * translation[2])
    };
    if (!poseReference.cameraOrigin) {
      poseReference.cameraOrigin = { x: cameraCenter.x, y: cameraCenter.y, z: cameraCenter.z };
    }
    var cameraDelta = {
      x: cameraCenter.x - poseReference.cameraOrigin.x,
      y: cameraCenter.y - poseReference.cameraOrigin.y,
      z: cameraCenter.z - poseReference.cameraOrigin.z
    };
    poseDiagnostic = Object.assign({}, poseFields, {
      attempted: true,
      accepted: true,
      reason: ''
    });
    return {
      geometry: geometry,
      confidence: confidence,
      featureCount: features.keypoints.size(),
      matchCount: matchCount,
      poseInliers: inliers,
      poseInlierRatio: inlierRatio,
      reprojectionRMS: reprojectionRMS,
      cameraPoseDelta: cameraDelta,
      worldAnchor: poseReference.worldAnchor
    };
  } finally {
    deleteAll([
      features.keypoints, features.descriptors, matcher, matches, objectMat, imageMat,
      cameraMat, distortion, rvec, tvec, inlierIndices, worldGeometryMat, projected,
      reprojectedMatches, rotation
    ]);
  }
}

function promotePlanarFallback(gray, message, geometry) {
  if (!gray || !geometry || !geometry.bounds || !Array.isArray(geometry.quad)) return false;
  var featureProfile = normalizedFeatureProfile(
    message.featureProfile || (reference && reference.featureProfile) ||
      (poseReference && poseReference.featureProfile)
  );
  var features = detectFeatures(gray, geometry.bounds, false, featureProfile, geometry.bounds);
  if (features.keypoints.size() < 12 || features.descriptors.empty()) {
    deleteAll([features.keypoints, features.descriptors]);
    return false;
  }
  resetReference();
  reference = {
    gray: null,
    keypoints: features.keypoints,
    descriptors: features.descriptors,
    bounds: geometry.bounds,
    quad: geometry.quad,
    width: message.width,
    height: message.height,
    anchor: geometry.anchor,
    featureProfile: featureProfile,
    pose: normalizedPose(message.pose)
  };
  return true;
}

function poseProjectionContinuous(geometry, previousBounds) {
  if (!geometry || !geometry.bounds) return false;
  var current = normalizedBounds(geometry.bounds);
  var previous = normalizedBounds(previousBounds);
  if (current.width <= 0 || current.height <= 0 || previous.width <= 0 || previous.height <= 0) return false;
  var currentCenterX = current.x + current.width / 2;
  var currentCenterY = current.y + current.height / 2;
  var previousCenterX = previous.x + previous.width / 2;
  var previousCenterY = previous.y + previous.height / 2;
  var maximumX = Math.max(0.08, previous.width * 0.35);
  var maximumY = Math.max(0.08, previous.height * 0.35);
  var widthLogDelta = Math.abs(Math.log(current.width / previous.width));
  var heightLogDelta = Math.abs(Math.log(current.height / previous.height));
  return Math.abs(currentCenterX - previousCenterX) <= maximumX &&
    Math.abs(currentCenterY - previousCenterY) <= maximumY &&
    widthLogDelta <= Math.log(1.5) && heightLogDelta <= Math.log(1.5);
}

function calibrate(message) {
  resetReference();
  resetRecoveryReference();
  var gray = grayFromMessage(message);
  var bounds = normalizedBounds(message.bounds);
  var featureProfile = normalizedFeatureProfile(message.featureProfile);
  planarLossFrames = 0;
  var features = detectFeatures(gray, bounds, true, featureProfile, bounds);
  var count = features.keypoints.size();
  if (count < 12 || features.descriptors.empty()) {
    deleteAll([gray, features.keypoints, features.descriptors]);
    self.postMessage({
      type: 'calibrated', accepted: false, bounds: bounds, featureCount: count,
      featureProfile: featureProfile,
      frameId: Number(message.frameId || 0), capturedAt: Number(message.capturedAt || Date.now())
    });
    return;
  }
  reference = {
    gray: gray,
    keypoints: features.keypoints,
    descriptors: features.descriptors,
    bounds: bounds,
    quad: [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      { x: bounds.x, y: bounds.y + bounds.height }
    ],
    width: message.width,
    height: message.height,
    anchor: normalizedPoint(message.anchor),
    featureProfile: featureProfile,
    pose: normalizedPose(message.pose)
  };
  // Keep one immutable, fully visible descriptor set for broad reacquisition.
  // The rolling reference can follow gradual pose changes; it must not become
  // the only route back after cropping, occlusion, or a large screen shift.
  var recoveryFeatures = detectFeatures(gray, bounds, true, featureProfile, bounds);
  if (recoveryFeatures.keypoints.size() >= 12 && !recoveryFeatures.descriptors.empty()) {
    recoveryReference = {
      keypoints: recoveryFeatures.keypoints,
      descriptors: recoveryFeatures.descriptors,
      bounds: bounds,
      quad: reference.quad.map(function (point) { return { x: point.x, y: point.y }; }),
      width: message.width,
      height: message.height,
      anchor: reference.anchor ? { x: reference.anchor.x, y: reference.anchor.y } : null,
      featureProfile: featureProfile,
      pose: normalizedPose(message.pose)
    };
  } else {
    deleteAll([recoveryFeatures.keypoints, recoveryFeatures.descriptors]);
  }
  var calibrationGeometry = { quad: reference.quad, anchor: reference.anchor };
  var depthAgreement = depthGeometryAgreement(calibrationGeometry);
  if (depthAgreement !== null && depthAgreement < 0.45) {
    resetReference();
    resetRecoveryReference();
    self.postMessage({
      type: 'calibrated', accepted: false, bounds: bounds, featureCount: count,
      featureProfile: featureProfile,
      reason: 'depth-plane-mismatch', frameId: Number(message.frameId || 0),
      capturedAt: Number(message.capturedAt || Date.now())
    });
    return;
  }
  self.postMessage({
    type: 'calibrated',
    accepted: true,
    bounds: bounds,
    confidence: 1,
    featureCount: count,
    featureProfile: featureProfile,
    inlierRatio: 1,
    depthAgreement: depthAgreement,
    fusionConfidence: depthAgreement === null ? 0 : Math.min(1, depthAgreement),
    frameId: Number(message.frameId || 0),
    capturedAt: Number(message.capturedAt || Date.now()),
    moved: false,
    quad: [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      { x: bounds.x, y: bounds.y + bounds.height }
    ],
    anchor: reference.anchor
  });
}

function pointAt(keypoints, index) {
  var point = keypoints.get(index).pt;
  return [point.x, point.y];
}

function projectedGeometry(homography, width, height, trackingReference) {
  trackingReference = trackingReference || reference;
  var bounds = trackingReference.bounds;
  var quad = trackingReference.quad || [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height }
  ];
  var coordinates = [];
  quad.forEach(function (point) {
    coordinates.push(point.x * trackingReference.width, point.y * trackingReference.height);
  });
  if (trackingReference.anchor) {
    coordinates.push(
      trackingReference.anchor.x * trackingReference.width,
      trackingReference.anchor.y * trackingReference.height
    );
  }
  var corners = cvRuntime.matFromArray(trackingReference.anchor ? 5 : 4, 1, cvRuntime.CV_32FC2, coordinates);
  var projected = new cvRuntime.Mat();
  cvRuntime.perspectiveTransform(corners, projected, homography);
  var data = projected.data32F;
  var quad = [];
  var minX = Infinity;
  var minY = Infinity;
  var maxX = -Infinity;
  var maxY = -Infinity;
  for (var index = 0; index < 4; index += 1) {
    var x = data[index * 2];
    var y = data[index * 2 + 1];
    quad.push({ x: x / width, y: y / height });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  var anchor = trackingReference.anchor ? {
    x: data[8] / width,
    y: data[9] / height
  } : null;
  deleteAll([corners, projected]);
  return {
    bounds: {
      x: minX / width,
      y: minY / height,
      width: (maxX - minX) / width,
      height: (maxY - minY) / height
    },
    quad: quad,
    anchor: anchor
  };
}

function convexQuad(quad) {
  if (!quad || quad.length !== 4) return false;
  var sign = 0;
  for (var index = 0; index < 4; index += 1) {
    var a = quad[index];
    var b = quad[(index + 1) % 4];
    var c = quad[(index + 2) % 4];
    var cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 0.000001) return false;
    var current = cross > 0 ? 1 : -1;
    if (sign && current !== sign) return false;
    sign = current;
  }
  return true;
}

function polygonArea(points) {
  if (!points || points.length < 3) return 0;
  var area = 0;
  for (var index = 0; index < points.length; index += 1) {
    var current = points[index];
    var next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

function clipPolygon(points, axis, boundary, keepGreater) {
  var clipped = [];
  if (!points.length) return clipped;
  for (var index = 0; index < points.length; index += 1) {
    var current = points[index];
    var previous = points[(index + points.length - 1) % points.length];
    var currentInside = keepGreater ? current[axis] >= boundary : current[axis] <= boundary;
    var previousInside = keepGreater ? previous[axis] >= boundary : previous[axis] <= boundary;
    if (currentInside !== previousInside) {
      var denominator = current[axis] - previous[axis];
      if (Math.abs(denominator) > 0.0000001) {
        var ratio = (boundary - previous[axis]) / denominator;
        clipped.push({
          x: axis === 'x' ? boundary : previous.x + (current.x - previous.x) * ratio,
          y: axis === 'y' ? boundary : previous.y + (current.y - previous.y) * ratio
        });
      }
    }
    if (currentInside) clipped.push({ x: current.x, y: current.y });
  }
  return clipped;
}

function clippedToViewport(points) {
  var clipped = clipPolygon(points, 'x', 0, true);
  clipped = clipPolygon(clipped, 'x', 1, false);
  clipped = clipPolygon(clipped, 'y', 0, true);
  return clipPolygon(clipped, 'y', 1, false);
}

function geometryInsideEnvelope(bounds, partialVisibility, trackingReference) {
  var anchor = (trackingReference || reference).bounds;
  var widthScale = bounds.width / anchor.width;
  var heightScale = bounds.height / anchor.height;
  var centerX = bounds.x + bounds.width / 2;
  var centerY = bounds.y + bounds.height / 2;
  var anchorCenterX = anchor.x + anchor.width / 2;
  var anchorCenterY = anchor.y + anchor.height / 2;
  return widthScale >= 0.65 && widthScale <= 1.55 &&
    heightScale >= 0.65 && heightScale <= 1.55 &&
    Math.abs(widthScale - heightScale) <= 0.16 &&
    Math.abs(centerX - anchorCenterX) <= (partialVisibility ? 0.55 : 0.16) &&
    Math.abs(centerY - anchorCenterY) <= (partialVisibility ? 0.55 : 0.16);
}

function geometryVisibility(geometry) {
  if (!geometry || !geometry.quad || geometry.quad.length !== 4) {
    return { trackable: false, partial: false, visibleFraction: 0, anchorVisible: false };
  }
  var minX = Infinity;
  var minY = Infinity;
  var maxX = -Infinity;
  var maxY = -Infinity;
  var partial = false;
  for (var index = 0; index < geometry.quad.length; index += 1) {
    var point = geometry.quad[index];
    if (!point || !isFinite(point.x) || !isFinite(point.y) ||
        point.x < -1 || point.x > 2 || point.y < -1 || point.y > 2) {
      return { trackable: false, partial: false, visibleFraction: 0, anchorVisible: false };
    }
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    partial = partial || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1;
  }
  var anchorVisible = !geometry.anchor || (
    isFinite(geometry.anchor.x) && isFinite(geometry.anchor.y) &&
    geometry.anchor.x >= 0 && geometry.anchor.x <= 1 &&
    geometry.anchor.y >= 0 && geometry.anchor.y <= 1
  );
  if (geometry.anchor && (!isFinite(geometry.anchor.x) || !isFinite(geometry.anchor.y) ||
      geometry.anchor.x < -1 || geometry.anchor.x > 2 ||
      geometry.anchor.y < -1 || geometry.anchor.y > 2)) {
    return { trackable: false, partial: partial, visibleFraction: 0, anchorVisible: false };
  }
  partial = partial || !anchorVisible;
  var fullWidth = maxX - minX;
  var fullHeight = maxY - minY;
  var fullArea = polygonArea(geometry.quad);
  var visibleArea = polygonArea(clippedToViewport(geometry.quad));
  var visibleFraction = fullArea > 0 ? clamp(visibleArea / fullArea, 0, 1) : 0;
  return {
    trackable: fullWidth > 0.01 && fullHeight > 0.01 &&
      visibleFraction >= 0.2 && visibleArea >= 0.006,
    partial: partial,
    visibleFraction: visibleFraction,
    visibleArea: visibleArea,
    anchorVisible: anchorVisible
  };
}

function track(message) {
  if (!reference) {
    self.postMessage({ type: 'lost', reason: 'not-calibrated', confidence: 0 });
    return;
  }
  var gray = grayFromMessage(message);
  var poseProjection = null;
  var broadPlanarRecovery = planarRecoveryFrames > 0;
  if (planarRecoveryFrames > 0) planarRecoveryFrames -= 1;
  try {
    poseProjection = estimateWorldProjection(gray, message);
  } catch (poseError) {
    // PnP is the depth-backed authority, but a malformed/degenerate solve must
    // degrade to the proven homography path instead of killing the worker.
    poseProjection = null;
    poseDiagnostic = {
      attempted: true,
      accepted: false,
      reason: 'pose-runtime-error',
      detail: String(poseError && poseError.message ? poseError.message : poseError || '')
    };
  }
  if (poseProjection && !poseProjectionContinuous(
    poseProjection.geometry,
    reference.bounds
  )) {
    broadPlanarRecovery = true;
    planarRecoveryFrames = Math.max(planarRecoveryFrames, 8);
    poseLocked = false;
    poseCandidateCount = 0;
    poseProjection = rejectWorldProjection('pose-discontinuous-projection', {
      matchCount: Number(poseProjection.matchCount || 0),
      poseInliers: Number(poseProjection.poseInliers || 0),
      poseInlierRatio: Number(poseProjection.poseInlierRatio || 0),
      reprojectionRMS: Number(poseProjection.reprojectionRMS || 0)
    });
  }
  if (poseProjection && !poseLocked) {
    poseCandidateCount += 1;
    if (poseCandidateCount < 2) {
      poseProjection = rejectWorldProjection('pose-awaiting-confirmation', {
        matchCount: Number(poseProjection.matchCount || 0),
        poseInliers: Number(poseProjection.poseInliers || 0),
        poseInlierRatio: Number(poseProjection.poseInlierRatio || 0),
        reprojectionRMS: Number(poseProjection.reprojectionRMS || 0)
      });
    } else {
      poseLocked = true;
    }
  } else if (!poseProjection && !poseLocked) {
    poseCandidateCount = 0;
  }
  if (!poseProjection && poseDiagnostic.attempted &&
      poseDiagnostic.reason !== 'pose-not-ready' &&
      poseDiagnostic.reason !== 'pose-aspect-mismatch' &&
      poseDiagnostic.reason !== 'pose-awaiting-confirmation') {
    broadPlanarRecovery = true;
    planarRecoveryFrames = Math.max(planarRecoveryFrames, 8);
  }
  if (poseProjection) {
    planarRecoveryFrames = 0;
    planarLossFrames = 0;
    var posePrevious = normalizedBounds(message.bounds || reference.bounds);
    var poseGeometry = poseProjection.geometry;
    var poseMoved = Math.abs(posePrevious.x - poseGeometry.bounds.x) > 0.002 ||
      Math.abs(posePrevious.y - poseGeometry.bounds.y) > 0.002 ||
      Math.abs(posePrevious.width - poseGeometry.bounds.width) > 0.002 ||
      Math.abs(posePrevious.height - poseGeometry.bounds.height) > 0.002;
    // A successful immutable world solve also refreshes the rolling planar
    // safety net. If PnP misses a later frame after camera motion, homography
    // now resumes from the newest trusted view instead of a stale startup view.
    var fallbackRefreshed = false;
    try {
      // A cropped view contains fewer physical landmarks. Keep the last full
      // reference for later reacquisition instead of replacing it with a
      // descriptor-starved sliver of the target.
      fallbackRefreshed = !poseGeometry.partialVisibility &&
        promotePlanarFallback(gray, message, poseGeometry);
    } catch (_fallbackRefreshError) {
      // The world solve remains valid. Keep the previous rolling reference
      // rather than turning an optional fallback refresh into worker failure.
      fallbackRefreshed = false;
    }
    self.postMessage({
      type: 'tracked',
      bounds: poseGeometry.bounds,
      quad: poseGeometry.quad,
      anchor: poseGeometry.anchor,
      confidence: poseProjection.confidence,
      moved: poseMoved,
      featureProfile: normalizedFeatureProfile(reference.featureProfile || message.featureProfile),
      featureCount: poseProjection.featureCount,
      matchCount: poseProjection.matchCount,
      inlierRatio: poseProjection.poseInlierRatio,
      poseInliers: poseProjection.poseInliers,
      poseInlierRatio: poseProjection.poseInlierRatio,
      reprojectionRMS: poseProjection.reprojectionRMS,
      anchorSpace: 'world-relative',
      worldAnchor: poseProjection.worldAnchor,
      cameraPoseDelta: poseProjection.cameraPoseDelta,
      poseAttempted: true,
      poseAccepted: true,
      poseFailureReason: '',
      partialVisibility: Boolean(poseGeometry.partialVisibility),
      visibleFraction: Number(poseGeometry.visibleFraction || 0),
      anchorVisible: Boolean(poseGeometry.anchorVisible),
      fallbackRefreshed: fallbackRefreshed,
      frameId: Number(message.frameId || 0),
      capturedAt: Number(message.capturedAt || Date.now())
    });
    gray.delete();
    return;
  }
  // A fast camera move can invalidate both the pose-continuity gate and the
  // narrow IMU-guided ROI while the target is still plainly visible. Search
  // one full frame for the existing descriptors; all ordinary inlier,
  // convexity, visibility, and calibrated-envelope checks still apply.
  var trackingReference = broadPlanarRecovery && recoveryReference && planarLossFrames >= 2
    ? recoveryReference
    : reference;
  var searchBounds = broadPlanarRecovery
    ? { x: 0, y: 0, width: 1, height: 1 }
    : poseGuidedBounds(trackingReference.bounds, trackingReference.pose, message.pose);
  var featureProfile = normalizedFeatureProfile(trackingReference.featureProfile || message.featureProfile);
  var features = detectFeatures(gray, searchBounds, false, featureProfile, reference.bounds);
  var matcher = new cvRuntime.BFMatcher(cvRuntime.NORM_HAMMING, false);
  var matches = new cvRuntime.DMatchVectorVector();
  var sourcePoints = [];
  var destinationPoints = [];
  var homography = null;
  var inlierMask = null;
  var sourceMat = null;
  var destinationMat = null;
  try {
    if (features.keypoints.size() < 8 || features.descriptors.empty()) {
      planarLossFrames += 1;
      self.postMessage({ type: 'lost', reason: 'insufficient-features', confidence: 0, featureProfile: featureProfile, featureCount: features.keypoints.size() });
      return;
    }
    matcher.knnMatch(trackingReference.descriptors, features.descriptors, matches, 2);
    for (var index = 0; index < matches.size(); index += 1) {
      var pair = matches.get(index);
      if (pair.size() < 2) {
        pair.delete();
        continue;
      }
      var best = pair.get(0);
      var second = pair.get(1);
      if (best.distance < second.distance * 0.76 && best.distance < 72) {
        var source = pointAt(trackingReference.keypoints, best.queryIdx);
        var destination = pointAt(features.keypoints, best.trainIdx);
        sourcePoints.push(source[0], source[1]);
        destinationPoints.push(destination[0], destination[1]);
      }
      pair.delete();
    }
    var matchCount = sourcePoints.length / 2;
    if (matchCount < 8) {
      planarLossFrames += 1;
      self.postMessage({ type: 'lost', reason: 'insufficient-matches', confidence: 0, featureProfile: featureProfile, featureCount: features.keypoints.size(), matchCount: matchCount });
      return;
    }
    sourceMat = cvRuntime.matFromArray(matchCount, 1, cvRuntime.CV_32FC2, sourcePoints);
    destinationMat = cvRuntime.matFromArray(matchCount, 1, cvRuntime.CV_32FC2, destinationPoints);
    inlierMask = new cvRuntime.Mat();
    homography = cvRuntime.findHomography(sourceMat, destinationMat, cvRuntime.RANSAC, 3, inlierMask);
    if (!homography || homography.empty()) {
      planarLossFrames += 1;
      self.postMessage({ type: 'lost', reason: 'homography-failed', confidence: 0, featureProfile: featureProfile, matchCount: matchCount });
      return;
    }
    var inliers = 0;
    for (var maskIndex = 0; maskIndex < inlierMask.rows; maskIndex += 1) {
      if (inlierMask.ucharAt(maskIndex, 0)) inliers += 1;
    }
    var inlierRatio = matchCount ? inliers / matchCount : 0;
    var geometry = projectedGeometry(homography, message.width, message.height, trackingReference);
    var confidence = clamp(Math.min(inlierRatio, inliers / 18, matchCount / 28), 0, 1);
    var visibility = geometryVisibility(geometry);
    // A bounded full-frame recovery is specifically for the case where the
    // phone returns with the target at a different screen position. Preserve
    // the strict scale/aspect gates, but use the wider center envelope already
    // allowed for cropped geometry; otherwise we find the correct target and
    // reject it solely for moving more than 16% across the viewport.
    var accepted = inliers >= 8 && confidence >= 0.45 && inlierRatio >= 0.48 &&
      convexQuad(geometry.quad) && visibility.trackable &&
      geometryInsideEnvelope(
        geometry.bounds,
        visibility.partial || broadPlanarRecovery,
        trackingReference
      );
    if (!accepted) {
      planarLossFrames += 1;
      self.postMessage({
        type: 'lost',
        reason: visibility.trackable ? 'unstable-geometry' : 'projection-below-visible-floor',
        confidence: confidence,
        featureProfile: featureProfile,
        featureCount: features.keypoints.size(),
        matchCount: matchCount,
        inlierRatio: inlierRatio
      });
      return;
    }
    geometry.partialVisibility = visibility.partial;
    geometry.visibleFraction = visibility.visibleFraction;
    geometry.anchorVisible = visibility.anchorVisible;
    planarRecoveryFrames = 0;
    planarLossFrames = 0;
    var previous = normalizedBounds(message.bounds || reference.bounds);
    var moved = Math.abs(previous.x - geometry.bounds.x) > 0.002 ||
      Math.abs(previous.y - geometry.bounds.y) > 0.002 ||
      Math.abs(previous.width - geometry.bounds.width) > 0.002 ||
      Math.abs(previous.height - geometry.bounds.height) > 0.002;
    self.postMessage({
      type: 'tracked',
      bounds: geometry.bounds,
      quad: geometry.quad,
      anchor: geometry.anchor,
      confidence: confidence,
      moved: moved,
      featureProfile: featureProfile,
      featureCount: features.keypoints.size(),
      matchCount: matchCount,
      inlierRatio: inlierRatio,
      partialVisibility: Boolean(geometry.partialVisibility),
      visibleFraction: Number(geometry.visibleFraction || 0),
      anchorVisible: Boolean(geometry.anchorVisible),
      poseAttempted: Boolean(poseDiagnostic.attempted),
      poseAccepted: false,
      poseFailureReason: String(poseDiagnostic.reason || 'pose-rejected'),
      poseMatchCount: Number(poseDiagnostic.matchCount || 0),
      poseInliers: Number(poseDiagnostic.poseInliers || 0),
      poseInlierRatio: Number(poseDiagnostic.poseInlierRatio || 0),
      poseReprojectionRMS: isFinite(Number(poseDiagnostic.reprojectionRMS))
        ? Number(poseDiagnostic.reprojectionRMS)
        : null,
      frameId: Number(message.frameId || 0),
      capturedAt: Number(message.capturedAt || Date.now())
    });
    // Re-extract the rolling reference from the trusted target neighborhood.
    // A broad recovery may have searched the entire room; promoting that full
    // frame would make the next solve depend on unrelated scene features and,
    // for displays, could reintroduce the changing reflective interior.
    if (!geometry.partialVisibility) promotePlanarFallback(gray, message, geometry);
  } finally {
    deleteAll([gray, features.keypoints, features.descriptors, matcher, matches, sourceMat, destinationMat, inlierMask, homography]);
  }
}

function initialize(runtimeURL) {
  if (runtimeLoading || cvRuntime) return;
  runtimeLoading = true;
  try {
    importScripts(runtimeURL);
    var loaded = self.cv;
    var ready = function () {
      cvRuntime = loaded;
      runtimeLoading = false;
      self.postMessage({ type: 'ready', version: '5.0.0' });
      tryInitializePoseReference();
    };
    if (loaded && loaded.Mat && loaded.calledRun) {
      ready();
    } else if (loaded) {
      var previousReady = loaded.onRuntimeInitialized;
      loaded.onRuntimeInitialized = function () {
        if (typeof previousReady === 'function') previousReady();
        ready();
      };
    } else {
      throw new Error('OpenCV did not expose its runtime');
    }
  } catch (_error) {
    runtimeLoading = false;
    self.postMessage({
      type: 'error',
      reason: 'opencv-load-failed',
      detail: String(_error && _error.message ? _error.message : _error || '')
    });
  }
}

self.onmessage = function (event) {
  var message = event.data || {};
  if (message.type === 'init') {
    initialize(message.runtimeURL);
    return;
  }
  if (message.type === 'reset') {
    resetReference();
    resetRecoveryReference();
    resetPoseReference();
    depthField = null;
    return;
  }
  if (message.type === 'pose-frame') {
    if (!poseReference && message.pixels instanceof ArrayBuffer && Number(message.width) > 0 && Number(message.height) > 0) {
      pendingPoseFrame = message;
      tryInitializePoseReference();
    }
    return;
  }
  if (message.type === 'depth-field') {
    var values = message.grid instanceof ArrayBuffer ? new Float32Array(message.grid) : null;
    if (values && Number(message.gridWidth) > 0 && Number(message.gridHeight) > 0) {
      depthField = {
        values: values,
        width: Number(message.gridWidth),
        height: Number(message.gridHeight),
        targetDepth: clamp(message.targetDepth || 1, 0.25, 4),
        confidence: clamp(message.confidence, 0, 1),
        planeSpread: clamp(message.planeSpread, 0, 1),
        frameId: Number(message.frameId || 0),
        capturedAt: Number(message.capturedAt || Date.now())
      };
      tryInitializePoseReference();
    }
    return;
  }
  if (!cvRuntime) {
    self.postMessage({ type: 'error', reason: 'opencv-not-ready' });
    return;
  }
  try {
    if (message.type === 'calibrate') calibrate(message);
    else if (message.type === 'track') track(message);
  } catch (_error) {
    self.postMessage({
      type: 'error',
      reason: 'opencv-runtime-error',
      detail: String(_error && _error.message ? _error.message : _error || '')
    });
  }
};
