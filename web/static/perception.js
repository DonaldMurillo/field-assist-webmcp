(function (global) {
  'use strict';

  var ASSET_ROOT = '/__gofastr/plugin/field-assist';
  var OPENCV_WORKER_URL = ASSET_ROOT + '/opencv-worker.js';
  var DEPTH_WORKER_URL = ASSET_ROOT + '/depth-worker.js';
  var OPENCV_RUNTIME_URL = ASSET_ROOT + '/runtime/opencv.js';
  var RUNTIME_ROOT = ASSET_ROOT + '/runtime';
  var MODEL_ROOT = ASSET_ROOT + '/model/onnx';

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

  function visibleBounds(bounds) {
    bounds = bounds || {};
    var left = clamp(bounds.x, 0, 1);
    var top = clamp(bounds.y, 0, 1);
    var right = clamp(Number(bounds.x || 0) + Number(bounds.width || 0), 0, 1);
    var bottom = clamp(Number(bounds.y || 0) + Number(bounds.height || 0), 0, 1);
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };
  }

  function quadArea(quad) {
    if (!Array.isArray(quad) || quad.length !== 4) return 0;
    var area = 0;
    for (var index = 0; index < quad.length; index += 1) {
      var current = quad[index] || {};
      var next = quad[(index + 1) % quad.length] || {};
      area += Number(current.x || 0) * Number(next.y || 0) - Number(next.x || 0) * Number(current.y || 0);
    }
    return Math.abs(area) / 2;
  }

  function depthGridAt(field, point) {
    if (!field || !field.values || !point) return null;
    if (!isFinite(Number(point.x)) || !isFinite(Number(point.y)) ||
        Number(point.x) < 0 || Number(point.x) > 1 || Number(point.y) < 0 || Number(point.y) > 1) return null;
    var x = clamp(Math.round(Number(point.x) * (field.width - 1)), 0, field.width - 1);
    var y = clamp(Math.round(Number(point.y) * (field.height - 1)), 0, field.height - 1);
    var value = Number(field.values[y * field.width + x]);
    return isFinite(value) ? value : null;
  }

  function depthQuadAgreement(field, quad) {
    if (!field || !Array.isArray(quad) || quad.length !== 4) return null;
    var center = quad.reduce(function (result, point) {
      result.x += Number(point.x || 0) / quad.length;
      result.y += Number(point.y || 0) / quad.length;
      return result;
    }, { x: 0, y: 0 });
    var points = [center].concat(quad.map(function (point) {
      return { x: Number(point.x) * 0.7 + center.x * 0.3, y: Number(point.y) * 0.7 + center.y * 0.3 };
    }));
    var tolerance = Math.max(0.08, Number(field.planeSpread || 0) * 2.5);
    var agreements = points.map(function (point) {
      var value = depthGridAt(field, point);
      return value === null ? null : clamp(1 - Math.abs(value - field.targetDepth) / tolerance, 0, 1);
    }).filter(function (value) { return value !== null; });
    if (!agreements.length) return null;
    return agreements.reduce(function (sum, value) { return sum + value; }, 0) / agreements.length;
  }

  function PerceptionEngine(video, onResult, onStatus, options) {
    this.video = video;
    this.onResult = onResult || function () {};
    this.onStatus = onStatus || function () {};
    this.options = options || {};
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.depthCanvas = document.createElement('canvas');
    this.depthContext = this.depthCanvas.getContext('2d', { willReadFrequently: true });
    this.openCVWorker = null;
    this.depthWorker = null;
    this.openCVReady = false;
    this.openCVCalibrated = false;
    this.openCVInFlight = false;
    this.openCVFailed = false;
    this.openCVCalibrationFailures = 0;
    this.nextOpenCVCalibrationAt = 0;
    this.openCVFrameID = 0;
    this.depthReady = false;
    this.depthModel = '';
    this.depthInFlight = false;
    this.depthFailed = false;
    this.depthStarted = false;
    this.lastDepthAt = 0;
    this.depthFrameID = 0;
    this.latestDepth = null;
    this.latestPose = null;
    this.fusionReferenceQuad = null;
    this.depthMismatchCount = 0;
    this.fusionActive = false;
    this.fusionValidUntil = 0;
    this.fusionRejected = false;
    this.openCVHistory = [];
    this.openCVLossCount = 0;
    this.openCVLost = false;
    this.poseReady = false;
    this.poseActive = false;
    this.poseFailureReason = '';
    this.active = false;
    this.anchor = null;
    this.anchorPoint = null;
    this.currentAnchor = null;
    this.bounds = null;
    this.featureProfile = 'default';
    this.status = { state: 'idle', source: 'calibrated-region', label: 'Spatial perception idle', reason: '' };
    this.testConfig = global.__fieldAssistPerceptionE2E || null;
    this.testIndex = 0;
  }

  PerceptionEngine.prototype.updateStatus = function (state, source, label, reason) {
    this.status = {
      state: state,
      source: source,
      label: label,
      reason: reason || ''
    };
    this.onStatus(this.status);
  };

  PerceptionEngine.prototype.start = function (bounds, anchorPoint, featureProfile) {
    this.active = true;
    this.featureProfile = String(featureProfile || 'default') === 'reflective-plane'
      ? 'reflective-plane'
      : 'default';
    this.anchor = normalizedBounds(bounds);
    this.anchorPoint = anchorPoint && isFinite(Number(anchorPoint.x)) && isFinite(Number(anchorPoint.y))
      ? { x: clamp(anchorPoint.x, 0, 1), y: clamp(anchorPoint.y, 0, 1) }
      : null;
    this.bounds = normalizedBounds(bounds);
    this.latestDepth = null;
    this.lastDepthAt = 0;
    this.testIndex = 0;
    this.openCVCalibrationFailures = 0;
    this.nextOpenCVCalibrationAt = 0;
    this.openCVFrameID = 0;
    this.fusionReferenceQuad = null;
    this.depthMismatchCount = 0;
    this.fusionActive = false;
    this.fusionValidUntil = 0;
    this.fusionRejected = false;
    this.openCVHistory = [];
    this.currentAnchor = this.anchorPoint;
    this.openCVLossCount = 0;
    this.openCVLost = false;
    this.poseReady = false;
    this.poseActive = false;
    this.poseFailureReason = '';

    if (this.testConfig) {
      if (this.testConfig.mode === 'opencv-unavailable') {
        this.openCVFailed = true;
        this.updateStatus('fallback', 'browser-multiscale-template', 'OpenCV unavailable · using browser fallback', 'opencv-unavailable');
        return;
      }
      if (this.testConfig.mode === 'depth-model-failure') {
        this.openCVReady = true;
        this.openCVCalibrated = false;
        this.depthFailed = true;
        this.updateStatus('fallback', 'opencv-homography', 'OpenCV ready · depth model unavailable', 'model-load-failed');
        return;
      }
      if (this.testConfig.mode === 'mock-ready') {
        this.openCVReady = true;
        this.openCVCalibrated = true;
        this.depthReady = this.options.depth !== false;
        this.updateStatus('ready', this.depthReady ? 'opencv-depth-anything' : 'opencv-homography',
          this.depthReady ? 'OpenCV + Depth Anything ready' : 'Phone-local spatial anchor ready');
        return;
      }
    }

    if (typeof Worker !== 'function' || typeof WebAssembly !== 'object') {
      this.openCVFailed = true;
      this.updateStatus('fallback', 'browser-multiscale-template', 'Advanced perception unavailable · using browser fallback', 'opencv-unavailable');
      return;
    }
    this.ensureOpenCVWorker();
    this.updateStatus('loading', 'calibrated-region', 'Loading OpenCV spatial tracker');
  };

  PerceptionEngine.prototype.recalibrate = function (bounds, anchorPoint) {
    if (!this.active || this.openCVFailed) return false;
    this.anchor = normalizedBounds(bounds);
    this.bounds = normalizedBounds(bounds);
    this.anchorPoint = anchorPoint && isFinite(Number(anchorPoint.x)) && isFinite(Number(anchorPoint.y))
      ? { x: clamp(anchorPoint.x, 0, 1), y: clamp(anchorPoint.y, 0, 1) }
      : this.anchorPoint;
    this.openCVCalibrated = false;
    this.openCVCalibrationFailures = 0;
    this.nextOpenCVCalibrationAt = 0;
    this.openCVFrameID = 0;
    this.latestDepth = null;
    this.fusionReferenceQuad = null;
    this.depthMismatchCount = 0;
    this.fusionActive = false;
    this.fusionValidUntil = 0;
    this.fusionRejected = false;
    this.openCVHistory = [];
    this.currentAnchor = this.anchorPoint;
    this.openCVLossCount = 0;
    this.openCVLost = false;
    this.poseReady = false;
    this.poseActive = false;
    this.poseFailureReason = '';
    if (this.openCVWorker) this.openCVWorker.postMessage({ type: 'reset' });
    if (this.depthWorker) this.depthWorker.postMessage({ type: 'reset' });
    this.updateStatus('loading', 'opencv-homography', 'Reacquiring target with OpenCV');
    return true;
  };

  PerceptionEngine.prototype.updatePose = function (pose) {
    if (!pose || !isFinite(Number(pose.alpha)) || !isFinite(Number(pose.beta)) || !isFinite(Number(pose.gamma))) return false;
    this.latestPose = {
      alpha: Number(pose.alpha),
      beta: Number(pose.beta),
      gamma: Number(pose.gamma),
      at: Number(pose.at || Date.now())
    };
    return true;
  };

  PerceptionEngine.prototype.ensureOpenCVWorker = function () {
    if (this.openCVWorker || this.openCVFailed) return;
    var self = this;
    try {
      this.openCVWorker = new Worker(OPENCV_WORKER_URL);
      this.openCVWorker.onmessage = function (event) { self.handleOpenCVMessage(event.data || {}); };
      this.openCVWorker.onerror = function () { self.failOpenCV('opencv-load-failed'); };
      this.openCVWorker.postMessage({ type: 'init', runtimeURL: OPENCV_RUNTIME_URL });
    } catch (_error) {
      this.failOpenCV('opencv-unavailable');
    }
  };

  PerceptionEngine.prototype.ensureDepthWorker = function () {
    if (this.depthWorker || this.depthFailed || this.depthStarted) return;
    var self = this;
    this.depthStarted = true;
    try {
      this.depthWorker = new Worker(DEPTH_WORKER_URL, { type: 'module' });
      this.depthWorker.onmessage = function (event) { self.handleDepthMessage(event.data || {}); };
      this.depthWorker.onerror = function () { self.failDepth('model-load-failed'); };
      this.depthWorker.postMessage({
        type: 'init',
        webGPURuntimeURL: RUNTIME_ROOT + '/ort.webgpu.min.mjs',
        wasmRuntimeURL: RUNTIME_ROOT + '/ort.wasm.min.mjs',
        webGPUModelURL: MODEL_ROOT + '/model_q4f16.onnx',
        wasmModelURL: MODEL_ROOT + '/model_int8.onnx',
        runtimeRoot: RUNTIME_ROOT,
        preferWebGPU: Boolean(navigator && navigator.gpu)
      });
    } catch (_error) {
      this.failDepth('onnx-unavailable');
    }
  };

  PerceptionEngine.prototype.failOpenCV = function (reason) {
    this.openCVFailed = true;
    this.openCVReady = false;
    this.openCVCalibrated = false;
    this.openCVInFlight = false;
    if (this.openCVWorker) this.openCVWorker.terminate();
    this.openCVWorker = null;
    this.updateStatus('fallback', 'browser-multiscale-template', 'OpenCV unavailable · using browser fallback', reason || 'opencv-load-failed');
  };

  PerceptionEngine.prototype.failDepth = function (reason) {
    this.depthFailed = true;
    this.depthReady = false;
    this.depthInFlight = false;
    if (this.depthWorker) this.depthWorker.terminate();
    this.depthWorker = null;
    this.updateStatus('fallback', 'opencv-homography', 'OpenCV tracking ready · depth model unavailable', reason || 'model-load-failed');
  };

  PerceptionEngine.prototype.handleOpenCVMessage = function (message) {
    if (message.type === 'ready') {
      this.openCVReady = true;
      this.updateStatus('loading', 'opencv-homography', 'OpenCV ready · calibrating target');
      if (this.options.depth !== false) this.ensureDepthWorker();
      return;
    }
    if (message.type === 'error') {
      this.failOpenCV(message.reason || 'opencv-runtime-error');
      return;
    }
    if (message.type === 'pose-ready') {
      this.poseReady = true;
      this.updateReadyStatus();
      return;
    }
    if (message.type === 'calibrated') {
      this.openCVInFlight = false;
      if (!message.accepted) {
        this.openCVCalibrated = false;
        this.openCVCalibrationFailures += 1;
        if (this.options.depth !== false && !this.depthFailed) {
          this.latestDepth = null;
          this.lastDepthAt = 0;
          if (this.depthWorker) this.depthWorker.postMessage({ type: 'reset' });
        }
        this.nextOpenCVCalibrationAt = Date.now() + Math.min(
          2000,
          400 * Math.pow(2, Math.min(3, this.openCVCalibrationFailures - 1))
        );
        this.updateStatus(
          'fallback',
          'browser-multiscale-template',
          'Waiting for a clear target · using browser fallback',
          'insufficient-features'
        );
        return;
      }
      this.openCVCalibrationFailures = 0;
      this.nextOpenCVCalibrationAt = 0;
      this.openCVCalibrated = true;
      this.openCVLossCount = 0;
      this.openCVLost = false;
      this.bounds = normalizedBounds(message.bounds || this.bounds);
      if (message.anchor) this.currentAnchor = normalizedPoint(message.anchor);
      if (Array.isArray(message.quad) && message.quad.length === 4) this.fusionReferenceQuad = message.quad;
      this.openCVHistory.push(Object.assign({}, message));
      // The first released Depth Anything inference can exceed five seconds on
      // real desktop hardware. Retain enough lightweight geometry summaries to
      // validate the delayed result against its capture-time OpenCV frame.
      this.openCVHistory = this.openCVHistory.slice(-64);
      this.updateReadyStatus();
      this.emitResult(message);
      return;
    }
    if (message.type === 'tracked' || message.type === 'lost') {
      this.openCVInFlight = false;
      if (message.poseAttempted && !message.poseAccepted) {
        this.poseFailureReason = String(message.poseFailureReason || 'pose-rejected');
      } else if (message.poseAccepted) {
        this.poseFailureReason = '';
      }
      if (message.type === 'lost') {
        this.openCVLossCount += 1;
        // A single out-of-frame projection is especially common on glossy
        // displays: one frame can lose the bezel while the next frame has a
        // strong planar or world solve. Keep the existing reference alive for
        // every transient loss reason so Canvas cannot reset OpenCV recovery.
        if (this.openCVLossCount < 3) {
          this.updateStatus(
            'ready',
            this.poseReady ? 'opencv-pnp+depth-anything' : 'opencv-homography',
            'Holding spatial anchor · checking next frame',
            message.reason || 'transient-tracking-loss'
          );
          return;
        }
        this.openCVLost = true;
      } else {
        this.openCVLossCount = 0;
        this.openCVLost = false;
      }
      if (message.type === 'tracked' && message.bounds) {
        this.bounds = message.partialVisibility ? visibleBounds(message.bounds) : normalizedBounds(message.bounds);
      }
      if (message.type === 'tracked' && message.anchor && message.anchorVisible !== false) {
        this.currentAnchor = normalizedPoint(message.anchor);
      }
      if (message.type === 'tracked' && Array.isArray(message.quad) && message.quad.length === 4) {
        this.openCVHistory.push(Object.assign({}, message));
        this.openCVHistory = this.openCVHistory.slice(-64);
      }
      this.emitResult(message);
    }
  };

  PerceptionEngine.prototype.handleDepthMessage = function (message) {
    if (message.type === 'ready') {
      this.depthReady = true;
      this.depthFailed = false;
      this.depthModel = String(message.model || 'depth-anything-v2-small-int8');
      this.updateReadyStatus();
      return;
    }
    if (message.type === 'error') {
      this.failDepth(message.reason || 'model-load-failed');
      return;
    }
    if (message.type === 'depth') {
      this.depthInFlight = false;
      this.fusionActive = false;
      var field = null;
      if (message.grid instanceof ArrayBuffer && Number(message.gridWidth) > 0 && Number(message.gridHeight) > 0) {
        field = {
          values: new Float32Array(message.grid.slice(0)),
          width: Number(message.gridWidth),
          height: Number(message.gridHeight),
          targetDepth: clamp(message.targetDepth || 1, 0.25, 4),
          planeSpread: clamp(message.planeSpread, 0, 1)
        };
      }
      this.latestDepth = {
        score: clamp(message.score, 0, 1),
        confidence: clamp(message.confidence, 0, 1),
        relativeDepth: clamp(message.relativeDepth || 1, 0.25, 4),
        planeSpread: clamp(message.planeSpread, 0, 1),
        source: String(message.model || this.depthModel || 'depth-anything-v2-small-int8'),
        capturedAt: Number(message.capturedAt || Date.now()),
        at: Date.now()
      };
      var nearest = null;
      var nearestDelta = Infinity;
      if (field) {
        this.openCVHistory.forEach(function (candidate) {
          var delta = Math.abs(Number(candidate.capturedAt || 0) - Number(message.capturedAt || 0));
          if (delta < nearestDelta) {
            nearest = candidate;
            nearestDelta = delta;
          }
        });
      }
      var validationMessage = null;
      if (nearest && nearestDelta <= 250 && Array.isArray(nearest.quad)) {
        validationMessage = Object.assign({}, nearest, {
          depthAgreement: depthQuadAgreement(field, nearest.quad),
          fusionConfidence: Math.min(Number(nearest.confidence || 0), this.latestDepth.confidence),
          depthValidation: true
        });
      }
      if (this.openCVWorker && message.grid instanceof ArrayBuffer &&
          Number(message.gridWidth) > 0 && Number(message.gridHeight) > 0) {
        this.openCVWorker.postMessage({
          type: 'depth-field',
          grid: message.grid,
          gridWidth: Number(message.gridWidth),
          gridHeight: Number(message.gridHeight),
          targetDepth: clamp(message.targetDepth || 1, 0.25, 4),
          confidence: this.latestDepth.confidence,
          planeSpread: this.latestDepth.planeSpread,
          frameId: Number(message.frameId || 0),
          capturedAt: Number(message.capturedAt || this.latestDepth.at)
        }, [message.grid]);
      }
      if (validationMessage && !this.openCVLost) this.emitResult(validationMessage);
      else this.updateReadyStatus();
    }
  };

  PerceptionEngine.prototype.updateReadyStatus = function () {
    if (!this.openCVCalibrated || this.openCVLost) return;
    if (this.poseActive) {
      this.updateStatus('ready', 'opencv-pnp+depth-anything', 'World-relative anchor locked');
    } else if (this.options.depth === false) {
      this.updateStatus('ready', 'opencv-homography', 'Phone-local spatial anchor ready');
    } else if (this.depthReady && this.latestDepth && this.fusionActive) {
      this.updateStatus('ready', 'opencv-depth-anything', 'OpenCV anchor · Depth Anything active');
    } else if (this.depthReady) {
      this.updateStatus(
        'loading',
        'opencv-homography',
        this.poseReady ? 'Tracking object plane · world pose reacquiring' : 'OpenCV locked · validating depth plane',
        this.poseReady ? this.poseFailureReason : ''
      );
    } else if (this.depthFailed) {
      this.updateStatus('fallback', 'opencv-homography', 'OpenCV tracking ready · depth model unavailable', 'model-load-failed');
    } else {
      this.updateStatus('loading', 'opencv-homography', 'OpenCV locked · loading Depth Anything');
    }
  };

  PerceptionEngine.prototype.emitResult = function (message) {
    if (!this.active) return;
    var result = {
      bounds: message.partialVisibility
        ? visibleBounds(message.bounds || this.bounds || this.anchor)
        : normalizedBounds(message.bounds || this.bounds || this.anchor),
      quad: Array.isArray(message.quad) ? message.quad : null,
      anchor: message.type === 'lost' || Boolean(message.lost) ? null : (message.anchorVisible !== false && message.anchor &&
        isFinite(Number(message.anchor.x)) && isFinite(Number(message.anchor.y))
        ? { x: clamp(message.anchor.x, 0, 1), y: clamp(message.anchor.y, 0, 1) }
        : this.anchorPoint),
      confidence: clamp(message.confidence, 0, 1),
      moved: Boolean(message.moved),
      lost: message.type === 'lost' || Boolean(message.lost),
      recalibrationRequired: Boolean(message.recalibrationRequired),
      source: 'opencv-homography',
      featureProfile: this.featureProfile,
      featureCount: Number(message.featureCount || 0),
      inlierRatio: clamp(message.inlierRatio, 0, 1),
      depthAgreement: isFinite(Number(message.depthAgreement)) ? clamp(message.depthAgreement, 0, 1) : null,
      fusionConfidence: isFinite(Number(message.fusionConfidence)) ? clamp(message.fusionConfidence, 0, 1) : null
    };
    result.partialVisibility = Boolean(message.partialVisibility);
    result.visibleFraction = result.partialVisibility ? clamp(message.visibleFraction, 0, 1) : 1;
    result.anchorVisible = message.anchorVisible !== false;
    if (!result.anchorVisible) result.anchor = null;
    if (message.poseAttempted) {
      result.poseAttempted = true;
      result.poseAccepted = Boolean(message.poseAccepted);
      result.poseFailureReason = String(message.poseFailureReason || '');
      result.poseMatchCount = Number(message.poseMatchCount || message.matchCount || 0);
      result.poseInliers = Number(message.poseInliers || 0);
      result.poseInlierRatio = clamp(message.poseInlierRatio, 0, 1);
      result.poseReprojectionRMS = isFinite(Number(message.poseReprojectionRMS))
        ? Number(message.poseReprojectionRMS)
        : null;
    }
    if (message.anchorSpace === 'world-relative' && message.worldAnchor && message.cameraPoseDelta) {
      result.source = 'opencv-pnp+depth-anything';
      result.anchorSpace = 'world-relative';
      result.worldAnchor = {
        x: Number(message.worldAnchor.x),
        y: Number(message.worldAnchor.y),
        z: Number(message.worldAnchor.z)
      };
      result.cameraPoseDelta = {
        x: Number(message.cameraPoseDelta.x),
        y: Number(message.cameraPoseDelta.y),
        z: Number(message.cameraPoseDelta.z)
      };
      result.poseInliers = Number(message.poseInliers || 0);
      result.poseInlierRatio = clamp(message.poseInlierRatio, 0, 1);
    }
    result.poseState = result.source === 'opencv-pnp+depth-anything'
      ? 'active'
      : (this.poseReady ? 'degraded' : 'unavailable');
    if (result.poseState === 'degraded' && !result.poseFailureReason) {
      result.poseFailureReason = this.poseFailureReason || 'pose-rejected';
    }
    // PnP keeps using the immutable depth-backed reference after the live
    // depth-validation TTL expires. Preserve the model evidence on those
    // results so transport does not misclassify valid world pose as plain CV.
    if (this.latestDepth && (result.source === 'opencv-pnp+depth-anything' ||
        Date.now() - this.latestDepth.at < 8000)) {
      result.depthScore = this.latestDepth.score;
      result.depthConfidence = this.latestDepth.confidence;
      result.depthRelative = this.latestDepth.relativeDepth;
      result.depthSource = this.latestDepth.source;
      var referenceArea = quadArea(this.fusionReferenceQuad);
      var currentArea = quadArea(result.quad);
      var imageScale = referenceArea > 0 && currentArea > 0 ? Math.sqrt(currentArea / referenceArea) : 0;
      var expectedScale = this.latestDepth.relativeDepth > 0 ? 1 / this.latestDepth.relativeDepth : 0;
      var scaleLogError = imageScale > 0 && expectedScale > 0
        ? Math.abs(Math.log(imageScale / expectedScale))
        : Infinity;
      var depthFresh = Date.now() - this.latestDepth.capturedAt <= 4000;
      var scalePass = depthFresh && scaleLogError <= Math.log(1.8);
      var validation = Boolean(message.depthValidation || (message.type === 'calibrated' && result.depthAgreement !== null));
      var planePass = result.depthAgreement !== null && result.depthAgreement >= 0.45;
      result.depthImageScale = imageScale || null;
      result.depthExpectedScale = expectedScale || null;
      result.depthScaleLogError = isFinite(scaleLogError) ? scaleLogError : null;
      if (validation && depthFresh && this.latestDepth.confidence >= 0.35) {
        if (scalePass && planePass) {
          this.depthMismatchCount = 0;
          this.fusionRejected = false;
          this.fusionValidUntil = Date.now() + 3500;
        } else {
          this.depthMismatchCount += 1;
          if (this.depthMismatchCount >= 2) this.fusionRejected = true;
        }
      }
      if (this.fusionRejected && result.source !== 'opencv-pnp+depth-anything') {
        result.recalibrationRequired = true;
        result.quad = null;
        result.anchor = null;
        result.reason = 'depth-geometry-conflict';
      }
      if (result.source !== 'opencv-pnp+depth-anything' && !result.lost && !result.recalibrationRequired && Date.now() <= this.fusionValidUntil &&
          depthFresh && this.latestDepth.confidence >= 0.35) {
        result.source = 'opencv-homography+depth-anything';
      }
    }
    this.fusionActive = result.source === 'opencv-homography+depth-anything' ||
      result.source === 'opencv-pnp+depth-anything';
    this.poseActive = result.source === 'opencv-pnp+depth-anything';
    this.updateReadyStatus();
    this.onResult(result);
  };

  PerceptionEngine.prototype.capture = function (canvas, context, maximumWidth, multiple) {
    var video = this.video;
    if (!context || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    var width = Math.min(maximumWidth, video.videoWidth);
    var height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
    if (multiple) {
      width = Math.max(multiple, Math.round(width / multiple) * multiple);
      height = Math.max(multiple, Math.round(height / multiple) * multiple);
    }
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  };

  PerceptionEngine.prototype.sample = function () {
    if (!this.active) return false;
    if (this.testConfig && this.testConfig.mode === 'mock-ready') {
      var results = Array.isArray(this.testConfig.results) ? this.testConfig.results : [];
      var mocked = results[Math.min(this.testIndex, Math.max(0, results.length - 1))] || {
        bounds: this.bounds,
        confidence: 0.92,
        moved: this.testIndex > 0,
        source: 'opencv-homography+depth-anything',
        depthScore: 0.62,
        depthConfidence: 0.84,
        depthRelative: this.testIndex > 1 ? 0.9 : 1,
        depthSource: 'depth-anything-v2-small-q4f16'
      };
      this.testIndex += 1;
      this.bounds = normalizedBounds(mocked.bounds || this.bounds);
      this.onResult(Object.assign({}, mocked, {
        bounds: this.bounds,
        featureProfile: this.featureProfile
      }));
      return true;
    }
    if (this.openCVFailed || !this.openCVWorker) return false;
    if (this.openCVReady && !this.openCVInFlight &&
        (this.openCVCalibrated || Date.now() >= this.nextOpenCVCalibrationAt)) {
      var frame = this.capture(this.canvas, this.context, Number(this.options.maximumWidth || 480));
      if (frame) {
        this.openCVInFlight = true;
        this.openCVFrameID += 1;
        var openCVCapturedAt = Date.now();
        this.openCVWorker.postMessage({
          type: this.openCVCalibrated ? 'track' : 'calibrate',
          width: frame.width,
          height: frame.height,
          pixels: frame.data.buffer,
          bounds: this.openCVCalibrated ? this.bounds : this.anchor,
          anchor: this.anchorPoint,
          featureProfile: this.featureProfile,
          pose: this.latestPose && Date.now() - this.latestPose.at <= 500 ? this.latestPose : null,
          frameId: this.openCVFrameID,
          capturedAt: openCVCapturedAt
        }, [frame.data.buffer]);
      }
    }
    var initialDepthRequired = this.options.depth !== false && !this.depthFailed && !this.latestDepth;
    if (this.options.depth !== false && this.depthReady && !this.depthInFlight &&
        (initialDepthRequired || (this.openCVCalibrated && Date.now() - this.lastDepthAt >= 2200))) {
      var depthFrame = this.capture(this.depthCanvas, this.depthContext, 518, 14);
      if (depthFrame) {
        this.depthInFlight = true;
        this.lastDepthAt = Date.now();
        this.depthFrameID += 1;
        var referenceAge = initialDepthRequired && this.testConfig
          ? Math.max(0, Number(this.testConfig.depthReferenceAgeMs || 0))
          : 0;
        var capturedAt = Date.now() - referenceAge;
        var posePixels = depthFrame.data.slice().buffer;
        this.openCVWorker.postMessage({
          type: 'pose-frame',
          width: depthFrame.width,
          height: depthFrame.height,
          pixels: posePixels,
          bounds: this.bounds,
          anchor: this.currentAnchor || this.anchorPoint,
          featureProfile: this.featureProfile,
          frameId: this.depthFrameID,
          capturedAt: capturedAt
        }, [posePixels]);
        this.depthWorker.postMessage({
          type: 'infer',
          width: depthFrame.width,
          height: depthFrame.height,
          pixels: depthFrame.data.buffer,
          bounds: this.bounds,
          frameId: this.depthFrameID,
          capturedAt: capturedAt
        }, [depthFrame.data.buffer]);
      }
    }
    return this.openCVCalibrated;
  };

  PerceptionEngine.prototype.stop = function () {
    this.active = false;
    this.anchor = null;
    this.anchorPoint = null;
    this.bounds = null;
    this.featureProfile = 'default';
    this.openCVCalibrated = false;
    this.openCVInFlight = false;
    this.openCVCalibrationFailures = 0;
    this.nextOpenCVCalibrationAt = 0;
    this.openCVFrameID = 0;
    this.latestDepth = null;
    this.latestPose = null;
    this.fusionReferenceQuad = null;
    this.depthMismatchCount = 0;
    this.fusionActive = false;
    this.fusionValidUntil = 0;
    this.fusionRejected = false;
    this.openCVHistory = [];
    this.currentAnchor = null;
    this.openCVLossCount = 0;
    this.openCVLost = false;
    this.poseReady = false;
    this.poseActive = false;
    this.poseFailureReason = '';
    if (this.openCVWorker) this.openCVWorker.postMessage({ type: 'reset' });
    if (this.depthWorker) this.depthWorker.postMessage({ type: 'reset' });
    this.updateStatus('idle', 'calibrated-region', 'Spatial perception idle');
  };

  PerceptionEngine.prototype.destroy = function () {
    this.stop();
    if (this.openCVWorker) this.openCVWorker.terminate();
    if (this.depthWorker) this.depthWorker.terminate();
    this.openCVWorker = null;
    this.depthWorker = null;
  };

  global.FieldAssistPerception = {
    PerceptionEngine: PerceptionEngine
  };
})(window);
