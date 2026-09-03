(function () {
  'use strict';

  // Keep the browser client framework-free. The server intentionally owns
  // session authentication and state; released perception runtimes are
  // capability-gated and lazy while this file coordinates the two views,
  // WebSocket signaling, and the direct media peer.
  var RTC_CONFIGURATION = {
    iceServers: [{ urls: 'stun:global.stun.twilio.com:3478' }]
  };
  var RECONNECT_BASE_MS = 500;
  var RECONNECT_MAX_MS = 10000;
  var READY_PULSE_MS = 3000;

  var hasOwn = Object.prototype.hasOwnProperty;

  function byId(id) {
    return document.getElementById(id);
  }

  function bindModalDialog(triggerID, dialogID, closeID) {
    var trigger = byId(triggerID);
    var dialog = byId(dialogID);
    var close = byId(closeID);
    if (!trigger || !dialog) return;
    trigger.addEventListener('click', function () {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
    if (close) close.addEventListener('click', function () {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      trigger.focus({ preventScroll: true });
    });
    dialog.addEventListener('click', function (event) {
      if (event.target !== dialog) return;
      var bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
    });
  }

  function setText(id, value) {
    var element = byId(id);
    if (element) {
      element.textContent = value == null ? '' : String(value);
    }
    return element;
  }

  function setStatus(id, label, state) {
    var element = setText(id, label);
    if (element && state) {
      element.setAttribute('data-state', state);
    }
    var control = element && element.closest ? element.closest('[data-status-control]') : null;
    if (control) {
      if (state) control.setAttribute('data-state', state);
      control.setAttribute('aria-label', label);
      control.setAttribute('data-status-label', label);
      control.setAttribute('title', label);
    }
  }

  function setPerceptionStatus(status, elementID) {
    var element = byId(elementID || 'operator-perception-status');
    if (!element) return;
    status = status && typeof status === 'object' ? status : {};
    var state = String(status.state || 'idle');
    var source = String(status.source || 'calibrated-region');
    var reason = String(status.reason || '');
    var label = String(status.label || 'Spatial perception idle');
    element.textContent = label;
    element.setAttribute('data-state', state);
    element.setAttribute('data-source', source);
    element.setAttribute('data-reason', reason);
    element.title = reason ? source + ' · ' + reason : source;
    var control = element.closest ? element.closest('[data-status-control]') : null;
    if (control) {
      control.setAttribute('data-state', state);
      control.setAttribute('data-source', source);
      control.setAttribute('data-reason', reason);
      control.setAttribute('aria-label', label);
      control.setAttribute('data-status-label', label);
      control.setAttribute('title', reason ? label + ' · ' + reason : label);
    }
  }

  function perceptionTrackingFields(tracking) {
    tracking = tracking && typeof tracking === 'object' ? tracking : {};
    var modelRelativeDepth = tracking.modelRelativeDepth !== undefined
      ? tracking.modelRelativeDepth
      : tracking.depthRelative;
    var depthScore = optionalNumber(tracking.depthScore);
    var depthConfidence = optionalNumber(tracking.depthConfidence);
    var depthRelative = optionalNumber(tracking.depthRelative);
    modelRelativeDepth = optionalNumber(modelRelativeDepth);
    return {
      source: tracking.source || 'browser-multiscale-template',
      depthSource: normalizedDepthSource(tracking.depthSource),
      depthScore: depthScore === null ? null : clamp(depthScore, 0, 1),
      depthConfidence: depthConfidence === null ? null : clamp(depthConfidence, 0, 1),
      depthRelative: depthRelative === null ? null : clamp(depthRelative, 0.25, 4),
      modelRelativeDepth: modelRelativeDepth === null ? null : clamp(modelRelativeDepth, 0.25, 4),
      poseState: String(tracking.poseState || 'unavailable'),
      poseFailureReason: String(tracking.poseFailureReason || '').slice(0, 96),
      poseInliers: Math.max(0, Number(tracking.poseInliers || 0)),
      poseInlierRatio: clamp(tracking.poseInlierRatio, 0, 1),
      partialVisibility: Boolean(tracking.partialVisibility),
      visibleFraction: tracking.partialVisibility ? clamp(tracking.visibleFraction, 0, 1) : 1,
      anchorVisible: tracking.anchorVisible !== false
    };
  }

  function isOpenCVTrackingSource(source) {
    source = String(source || '');
    return source === 'opencv-homography' || source === 'opencv-homography+depth-anything' ||
      source === 'opencv-pnp+depth-anything';
  }

  function isDepthBackedTrackingSource(source) {
    source = String(source || '');
    return source === 'opencv-homography+depth-anything' || source === 'opencv-pnp+depth-anything';
  }

  function removeChildren(element) {
    if (!element) return;
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function clamp(value, minimum, maximum) {
    var number = Number(value);
    if (!isFinite(number)) return minimum;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function optionalNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
  }

  function normalizedDepthSource(value) {
    value = String(value || '');
    if (value === 'depth-anything-v2-small-q4') return 'depth-anything-v2-small-q4f16';
    if (value === 'depth-anything-v2-small-q4f16' || value === 'depth-anything-v2-small-int8') return value;
    return '';
  }

  function parseMaybeJSON(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (_error) {
      return value;
    }
  }

  function pathSessionId() {
    var parts = window.location.pathname.split('/').filter(function (part) {
      return part !== '';
    });
    if (parts[0] !== 'session' || !parts[1]) return '';
    try {
      return decodeURIComponent(parts[1]);
    } catch (_error) {
      return parts[1];
    }
  }

  function websocketURL(sessionId, role) {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return protocol + '//' + window.location.host + '/ws/sessions/' +
      encodeURIComponent(sessionId) + '?role=' + encodeURIComponent(role);
  }

  function readableRole(role) {
    if (role === 'operator') return 'Operator';
    if (role === 'support') return 'Support';
    return role || 'Participant';
  }

  var timeFormatter;

  function formatTime(value) {
    if (!value) return '';
    var date = new Date(value);
    if (isNaN(date.getTime())) return '';
    try {
      if (!timeFormatter) {
        timeFormatter = new Intl.DateTimeFormat(undefined, {
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit'
        });
      }
      return timeFormatter.format(date);
    } catch (_error) {
      return date.toLocaleTimeString();
    }
  }

  function formatError(error) {
    if (!error) return 'Something went wrong.';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string' && error.message) return error.message;
    if (typeof error.detail === 'string' && error.detail) return error.detail;
    if (typeof error.error === 'string' && error.error) return error.error;
    try {
      var serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch (_error) {}
    return 'Something went wrong.';
  }

  function browserModelContext() {
    var documentContext = document && document.modelContext;
    var navigatorContext = navigator && navigator.modelContext;
    var context = documentContext || navigatorContext;
    if (!context || typeof context.getTools !== 'function' || typeof context.executeTool !== 'function') {
      return null;
    }
    return context;
  }

  function renderWebMCPCapability() {
    var element = byId('webmcp-status');
    if (!element) return false;
    var supported = Boolean(browserModelContext());
    setStatus('webmcp-status', supported ? 'WebMCP supported' : 'Manual controls', supported ? 'connected' : 'ready');
    element.setAttribute('data-capability', supported ? 'webmcp' : 'manual');
    element.setAttribute('title', supported
      ? 'The browser exposes modelContext; Codex can use the registered page tools.'
      : 'This browser has no modelContext; use the visible scene controls.');
    return supported;
  }

  function announceFieldAssistReady(role, root) {
    if (!root) return;
    root.setAttribute('data-fui-field-assist-ready', 'true');
    if (typeof window.CustomEvent !== 'function') return;
    root.dispatchEvent(new window.CustomEvent('gofastr:field-assist-ready', {
      bubbles: true,
      detail: {
        role: role,
        sessionId: pathSessionId(),
        webmcp: Boolean(browserModelContext())
      }
    }));
  }

  function csrfToken() {
    var selectors = [
      'meta[name="csrf-token"]',
      'meta[name="csrf_token"]',
      'meta[name="gofastr-csrf-token"]',
      'meta[name="x-csrf-token"]',
      'meta[property="csrf-token"]'
    ];
    for (var i = 0; i < selectors.length; i += 1) {
      var meta = document.querySelector(selectors[i]);
      if (meta) {
        var content = meta.getAttribute('content');
        if (content) return content;
      }
    }
    return '';
  }

  function requestHeaders(json) {
    var headers = { Accept: 'application/json' };
    if (json) headers['Content-Type'] = 'application/json';
    var token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
    return headers;
  }

  function responseBody(response) {
    return response.text().then(function (body) {
      if (!body) return {};
      try {
        return JSON.parse(body);
      } catch (_error) {
        return { message: body };
      }
    });
  }

  function fetchJSON(url, options) {
    var request = options || {};
    if (!request.credentials) request.credentials = 'same-origin';
    if (!request.headers) request.headers = requestHeaders(Boolean(request.body));
    return window.fetch(url, request).then(function (response) {
      return responseBody(response).then(function (body) {
        if (!response.ok) {
          var message = body && (body.message || body.error || body.detail);
          throw new Error(formatError(message) || ('Request failed (' + response.status + ')'));
        }
        return body;
      });
    });
  }

  function loadCurrentSession() {
    return fetchJSON('/api/session/current', {
      method: 'GET',
      cache: 'no-store',
      headers: requestHeaders(false)
    });
  }

  function loadICEConfiguration() {
    return fetchJSON('/api/session/ice-config', {
      method: 'GET',
      cache: 'no-store',
      headers: requestHeaders(false)
    }).then(function (result) {
      if (!result || !Array.isArray(result.iceServers) || result.iceServers.length === 0) {
        throw new Error('ICE configuration was empty');
      }
      RTC_CONFIGURATION = { iceServers: result.iceServers };
      return RTC_CONFIGURATION;
    }).catch(function () {
      // The public STUN default keeps local/demo sessions usable if the
      // deployment endpoint is temporarily unavailable. TURN credentials,
      // when configured, are still delivered only through the authenticated
      // same-origin endpoint above.
      return RTC_CONFIGURATION;
    });
  }

  function objectValue(object, attributes, keys) {
    var values = [object || {}, attributes || {}];
    for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      var source = values[valueIndex];
      if (!source || typeof source !== 'object') continue;
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        var key = keys[keyIndex];
        if (hasOwn.call(source, key) && source[key] !== null && source[key] !== undefined && source[key] !== '') {
          return source[key];
        }
      }
    }
    return undefined;
  }

  function sceneObject(scene, objectId) {
    if (objectId === null || objectId === undefined || String(objectId).trim() === '') return null;
    var objects = scene && Array.isArray(scene.objects) ? scene.objects : [];
    return objects.find(function (object) {
      return object && (object.id === objectId || object.ID === objectId || object.objectId === objectId);
    }) || null;
  }

  function perceptionFeatureProfile(object) {
    if (!object) return 'default';
    var attributes = object.attributes || object.Attributes || {};
    var kind = String(object.kind || object.Kind || '').trim().toLowerCase();
    if (['device-control', 'control', 'button', 'remote', 'console', 'stand'].indexOf(kind) >= 0) {
      return 'default';
    }
    if (['tv', 'television', 'display', 'screen', 'monitor', 'reflective-display'].indexOf(kind) >= 0) {
      return 'reflective-plane';
    }
    var surface = [attributes.surface, attributes.material].filter(Boolean).join(' ').toLowerCase();
    return /(^|\s|-)(reflective|glass)(\s|-|$)/.test(surface) ? 'reflective-plane' : 'default';
  }

  function objectBounds(object) {
    return object && normalizedBounds(object.bounds || object.Bounds);
  }

  function objectAttributes(object) {
    return object && (object.attributes || object.Attributes) || {};
  }

  function precisionTargetRequiresTracking(object) {
    var attributes = objectAttributes(object);
    return Boolean(attributes.trackingRequired) ||
      String(attributes.localizationStatus || '').toLowerCase() === 'provisional';
  }

  function trackingReferenceForObject(scene, target) {
    if (!target) return null;
    var attributes = objectAttributes(target);
    var explicit = sceneObject(scene, attributes.trackingReferenceObjectId);
    return explicit || target;
  }

  function targetAnchorWithinReference(targetBounds, targetAnchor, referenceBounds) {
    targetBounds = normalizedBounds(targetBounds);
    referenceBounds = normalizedBounds(referenceBounds);
    var absolute = pointForObjectAnchor(targetBounds, targetAnchor);
    if (!absolute || referenceBounds.width <= 0 || referenceBounds.height <= 0) return { x: 0.5, y: 0.5 };
    return {
      x: clamp((absolute.x - referenceBounds.x) / referenceBounds.width, 0, 1),
      y: clamp((absolute.y - referenceBounds.y) / referenceBounds.height, 0, 1)
    };
  }

  // Scene attributes are intentionally read defensively. The Go scene model
  // can add physical-state attributes without forcing this browser bundle to
  // know every future field name. Negative states run first so
  // "disconnected" is never mistaken for "connected".
  function sceneConnectionState(scene) {
    var wan = sceneObject(scene, 'wan-port');
    var attributes = wan && (wan.attributes || wan.Attributes || {});
    var sceneAttributes = scene && (scene.attributes || scene.Attributes || {});
    var values = [
      objectValue(wan, attributes, ['connected', 'isConnected', 'connectionState', 'connection', 'status', 'state', 'cableState', 'physicalState', 'plugged', 'present', 'occupancy', 'link']),
      objectValue(scene, sceneAttributes, ['wanConnected', 'connected', 'isConnected', 'connectionState', 'connection', 'status', 'state', 'cableState', 'physicalState', 'plugged', 'present', 'occupancy', 'link'])
    ];
    for (var index = 0; index < values.length; index += 1) {
      var value = values[index];
      if (typeof value === 'boolean') return value ? 'connected' : 'empty';
      if (value && typeof value === 'object') {
        var nested = objectValue(value, value, ['connected', 'isConnected', 'connectionState', 'connection', 'status', 'state', 'cableState', 'physicalState', 'plugged', 'present']);
        if (typeof nested === 'boolean') return nested ? 'connected' : 'empty';
        value = nested;
      }
      if (typeof value !== 'string') continue;
      var normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
      if (/^(disconnected|not_connected|unplugged|missing|empty|absent|open|available|waiting|pending)$/.test(normalized)) {
        return 'empty';
      }
      if (/^(connected|occupied|inserted|seated|present|moved|complete|active|up|done)$/.test(normalized)) {
        return 'connected';
      }
    }
    return 'empty';
  }

  function sceneVersion(scene) {
    var value = scene && (scene.version !== undefined ? scene.version : scene.revision);
    if (value === undefined || value === null || value === '') return 1;
    return value;
  }

  function sceneTimestamp(scene) {
    if (!scene || typeof scene !== 'object') return '';
    return scene.timestamp || scene.updatedAt || scene.updated_at || '';
  }

  function normalizeScene(scene, fallback) {
    var source = scene && typeof scene === 'object' ? scene : (fallback || {});
    var objects = Array.isArray(source.objects) ? source.objects.slice() : [];
    var normalized = Object.assign({}, source, { objects: objects });
    if (normalized.id === undefined && normalized.ID !== undefined) normalized.id = normalized.ID;
    if (normalized.label === undefined && normalized.Label !== undefined) normalized.label = normalized.Label;
    if (normalized.version === undefined && normalized.revision !== undefined) normalized.version = normalized.revision;
    if (normalized.version === undefined) normalized.version = 1;
    return normalized;
  }

  function unwrapSnapshot(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.snapshot && typeof value.snapshot === 'object') return value.snapshot;
    return value;
  }

  function createEmptySnapshot(sessionId) {
    return {
      id: sessionId || '',
      createdAt: '',
      expiresAt: '',
      sequence: 0,
      participants: { support: 0, operator: 0 },
      scene: { id: '', label: '', version: 1, timestamp: '', objects: [], relationships: [], calibration: null },
      operatorIssue: null,
      caseContext: null,
      roomContext: null,
      activeQuestion: null,
      operatorInstruction: null,
      messages: [],
      activeApproval: null,
      sceneActivity: null,
      sceneTracking: null,
      annotations: [],
      annotationReceipts: [],
      timeline: [],
      snapshots: []
    };
  }

  function SessionState(role, sessionId) {
    this.role = role;
    this.sessionId = sessionId || '';
    this.snapshot = createEmptySnapshot(this.sessionId);
    this.lastSequence = 0;
    this.seenEventIds = Object.create(null);
    this.sceneState = 'empty';
    this.guidanceResolved = false;
    this.actionStatus = 'Manual scene controls are ready.';
    this.confirmStatus = '';
    this.sceneActivityStatus = 'Visual check idle';
    this.sceneActivityState = 'pending';
    this.sceneActivityReporting = false;
    this.answeringQuestion = false;
    this.questionError = '';
    this.selectingIssue = false;
    this.issueError = '';
    this.chatOpen = false;
    this.sendingMessage = false;
    this.messageError = '';
    this.messageStatus = '';
    this.sendingInstruction = false;
    this.instructionError = '';
    this.instructionStatus = 'Replaces the current yellow banner.';
    this.trackedBounds = Object.create(null);
    this.trackingLostObjectID = '';
    this.latestSnapshot = null;
    this.calibrationMode = false;
    this.calibrating = false;
    this.diagnostics = {
      role: role,
      sessionId: sessionId || '',
      signaling: 'not started',
      websocket: 'closed',
      peer: 'not created',
      ice: 'new',
      media: 'waiting',
      lastEvent: '',
      lastSequence: 0,
      reconnectAttempt: 0
    };
  }

  SessionState.prototype.setSnapshot = function (snapshot) {
    snapshot = unwrapSnapshot(snapshot);
    if (!snapshot || typeof snapshot !== 'object') return;
    var previous = this.snapshot || createEmptySnapshot(this.sessionId);
    var scene = normalizeScene(snapshot.scene, previous.scene);
    var snapshots = Array.isArray(snapshot.snapshots) ? snapshot.snapshots.slice() : (previous.snapshots || []);
    this.snapshot = {
      id: snapshot.id || this.sessionId,
      createdAt: snapshot.createdAt || '',
      expiresAt: snapshot.expiresAt || '',
      sequence: Number(snapshot.sequence) || 0,
      participants: Object.assign({ support: 0, operator: 0 }, snapshot.participants || {}),
      scene: scene,
      operatorIssue: hasOwn.call(snapshot, 'operatorIssue') ? snapshot.operatorIssue : (previous.operatorIssue || null),
      caseContext: snapshot.caseContext || previous.caseContext || null,
      roomContext: snapshot.roomContext || previous.roomContext || null,
      activeQuestion: snapshot.activeQuestion || previous.activeQuestion || null,
      operatorInstruction: hasOwn.call(snapshot, 'operatorInstruction') ? snapshot.operatorInstruction : (previous.operatorInstruction || null),
      messages: Array.isArray(snapshot.messages) ? snapshot.messages.slice() : (previous.messages || []).slice(),
      activeApproval: snapshot.activeApproval || null,
      sceneActivity: snapshot.sceneActivity || previous.sceneActivity || null,
      sceneTracking: snapshot.sceneTracking || null,
      annotations: Array.isArray(snapshot.annotations) ? snapshot.annotations.slice() : [],
      annotationReceipts: Array.isArray(snapshot.annotationReceipts) ? snapshot.annotationReceipts.slice() : [],
      timeline: Array.isArray(snapshot.timeline) ? snapshot.timeline.slice() : [],
      snapshots: snapshots
    };
    this.sessionId = this.snapshot.id || this.sessionId;
    this.lastSequence = Math.max(this.lastSequence, this.snapshot.sequence);
    this.diagnostics.lastSequence = this.lastSequence;
    this.sceneState = sceneConnectionState(scene);
    this.guidanceResolved = this.sceneState === 'connected';
    if (snapshots.length) this.latestSnapshot = snapshots[snapshots.length - 1];
  };

  SessionState.prototype.ensureSnapshot = function () {
    if (!this.snapshot) this.snapshot = createEmptySnapshot(this.sessionId);
    return this.snapshot;
  };

  SessionState.prototype.setScene = function (scene) {
    if (!scene || typeof scene !== 'object') return;
    var snapshot = this.ensureSnapshot();
    snapshot.scene = normalizeScene(scene, snapshot.scene);
    this.sceneState = sceneConnectionState(snapshot.scene);
    this.guidanceResolved = this.sceneState === 'connected';
  };

  SessionState.prototype.addSnapshot = function (record) {
    record = unwrapSnapshot(record);
    if (!record || typeof record !== 'object') return;
    var snapshot = this.ensureSnapshot();
    var snapshots = Array.isArray(snapshot.snapshots) ? snapshot.snapshots.slice() : [];
    var id = record.id || record.ID || '';
    if (id) {
      snapshots = snapshots.filter(function (existing) {
        return !existing || !existing.id || existing.id !== id;
      });
    }
    snapshots.push(record);
    if (snapshots.length > 50) snapshots = snapshots.slice(-50);
    snapshot.snapshots = snapshots;
    this.latestSnapshot = record;
    if (record.scene) this.setScene(record.scene);
  };

  SessionState.prototype.resolveGuidance = function (result) {
    result = result && typeof result === 'object' ? result : {};
    this.guidanceResolved = true;
    this.confirmStatus = 'Confirmed · cable moved';
    var snapshot = this.ensureSnapshot();
    snapshot.annotations = [];
    if (snapshot.activeApproval) snapshot.activeApproval.status = 'consumed';
    if (result.scene) this.setScene(result.scene);
    if (result.snapshot || result.afterSnapshot) this.addSnapshot(result.snapshot || result.afterSnapshot);
    // The response is authoritative for the action even if the broadcast
    // scene update arrives a moment later.
    this.guidanceResolved = true;
  };

  SessionState.prototype.addTimeline = function (item) {
    if (!item) return;
    var snapshot = this.ensureSnapshot();
    var id = item.id || '';
    if (id && snapshot.timeline.some(function (existing) {
      return existing && existing.id === id;
    })) {
      return;
    }
    snapshot.timeline.push(item);
    if (snapshot.timeline.length > 200) {
      snapshot.timeline = snapshot.timeline.slice(-200);
    }
  };

  SessionState.prototype.addMessage = function (message) {
    if (!message || !message.id) return;
    var snapshot = this.ensureSnapshot();
    snapshot.messages = (Array.isArray(snapshot.messages) ? snapshot.messages : []).filter(function (existing) {
      return !existing || existing.id !== message.id;
    });
    snapshot.messages.push(message);
    if (snapshot.messages.length > 64) snapshot.messages = snapshot.messages.slice(-64);
  };

  SessionState.prototype.addAnnotation = function (annotation) {
    if (!annotation || !annotation.id) return;
    var snapshot = this.ensureSnapshot();
    var replaced = false;
    snapshot.annotations = snapshot.annotations.map(function (existing) {
      if (existing && existing.id === annotation.id) {
        replaced = true;
        return annotation;
      }
      return existing;
    });
    if (!replaced) snapshot.annotations.push(annotation);
    this.guidanceResolved = false;
    this.confirmStatus = '';
  };

  SessionState.prototype.applyEvent = function (event) {
    if (!event || typeof event !== 'object') return false;
    var sequence = Number(event.sequence) || 0;
    if (sequence && sequence <= this.lastSequence) return false;
    if (event.id && this.seenEventIds[event.id]) return false;
    if (event.id) {
      this.seenEventIds[event.id] = true;
      var seenKeys = Object.keys(this.seenEventIds);
      if (seenKeys.length > 500) {
        delete this.seenEventIds[seenKeys[0]];
      }
    }
    if (sequence) {
      this.lastSequence = Math.max(this.lastSequence, sequence);
      this.diagnostics.lastSequence = this.lastSequence;
    }

    var payload = parseMaybeJSON(event.payload);
    var relayed = payload && typeof payload === 'object' && hasOwn.call(payload, 'data');
    var data = relayed ? parseMaybeJSON(payload.data) : payload;
    var snapshot = this.ensureSnapshot();
    var role;
    var timeline;

    switch (event.type) {
      case 'session.snapshot':
        this.setSnapshot(data);
        break;
      case 'participant.joined':
      case 'participant.left':
        role = data && data.role;
        if (role) snapshot.participants[role] = Number(data.count) || 0;
        timeline = {
          id: event.id,
          type: event.type,
          message: readableRole(role) + (event.type === 'participant.joined' ? ' joined the session' : ' left the session'),
          actor: role || '',
          createdAt: event.timestamp || ''
        };
        this.addTimeline(timeline);
        break;
      case 'operator.issue_selected':
        snapshot.operatorIssue = data && data.issue ? data.issue : null;
        this.issueError = '';
        if (data && data.message) this.addMessage(data.message);
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        break;
      case 'annotation.created':
        // Annotation mutations are broadcast directly by Session, while a
        // future relay implementation may wrap them in {annotation: ...}.
        var createdAnnotation = data && data.annotation ? data.annotation : data;
        var replacedAnnotationIds = data && Array.isArray(data.replacedAnnotationIds)
          ? data.replacedAnnotationIds
          : [];
        if (replacedAnnotationIds.length) {
          snapshot.annotations = snapshot.annotations.filter(function (annotation) {
            return annotation && replacedAnnotationIds.indexOf(annotation.id) < 0;
          });
          snapshot.annotationReceipts = snapshot.annotationReceipts.filter(function (receipt) {
            return receipt && replacedAnnotationIds.indexOf(receipt.annotationId) < 0;
          });
        }
        if (createdAnnotation && createdAnnotation.kind === 'arrow') {
          snapshot.annotations = snapshot.annotations.filter(function (annotation) {
            return annotation && ['closeup', 'angle', 'move', 'view', 'region'].indexOf(annotation.kind) < 0;
          });
        }
        var newerArrowExists = createdAnnotation && ['closeup', 'angle', 'move', 'view', 'region'].indexOf(createdAnnotation.kind) >= 0 &&
          snapshot.annotations.some(function (annotation) {
            return annotation && annotation.kind === 'arrow' && annotationTimestamp(annotation) >= annotationTimestamp(createdAnnotation);
          });
        if (!newerArrowExists) this.addAnnotation(createdAnnotation);
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        if (data && data.objectId) {
          this.addTimeline({
            id: event.id,
            type: event.type,
            message: 'Highlighted ' + (data.label || data.objectId),
            actor: data.actor || '',
            createdAt: data.createdAt || event.timestamp || ''
          });
        }
        break;
      case 'annotation.removed':
        if (data && data.id) {
          snapshot.annotations = snapshot.annotations.filter(function (annotation) {
            return annotation && annotation.id !== data.id;
          });
          snapshot.annotationReceipts = snapshot.annotationReceipts.filter(function (receipt) {
            return receipt && receipt.annotationId !== data.id;
          });
          if (snapshot.sceneTracking && snapshot.sceneTracking.guidanceId === data.id) {
            snapshot.sceneTracking = null;
          }
        }
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        break;

      case 'annotation.acknowledged':
        var receipts = data && Array.isArray(data.receipts) ? data.receipts : [];
        receipts.forEach(function (receipt) {
          if (!receipt || !receipt.annotationId) return;
          snapshot.annotationReceipts = snapshot.annotationReceipts.filter(function (existing) {
            return !existing || existing.annotationId !== receipt.annotationId;
          });
          snapshot.annotationReceipts.push(receipt);
        });
        break;

      case 'action.approved':
        snapshot.activeApproval = data && data.approval ? data.approval : null;
        snapshot.sceneActivity = null;
        snapshot.sceneTracking = null;
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        break;
      case 'scene.activity_detected':
        snapshot.sceneActivity = data && data.activity ? data.activity : null;
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        break;
      case 'scene.tracking_updated':
        snapshot.sceneTracking = data && data.tracking ? data.tracking : null;
        if (snapshot.sceneTracking && snapshot.sceneTracking.needsRecalibration && snapshot.sceneTracking.guidanceId) {
          snapshot.annotationReceipts = snapshot.annotationReceipts.filter(function (receipt) {
            return receipt && receipt.annotationId !== snapshot.sceneTracking.guidanceId;
          });
        }
        break;
      case 'room.context_updated':
        snapshot.roomContext = data && data.roomContext ? data.roomContext : null;
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        break;
      case 'operator.question_asked':
      case 'operator.question_answered':
        snapshot.activeQuestion = data && data.question ? data.question : null;
        this.questionError = '';
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        break;
      case 'operator.instruction_updated':
        snapshot.operatorInstruction = data && data.instruction ? data.instruction : null;
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        break;
      case 'conversation.message_sent':
        if (data && data.message) this.addMessage(data.message);
        this.messageError = '';
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        break;
      case 'annotations.cleared':
        snapshot.annotations = [];
        snapshot.annotationReceipts = [];
        snapshot.sceneTracking = null;
        this.addTimeline({
          id: event.id,
          type: event.type,
          message: 'Cleared ' + ((data && data.count) || 0) + ' annotation(s)',
          actor: data && data.actor ? data.actor : '',
          createdAt: event.timestamp || ''
        });
        break;
      case 'observation.created':
        this.addTimeline(data);
        break;
      case 'scene.updated':
        if (data && data.scene) {
          this.setScene(data.scene);
        } else if (data && (data.objects || data.version || data.timestamp || data.updatedAt)) {
          this.setScene(data);
        }
        if (data && data.snapshot) this.addSnapshot(data.snapshot);
		snapshot.sceneTracking = null;
		if (data && hasOwn.call(data, 'activeApproval')) snapshot.activeApproval = data.activeApproval || null;
		if (data && hasOwn.call(data, 'sceneActivity')) snapshot.sceneActivity = data.sceneActivity || null;
		if (data && data.caseContext) snapshot.caseContext = data.caseContext;
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        break;
	  case 'case.resolved':
		if (data && data.caseContext) snapshot.caseContext = data.caseContext;
		if (data && data.timelineItem) this.addTimeline(data.timelineItem);
		break;
      case 'snapshot.created':
        this.addSnapshot(data && data.snapshot ? data.snapshot : data);
        if (data && data.timelineItem) {
          this.addTimeline(data.timelineItem);
        } else {
          this.addTimeline({
            id: event.id,
            type: event.type,
            message: data && data.label ? 'Captured snapshot · ' + data.label : 'Captured scene snapshot',
            actor: data && data.actor ? data.actor : '',
            createdAt: data && data.createdAt ? data.createdAt : event.timestamp || ''
          });
        }
        break;
      case 'guidance.resolved':
      case 'cable.moved':
      case 'action.confirmed':
        snapshot.annotations = [];
        this.guidanceResolved = true;
        this.confirmStatus = 'Confirmed · cable moved';
        if (data && data.scene) this.setScene(data.scene);
        if (data && data.timelineItem) this.addTimeline(data.timelineItem);
        break;
      default:
        // WebRTC events are consumed by PeerController.  Keeping them in the
        // event stream still advances sequence numbers and diagnostics.
        break;
    }
    this.diagnostics.lastEvent = event.type || '';
    return true;
  };

  SessionState.prototype.applyIncoming = function (event) {
    if (!event || typeof event !== 'object') return false;
    if (event.type === 'session.snapshot') {
      var snapshot = parseMaybeJSON(event.payload);
      var sequence = Number(event.sequence) || Number(snapshot && snapshot.sequence) || 0;
      // Reconnect snapshots and live mutations share one ordered stream. A
      // snapshot can arrive after a newer mutation because the initial socket
      // payload is written independently from hub broadcasts; never let that
      // stale snapshot resurrect a cleared banner or other superseded state.
      if (sequence && sequence <= this.lastSequence) return false;
      if (event.id && this.seenEventIds[event.id]) return false;
      this.setSnapshot(snapshot);
      if (event.id) this.seenEventIds[event.id] = true;
      if (sequence) {
        this.lastSequence = Math.max(this.lastSequence, sequence);
        this.diagnostics.lastSequence = this.lastSequence;
      }
      this.diagnostics.lastEvent = event.type;
      return true;
    }
    return this.applyEvent(event);
  };

  function renderTimeline(state) {
    var timelineElement = byId('timeline');
    if (!timelineElement) return;
    removeChildren(timelineElement);
    var items = state.snapshot && Array.isArray(state.snapshot.timeline) ? state.snapshot.timeline : [];
    setText('timeline-count', items.length + ' event' + (items.length === 1 ? '' : 's'));
    if (!items.length) {
      var empty = document.createElement('li');
      empty.className = 'timeline-empty';
      empty.textContent = 'Activity will appear as the session unfolds.';
      timelineElement.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      if (!item) return;
      var li = document.createElement('li');
      li.className = 'timeline-item';
      var marker = document.createElement('span');
      marker.className = 'timeline-marker';
      marker.setAttribute('aria-hidden', 'true');
      var content = document.createElement('div');
      content.className = 'timeline-content';
      var message = document.createElement('strong');
      message.textContent = item.message || item.type || 'Session activity';
      var metadata = document.createElement('span');
      metadata.className = 'timeline-meta';
      var actor = item.actor ? readableRole(item.actor) : '';
      var time = formatTime(item.createdAt);
      metadata.textContent = actor && time ? actor + ' · ' + time : (actor || time);
      content.appendChild(message);
      if (metadata.textContent) content.appendChild(metadata);
      li.appendChild(marker);
      li.appendChild(content);
      timelineElement.appendChild(li);
    });
    timelineElement.scrollTop = timelineElement.scrollHeight;
  }

  function snapshotRecordTime(record) {
    if (!record || typeof record !== 'object') return '';
    return record.createdAt || record.timestamp || record.capturedAt || record.created_at || '';
  }

  function snapshotRecordLabel(record) {
    if (!record || typeof record !== 'object') return 'Scene capture';
    return record.label || record.name || 'Scene capture';
  }

  function renderSnapshotHistory(state) {
    var snapshot = state.snapshot || createEmptySnapshot(state.sessionId);
    var history = byId('snapshot-history');
    var status = byId('snapshot-status');
    var records = Array.isArray(snapshot.snapshots) ? snapshot.snapshots.slice() : [];
    if (!records.length && state.latestSnapshot) records = [state.latestSnapshot];
    if (status) {
      if (!records.length) {
        status.textContent = 'None captured';
        status.setAttribute('data-state', 'empty');
      } else {
        var latest = records[records.length - 1];
        var time = formatTime(snapshotRecordTime(latest));
        status.textContent = 'Captured' + (time ? ' · ' + time : '');
        status.setAttribute('data-state', 'ready');
      }
    }
    if (!history) return;
    removeChildren(history);
    history.hidden = !records.length;
    records.slice().reverse().slice(0, 5).forEach(function (record) {
      var item = document.createElement('li');
      var label = document.createElement('strong');
      label.textContent = snapshotRecordLabel(record);
      var time = document.createElement('span');
      time.textContent = formatTime(snapshotRecordTime(record));
      item.appendChild(label);
      if (time.textContent) item.appendChild(time);
      history.appendChild(item);
    });
  }

  function renderSceneSummary(state) {
    var snapshot = state.snapshot || createEmptySnapshot(state.sessionId);
    var scene = snapshot.scene || {};
	var objects = Array.isArray(scene.objects) ? scene.objects : [];
	var hasWAN = objects.some(function (object) { return object && object.id === 'wan-port'; });
    var connection = hasWAN ? (state.sceneState || sceneConnectionState(scene)) : (objects.length ? 'observed' : 'empty');
    var summary = byId('scene-summary');
	var label = hasWAN ? (connection === 'connected' ? 'WAN connected' : 'WAN empty') : (objects.length ? objects.length + ' observed target' + (objects.length === 1 ? '' : 's') : 'Awaiting observation');
    var detail = hasWAN && connection === 'connected'
      ? 'Cable movement confirmed'
	  : (snapshot.annotations && snapshot.annotations.length ? 'Follow the highlighted guidance' : (hasWAN ? 'Cable movement not confirmed' : 'Add a target from the live camera to begin'));
    if (summary) summary.setAttribute('data-state', connection);
    setText('scene-state', label);
    setText('scene-state-detail', detail);
    setText('scene-version', 'Scene v' + sceneVersion(scene));
    var timestamp = sceneTimestamp(scene);
    setText('scene-updated', timestamp ? 'Updated ' + formatTime(timestamp) : 'Waiting for scene telemetry.');
    setText('scene-action-status', state.actionStatus || 'Manual scene controls are ready.');
    var activity = snapshot.sceneActivity;
    setStatus('support-scene-activity-status', activity ? 'Visual change detected' : 'Visual check idle', activity ? 'ready' : 'pending');
    var activeAnnotations = Array.isArray(snapshot.annotations) ? snapshot.annotations : [];
    var annotationReceipts = Array.isArray(snapshot.annotationReceipts) ? snapshot.annotationReceipts : [];
    var currentVersion = sceneVersion(scene);
    var deliveredCount = activeAnnotations.filter(function (annotation) {
      return annotation && annotationReceipts.some(function (receipt) {
        return receipt && receipt.annotationId === annotation.id && Number(receipt.sceneVersion) === currentVersion;
      });
    }).length;
    var deliveryLabel = connection === 'connected'
      ? 'Guidance complete'
      : (!activeAnnotations.length ? 'Guidance idle' :
        (deliveredCount === activeAnnotations.length ? 'Operator sees guidance' : 'Waiting for operator'));
    setStatus('support-guidance-delivery-status', deliveryLabel,
      connection === 'connected' || (activeAnnotations.length > 0 && deliveredCount === activeAnnotations.length) ? 'connected' : 'pending');
    var tracking = snapshot.sceneTracking;
    var trackingNeedsRecalibration = tracking && (
	  tracking.needsRecalibration ||
	  tracking.status === 'recalibration_required' ||
      tracking.status === 'reacquire_required' ||
      (tracking.status === 'following_camera_drift' && Number(tracking.confidence || 0) < 0.5)
    );
    var trackingLabel = trackingNeedsRecalibration
      ? 'Recalibration recommended'
      : (tracking && tracking.status === 'following_camera_drift'
        ? 'Following camera drift'
        : (tracking && tracking.status === 'locked' ? 'Guidance tracking locked' :
          (tracking && tracking.status === 'calibrated_fallback' ? 'Using calibrated region' : 'Tracking idle')));
    setStatus('support-tracking-status', trackingLabel,
      tracking && !trackingNeedsRecalibration && (tracking.status === 'following_camera_drift' || tracking.status === 'locked') ? 'ready' : 'pending');
  }

  function renderRoomContext(state) {
    var context = state.snapshot && state.snapshot.roomContext ? state.snapshot.roomContext : null;
    var observations = context && Array.isArray(context.observations) ? context.observations : [];
    var empty = byId('room-context-empty');
    var list = byId('room-context-observations');
    setText('room-context-summary', context && context.summary ? context.summary : 'No room context yet');
    if (empty) empty.hidden = Boolean(context);
    if (list) {
      removeChildren(list);
      list.hidden = !observations.length;
      observations.forEach(function (observation) {
        if (!observation) return;
        var item = document.createElement('li');
        var label = document.createElement('strong');
        var detail = document.createElement('span');
        label.textContent = observation.label || 'Landmark';
        detail.textContent = observation.detail || '';
        item.appendChild(label);
        if (detail.textContent) item.appendChild(detail);
        list.appendChild(item);
      });
    }
    setText('room-context-meta', context
      ? 'Scene v' + Number(context.baseSceneVersion || 0) + ' · ' + (context.updatedBy || 'Codex') + ' · ' + formatTime(context.updatedAt)
      : '');
  }

  function renderSupportQuestion(state) {
    var question = state.snapshot && state.snapshot.activeQuestion ? state.snapshot.activeQuestion : null;
    var region = byId('support-question');
    if (!region) return;
    region.hidden = !question;
    if (!question) return;
    var answered = question.status === 'answered';
    setText('support-question-label', answered ? 'OPERATOR ANSWER RECEIVED' : 'WAITING FOR OPERATOR');
    setText('support-question-prompt', question.prompt || 'Question for the operator');
    setText('support-question-status', answered
      ? (question.answer || 'Response received') + ' · received'
      : 'Waiting for the operator');
    region.setAttribute('data-state', question.status || 'pending');
  }

  function renderSupportInstruction(state) {
    var instruction = state.snapshot && state.snapshot.operatorInstruction
      ? state.snapshot.operatorInstruction : null;
    var region = byId('support-instruction');
    var titleInput = byId('support-banner-title');
    var detailInput = byId('support-banner-detail');
    var sendButton = byId('support-banner-send');
    var clearButton = byId('support-banner-clear');
    setText('support-banner-status', state.instructionError || state.instructionStatus || '');
    setText('support-banner-preview', instruction ? (instruction.title || 'Operator instruction') : 'No active instruction');
    var bannerTrigger = byId('support-banner-dialog-trigger');
    if (bannerTrigger) bannerTrigger.setAttribute('data-state', instruction ? 'live' : 'idle');
    if (titleInput) titleInput.disabled = state.sendingInstruction;
    if (detailInput) detailInput.disabled = state.sendingInstruction;
    if (sendButton) sendButton.disabled = state.sendingInstruction;
    if (clearButton) {
      clearButton.hidden = !instruction;
      clearButton.disabled = Boolean(state.sendingInstruction || state.clearingInstruction);
    }
    if (!region) return;
    region.hidden = !instruction;
    if (!instruction) return;
    setText('support-instruction-label', String(instruction.sentBy || '').toLowerCase().indexOf('codex') >= 0
      ? 'CODEX PHONE BANNER' : 'SUPPORT PHONE BANNER');
    setText('support-instruction-title', instruction.title || 'Operator instruction');
    setText('support-instruction-detail', instruction.detail || '');
    region.setAttribute('data-instruction-id', instruction.id || '');
  }

  function renderOperatorQuestion(state) {
    var question = state.snapshot && state.snapshot.activeQuestion ? state.snapshot.activeQuestion : null;
    var region = byId('operator-question');
    var options = byId('operator-question-options');
    if (!region || !options) return;
    region.hidden = !question;
    removeChildren(options);
    if (!question) return;
    var answered = question.status === 'answered';
    setText('operator-question-source', answered
      ? 'RESPONSE DELIVERED'
      : (String(question.askedBy || '').toLowerCase().indexOf('codex') >= 0
        ? 'CODEX IS ASKING' : 'SUPPORT IS ASKING'));
    setText('operator-question-prompt', question.prompt || 'Choose a response');
    setText('operator-question-status', answered
      ? 'Received by Codex and support'
      : (state.answeringQuestion ? 'Sending response…' : (state.questionError || 'Tap one answer')));
    region.setAttribute('data-state', answered ? 'answered' : 'pending');
    if (answered) {
      var receipt = document.createElement('div');
      receipt.className = 'operator-answer-receipt';
      receipt.setAttribute('role', 'status');

      var mark = document.createElement('span');
      mark.className = 'operator-answer-receipt-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = '✓';

      var copy = document.createElement('span');
      copy.className = 'operator-answer-receipt-copy';
      var answer = document.createElement('strong');
      answer.textContent = '“' + (question.answer || 'Answer') + '” sent';
      var delivery = document.createElement('span');
      delivery.textContent = 'Codex and support received your answer.';
      copy.appendChild(answer);
      copy.appendChild(delivery);
      receipt.appendChild(mark);
      receipt.appendChild(copy);
      options.appendChild(receipt);
      return;
    }
    (Array.isArray(question.options) ? question.options : []).forEach(function (option) {
      if (!option) return;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'operator-question-option';
      button.setAttribute('data-question-id', question.id || '');
      button.setAttribute('data-option-id', option.id || '');
      button.disabled = state.answeringQuestion;
      button.textContent = option.label || 'Answer';
      options.appendChild(button);
    });
  }

  function renderCaseContext(state) {
    var snapshot = state.snapshot || createEmptySnapshot(state.sessionId);
    var scene = snapshot.scene || {};
    var connected = state.sceneState === 'connected';
    var operatorJoined = snapshot.participants && Number(snapshot.participants.operator) > 0;
    var annotations = Array.isArray(snapshot.annotations) ? snapshot.annotations : [];
    var wanGuidance = annotations.filter(function (annotation) {
      return annotation && annotation.objectId === 'wan-port' && ['highlight', 'arrow', 'label'].indexOf(annotation.kind || annotation.intent) >= 0;
    });
    var approval = snapshot.activeApproval;
    var approved = approval && approval.status === 'approved' && new Date(approval.expiresAt).getTime() > Date.now();
    var context = snapshot.caseContext || {};
    var resolved = context.status === 'resolved';
	var hasWAN = Boolean(sceneObject(scene, 'wan-port'));
	setText('scene-title', scene.label || 'Awaiting scene');
	var demoRow = byId('demo-object-row');
	if (demoRow) demoRow.hidden = !hasWAN;
	if (!hasWAN) {
	  var issue = snapshot.operatorIssue;
	  var genericTitle = !operatorJoined
	    ? 'Pair the operator'
	    : (!issue
	      ? 'Waiting for operator request'
	      : (Array.isArray(scene.objects) && scene.objects.length
	        ? 'Guide the operator'
	        : 'Inspect the operator request'));
	  var genericRationale = !operatorJoined
	    ? 'Send the one-time link, then wait for the live camera.'
	    : (!issue
	      ? 'The operator is choosing a starter or entering a free-form request.'
	      : (Array.isArray(scene.objects) && scene.objects.length
	        ? 'Use the conversation and visible evidence to place reversible guidance on a verified target.'
	        : 'Inspect the live view and ask for any missing context before registering an object.'));
	  setStatus('case-status', resolved ? 'Resolved' : (operatorJoined ? 'Investigating' : 'Awaiting operator'), resolved ? 'connected' : 'pending');
	  setText('case-current-step', genericTitle);
	  setText('next-step-title', genericTitle);
	  setText('next-step-rationale', genericRationale);
	  ['approve-cable-move', 'calibrate-wan', 'resolve-case'].forEach(function (id) {
	    var control = byId(id);
	    if (control) control.hidden = true;
	  });
	  return;
	}
	['approve-cable-move', 'calibrate-wan'].forEach(function (id) {
	  var control = byId(id);
	  if (control) control.hidden = false;
	});
    var title = resolved ? 'Case resolved' : (connected ? 'Verify the WAN connection' : 'Move the modem cable to the WAN port');
    var rationale = resolved
	  ? 'The support representative verified the WAN connection and closed the troubleshooting workflow.'
	  : connected
      ? 'The cable relationship now points to WAN. Capture or compare a final snapshot to verify the repair.'
      : 'The modem cable is connected to a LAN port while the WAN port is empty.';
    if (!resolved && !operatorJoined) {
      title = 'Pair the operator';
      rationale = 'Send the one-time link, then wait for the operator camera before placing guidance.';
    } else if (!resolved && !wanGuidance.length && !connected) {
      title = 'Mark the WAN port';
      rationale = 'Use a highlight, arrow, or calibrated region so the operator can identify the correct uplink port.';
    } else if (!resolved && !approved && !connected) {
      title = 'Approve the physical instruction';
      rationale = 'Review the visible WAN guidance, then approve the one-time cable move for the operator.';
    }

    setStatus('case-status', resolved ? 'Resolved' : (connected ? 'Verifying' : (approved ? 'Approved' : (operatorJoined ? 'Investigating' : 'Awaiting operator'))), resolved ? 'connected' : (connected ? 'ready' : (approved ? 'connected' : 'pending')));
    setText('case-current-step', title);
    setText('next-step-title', title);
    setText('next-step-rationale', rationale);
    var approve = byId('approve-cable-move');
    if (approve) {
	  approve.hidden = resolved || !operatorJoined;
      approve.disabled = resolved || connected || approved || wanGuidance.length === 0;
      approve.textContent = approved ? 'Cable move approved' : 'Approve cable move';
      approve.setAttribute('data-guidance-id', wanGuidance.length ? wanGuidance[wanGuidance.length - 1].id : '');
    }
    var calibrate = byId('calibrate-wan');
    if (calibrate) {
	  calibrate.hidden = resolved || !operatorJoined;
      calibrate.disabled = Boolean(state.calibrating);
      calibrate.textContent = state.calibrationMode ? 'Cancel calibration' : (state.calibrating ? 'Saving region…' : 'Calibrate WAN region');
    }
	var resolve = byId('resolve-case');
	if (resolve) {
	  resolve.hidden = !connected || resolved;
	  resolve.disabled = !connected || resolved;
	}
  }

  function renderSceneObjects(state) {
	var list = byId('scene-object-list');
	if (!list) return;
	removeChildren(list);
	var scene = state.snapshot && state.snapshot.scene ? state.snapshot.scene : {};
	var objects = Array.isArray(scene.objects) ? scene.objects : [];
	var tracking = state.snapshot && state.snapshot.sceneTracking ? state.snapshot.sceneTracking : null;
	objects.filter(function (object) { return object && object.id !== 'wan-port'; }).forEach(function (object) {
	  var row = document.createElement('div');
	  row.className = 'object-row';
	  row.setAttribute('data-object-id', object.id || '');
	  var copy = document.createElement('div');
	  var title = document.createElement('strong');
	  title.textContent = object.label || object.id || 'Observed target';
	  var detail = document.createElement('p');
	  detail.className = 'muted';
	  detail.textContent = (object.kind || 'object') + ' · ' + Math.round(Number(object.confidence || 0) * 100) + '% confidence';
	  copy.appendChild(title);
	  copy.appendChild(detail);
	  if (tracking && tracking.objectId === object.id) {
		var trackingDetail = document.createElement('p');
		trackingDetail.className = 'muted object-tracking-detail';
		trackingDetail.textContent = tracking.needsRecalibration || tracking.status === 'recalibration_required' || tracking.status === 'reacquire_required'
		  ? 'Tracking lost · recalibrate this target'
		  : 'Tracking ' + Math.round(Number(tracking.confidence || 0) * 100) + '% · ' + String(tracking.status || 'idle').replace(/_/g, ' ');
		copy.appendChild(trackingDetail);
	  }
	  var actions = document.createElement('div');
	  actions.className = 'object-row-actions';
	  var highlightButton = document.createElement('button');
	  highlightButton.type = 'button';
	  highlightButton.className = 'primary-action compact-action scene-object-highlight';
	  highlightButton.setAttribute('data-object-id', object.id || '');
	  highlightButton.textContent = 'Highlight';
	  var recalibrateButton = document.createElement('button');
	  recalibrateButton.type = 'button';
	  recalibrateButton.className = 'secondary-action compact-action scene-object-recalibrate';
	  recalibrateButton.setAttribute('data-object-id', object.id || '');
	  recalibrateButton.setAttribute('data-object-label', object.label || object.id || 'target');
	  recalibrateButton.textContent = 'Recalibrate';
	  actions.appendChild(highlightButton);
	  actions.appendChild(recalibrateButton);
	  row.appendChild(copy);
	  row.appendChild(actions);
	  list.appendChild(row);
	});
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

  function normalizedQuad(quad) {
    if (!Array.isArray(quad) || quad.length !== 4) return null;
    var points = quad.map(normalizedPoint);
    return points.every(Boolean) ? points : null;
  }

  function trackingQuadForTransport(quad, bounds, partialVisibility) {
    if (!partialVisibility) return normalizedQuad(quad);
    if (!Array.isArray(quad) || quad.length !== 4) return null;
    var points = quad.map(function (point) {
      if (!point || !isFinite(Number(point.x)) || !isFinite(Number(point.y))) return null;
      var x = Number(point.x);
      var y = Number(point.y);
      if (x < -1 || x > 2 || y < -1 || y > 2) return null;
      return { x: x, y: y };
    });
    return points.every(Boolean) ? points : null;
  }

  function pointForObjectAnchor(bounds, anchor) {
    bounds = normalizedBounds(bounds);
    var x = anchor && isFinite(Number(anchor.x)) ? Number(anchor.x) : 0.5;
    var y = anchor && isFinite(Number(anchor.y)) ? Number(anchor.y) : 0.5;
    return normalizedPoint({ x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y });
  }

  function trackedGeometry(value, fallbackBounds, objectAnchor) {
    var geometry = value && value.bounds ? value : { bounds: value || fallbackBounds };
    var bounds = normalizedBounds(geometry.bounds || fallbackBounds);
    return {
      bounds: bounds,
      quad: normalizedQuad(geometry.quad),
      anchor: geometry.anchorVisible === false
        ? null
        : (normalizedPoint(geometry.anchor) || pointForObjectAnchor(bounds, objectAnchor)),
      anchorVisible: geometry.anchorVisible !== false,
      partialVisibility: Boolean(geometry.partialVisibility)
    };
  }

  function shortestAngle(from, to) {
    var delta = Number(to || 0) - Number(from || 0);
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return delta;
  }

  function DevicePosePredictor(onChange, onRaw) {
    this.onChange = onChange || function () {};
    this.onRaw = onRaw || function () {};
    this.current = null;
    this.baseline = null;
    this.listening = false;
    this.permission = 'unknown';
    this.staleTimer = 0;
    this.handleOrientation = this.handleOrientation.bind(this);
  }

  DevicePosePredictor.prototype.requestPermission = function () {
    var self = this;
    var OrientationEvent = window.DeviceOrientationEvent;
    if (!OrientationEvent) {
      this.permission = 'unavailable';
      return Promise.resolve(false);
    }
    var permissionRequest = typeof OrientationEvent.requestPermission === 'function'
      ? OrientationEvent.requestPermission()
      : Promise.resolve('granted');
    return permissionRequest.then(function (permission) {
      self.permission = permission === 'granted' ? 'granted' : 'denied';
      if (self.permission === 'granted') self.start();
      return self.permission === 'granted';
    }).catch(function () {
      self.permission = 'denied';
      return false;
    });
  };

  DevicePosePredictor.prototype.start = function () {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('deviceorientation', this.handleOrientation, true);
  };

  DevicePosePredictor.prototype.handleOrientation = function (event) {
    var alpha = Number(event.webkitCompassHeading);
    if (!isFinite(alpha)) alpha = Number(event.alpha);
    var beta = Number(event.beta);
    var gamma = Number(event.gamma);
    if (!isFinite(alpha) || !isFinite(beta) || !isFinite(gamma)) return;
    this.current = { alpha: alpha, beta: beta, gamma: gamma };
    this.onRaw(this.current);
    if (!this.baseline) return;
    var yaw = shortestAngle(this.baseline.alpha, alpha);
    var pitch = beta - this.baseline.beta;
    var roll = gamma - this.baseline.gamma;
    this.onChange({
      x: clamp(-yaw / 60 - roll / 180, -0.14, 0.14),
      y: clamp(-pitch / 45, -0.14, 0.14),
      yaw: yaw,
      pitch: pitch,
      roll: roll
    });
  };

  DevicePosePredictor.prototype.lock = function () {
    var self = this;
    if (this.staleTimer) window.clearTimeout(this.staleTimer);
    this.baseline = this.current ? Object.assign({}, this.current) : null;
    this.onChange({ x: 0, y: 0, yaw: 0, pitch: 0, roll: 0 });
    if (this.baseline) {
      this.staleTimer = window.setTimeout(function () {
        self.clear();
      }, 900);
    }
  };

  DevicePosePredictor.prototype.clear = function () {
    if (this.staleTimer) window.clearTimeout(this.staleTimer);
    this.staleTimer = 0;
    this.baseline = null;
    this.onChange({ x: 0, y: 0, yaw: 0, pitch: 0, roll: 0 });
  };

  DevicePosePredictor.prototype.stop = function () {
    if (this.listening) window.removeEventListener('deviceorientation', this.handleOrientation, true);
    this.listening = false;
    this.clear();
  };

  function applyPosePrediction(container, video, offset) {
    if (!container) return;
    offset = offset || { x: 0, y: 0 };
    var media = containedMediaRect(container, video);
    var translateX = Number(offset.x || 0) * media.width;
    var translateY = Number(offset.y || 0) * media.height;
    Array.prototype.forEach.call(container.querySelectorAll('.field-annotation--arrow'), function (element) {
      element.style.transform = 'translate3d(' + translateX + 'px,' + translateY + 'px,0)';
      element.setAttribute('data-pose-predicted', Math.abs(translateX) + Math.abs(translateY) > 0.5 ? 'true' : 'false');
    });
  }

  function containedMediaRect(container, video) {
    var width = container ? container.clientWidth : 0;
    var height = container ? container.clientHeight : 0;
    var mediaWidth = video ? Number(video.videoWidth) : 0;
    var mediaHeight = video ? Number(video.videoHeight) : 0;
    if (!width || !height || !mediaWidth || !mediaHeight) {
      return { left: 0, top: 0, width: width, height: height };
    }
    var scale = Math.min(width / mediaWidth, height / mediaHeight);
    var displayedWidth = mediaWidth * scale;
    var displayedHeight = mediaHeight * scale;
    return {
      left: (width - displayedWidth) / 2,
      top: (height - displayedHeight) / 2,
      width: displayedWidth,
      height: displayedHeight
    };
  }

  function annotationTimestamp(annotation) {
    var timestamp = annotation && annotation.createdAt ? new Date(annotation.createdAt).getTime() : 0;
    return isFinite(timestamp) ? timestamp : 0;
  }

  function guidanceSource(annotation) {
    return annotation && String(annotation.actor || '').toLowerCase().indexOf('codex') >= 0 ? 'CODEX' : 'SUPPORT';
  }

  function guidanceHint(annotation) {
    var kind = String(annotation && (annotation.kind || annotation.intent) || '').toLowerCase();
    if (kind === 'move') return 'Move slowly, then hold the camera steady';
    if (kind === 'view') return 'Keep the full requested area inside the frame';
    if (kind === 'closeup') return 'Approach slowly so tracking can stay locked';
    if (kind === 'angle') return 'Turn slowly and keep the marked target visible';
    if (kind === 'arrow') return 'Follow the arrow to the marked target';
    return 'Use the amber marker to find the target';
  }

  function directionGlyph(direction) {
    return { up: '↑', down: '↓', left: '←', right: '→', closer: 'IN', farther: 'OUT' }[direction] || '↗';
  }

  function annotationOverlayKey(annotation, index) {
    if (annotation && annotation.id) return 'annotation:' + annotation.id;
    return 'annotation:legacy:' + index + ':' + String(annotation && annotation.objectId || 'region') + ':' + annotationTimestamp(annotation);
  }

  function directOverlayChild(container, key) {
    var children = container ? container.children : [];
    for (var index = 0; index < children.length; index += 1) {
      if (children[index].getAttribute('data-overlay-key') === key) return children[index];
    }
    return null;
  }

  function reconcileOverlayChild(container, key, tagName, className, activeKeys) {
    var element = directOverlayChild(container, key);
    if (!element || element.tagName.toLowerCase() !== tagName) {
      if (element) element.remove();
      element = document.createElement(tagName);
      element.setAttribute('data-overlay-key', key);
    }
    if (element.className !== className) element.className = className;
    activeKeys[key] = true;
    if (element.parentNode !== container) container.appendChild(element);
    return element;
  }

  function reconcileOverlayPart(parent, className, tagName) {
    var element = parent.querySelector('.' + className);
    if (!element) {
      element = document.createElement(tagName);
      element.className = className;
      parent.appendChild(element);
    }
    return element;
  }

  function pruneOverlayChildren(container, activeKeys) {
    Array.prototype.slice.call(container.children).forEach(function (element) {
      var key = element.getAttribute('data-overlay-key');
      if (!key || !activeKeys[key]) element.remove();
    });
  }

  function renderAnnotations(container, annotations, video, scene, trackedBounds, options) {
    if (!container) return;
    options = options || {};
    var instruction = options.instruction && typeof options.instruction === 'object'
      ? options.instruction : null;
    if ((!Array.isArray(annotations) || !annotations.length) && !instruction) {
      removeChildren(container);
      return;
    }
    annotations = Array.isArray(annotations) ? annotations : [];
    var activeKeys = Object.create(null);
    var media = containedMediaRect(container, video);
    var latest = annotations.slice().sort(function (left, right) {
      return annotationTimestamp(left) - annotationTimestamp(right);
    }).pop();
    annotations.forEach(function (annotation, annotationIndex) {
      if (!annotation || !annotation.bounds) return;
      var currentObject = annotation.objectId && scene && Array.isArray(scene.objects)
        ? scene.objects.find(function (object) { return object && object.id === annotation.objectId; })
        : null;
      var tracked = annotation.objectId && trackedBounds ? trackedBounds[annotation.objectId] : null;
      var fallbackBounds = currentObject && currentObject.bounds ? currentObject.bounds : annotation.bounds;
      var geometry = trackedGeometry(tracked, fallbackBounds, annotation.anchor);
      var bounds = geometry.bounds;
      var kind = String(annotation.kind || annotation.intent || 'highlight').toLowerCase();
      var boxClassName = 'field-annotation field-annotation--' + kind.replace(/[^a-z-]/g, '');
      if (latest && annotation !== latest) boxClassName += ' field-annotation--secondary';
      var suppressed = Boolean(annotation.objectId && annotation.objectId === options.suppressedObjectId) ||
        (kind === 'arrow' && (geometry.anchorVisible === false ||
          (precisionTargetRequiresTracking(currentObject) && !tracked)));
      if (suppressed) boxClassName += ' field-annotation--suppressed';
      var box = reconcileOverlayChild(container, annotationOverlayKey(annotation, annotationIndex), 'div', boxClassName, activeKeys);
      if (annotation.id) box.setAttribute('data-annotation-id', annotation.id);
      else box.removeAttribute('data-annotation-id');
      box.hidden = suppressed;
      if (suppressed) {
        box.removeAttribute('role');
        box.setAttribute('aria-hidden', 'true');
        box.removeAttribute('aria-label');
        box.style.transform = '';
      } else {
        box.setAttribute('role', 'status');
        box.removeAttribute('aria-hidden');
        box.setAttribute('aria-label', annotation.label || 'Guidance');
      }
      var arrowPoint = kind === 'arrow' ? geometry.anchor : null;
      box.style.left = (media.left + (arrowPoint ? arrowPoint.x : bounds.x) * media.width) + 'px';
      box.style.top = (media.top + (arrowPoint ? arrowPoint.y : bounds.y) * media.height) + 'px';
      box.style.width = (arrowPoint ? 0 : bounds.width * media.width) + 'px';
      box.style.height = (arrowPoint ? 0 : bounds.height * media.height) + 'px';
      if (arrowPoint) {
        box.setAttribute('data-anchor-x', String(arrowPoint.x));
        box.setAttribute('data-anchor-y', String(arrowPoint.y));
        box.setAttribute('data-anchor-space', geometry.quad ? 'object-homography' : 'object-bounds');
      } else {
        box.removeAttribute('data-anchor-x');
        box.removeAttribute('data-anchor-y');
        box.removeAttribute('data-anchor-space');
      }
      if (annotation.objectId && !suppressed) {
        var leader = reconcileOverlayPart(box, 'field-annotation-leader', 'span');
        var targetCenter = arrowPoint ? arrowPoint.x : bounds.x + bounds.width / 2;
        leader.className = 'field-annotation-leader field-annotation-leader--' + (targetCenter < 0.5 ? 'right' : 'left');
        leader.setAttribute('aria-hidden', 'true');
      } else {
        var existingLeader = box.querySelector('.field-annotation-leader');
        if (existingLeader) existingLeader.remove();
      }
    });

    if (!latest && !instruction) {
      pruneOverlayChildren(container, activeKeys);
      return;
    }
    var trackingStatus = String(options.trackingStatus || '').replace(/_/g, ' ');
    var latestKind = instruction ? 'instruction' : String(latest.kind || latest.intent || '').toLowerCase();
    var explicitMovement = ['move', 'view', 'closeup', 'angle'].indexOf(latestKind) >= 0;
    var commandTitle = instruction ? (instruction.title || 'HOLD STEADY') : (latest.label || 'LOOK HERE');
    var commandHint = instruction ? (instruction.detail || '') : guidanceHint(latest);
    if (!instruction && explicitMovement && (trackingStatus === 'reacquire required' || trackingStatus === 'recalibration required')) {
      commandHint = 'Move slowly · target marker paused until the camera settles';
    } else if (!instruction && trackingStatus === 'reacquire required') {
      commandHint = 'Tracking paused · move slowly until the marked device is visible';
    } else if (!instruction && trackingStatus === 'recalibration required') {
      commandHint = 'Tracking paused · hold steady while the target position is recalibrated';
    }
    var latestKey = instruction
      ? 'instruction:' + String(instruction.id || instruction.sentAt || 'current')
      : annotationOverlayKey(latest, annotations.indexOf(latest));
    var command = reconcileOverlayChild(container, 'command:' + latestKey, 'div', 'guidance-command', activeKeys);
    var commandSource = instruction
      ? (String(instruction.sentBy || '').toLowerCase().indexOf('codex') >= 0 ? 'CODEX' : 'SUPPORT')
      : guidanceSource(latest);
    command.setAttribute('data-source', commandSource);
    command.setAttribute('role', 'status');
    command.setAttribute('aria-live', instruction ? 'assertive' : 'polite');
    if (instruction && instruction.id) command.setAttribute('data-instruction-id', instruction.id);
    else command.removeAttribute('data-instruction-id');
    command.style.left = media.left + 'px';
    command.style.top = media.top + 'px';
    command.style.width = media.width + 'px';
    var source = reconcileOverlayPart(command, 'guidance-command-source', 'span');
    source.textContent = 'LIVE GUIDANCE · ' + commandSource;
    var title = reconcileOverlayPart(command, 'guidance-command-title', 'strong');
    title.textContent = commandTitle;
    var hint = reconcileOverlayPart(command, 'guidance-command-hint', 'span');
    hint.textContent = commandHint;

    if (latestKind === 'move' || latestKind === 'view') {
      var directionValue = String(latest.direction || '').toLowerCase();
      var directionClassName = 'guidance-direction';
      if (directionValue === 'closer' || directionValue === 'farther') {
        directionClassName += ' guidance-direction--depth';
      }
      var direction = reconcileOverlayChild(container, 'direction:' + latestKey, 'div', directionClassName, activeKeys);
      direction.style.left = (media.left + media.width / 2) + 'px';
      direction.style.top = (media.top + media.height / 2) + 'px';
      direction.setAttribute('aria-hidden', 'true');
      direction.setAttribute('data-direction', directionValue);
      direction.textContent = directionGlyph(directionValue);
    }
    pruneOverlayChildren(container, activeKeys);
  }

  function renderConversationList(id, messages, viewerRole) {
    var list = byId(id);
    if (!list) return;
    messages = Array.isArray(messages) ? messages : [];
    var signature = messages.map(function (message) { return message && message.id || ''; }).join('|');
    if (list.getAttribute('data-message-signature') === signature) return;
    list.setAttribute('data-message-signature', signature);
    removeChildren(list);
    if (!messages.length) {
      var empty = document.createElement('li');
      empty.className = 'conversation-empty';
      empty.textContent = 'Messages will appear here.';
      list.appendChild(empty);
      return;
    }
    messages.forEach(function (message) {
      if (!message) return;
      var item = document.createElement('li');
      item.className = 'conversation-message conversation-message--' +
        (message.sender === viewerRole ? 'mine' : 'theirs');
      item.setAttribute('data-message-id', message.id || '');

      var meta = document.createElement('div');
      meta.className = 'conversation-message-meta';
      var actor = document.createElement('strong');
      actor.textContent = message.actor || readableRole(message.sender);
      var time = document.createElement('time');
      time.dateTime = message.sentAt || '';
      time.textContent = formatTime(message.sentAt);
      meta.appendChild(actor);
      meta.appendChild(time);

      var text = document.createElement('p');
      text.textContent = message.text || '';
      item.appendChild(meta);
      item.appendChild(text);
      list.appendChild(item);
    });
    list.scrollTop = list.scrollHeight;
  }

  function renderConversation(state) {
    var snapshot = state.snapshot || createEmptySnapshot(state.sessionId);
    var messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    renderConversationList('support-message-list', messages, 'support');
    renderConversationList('operator-message-list', messages, 'operator');
    setText('support-message-count', messages.length + (messages.length === 1 ? ' message' : ' messages'));
    setText('support-chat-status', state.role === 'support' ? (state.messageError || state.messageStatus || '') : '');
    setText('operator-chat-status', state.role === 'operator' ? (state.messageError || state.messageStatus || '') : '');

    var panel = byId('operator-chat-panel');
    var toggle = byId('operator-chat-toggle');
    if (panel) panel.hidden = !state.chatOpen;
    if (toggle) {
      toggle.setAttribute('aria-expanded', state.chatOpen ? 'true' : 'false');
      toggle.setAttribute('data-message-count', String(messages.length));
    }
  }

  function renderSupportIssue(state) {
    var issue = state.snapshot && state.snapshot.operatorIssue;
    var summary = byId('operator-issue-summary');
    if (summary) summary.hidden = !issue;
    if (!issue) return;
    setText('operator-issue-title', issue.summary || 'Operator request received');
    setText('operator-issue-detail', 'Sent from the operator phone');
  }

  function renderOperatorIssue(state) {
    var issue = state.snapshot && state.snapshot.operatorIssue;
    var chooser = byId('operator-issue-chooser');
    var preset = byId('operator-tv-demo');
    var input = byId('operator-freeform-issue');
    var submit = byId('operator-freeform-submit');
    var status = byId('operator-issue-status');
    if (chooser) chooser.hidden = Boolean(issue);
    if (preset) preset.disabled = state.selectingIssue;
    if (input) input.disabled = state.selectingIssue;
    if (submit) submit.disabled = state.selectingIssue;
    if (status) {
      status.textContent = state.issueError || (state.selectingIssue ? 'Starting your support flow…' : '');
      status.setAttribute('data-state', state.issueError ? 'error' : (state.selectingIssue ? 'pending' : 'idle'));
    }
  }

  function renderOperatorConnectionStatus(state, peer) {
    var diagnostics = state && state.diagnostics ? state.diagnostics : {};
    var connection = peer && typeof peer.connectionState === 'function'
      ? String(peer.connectionState() || '').toLowerCase()
      : String(diagnostics.peer || '').toLowerCase();
    var signaling = String(diagnostics.signaling || '').toLowerCase();
    var websocket = String(diagnostics.websocket || '').toLowerCase();
    var label = 'Joining session…';
    var status = 'pending';

    if (state && state.cameraError) {
      label = 'Camera unavailable';
      status = 'error';
    } else if (connection === 'connected') {
      label = 'Connected';
      status = 'connected';
    } else if (connection === 'failed' || signaling.indexOf('failed') >= 0 || signaling === 'error' || websocket === 'error') {
      label = 'Connection error';
      status = 'error';
    } else if (websocket === 'retrying' || (websocket === 'connecting' && signaling !== 'not started')) {
      label = 'Reconnecting…';
    } else if (signaling === 'closed' || (websocket === 'closed' && connection === 'closed')) {
      label = 'Session disconnected';
      status = 'error';
    } else if (signaling === 'ready sent' || signaling === 'connected') {
      label = peer && peer.localStream ? 'Ready for support' : 'Connected · camera needed';
    } else if (signaling === 'offer sent' || signaling === 'answer sent' || signaling === 'answer received' ||
        connection === 'connecting' || connection === 'checking') {
      label = 'Connecting to support…';
    } else if (websocket === 'connecting') {
      label = 'Joining session…';
    }

    setStatus('operator-connection-status', label, status);
  }

  function renderSupport(state, socket, peer) {
    var snapshot = state.snapshot || createEmptySnapshot(state.sessionId);
	var peerMediaState = peer ? peer.mediaState() : 'Waiting';
	var mediaReceiving = String(peerMediaState).toLowerCase() === 'receiving';
    var supportStage = byId('support-overlay');
    var supportTracking = snapshot.sceneTracking;
    var supportAnnotations = Array.isArray(snapshot.annotations) ? snapshot.annotations : [];
    var supportTrackedBounds = Object.create(null);
    var supportTrackingBound = Boolean(supportTracking && supportTracking.objectId && supportTracking.guidanceId && supportTracking.bounds &&
      Number(supportTracking.baseSceneVersion || 0) === sceneVersion(snapshot.scene) && supportAnnotations.some(function (annotation) {
        return annotation && annotation.id === supportTracking.guidanceId && annotation.objectId === supportTracking.objectId;
      }));
    if (supportTrackingBound && !supportTracking.needsRecalibration && supportTracking.status !== 'recalibration_required' && supportTracking.status !== 'reacquire_required') {
      supportTrackedBounds[supportTracking.objectId] = {
        bounds: supportTracking.bounds,
        quad: supportTracking.quad,
        anchor: supportTracking.anchor,
        partialVisibility: Boolean(supportTracking.partialVisibility),
        anchorVisible: supportTracking.anchorVisible !== false
      };
    }
    var supportTrackingStatus = supportTracking && String(supportTracking.status || '').replace(/_/g, ' ');
    var supportSuppressedObjectID = supportTrackingBound && (supportTracking.needsRecalibration || supportTrackingStatus === 'recalibration required' || supportTrackingStatus === 'reacquire required')
      ? supportTracking.objectId : '';
    renderAnnotations(supportStage, supportAnnotations, byId('remote-video'), snapshot.scene, supportTrackedBounds, {
      suppressedObjectId: supportSuppressedObjectID,
      trackingStatus: supportTrackingStatus,
      instruction: snapshot.operatorInstruction
    });
    renderTimeline(state);
    renderSceneSummary(state);
    renderCaseContext(state);
	renderSupportIssue(state);
	renderConversation(state);
	renderRoomContext(state);
	renderSupportInstruction(state);
	renderSupportQuestion(state);
	renderSceneObjects(state);
    renderSnapshotHistory(state);
	var sceneWorkbench = byId('scene-workbench');
	var sceneToolsGate = byId('scene-tools-gate');
	var scenePanel = document.querySelector('.scene-panel');
	if (sceneWorkbench) sceneWorkbench.hidden = !mediaReceiving;
	if (sceneToolsGate) sceneToolsGate.hidden = mediaReceiving;
	if (scenePanel) {
	  scenePanel.hidden = !mediaReceiving;
	  scenePanel.setAttribute('data-media', mediaReceiving ? 'live' : 'waiting');
	}
	if (!mediaReceiving) {
	  ['approve-cable-move', 'calibrate-wan'].forEach(function (id) {
		var control = byId(id);
		if (control) control.hidden = true;
	  });
	}

    var link = byId('operator-link');
    if (link && state.operatorPath) {
      var absolute;
      try {
        absolute = new URL(state.operatorPath, window.location.origin).href;
      } catch (_error) {
        absolute = state.operatorPath;
      }
      link.href = absolute;
      link.textContent = absolute;
      link.setAttribute('title', absolute);
      var copyControl = document.querySelector('[data-field-copy-control="operator-link"]');
      if (copyControl) copyControl.hidden = false;
    }

    var operatorCount = snapshot.participants && Number(snapshot.participants.operator);
    var videoEmpty = byId('video-empty');
    var stagePairing = byId('stage-pairing');
    var stageJoined = byId('stage-joined');
    var supportStageElement = byId('support-stage');
    if (videoEmpty) {
      videoEmpty.hidden = mediaReceiving;
      videoEmpty.setAttribute('data-state', mediaReceiving ? 'live' : (operatorCount > 0 ? 'joined' : 'pairing'));
    }
    if (stagePairing) stagePairing.hidden = mediaReceiving || operatorCount > 0;
    if (stageJoined) stageJoined.hidden = mediaReceiving || operatorCount === 0;
    if (supportStageElement) supportStageElement.setAttribute('data-state', mediaReceiving ? 'live' : (operatorCount > 0 ? 'joined' : 'pairing'));
    if (mediaReceiving) {
      setStatus('peer-status', 'Operator camera live', 'connected');
    } else if (operatorCount > 0) {
      setStatus('peer-status', 'Operator joined · waiting for camera', 'pending');
    } else {
      setStatus('peer-status', 'Waiting for operator', 'pending');
    }
    setText('signal-status', socket ? socket.readyStateLabel() : 'Connecting');
    setText('ice-status', peer ? peer.iceState() : 'New');
    setText('media-status', peerMediaState);
  }

  function renderOperator(state, socket, peer) {
    var snapshot = state.snapshot || createEmptySnapshot(state.sessionId);
    if (state.diagnostics && state.diagnostics.perception) {
      setPerceptionStatus(state.diagnostics.perception);
    }
    var annotations = Array.isArray(snapshot.annotations) ? snapshot.annotations : [];
    var hasAnnotations = annotations.length > 0;
    var activeGuidance = hasAnnotations && !state.guidanceResolved;
    var approval = snapshot.activeApproval;
    var approved = approval && approval.status === 'approved' && new Date(approval.expiresAt).getTime() > Date.now();
    var visibleAnnotations = activeGuidance ? annotations : [];
    var sharedTracking = snapshot.sceneTracking || null;
    var sharedTrackingStatus = sharedTracking && String(sharedTracking.status || '').replace(/_/g, ' ');
    var sharedTrackingBound = Boolean(sharedTracking && sharedTracking.objectId && sharedTracking.bounds &&
      Number(sharedTracking.baseSceneVersion || 0) === sceneVersion(snapshot.scene) && annotations.some(function (annotation) {
        return annotation && annotation.id === sharedTracking.guidanceId && annotation.objectId === sharedTracking.objectId;
      }));
    var sharedTrackingLost = Boolean(sharedTrackingBound && (sharedTracking.needsRecalibration ||
      sharedTrackingStatus === 'recalibration required' || sharedTrackingStatus === 'reacquire required'));
    var operatorTrackedBounds = Object.create(null);
    var sharedTrackingConfirmed = Boolean(sharedTrackingBound && !sharedTrackingLost);
    if (sharedTrackingConfirmed) {
      // Keep one geometry authority: the operator renders only geometry the
      // backend accepted, whether it came from the Mac enhanced tracker or
      // the phone's Canvas fallback. Local samples never race the shared view.
      operatorTrackedBounds[sharedTracking.objectId] = {
        bounds: sharedTracking.bounds,
        quad: sharedTracking.quad,
        anchor: sharedTracking.anchor,
        partialVisibility: Boolean(sharedTracking.partialVisibility),
        anchorVisible: sharedTracking.anchorVisible !== false
      };
    } else if (sharedTrackingLost) {
      delete operatorTrackedBounds[sharedTracking.objectId];
    }
    var suppressedObjectID = sharedTrackingLost
      ? sharedTracking.objectId
      : (sharedTrackingBound && state.trackingLostObjectID === sharedTracking.objectId ? '' : state.trackingLostObjectID);
    // Local vision is telemetry input, never rendered truth. Both role UIs
    // display only the backend-confirmed tracking snapshot so an in-flight or
    // rejected local update cannot make the operator disagree with support.
    var operatorTracking = sharedTrackingBound ? sharedTracking : null;
    state.posePredictionAllowed = !sharedTrackingLost &&
      !(sharedTrackingConfirmed && isOpenCVTrackingSource(sharedTracking.source));
    renderAnnotations(byId('operator-overlay'), visibleAnnotations, byId('local-video'), snapshot.scene, operatorTrackedBounds, {
      suppressedObjectId: suppressedObjectID,
      trackingStatus: operatorTracking && operatorTracking.status || '',
      instruction: snapshot.operatorInstruction
    });
    renderOperatorIssue(state);
    renderConversation(state);
    renderOperatorQuestion(state);
    var statusHUD = byId('operator-status-hud');
    if (statusHUD) statusHUD.hidden = !snapshot.operatorIssue;
    renderOperatorConnectionStatus(state, peer);
    var resolved = state.guidanceResolved || state.sceneState === 'connected';
    setText('operator-instruction', state.cameraError || (snapshot.operatorInstruction
      ? (snapshot.operatorInstruction.title || 'Shared instruction active.')
      : (activeGuidance
        ? (approved ? 'Approved guidance active.' : 'Visual guidance pending approval.')
        : (resolved ? 'Scene confirmed.' : 'No active instruction.'))));
    var actions = byId('operator-actions');
    var confirmButton = byId('confirm-cable-moved');
    var confirmStatus = byId('confirm-status');
    if (confirmButton) {
      confirmButton.hidden = !(activeGuidance && approved);
      confirmButton.disabled = Boolean(state.confirmingGuidance);
    }
    if (confirmStatus) {
      confirmStatus.textContent = state.confirmStatus || '';
      confirmStatus.hidden = !state.confirmStatus;
    }
    if (actions) actions.hidden = !((activeGuidance && approved) || Boolean(state.confirmStatus));
    var footer = document.querySelector('.operator-footer');
    if (footer) footer.hidden = !(snapshot.activeQuestion || (actions && !actions.hidden));
    setStatus('operator-scene-activity-status', state.sceneActivityStatus || 'Visual check idle', state.sceneActivityState || 'pending');
    var tracking = operatorTracking || {};
    var trackingStatus = String(tracking.status || '').replace(/_/g, ' ');
    var trackingLabel = trackingStatus === 'following camera drift'
      ? 'Following camera drift'
      : (trackingStatus === 'locked' ? 'Guidance tracking locked' :
        (trackingStatus === 'reacquire required' ? 'Tracking lost · hold target in view' :
		  (trackingStatus === 'recalibration required' ? 'Recalibration needed · hold target in view' :
		  (trackingStatus === 'calibrated fallback' ? 'Using calibrated region' : 'Tracking idle'))));
    setStatus('operator-tracking-status', trackingLabel,
      trackingStatus === 'following camera drift' || trackingStatus === 'locked' ? 'ready' : 'pending');
    setStatus('operator-banner-status', snapshot.operatorInstruction ? 'Banner visible' : 'No active banner',
      snapshot.operatorInstruction ? 'connected' : 'pending');
  }

  function frameDifference(left, right) {
    if (!left || !right || left.length !== right.length || left.length === 0) return 0;
    var total = 0;
    for (var index = 0; index < left.length; index += 1) {
      total += Math.abs(left[index] - right[index]);
    }
    return total / left.length / 255;
  }

  function globalFrameMotion(left, right, width) {
    if (!left || !right || left.length !== right.length || !left.length || width < 4) return 0;
    var height = Math.floor(left.length / width);
    var blockSize = 4;
    var blocks = [];
    for (var top = 0; top < height; top += blockSize) {
      for (var leftEdge = 0; leftEdge < width; leftEdge += blockSize) {
        var total = 0;
        var samples = 0;
        for (var y = top; y < Math.min(height, top + blockSize); y += 1) {
          for (var x = leftEdge; x < Math.min(width, leftEdge + blockSize); x += 1) {
            var index = y * width + x;
            total += Math.abs(left[index] - right[index]);
            samples += 1;
          }
        }
        if (samples) blocks.push(total / samples / 255);
      }
    }
    if (!blocks.length) return 0;
    blocks.sort(function (leftScore, rightScore) { return leftScore - rightScore; });
    // Camera motion changes most of the scene. A television or status panel
    // can change dramatically without moving, so ignore the noisiest 40%.
    return blocks[Math.floor((blocks.length - 1) * 0.6)];
  }

  function luminanceFromPixels(pixels) {
    var luminance = new Uint8Array(Math.floor(pixels.length / 4));
    for (var pixel = 0, output = 0; pixel < pixels.length; pixel += 4, output += 1) {
      luminance[output] = Math.round(0.2126 * pixels[pixel] + 0.7152 * pixels[pixel + 1] + 0.0722 * pixels[pixel + 2]);
    }
    return luminance;
  }

  function luminanceContrast(sample) {
    if (!sample || !sample.length) return 0;
    var total = 0;
    for (var index = 0; index < sample.length; index += 1) total += sample[index];
    var mean = total / sample.length;
    var variance = 0;
    for (var valueIndex = 0; valueIndex < sample.length; valueIndex += 1) {
      var delta = sample[valueIndex] - mean;
      variance += delta * delta;
    }
    return Math.sqrt(variance / sample.length) / 255;
  }

  function trackingAppearanceDifference(left, right, width) {
    if (!left || !right || left.length !== right.length || !left.length || width < 3) return 1;
    var height = Math.floor(left.length / width);
    if (height < 3) return 1;
    var total = 0;
    var totalWeight = 0;
    var contextBand = 2;
    for (var y = 1; y < height - 1; y += 1) {
      for (var x = 1; x < width - 1; x += 1) {
        var index = y * width + x;
        var leftDX = left[index + 1] - left[index - 1];
        var rightDX = right[index + 1] - right[index - 1];
        var leftDY = left[index + width] - left[index - width];
        var rightDY = right[index + width] - right[index - width];
        var edgeDistance = Math.min(x, y, width - 1 - x, height - 1 - y);
        // Stable target outlines and nearby room context matter much more than
        // a changing interior such as a television, monitor, or status panel.
        var weight = edgeDistance <= contextBand ? 5 : 0.05;
        var luminance = Math.abs(left[index] - right[index]) / 255;
        var edges = (Math.abs(leftDX - rightDX) + Math.abs(leftDY - rightDY)) / 1020;
        total += weight * (luminance * 0.3 + edges * 0.7);
        totalWeight += weight;
      }
    }
    return totalWeight ? total / totalWeight : 1;
  }

  function trackingSampleBounds(bounds) {
    bounds = normalizedBounds(bounds);
    var padX = Math.min(0.06, Math.max(0.012, bounds.width * 0.06));
    var padY = Math.min(0.06, Math.max(0.012, bounds.height * 0.16));
    var left = clamp(bounds.x - padX, 0, 1);
    var top = clamp(bounds.y - padY, 0, 1);
    var right = clamp(bounds.x + bounds.width + padX, left, 1);
    var bottom = clamp(bounds.y + bounds.height + padY, top, 1);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function readLuminanceRegion(video, canvas, context, bounds) {
    if (!context || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    bounds = normalizedBounds(bounds);
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    context.drawImage(
      video,
      bounds.x * video.videoWidth,
      bounds.y * video.videoHeight,
      Math.max(1, bounds.width * video.videoWidth),
      Math.max(1, bounds.height * video.videoHeight),
      0,
      0,
      canvas.width,
      canvas.height
    );
    return luminanceFromPixels(context.getImageData(0, 0, canvas.width, canvas.height).data);
  }

	function trackedCandidateBounds(anchor, current, offsetX, offsetY, scale) {
	  var maxDrift = 0.16;
	  scale = clamp(Number(scale || 1), 0.72, 1.35);
	  var width = clamp(current.width * scale, anchor.width * 0.65, Math.min(1, anchor.width * 1.55));
	  var height = clamp(current.height * scale, anchor.height * 0.65, Math.min(1, anchor.height * 1.55));
	  var centerX = current.x + current.width / 2 + offsetX;
	  var centerY = current.y + current.height / 2 + offsetY;
	  var anchorCenterX = anchor.x + anchor.width / 2;
	  var anchorCenterY = anchor.y + anchor.height / 2;
	  centerX = clamp(centerX, anchorCenterX - maxDrift, anchorCenterX + maxDrift);
	  centerY = clamp(centerY, anchorCenterY - maxDrift, anchorCenterY + maxDrift);
    return {
		x: clamp(centerX - width / 2, 0, 1 - width),
		y: clamp(centerY - height / 2, 0, 1 - height),
		width: width,
		height: height
    };
  }

  // This is intentionally a small, explainable browser-CV primitive rather
  // than a pretend object detector. It watches the calibrated target region
  // for a durable visual change, then reports an advisory signal to GoFastr.
  // The signal never changes physical state or bypasses human confirmation.
  function VisualChangeDetector(video, onStatus, onDetected, onTracked, onPerceptionStatus, options) {
    this.video = video;
    this.onStatus = onStatus || function () {};
    this.onDetected = onDetected || function () {};
    this.onTracked = onTracked || function () {};
    this.onPerceptionStatus = onPerceptionStatus || function () {};
    this.options = options || {};
    this.canvas = document.createElement('canvas');
    this.canvas.width = 32;
    this.canvas.height = 24;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.trackingCanvas = document.createElement('canvas');
    this.trackingCanvas.width = 24;
    this.trackingCanvas.height = 18;
    this.trackingContext = this.trackingCanvas.getContext('2d', { willReadFrequently: true });
    this.motionCanvas = document.createElement('canvas');
    this.motionCanvas.width = 32;
    this.motionCanvas.height = 24;
    this.motionContext = this.motionCanvas.getContext('2d', { willReadFrequently: true });
    this.timer = null;
    this.approvalKey = '';
    this.approval = null;
    this.trackingObjectID = '';
    this.trackingReferenceObjectID = '';
    this.trackingGuidanceID = '';
    this.scene = null;
    this.bounds = null;
    this.trackingAnchor = null;
    this.objectAnchor = null;
    this.trackingTemplate = null;
    this.trackingConfidence = 0;
    this.trackingFallbackNotified = false;
    this.trackingLostFrames = 0;
    this.trackingLostNotified = false;
	this.trackingUnreliableFrames = 0;
	this.trackingRecalibrationNotified = false;
    this.trackingMotionPrevious = null;
    this.trackingMotionNotified = false;
    this.trackingStableFrames = 0;
    this.baseline = null;
    this.previous = null;
    this.stableChangedFrames = 0;
    this.reported = false;
    this.perception = null;
    this.perceptionGeneration = 0;
    this.perceptionCalibrated = false;
    this.perceptionLastResult = null;
    this.perceptionNeedsReseed = false;
    this.lastPerceptionReseedAt = 0;
    this.perceptionFeatureProfile = 'default';
  }

  VisualChangeDetector.prototype.publishPerceptionStatus = function (status) {
    status = status && typeof status === 'object' ? status : {};
    var normalized = {
      state: String(status.state || 'idle'),
      source: String(status.source || 'calibrated-region'),
      label: String(status.label || 'Spatial perception idle'),
      reason: String(status.reason || '')
    };
    this.onPerceptionStatus(normalized);
  };

  VisualChangeDetector.prototype.updatePose = function (pose) {
    if (!this.perception || typeof this.perception.updatePose !== 'function') return false;
    return this.perception.updatePose(pose);
  };

  VisualChangeDetector.prototype.stopEnhancedPerception = function (label, reason) {
    this.perceptionGeneration += 1;
    var engine = this.perception;
    this.perception = null;
    this.perceptionCalibrated = false;
    this.perceptionLastResult = null;
    this.perceptionNeedsReseed = false;
    if (engine) {
      try {
        if (typeof engine.destroy === 'function') engine.destroy();
        else if (typeof engine.stop === 'function') engine.stop();
      } catch (_error) {}
    }
    this.publishPerceptionStatus({
      state: 'idle',
      source: 'calibrated-region',
      label: label || 'Spatial perception idle',
      reason: reason || ''
    });
  };

  VisualChangeDetector.prototype.startEnhancedPerception = function (bounds, anchorPoint, featureProfile) {
    this.stopEnhancedPerception();
    this.perceptionFeatureProfile = String(featureProfile || 'default') === 'reflective-plane'
      ? 'reflective-plane'
      : 'default';
    if (this.options.enhanced === false) {
      this.publishPerceptionStatus({
        state: 'remote',
        source: 'support-console',
        label: 'Spatial analysis runs on support console'
      });
      return;
    }
    var perception = window.FieldAssistPerception;
    var Constructor = perception && perception.PerceptionEngine;
    if (typeof Constructor !== 'function') {
      this.publishPerceptionStatus({
        state: 'fallback',
        source: 'browser-multiscale-template',
        label: 'Advanced perception unavailable · using browser fallback',
        reason: 'opencv-unavailable'
      });
      return;
    }

    var self = this;
    var generation = this.perceptionGeneration;
    var engine;
    try {
      engine = new Constructor(this.video, function (result) {
        if (generation !== self.perceptionGeneration || self.perception !== engine || !self.approvalKey) return;
        self.handleEnhancedPerceptionResult(result, generation);
      }, function (status) {
        if (generation !== self.perceptionGeneration || self.perception !== engine || !self.approvalKey) return;
        self.publishPerceptionStatus(status);
        if (status && status.state === 'fallback' && String(status.source || '').indexOf('opencv') < 0) {
          self.perceptionCalibrated = false;
          // The 125-candidate Canvas search needs a calmer cadence than the
          // phone's lightweight OpenCV worker to avoid chasing decoder noise.
          self.options.sampleDelay = Math.max(350, Number(self.options.sampleDelay || 0));
        } else if (status && (status.state === 'ready' || String(status.source || '').indexOf('opencv') === 0)) {
          self.options.sampleDelay = Math.max(120, Math.min(300, Number(self.options.sampleDelay || 200)));
        }
      }, this.options.perception || {});
      this.perception = engine;
      this.publishPerceptionStatus({
        state: 'loading',
        source: 'calibrated-region',
        label: 'Loading OpenCV spatial tracker'
      });
      engine.start(bounds, anchorPoint, featureProfile);
    } catch (_error) {
      if (generation === this.perceptionGeneration) {
        if (engine) {
          try {
            if (typeof engine.destroy === 'function') engine.destroy();
            else if (typeof engine.stop === 'function') engine.stop();
          } catch (_destroyError) {}
        }
        this.perception = null;
        this.perceptionCalibrated = false;
        this.publishPerceptionStatus({
          state: 'fallback',
          source: 'browser-multiscale-template',
          label: 'Advanced perception unavailable · using browser fallback',
          reason: 'opencv-unavailable'
        });
      }
    }
  };

  VisualChangeDetector.prototype.handleEnhancedPerceptionResult = function (result, generation) {
    if (generation !== this.perceptionGeneration || !this.approvalKey || !result) return;
    var objectID = this.trackingObjectID || (this.approval && this.approval.targetObjectId) || 'wan-port';
    var guidanceID = this.trackingGuidanceID || (this.approval && this.approval.guidanceId) || '';
    var source = String(result.source || 'opencv-homography');
    var lost = Boolean(result.lost);
    var bounds = normalizedBounds(result.bounds || this.bounds || this.trackingAnchor);
    var depthScore = optionalNumber(result.depthScore);
    var depthConfidence = optionalNumber(result.depthConfidence);
    var depthRelative = optionalNumber(result.depthRelative);
    var modelRelativeDepth = optionalNumber(result.modelRelativeDepth !== undefined ? result.modelRelativeDepth : result.depthRelative);
    var tracking = Object.assign({}, result, {
      objectId: objectID,
      referenceObjectId: this.trackingReferenceObjectID,
      guidanceId: guidanceID,
      approvalId: this.approval && this.approval.id ? this.approval.id : '',
      bounds: bounds,
      source: source,
      depthSource: normalizedDepthSource(result.depthSource),
      depthScore: depthScore === null ? null : clamp(depthScore, 0, 1),
      depthConfidence: depthConfidence === null ? null : clamp(depthConfidence, 0, 1),
      depthRelative: depthRelative === null ? null : clamp(depthRelative, 0.25, 4),
      modelRelativeDepth: modelRelativeDepth === null ? null : clamp(modelRelativeDepth, 0.25, 4)
    });
    if (lost) {
      this.perceptionCalibrated = false;
      this.perceptionLastResult = null;
      this.perceptionNeedsReseed = true;
      this.publishPerceptionStatus({
        state: 'fallback',
        source: 'browser-multiscale-template',
        label: 'OpenCV target lost · using browser fallback',
        reason: result.reason || 'opencv-lost'
      });
      this.onTracked({
        objectId: objectID,
        referenceObjectId: this.trackingReferenceObjectID,
        guidanceId: guidanceID,
        approvalId: tracking.approvalId,
        bounds: this.bounds || this.trackingAnchor,
        quad: null,
        anchor: null,
        confidence: 0,
        moved: false,
        lost: true,
        fallback: true,
        // Preserve the enhanced engine identity for this transition so the
        // server can replace stale locked geometry with reacquire_required.
        // Canvas remains local and still cannot overwrite a healthy Mac lock.
        source: source,
        depthSource: '',
        depthScore: null,
        depthConfidence: null,
        depthRelative: null,
        modelRelativeDepth: null,
        reason: result.reason || 'opencv-lost'
      });
      return;
    }
    if (!isOpenCVTrackingSource(source) || !tracking.bounds || tracking.bounds.width <= 0 || tracking.bounds.height <= 0) return;
    this.perceptionCalibrated = true;
    this.perceptionLastResult = tracking;
    this.perceptionNeedsReseed = false;
    this.onTracked(tracking);
  };

  VisualChangeDetector.prototype.sampleEnhancedPerception = function () {
    if (!this.perception || !this.approvalKey || typeof this.perception.sample !== 'function') return false;
    try {
      this.perception.sample();
    } catch (_error) {
      this.stopEnhancedPerception();
      this.perceptionCalibrated = false;
      this.publishPerceptionStatus({
        state: 'fallback',
        source: 'browser-multiscale-template',
        label: 'Advanced perception unavailable · using browser fallback',
        reason: 'opencv-runtime-error'
      });
    }
    return this.perceptionCalibrated;
  };

  VisualChangeDetector.prototype.emitCanvasTracking = function (tracking) {
    if (this.perceptionCalibrated) return;
    tracking = Object.assign({
      source: 'browser-multiscale-template',
      depthSource: '',
      depthScore: null,
      depthConfidence: null,
      depthRelative: null,
      modelRelativeDepth: null
    }, tracking || {});
    tracking.referenceObjectId = this.trackingReferenceObjectID;
    if (tracking.bounds && !tracking.anchor) {
      tracking.anchor = pointForObjectAnchor(tracking.bounds, this.objectAnchor);
    }
    if (this.perceptionNeedsReseed && this.perceptionFeatureProfile !== 'reflective-plane' &&
        !tracking.lost && !tracking.recalibrationRequired &&
        Number(tracking.confidence || 0) >= 0.5 && this.perception &&
        typeof this.perception.recalibrate === 'function' &&
        Date.now() - this.lastPerceptionReseedAt >= 1200) {
      this.lastPerceptionReseedAt = Date.now();
      this.perceptionNeedsReseed = !this.perception.recalibrate(tracking.bounds, tracking.anchor);
    }
    this.onTracked(tracking);
  };

  VisualChangeDetector.prototype.sync = function (approval, scene, resolved, annotations) {
    var approved = approval && approval.status === 'approved' &&
      new Date(approval.expiresAt).getTime() > Date.now() && !resolved;
    var activeAnnotation = Array.isArray(annotations) ? annotations.filter(function (annotation) {
      return annotation && annotation.objectId && sceneObject(scene, annotation.objectId);
    }).sort(function (left, right) {
      return annotationTimestamp(left) - annotationTimestamp(right);
    }).pop() : null;
    var objectID = approved
      ? (approval.targetObjectId || 'wan-port')
      : (activeAnnotation && activeAnnotation.objectId);
    var active = Boolean(objectID) && !resolved;
    var target = active ? sceneObject(scene, objectID) : null;
    var reference = target ? trackingReferenceForObject(scene, target) : null;
    var targetBounds = target && normalizedBounds(target.bounds || target.Bounds);
    var bounds = reference && normalizedBounds(reference.bounds || reference.Bounds);
    var key = active
      ? (approved ? String(approval.id || '') : 'annotation:' + String(activeAnnotation.id || objectID)) + ':' +
        String(reference && (reference.id || reference.ID) || objectID) + ':' + String(sceneVersion(scene))
      : '';
    if (!active || !key || !bounds || bounds.width <= 0 || bounds.height <= 0) {
      if (this.approvalKey) this.stop(resolved ? 'Visual check complete' : 'Visual check idle', resolved ? 'connected' : 'pending');
      return;
    }
    if (this.approvalKey === key) {
      this.scene = scene;
      return;
    }
    this.stop();
    this.approvalKey = key;
    this.approval = approved ? approval : null;
    this.trackingObjectID = objectID;
    this.trackingReferenceObjectID = reference && (reference.id || reference.ID) !== objectID
      ? String(reference.id || reference.ID || '')
      : '';
    this.trackingGuidanceID = approved ? String(approval.guidanceId || '') : String(activeAnnotation.id || '');
    this.scene = scene;
    this.bounds = bounds;
    this.trackingAnchor = bounds;
    this.objectAnchor = targetAnchorWithinReference(
      targetBounds,
      activeAnnotation && activeAnnotation.anchor ? activeAnnotation.anchor : null,
      bounds
    );
    this.startEnhancedPerception(
      bounds,
      pointForObjectAnchor(bounds, this.objectAnchor),
      perceptionFeatureProfile(reference)
    );
    this.onStatus('Watching guided region', 'pending');
    this.schedule(120);
  };

  VisualChangeDetector.prototype.schedule = function (delay) {
    var self = this;
    if (!this.approvalKey || this.reported || this.timer) return;
    this.timer = window.setTimeout(function () {
      self.timer = null;
      self.sample();
    }, delay == null ? Number(this.options.sampleDelay || 350) : delay);
  };

  VisualChangeDetector.prototype.readFrame = function () {
    if (!this.context || !this.video || this.video.readyState < 2 || !this.video.videoWidth || !this.video.videoHeight) {
      return null;
    }
    var bounds = this.bounds || { x: 0, y: 0, width: 1, height: 1 };
    var padX = Math.max(0.025, bounds.width * 0.25);
    var padY = Math.max(0.025, bounds.height * 0.25);
    var left = clamp(bounds.x - padX, 0, 1);
    var top = clamp(bounds.y - padY, 0, 1);
    var right = clamp(bounds.x + bounds.width + padX, left, 1);
    var bottom = clamp(bounds.y + bounds.height + padY, top, 1);
    var sourceWidth = Math.max(1, (right - left) * this.video.videoWidth);
    var sourceHeight = Math.max(1, (bottom - top) * this.video.videoHeight);
    this.context.drawImage(
      this.video,
      left * this.video.videoWidth,
      top * this.video.videoHeight,
      sourceWidth,
      sourceHeight,
      0,
      0,
      this.canvas.width,
      this.canvas.height
    );
    return luminanceFromPixels(this.context.getImageData(0, 0, this.canvas.width, this.canvas.height).data);
  };

  VisualChangeDetector.prototype.trackRegion = function () {
    if (!this.bounds || !this.trackingAnchor || !this.trackingContext) return false;
    var motionFrame = readLuminanceRegion(
      this.video,
      this.motionCanvas,
      this.motionContext,
      { x: 0, y: 0, width: 1, height: 1 }
    );
    var motionScore = this.trackingMotionPrevious && motionFrame
      ? globalFrameMotion(this.trackingMotionPrevious, motionFrame, this.motionCanvas.width)
      : 0;
    if (motionFrame) this.trackingMotionPrevious = motionFrame;
    if (motionScore > 0.035) {
      this.trackingStableFrames = 0;
      if (!this.trackingMotionNotified) {
        this.trackingMotionNotified = true;
        this.trackingRecalibrationNotified = true;
        this.emitCanvasTracking({
          objectId: this.trackingObjectID || (this.approval && this.approval.targetObjectId) || 'wan-port',
          guidanceId: this.trackingGuidanceID,
          bounds: this.bounds,
          confidence: 0,
          moved: false,
          recalibrationRequired: true,
          reason: 'camera-motion'
        });
      }
      return false;
    }
    if (this.trackingMotionNotified) {
      if (motionScore < 0.015) this.trackingStableFrames += 1;
      else this.trackingStableFrames = 0;
      if (this.trackingStableFrames < 2) return false;
      this.trackingMotionNotified = false;
      this.trackingStableFrames = 0;
    }
    if (!this.trackingTemplate) {
      var initial = readLuminanceRegion(
        this.video,
        this.trackingCanvas,
        this.trackingContext,
        trackingSampleBounds(this.bounds)
      );
      if (!initial || luminanceContrast(initial) < 0.045) {
        this.trackingConfidence = 0;
        if (!this.trackingFallbackNotified) {
          this.trackingFallbackNotified = true;
          this.emitCanvasTracking({
            objectId: this.trackingObjectID || (this.approval && this.approval.targetObjectId) || 'wan-port',
            guidanceId: this.trackingGuidanceID,
            bounds: this.trackingAnchor,
            confidence: 0,
            moved: false,
            fallback: true
          });
        }
        return false;
      }
      var reacquiredAfterFallback = this.trackingFallbackNotified;
      this.trackingFallbackNotified = false;
	  this.trackingUnreliableFrames = 0;
	  this.trackingRecalibrationNotified = false;
      this.trackingTemplate = initial;
      this.trackingConfidence = 1;
      this.emitCanvasTracking({
        objectId: this.trackingObjectID || (this.approval && this.approval.targetObjectId) || 'wan-port',
        guidanceId: this.trackingGuidanceID,
        bounds: this.bounds,
        confidence: 1,
        moved: false
      });
      return reacquiredAfterFallback;
    }

    var recovering = this.trackingRecalibrationNotified || this.trackingLostNotified;
    var radiusX = recovering
      ? Math.min(0.16, Math.max(0.06, this.bounds.width * 0.55))
      : Math.min(0.08, Math.max(0.025, this.bounds.width * 0.4));
    var radiusY = recovering
      ? Math.min(0.16, Math.max(0.06, this.bounds.height * 0.55))
      : Math.min(0.08, Math.max(0.025, this.bounds.height * 0.4));
    var offsetsX = [-radiusX, -radiusX / 2, 0, radiusX / 2, radiusX];
    var offsetsY = [-radiusY, -radiusY / 2, 0, radiusY / 2, radiusY];
	var scales = recovering ? [0.75, 0.875, 1, 1.15, 1.3] : [0.9, 0.95, 1, 1.05, 1.1];
    var best = null;
    var candidates = [];
    var currentScore = null;
	for (var scaleIndex = 0; scaleIndex < scales.length; scaleIndex += 1) {
	  for (var yIndex = 0; yIndex < offsetsY.length; yIndex += 1) {
		for (var xIndex = 0; xIndex < offsetsX.length; xIndex += 1) {
        var candidateBounds = trackedCandidateBounds(
          this.trackingAnchor,
          this.bounds,
          offsetsX[xIndex],
		  offsetsY[yIndex],
		  scales[scaleIndex]
        );
        var candidate = readLuminanceRegion(
          this.video,
          this.trackingCanvas,
          this.trackingContext,
          trackingSampleBounds(candidateBounds)
        );
        var score = trackingAppearanceDifference(this.trackingTemplate, candidate, this.trackingCanvas.width);
		if (offsetsX[xIndex] === 0 && offsetsY[yIndex] === 0 && scales[scaleIndex] === 1) currentScore = score;
        var ranked = { bounds: candidateBounds, score: score };
        candidates.push(ranked);
        if (!best || score < best.score) best = ranked;
		}
      }
    }
    if (!best || best.score > 0.12) {
      this.trackingConfidence = 0;
	  this.trackingUnreliableFrames = 0;
      this.trackingLostFrames += 1;
      if (this.trackingLostFrames >= 3 && !this.trackingLostNotified) {
        this.trackingLostNotified = true;
        this.emitCanvasTracking({
          objectId: this.trackingObjectID || (this.approval && this.approval.targetObjectId) || 'wan-port',
          guidanceId: this.trackingGuidanceID,
          bounds: this.bounds,
          confidence: 0,
          moved: false,
          lost: true
        });
      }
      return false;
    }
    var recoveredAfterLoss = this.trackingLostNotified;
    this.trackingLostFrames = 0;
    this.trackingLostNotified = false;
    candidates.sort(function (left, right) { return left.score - right.score; });
    var bestCenterX = best.bounds.x + best.bounds.width / 2;
    var bestCenterY = best.bounds.y + best.bounds.height / 2;
    var runnerUp = candidates.find(function (candidate) {
      var centerX = candidate.bounds.x + candidate.bounds.width / 2;
      var centerY = candidate.bounds.y + candidate.bounds.height / 2;
      return Math.abs(centerX - bestCenterX) > 0.018 || Math.abs(centerY - bestCenterY) > 0.018 ||
        Math.abs(candidate.bounds.width - best.bounds.width) > 0.025;
    });
    var ambiguous = Boolean(runnerUp && best.score > 0.012 && runnerUp.score - best.score < 0.006);
    var moved = Math.abs(best.bounds.x - this.bounds.x) > 0.002 ||
	  Math.abs(best.bounds.y - this.bounds.y) > 0.002 ||
	  Math.abs(best.bounds.width - this.bounds.width) > 0.002 ||
	  Math.abs(best.bounds.height - this.bounds.height) > 0.002;
    // Avoid walking the box on compression noise or repeated textures. A new
    // location must beat the current one by a meaningful luminance margin.
    // Scale candidates use a smaller margin because a growing target retains
    // more of the original template than a translated false-positive does.
    var sizeChanged = Math.abs(best.bounds.width - this.bounds.width) > 0.002 ||
	  Math.abs(best.bounds.height - this.bounds.height) > 0.002;
    var improvementMargin = sizeChanged ? 0.002 : 0.012;
    if (moved && currentScore !== null && best.score > currentScore - improvementMargin) {
      this.trackingConfidence = clamp(1 - currentScore / 0.12, 0, 1);
	  if (ambiguous) this.trackingConfidence = Math.min(this.trackingConfidence, 0.42);
	  this.reportTrackingMatch(false, recoveredAfterLoss);
      return false;
    }
    this.bounds = best.bounds;
    this.trackingConfidence = clamp(1 - best.score / 0.12, 0, 1);
	if (ambiguous) this.trackingConfidence = Math.min(this.trackingConfidence, 0.42);
	this.reportTrackingMatch(moved, recoveredAfterLoss);
    return false;
  };

  VisualChangeDetector.prototype.reportTrackingMatch = function (moved, recoveredAfterLoss) {
	var anchor = this.trackingAnchor;
	var bounds = this.bounds;
	var anchorArea = anchor ? anchor.width * anchor.height : 0;
	var trackedArea = bounds ? bounds.width * bounds.height : 0;
	var scale = anchorArea > 0 && trackedArea > 0 ? Math.sqrt(trackedArea / anchorArea) : 1;
	var centerDriftX = anchor && bounds ? Math.abs((bounds.x + bounds.width / 2) - (anchor.x + anchor.width / 2)) : 0;
	var centerDriftY = anchor && bounds ? Math.abs((bounds.y + bounds.height / 2) - (anchor.y + anchor.height / 2)) : 0;
	var mediumConfidenceGeometryJump = this.trackingConfidence < 0.72 && (
	  Math.abs(scale - 1) > 0.12 || centerDriftX > 0.06 || centerDriftY > 0.06
	);
	var unreliableMatch = this.trackingConfidence > 0 && (
	  this.trackingConfidence < 0.25 ||
	  (this.trackingConfidence < 0.5 && Boolean(moved)) ||
	  mediumConfidenceGeometryJump
	);
	if (unreliableMatch) this.trackingUnreliableFrames += 1;
	else this.trackingUnreliableFrames = 0;
	var requiresRecalibration = this.trackingUnreliableFrames >= 2;
	var recalibrationTransition = requiresRecalibration && !this.trackingRecalibrationNotified;
	var recoveredAfterRecalibration = !unreliableMatch && this.trackingRecalibrationNotified;
	if (recalibrationTransition) this.trackingRecalibrationNotified = true;
	else if (recoveredAfterRecalibration) this.trackingRecalibrationNotified = false;
	if (!moved && !recoveredAfterLoss && !recalibrationTransition && !recoveredAfterRecalibration) return;
    this.emitCanvasTracking({
	  objectId: this.trackingObjectID || (this.approval && this.approval.targetObjectId) || 'wan-port',
	  guidanceId: this.trackingGuidanceID,
	  bounds: this.bounds,
	  confidence: this.trackingConfidence,
	  moved: Boolean(moved || recoveredAfterLoss),
	  recalibrationRequired: this.trackingRecalibrationNotified
	});
  };

  VisualChangeDetector.prototype.sample = function () {
    if (!this.approvalKey || this.reported) return;
    var current;
    try {
      current = this.readFrame();
    } catch (_error) {
      this.onStatus('Visual check unavailable', 'error');
      this.stop();
      return;
    }
    if (!current) {
      this.schedule();
      return;
    }
    if (!this.baseline) {
      this.sampleEnhancedPerception();
      if (!this.perceptionCalibrated) this.trackRegion();
      current = this.readFrame() || current;
      this.baseline = current;
      this.previous = current;
      this.schedule();
      return;
    }
    this.sampleEnhancedPerception();
    var rebaselineForTracking = this.perceptionCalibrated ? false : this.trackRegion();
    current = this.readFrame() || current;
    if (rebaselineForTracking) {
      this.baseline = current;
      this.previous = current;
      this.stableChangedFrames = 0;
      this.schedule();
      return;
    }
    // Unapproved visual guidance is still registered to the camera locally,
    // but only the approved demo workflow can infer and report a physical
    // scene change. This keeps ordinary annotations useful without widening
    // the authorization boundary.
    if (!this.approval) {
      this.baseline = current;
      this.previous = current;
      this.schedule();
      return;
    }
    var changeScore = frameDifference(current, this.baseline);
    var motionScore = frameDifference(current, this.previous);
    this.previous = current;
    if (changeScore >= 0.065) {
      if (motionScore <= 0.025) this.stableChangedFrames += 1;
      else this.stableChangedFrames = 0;
      this.onStatus(this.stableChangedFrames >= 2 ? 'Visual change detected · hold steady' : 'Watching visual change', 'ready');
      if (this.stableChangedFrames >= 3) {
        this.reported = true;
        this.onStatus('View changed · confirm cable is seated', 'connected');
        this.onDetected({
          approvalId: this.approval.id,
          baseSceneVersion: sceneVersion(this.scene),
          changeScore: Math.min(1, Math.max(0.05, changeScore))
        });
        return;
      }
    } else {
      this.stableChangedFrames = 0;
      this.onStatus('Watching guided region', 'pending');
    }
    this.schedule();
  };

  VisualChangeDetector.prototype.allowRetry = function () {
    if (!this.approvalKey) return;
    this.reported = false;
    this.stableChangedFrames = 0;
    this.schedule(700);
  };

  VisualChangeDetector.prototype.stop = function (label, state) {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.stopEnhancedPerception();
    this.approvalKey = '';
    this.approval = null;
    this.trackingObjectID = '';
    this.trackingReferenceObjectID = '';
    this.trackingGuidanceID = '';
    this.scene = null;
    this.bounds = null;
    this.trackingAnchor = null;
    this.objectAnchor = null;
    this.trackingTemplate = null;
    this.trackingConfidence = 0;
    this.trackingFallbackNotified = false;
    this.trackingLostFrames = 0;
    this.trackingLostNotified = false;
	this.trackingUnreliableFrames = 0;
	this.trackingRecalibrationNotified = false;
    this.trackingMotionPrevious = null;
    this.trackingMotionNotified = false;
    this.trackingStableFrames = 0;
    this.perceptionNeedsReseed = false;
    this.lastPerceptionReseedAt = 0;
    this.baseline = null;
    this.previous = null;
    this.stableChangedFrames = 0;
    this.reported = false;
    this.onTracked(null);
    if (label) this.onStatus(label, state || 'pending');
  };

  function SocketController(role, sessionId, onEvent, onStatus) {
    this.role = role;
    this.sessionId = sessionId;
    this.onEvent = onEvent;
    this.onStatus = onStatus || function () {};
    this.ws = null;
    this.closed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.outbox = [];
  }

  SocketController.prototype.readyStateLabel = function () {
    if (!this.ws) return this.closed ? 'closed' : 'connecting';
    if (typeof window.WebSocket === 'undefined') return 'unknown';
    switch (this.ws.readyState) {
      case window.WebSocket.CONNECTING: return 'connecting';
      case window.WebSocket.OPEN: return 'open';
      case window.WebSocket.CLOSING: return 'closing';
      case window.WebSocket.CLOSED: return 'closed';
      default: return 'unknown';
    }
  };

  SocketController.prototype.start = function () {
    this.closed = false;
    this.connect();
  };

  SocketController.prototype.connect = function () {
    var self = this;
    if (this.closed || (this.ws && typeof window.WebSocket !== 'undefined' &&
      (this.ws.readyState === window.WebSocket.OPEN || this.ws.readyState === window.WebSocket.CONNECTING))) {
      return;
    }
    var socket;
    try {
      if (typeof window.WebSocket !== 'function') throw new Error('This browser does not support WebSocket signaling.');
      socket = new window.WebSocket(websocketURL(this.sessionId, this.role));
    } catch (error) {
      this.onStatus('error', formatError(error));
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    this.onStatus('connecting');
    socket.onopen = function () {
      if (self.ws !== socket) return;
      self.reconnectAttempt = 0;
      self.onStatus('open');
      var pending = self.outbox.slice();
      self.outbox = [];
      pending.forEach(function (message) {
        self.send(message.type, message.payload);
      });
    };
    socket.onmessage = function (message) {
      if (self.ws !== socket) return;
      var event;
      try {
        event = JSON.parse(message.data);
      } catch (_error) {
        return;
      }
      self.onEvent(event);
    };
    socket.onerror = function () {
      if (self.ws === socket) self.onStatus('error', 'WebSocket error');
    };
    socket.onclose = function () {
      if (self.ws !== socket) return;
      self.ws = null;
      self.onStatus('closed');
      self.scheduleReconnect();
    };
  };

  SocketController.prototype.scheduleReconnect = function () {
    var self = this;
    if (this.closed || this.reconnectTimer) return;
    var exponent = Math.min(this.reconnectAttempt, 5);
    var delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, exponent));
    var jitter = Math.floor(Math.random() * Math.min(250, delay / 2));
    this.reconnectAttempt += 1;
    this.onStatus('retrying', delay + jitter);
    this.reconnectTimer = window.setTimeout(function () {
      self.reconnectTimer = null;
      self.connect();
    }, delay + jitter);
  };

  SocketController.prototype.isOpen = function () {
    return Boolean(this.ws && typeof window.WebSocket !== 'undefined' && this.ws.readyState === window.WebSocket.OPEN);
  };

  SocketController.prototype.send = function (type, payload) {
    var message = { type: type, payload: payload == null ? {} : payload };
    if (!this.isOpen()) {
      if (this.outbox.length >= 64) this.outbox.shift();
      this.outbox.push(message);
      return false;
    }
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (_error) {
      if (this.outbox.length < 64) this.outbox.push(message);
      return false;
    }
  };

  SocketController.prototype.close = function () {
    this.closed = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.outbox = [];
    if (this.ws) {
      var socket = this.ws;
      this.ws = null;
      try { socket.close(); } catch (_error) {}
    }
  };

  function serializableCandidate(candidate) {
    if (!candidate) return null;
    if (typeof candidate.toJSON === 'function') return candidate.toJSON();
    return {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      usernameFragment: candidate.usernameFragment
    };
  }

  function descriptionFromPayload(payload, type) {
    var value = parseMaybeJSON(payload);
    if (value && value.description) value = parseMaybeJSON(value.description);
    if (!value || typeof value !== 'object' || !value.sdp) return null;
    return { type: value.type || type, sdp: value.sdp };
  }

  function candidateFromPayload(payload) {
    var value = parseMaybeJSON(payload);
    if (value && value.candidate && typeof value.candidate === 'object') {
      return value.candidate;
    }
    if (typeof value === 'string') return { candidate: value };
    if (value && typeof value === 'object' && value.candidate) return value;
    return null;
  }

  function PeerController(role, socket, state, onRender) {
    this.role = role;
    this.socket = socket;
    this.state = state;
    this.onRender = onRender || function () {};
    this.pc = null;
    this.generation = 0;
    this.pendingCandidates = [];
    this.remoteDescriptionReady = false;
    this.localStream = null;
    this.remoteStream = null;
    this.offerInFlight = false;
    this.lastOfferSDP = '';
    this.handlingOfferSDP = '';
    this.lastAnswerSDP = '';
    this.readyTimer = null;
    this.poseChannel = null;
    this.poseSendSequence = 0;
    this.lastPoseSequence = 0;
    this.onPose = function () {};
    this.remoteVideo = byId('remote-video');
    this.localVideo = byId('local-video');
    this.videoEmpty = byId('video-empty');
  }

  PeerController.prototype.connectionState = function () {
    if (!this.pc) return 'not created';
    return this.pc.connectionState || this.pc.iceConnectionState || 'unknown';
  };

  PeerController.prototype.iceState = function () {
    if (!this.pc) return 'new';
    var ice = this.pc.iceConnectionState || 'new';
    // Chromium can continue reporting `checking` briefly after a usable
    // connection has already delivered the first remote track. Surface the
    // effective connection state to the console while diagnostics still keep
    // the raw ICE gathering state below.
    if ((this.pc.connectionState === 'connected' || this.remoteStream) &&
      (ice === 'new' || ice === 'checking')) {
      return 'connected';
    }
    return ice;
  };

  PeerController.prototype.mediaState = function () {
    if (this.role === 'operator') {
      if (!this.localStream) return 'waiting';
      var tracks = this.localStream.getVideoTracks ? this.localStream.getVideoTracks() : [];
      return tracks.length && tracks[0].readyState === 'live' ? 'camera ready' : 'camera stopped';
    }
    if (!this.remoteStream || !this.remoteStream.getVideoTracks) return 'waiting';
    var remoteTracks = this.remoteStream.getVideoTracks();
    return remoteTracks.some(function (track) { return track.readyState === 'live'; }) ? 'receiving' : 'waiting';
  };

  PeerController.prototype.isUsable = function () {
    if (!this.pc) return false;
    var connection = this.pc.connectionState;
    var ice = this.pc.iceConnectionState;
    return connection !== 'failed' && connection !== 'closed' &&
      ice !== 'failed' && ice !== 'closed';
  };

  PeerController.prototype.setupPoseChannel = function (channel) {
    if (!channel || channel.label !== 'fieldassist-pose') return;
    var self = this;
    this.poseChannel = channel;
    channel.onmessage = function (event) {
      if (self.role !== 'support') return;
      var value;
      try { value = JSON.parse(String(event.data || '')); } catch (_error) { return; }
      if (!value || value.type !== 'pose' || !isFinite(Number(value.alpha)) ||
          !isFinite(Number(value.beta)) || !isFinite(Number(value.gamma))) return;
      var sequence = Number(value.sequence || 0);
      if (!isFinite(sequence) || sequence <= self.lastPoseSequence) return;
      self.lastPoseSequence = sequence;
      self.onPose({
        alpha: Number(value.alpha),
        beta: Number(value.beta),
        gamma: Number(value.gamma),
        at: Date.now(),
        sentAt: Number(value.sentAt || 0)
      });
    };
    channel.onclose = function () {
      if (self.poseChannel === channel) self.poseChannel = null;
    };
  };

  PeerController.prototype.sendPose = function (pose) {
    var channel = this.poseChannel;
    if (this.role !== 'operator' || !channel || channel.readyState !== 'open' || !pose ||
        Number(channel.bufferedAmount || 0) > 1024) return false;
    try {
      this.poseSendSequence += 1;
      channel.send(JSON.stringify({
        type: 'pose',
        sequence: this.poseSendSequence,
        sentAt: Date.now(),
        alpha: Number(pose.alpha),
        beta: Number(pose.beta),
        gamma: Number(pose.gamma)
      }));
      return true;
    } catch (_error) {
      return false;
    }
  };

  PeerController.prototype.createPeer = function () {
    var self = this;
    if (typeof window.RTCPeerConnection !== 'function') {
      this.state.diagnostics.peer = 'WebRTC unavailable';
      this.onRender();
      return null;
    }
    if (this.pc && this.isUsable()) return this.pc;
    // ICE can arrive before the first offer/answer. There is no old peer to
    // invalidate in that case, so keep those candidates for the new peer.
    var queuedCandidates = this.pc ? [] : this.pendingCandidates.slice();
    this.closePeer();
    this.pendingCandidates = queuedCandidates;
    var pc;
    try {
      // STUN is intentionally the only server-assisted transport here.  The
      // application never receives or records the camera media.
      pc = new window.RTCPeerConnection(RTC_CONFIGURATION);
    } catch (error) {
      this.state.diagnostics.peer = 'create failed';
      this.onRender();
      return null;
    }
    this.pc = pc;
    this.generation += 1;
    var generation = this.generation;
    this.remoteDescriptionReady = false;
    this.pendingCandidates = [];
    this.state.diagnostics.peer = 'new';

    pc.ondatachannel = function (event) {
      if (self.pc !== pc || self.generation !== generation) return;
      self.setupPoseChannel(event.channel);
    };
    if (this.role === 'support' && typeof pc.createDataChannel === 'function') {
      try {
        this.setupPoseChannel(pc.createDataChannel('fieldassist-pose', {
          ordered: false,
          maxRetransmits: 0
        }));
      } catch (_poseChannelError) {}
    }

    if (this.role === 'support' && typeof pc.addTransceiver === 'function') {
      try {
        // The support side is the offerer, so it must advertise that it can
        // receive video before the operator answers with a camera track.
        pc.addTransceiver('video', { direction: 'recvonly' });
      } catch (_error) {
        // Older WebKit versions can still negotiate when the operator's
        // offer contains a media section; leave the peer usable.
      }
    }

    if (this.role === 'operator' && this.localStream) {
      this.addLocalTracks(pc, this.localStream);
    }

    pc.onicecandidate = function (event) {
      if (self.pc !== pc || self.generation !== generation || !event.candidate) return;
      self.socket.send('webrtc.ice_candidate', { candidate: serializableCandidate(event.candidate) });
    };
    pc.onicegatheringstatechange = function () {
      if (self.pc !== pc || self.generation !== generation) return;
      self.state.diagnostics.ice = pc.iceGatheringState || self.iceState();
      self.onRender();
    };
    pc.oniceconnectionstatechange = function () {
      if (self.pc !== pc || self.generation !== generation) return;
      self.state.diagnostics.ice = self.iceState();
      self.sendPeerState();
      self.onRender();
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        self.handlePeerFailure();
      }
    };
    pc.onconnectionstatechange = function () {
      if (self.pc !== pc || self.generation !== generation) return;
      self.state.diagnostics.peer = self.connectionState();
      self.sendPeerState();
      self.onRender();
      if (self.connectionState() === 'connected' && self.readyTimer) {
        window.clearInterval(self.readyTimer);
        self.readyTimer = null;
      }
      if (self.connectionState() === 'connected') {
        self.refreshCandidateDiagnostics();
        window.setTimeout(function () { self.refreshCandidateDiagnostics(); }, 500);
      }
      if (self.connectionState() === 'failed' || self.connectionState() === 'closed') {
        self.handlePeerFailure();
      }
    };
    pc.ontrack = function (event) {
      if (self.pc !== pc || self.generation !== generation) return;
      if (!self.remoteStream && typeof window.MediaStream === 'function') self.remoteStream = new window.MediaStream();
      var incomingTracks = event.streams && event.streams[0] && event.streams[0].getTracks
        ? event.streams[0].getTracks()
        : (event.track ? [event.track] : []);
      incomingTracks.forEach(function (track) {
        if (!self.remoteStream || !self.remoteStream.addTrack) return;
        var exists = self.remoteStream.getTracks().some(function (candidate) { return candidate.id === track.id; });
        if (!exists) self.remoteStream.addTrack(track);
      });
      if (!self.remoteStream) return;
      if (self.remoteVideo && self.remoteStream.getVideoTracks().length) {
        self.remoteVideo.srcObject = self.remoteStream;
        self.remoteVideo.muted = true;
        var playResult = self.remoteVideo.play();
        if (playResult && typeof playResult.catch === 'function') playResult.catch(function () {});
      }
      if (self.videoEmpty && self.remoteStream.getVideoTracks().length) self.videoEmpty.hidden = true;
      self.state.diagnostics.media = self.mediaState();
      self.refreshCandidateDiagnostics();
      self.onRender();
    };
    this.onRender();
    return pc;
  };

  PeerController.prototype.addLocalTracks = function (pc, stream) {
    if (!pc || !stream || !stream.getTracks) return;
    var existing = pc.getSenders ? pc.getSenders() : [];
    stream.getTracks().forEach(function (track) {
      var alreadyAdded = existing.some(function (sender) {
        return sender && sender.track && sender.track.id === track.id;
      });
      if (!alreadyAdded) {
        try { pc.addTrack(track, stream); } catch (_error) {}
      }
    });
  };

  PeerController.prototype.closePeer = function () {
    if (this.poseChannel) {
      try { this.poseChannel.close(); } catch (_poseError) {}
    }
    this.poseChannel = null;
    this.lastPoseSequence = 0;
    if (this.pc) {
      try { this.pc.onicecandidate = null; } catch (_error) {}
      try { this.pc.ondatachannel = null; } catch (_dataError) {}
      try { this.pc.close(); } catch (_error2) {}
    }
    this.pc = null;
    this.generation += 1;
    this.remoteDescriptionReady = false;
    this.pendingCandidates = [];
    this.offerInFlight = false;
    this.lastOfferSDP = '';
    this.handlingOfferSDP = '';
    this.lastAnswerSDP = '';
    this.remoteStream = null;
    if (this.remoteVideo) this.remoteVideo.srcObject = null;
    if (this.role === 'support' && this.videoEmpty) this.videoEmpty.hidden = false;
    this.state.diagnostics.peer = 'closed';
    this.state.diagnostics.ice = 'closed';
  };

  PeerController.prototype.handlePeerFailure = function () {
    var connection = this.connectionState();
    var ice = this.iceState();
    if (connection !== 'failed' && connection !== 'closed' && ice !== 'failed' && ice !== 'closed') return;
    this.closePeer();
    if (this.role === 'operator' && this.localStream && this.socket.isOpen()) {
      this.startReadyPulse();
    }
    if (this.role === 'support' && this.socket.isOpen()) {
      this.socket.send('webrtc.renegotiate', { reason: 'support peer failed' });
    }
    this.onRender();
  };

  PeerController.prototype.sendPeerState = function () {
    if (!this.pc) return;
    this.socket.send('webrtc.state_changed', {
      connectionState: this.connectionState(),
      iceConnectionState: this.iceState(),
      role: this.role,
      candidatePair: this.state.diagnostics.candidatePair || null
    });
  };

  PeerController.prototype.refreshCandidateDiagnostics = function () {
    var self = this;
    var pc = this.pc;
    if (!pc || typeof pc.getStats !== 'function') return;
    Promise.resolve(pc.getStats()).then(function (report) {
      if (self.pc !== pc || !report) return;
      var pair;
      report.forEach(function (stat) {
        if (stat.type === 'transport' && stat.selectedCandidatePairId && report.get) {
          pair = report.get(stat.selectedCandidatePairId) || pair;
        }
      });
      if (!pair) {
        report.forEach(function (stat) {
          if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) {
            pair = pair || stat;
          }
        });
      }
      if (!pair) return;
      var local = pair.localCandidateId && report.get ? report.get(pair.localCandidateId) : null;
      var remote = pair.remoteCandidateId && report.get ? report.get(pair.remoteCandidateId) : null;
      var localType = local && local.candidateType ? local.candidateType : 'unknown';
      var remoteType = remote && remote.candidateType ? remote.candidateType : 'unknown';
      self.state.diagnostics.candidatePair = {
        localType: localType,
        remoteType: remoteType,
        protocol: (local && local.protocol) || (remote && remote.protocol) || 'unknown',
        relay: localType === 'relay' || remoteType === 'relay'
      };
      self.sendPeerState();
      self.onRender();
    }).catch(function () {
      // Candidate stats are diagnostic only; lack of support must not disturb
      // an otherwise healthy media session.
    });
  };

  PeerController.prototype.flushCandidates = function () {
    var self = this;
    if (!this.pc || !this.remoteDescriptionReady) return;
    var candidates = this.pendingCandidates.slice();
    this.pendingCandidates = [];
    candidates.forEach(function (candidate) {
      self.addCandidate(candidate);
    });
  };

  PeerController.prototype.addCandidate = function (candidate) {
    var self = this;
    if (!candidate) return;
    if (!this.pc || !this.remoteDescriptionReady) {
      this.pendingCandidates.push(candidate);
      return;
    }
    Promise.resolve(this.pc.addIceCandidate(candidate)).catch(function () {
      // A candidate can race a peer replacement.  It is safe to ignore it;
      // the next offer will produce a fresh candidate set.
      if (self.pc) self.state.diagnostics.lastEvent = 'webrtc.ice_candidate (ignored)';
      self.onRender();
    });
  };

  PeerController.prototype.handleCandidate = function (payload) {
    var candidate = candidateFromPayload(payload);
    if (candidate) this.addCandidate(candidate);
  };

  PeerController.prototype.startSupportOffer = function () {
    var self = this;
    if (this.role !== 'support' || this.offerInFlight) return;
    var pc = this.createPeer();
    if (!pc || pc.signalingState !== 'stable') return;
    if (pc.localDescription && pc.localDescription.type === 'offer') return;
    this.offerInFlight = true;
    Promise.resolve().then(function () {
      return pc.createOffer();
    }).then(function (offer) {
      if (self.pc !== pc) throw new Error('peer replaced');
      return pc.setLocalDescription(offer);
    }).then(function () {
      if (self.pc !== pc || !pc.localDescription) return;
      self.lastOfferSDP = pc.localDescription.sdp || '';
      self.socket.send('webrtc.offer', {
        type: pc.localDescription.type || 'offer',
        sdp: pc.localDescription.sdp
      });
      self.state.diagnostics.signaling = 'offer sent';
      self.onRender();
    }).catch(function (error) {
      if (self.pc === pc) {
        self.state.diagnostics.signaling = 'offer failed';
        self.state.diagnostics.lastEvent = formatError(error);
        self.onRender();
      }
    }).then(function () {
      self.offerInFlight = false;
    });
  };

  PeerController.prototype.handleReady = function (fromRole) {
    if (this.role !== 'support' || (fromRole && fromRole !== 'operator')) return;
    var connection = this.connectionState();
    if (this.pc && this.isUsable() && connection === 'connected') return;
    // A fresh ready pulse is authoritative. A stale local offer can survive a
    // signaling reconnect even though its answer was lost, so replace any
    // non-connected peer before creating the next offer.
    if (this.pc) this.closePeer();
    this.startSupportOffer();
  };

  PeerController.prototype.handleOffer = function (payload, fromRole) {
    var self = this;
    if (this.role !== 'operator' || (fromRole && fromRole !== 'support')) return;
    var description = descriptionFromPayload(payload, 'offer');
    if (!description) return;
    if (this.lastOfferSDP === description.sdp || this.handlingOfferSDP === description.sdp) return;
    this.handlingOfferSDP = description.sdp;
    var pc = this.pc;
    if (pc && !this.isUsable()) {
      this.closePeer();
      pc = null;
    }
    if (pc && pc.remoteDescription && this.lastOfferSDP && this.lastOfferSDP !== description.sdp) {
      this.closePeer();
      pc = null;
    }
    pc = pc || this.createPeer();
    if (!pc) {
      this.handlingOfferSDP = '';
      return;
    }
    Promise.resolve().then(function () {
      return pc.setRemoteDescription(description);
    }).then(function () {
      if (self.pc !== pc) throw new Error('peer replaced');
      self.remoteDescriptionReady = true;
      self.flushCandidates();
      return pc.createAnswer();
    }).then(function (answer) {
      if (self.pc !== pc) throw new Error('peer replaced');
      return pc.setLocalDescription(answer);
    }).then(function () {
      if (self.pc !== pc || !pc.localDescription) return;
      self.lastOfferSDP = description.sdp;
      self.lastAnswerSDP = pc.localDescription.sdp || '';
      self.socket.send('webrtc.answer', {
        type: pc.localDescription.type || 'answer',
        sdp: pc.localDescription.sdp
      });
      self.state.diagnostics.signaling = 'answer sent';
      self.onRender();
    }).catch(function (error) {
      if (self.pc === pc) {
        self.state.diagnostics.signaling = 'answer failed';
        self.state.diagnostics.lastEvent = formatError(error);
        self.onRender();
      }
    }).then(function () {
      if (self.handlingOfferSDP === description.sdp) self.handlingOfferSDP = '';
    });
  };

  PeerController.prototype.handleAnswer = function (payload, fromRole) {
    var self = this;
    if (this.role !== 'support' || (fromRole && fromRole !== 'operator')) return;
    var description = descriptionFromPayload(payload, 'answer');
    if (!description || !this.pc || this.lastAnswerSDP === description.sdp) return;
    if (this.pc.signalingState !== 'have-local-offer') return;
    Promise.resolve(this.pc.setRemoteDescription(description)).then(function () {
      self.remoteDescriptionReady = true;
      self.lastAnswerSDP = description.sdp;
      self.flushCandidates();
      self.state.diagnostics.signaling = 'answer received';
      self.onRender();
    }).catch(function (error) {
      self.state.diagnostics.signaling = 'answer failed';
      self.state.diagnostics.lastEvent = formatError(error);
      self.onRender();
    });
  };

  PeerController.prototype.handleSignal = function (event, data, fromRole) {
    switch (event.type) {
      case 'webrtc.ready':
        this.handleReady(fromRole);
        break;
      case 'webrtc.offer':
        this.handleOffer(data, fromRole);
        break;
      case 'webrtc.answer':
        this.handleAnswer(data, fromRole);
        break;
      case 'webrtc.ice_candidate':
        this.handleCandidate(data);
        break;
      case 'webrtc.state_changed':
        if (data && data.connectionState) {
          this.state.diagnostics.remotePeer = data.connectionState;
        }
        this.onRender();
        break;
      case 'webrtc.renegotiate':
        if (this.role === 'operator' && (!fromRole || fromRole === 'support')) {
          this.closePeer();
          this.startReadyPulse();
        }
        break;
      default:
        break;
    }
  };

  PeerController.prototype.setLocalStream = function (stream) {
    if (!stream) return;
    this.localStream = stream;
    if (this.localVideo) {
      this.localVideo.srcObject = stream;
      this.localVideo.muted = true;
      var playResult = this.localVideo.play();
      if (playResult && typeof playResult.catch === 'function') playResult.catch(function () {});
    }
    if (this.pc) this.addLocalTracks(this.pc, stream);
    this.state.diagnostics.media = 'camera ready';
    this.onRender();
  };

  PeerController.prototype.sendReady = function () {
    if (this.role !== 'operator' || !this.localStream) return;
    this.socket.send('webrtc.ready', {
      version: 1,
      media: ['video'],
      facingMode: 'environment'
    });
    this.state.diagnostics.signaling = 'ready sent';
    this.onRender();
  };

  PeerController.prototype.startReadyPulse = function () {
    var self = this;
    if (this.role !== 'operator' || this.readyTimer || !this.localStream) return;
    this.sendReady();
    this.readyTimer = window.setInterval(function () {
      if (!self.localStream) return;
      if (self.connectionState() === 'connected') {
        window.clearInterval(self.readyTimer);
        self.readyTimer = null;
        return;
      }
      self.sendReady();
    }, READY_PULSE_MS);
  };

  PeerController.prototype.onSocketOpen = function () {
    if (this.role === 'operator' && this.localStream) {
      this.startReadyPulse();
      return;
    }
    if (this.role === 'support' && this.pc && this.connectionState() !== 'connected') {
      this.closePeer();
      this.socket.send('webrtc.renegotiate', { reason: 'support signaling restored' });
    }
  };

  PeerController.prototype.destroy = function () {
    if (this.readyTimer) window.clearInterval(this.readyTimer);
    this.readyTimer = null;
    this.closePeer();
    if (this.localStream && this.localStream.getTracks) {
      this.localStream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (_error) {}
      });
    }
    this.localStream = null;
  };

  function initLanding() {
    var form = byId('create-session-form');
    if (!form) return;
    var button = byId('create-session');
    var status = byId('create-status');
    form.addEventListener('submit', function (event) {
      // The regular POST /sessions/new remains the fallback, which keeps the
      // landing page usable if fetch is disabled or the JSON route changes.
      if (typeof window.fetch !== 'function') return;
      event.preventDefault();
      if (button) button.disabled = true;
      if (status) status.textContent = 'Creating a secure field session…';
      fetchJSON('/api/sessions', {
        method: 'POST',
        headers: requestHeaders(true),
		body: JSON.stringify({ mode: 'live' })
      }).then(function (created) {
        if (!created || !created.supportPath) throw new Error('The session did not return a support link.');
        if (status) status.textContent = 'Opening the support console…';
        window.location.assign(created.supportPath);
      }).catch(function () {
        // A native form submission is the server-supported fallback.  Use the
        // prototype method so a control named "submit" cannot shadow it.
        if (button) button.disabled = false;
        if (status) status.textContent = 'Opening the support console…';
        HTMLFormElement.prototype.submit.call(form);
      });
    });
  }

  function initSupport() {
    var root = byId('support-app');
    if (!root) return;

    bindModalDialog('tools-dialog-trigger', 'tools-dialog', 'tools-dialog-close');
    bindModalDialog('support-banner-dialog-trigger', 'support-banner-dialog', 'support-banner-dialog-close');
    var cameraStatusHUD = byId('camera-status-hud');
    var cameraStatusToggle = byId('camera-status-toggle');
    if (cameraStatusHUD && cameraStatusToggle) {
      cameraStatusToggle.addEventListener('click', function () {
        var expanded = cameraStatusHUD.getAttribute('data-expanded') === 'true';
        cameraStatusHUD.setAttribute('data-expanded', expanded ? 'false' : 'true');
        cameraStatusToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        cameraStatusToggle.setAttribute('aria-label', expanded ? 'Show scene system status' : 'Hide scene system status');
      });
      cameraStatusHUD.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        cameraStatusHUD.setAttribute('data-expanded', 'false');
        cameraStatusToggle.setAttribute('aria-expanded', 'false');
        cameraStatusToggle.setAttribute('aria-label', 'Show scene system status');
        cameraStatusToggle.focus();
      });
    }

    var state = new SessionState('support', pathSessionId());
    state.diagnostics.perception = {
      state: 'idle',
      source: 'support-console',
      label: 'Spatial perception idle',
      reason: ''
    };
    var socket;
    var peer;
    var changeDetector;
    var pendingTrackingTelemetry = null;
    var trackingTelemetryInFlight = false;
    var lastTrackingTelemetrySignature = '';
    var eventRenderTimer = 0;
    function render() {
      renderSupport(state, socket, peer);
      setPerceptionStatus(state.diagnostics.perception, 'support-perception-status');
      if (changeDetector) {
        changeDetector.sync(
          state.snapshot.activeApproval,
          state.snapshot.scene,
          state.guidanceResolved,
          state.snapshot.annotations
        );
      }
    }

    function scheduleEventRender() {
      if (eventRenderTimer) return;
      eventRenderTimer = window.setTimeout(function () {
        eventRenderTimer = 0;
        render();
      }, 0);
    }

    function socketStatus(status, detail) {
      state.diagnostics.websocket = status;
      if (status === 'open') {
        state.diagnostics.signaling = 'connected';
        if (peer) peer.onSocketOpen();
        setStatus('peer-status', 'Signaling connected · waiting for operator', 'pending');
      } else if (status === 'connecting') {
        setStatus('peer-status', 'Connecting to session…', 'pending');
      } else if (status === 'retrying') {
        state.diagnostics.reconnectAttempt += 1;
        setStatus('peer-status', 'Reconnecting…', 'pending');
      } else if (status === 'error') {
        state.diagnostics.signaling = detail || 'error';
        setStatus('peer-status', 'Connection error', 'error');
      } else if (status === 'closed') {
        state.diagnostics.signaling = 'closed';
        setStatus('peer-status', 'Session disconnected', 'error');
      }
      scheduleEventRender();
    }

    function eventReceived(event) {
      var payload = parseMaybeJSON(event && event.payload);
      var relayed = payload && typeof payload === 'object' && hasOwn.call(payload, 'data');
      var data = relayed ? parseMaybeJSON(payload.data) : payload;
      var fromRole = relayed ? payload.fromRole : '';
      state.applyIncoming(event);
      if (peer && event && event.type && event.type.indexOf('webrtc.') === 0) {
        peer.handleSignal(event, data, fromRole);
      }
      scheduleEventRender();
    }

    function runTool(path, body) {
      var options = {
        method: 'POST',
        headers: requestHeaders(body !== undefined)
      };
      if (body !== undefined) options.body = JSON.stringify(body);
      return fetchJSON(path, options);
    }

    var supportChatForm = byId('support-chat-form');
    if (supportChatForm) supportChatForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (state.sendingMessage) return;
      var input = byId('support-chat-input');
      var text = input ? String(input.value || '').trim() : '';
      if (!text) {
        state.messageError = 'Write a message first.';
        render();
        if (input) input.focus();
        return;
      }
      state.sendingMessage = true;
      state.messageError = '';
      state.messageStatus = 'Sending…';
      if (input) input.disabled = true;
      render();
      fetchJSON('/api/support/messages', {
        method: 'POST', headers: requestHeaders(true), body: JSON.stringify({ text: text })
      }).then(function (result) {
        if (!result || !result.message) throw new Error('The message was not accepted.');
        state.addMessage(result.message);
        if (input) input.value = '';
        state.messageStatus = 'Sent';
      }).catch(function (error) {
        state.messageError = 'Could not send · ' + formatError(error);
        state.messageStatus = '';
      }).then(function () {
        state.sendingMessage = false;
        if (input) input.disabled = false;
        render();
      });
    });

    var supportBannerForm = byId('support-banner-form');
    if (supportBannerForm) supportBannerForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (state.sendingInstruction) return;
      var titleInput = byId('support-banner-title');
      var detailInput = byId('support-banner-detail');
      var title = titleInput ? String(titleInput.value || '').trim() : '';
      var detail = detailInput ? String(detailInput.value || '').trim() : '';
      if (!title || !detail) {
        state.instructionError = 'Add both a short command and what the operator should do.';
        state.instructionStatus = '';
        render();
        if (!title && titleInput) titleInput.focus();
        else if (detailInput) detailInput.focus();
        return;
      }
      state.sendingInstruction = true;
      state.instructionError = '';
      state.instructionStatus = 'Sending to operator phone…';
      render();
      runTool('/api/tools/send-operator-instruction', { title: title, detail: detail }).then(function (result) {
        if (!result || !result.instruction) throw new Error('The phone banner was not accepted.');
        state.snapshot.operatorInstruction = result.instruction;
        if (result.timelineItem) state.addTimeline(result.timelineItem);
        if (titleInput) titleInput.value = '';
        if (detailInput) detailInput.value = '';
        state.instructionStatus = 'Visible on operator phone';
        var bannerDialog = byId('support-banner-dialog');
        if (bannerDialog && typeof bannerDialog.close === 'function') bannerDialog.close();
        else if (bannerDialog) bannerDialog.removeAttribute('open');
      }).catch(function (error) {
        state.instructionError = 'Could not send · ' + formatError(error);
        state.instructionStatus = '';
      }).then(function () {
        state.sendingInstruction = false;
        render();
      });
    });

    var supportBannerClear = byId('support-banner-clear');
    if (supportBannerClear) supportBannerClear.addEventListener('click', function () {
      if (state.clearingInstruction || !state.snapshot.operatorInstruction) return;
      state.clearingInstruction = true;
      state.instructionError = '';
      state.instructionStatus = 'Removing from operator phone…';
      render();
      fetchJSON('/api/support/operator-instruction/clear', {
        method: 'POST', headers: requestHeaders(true), body: '{}'
      }).then(function (result) {
        if (!result || !result.success) throw new Error('The phone banner was not removed.');
        state.snapshot.operatorInstruction = null;
        if (result.timelineItem) state.addTimeline(result.timelineItem);
        state.instructionStatus = 'Removed from operator phone';
      }).catch(function (error) {
        state.instructionError = 'Could not remove · ' + formatError(error);
        state.instructionStatus = '';
      }).then(function () {
        state.clearingInstruction = false;
        render();
      });
    });

    function flushTrackingTelemetry() {
      if (trackingTelemetryInFlight || !pendingTrackingTelemetry) return;
      var queued = pendingTrackingTelemetry;
      pendingTrackingTelemetry = null;
      trackingTelemetryInFlight = true;
      fetchJSON('/api/support/scene-tracking', {
        method: 'POST',
        headers: requestHeaders(true),
        body: JSON.stringify(queued.payload)
      }).then(function (result) {
        lastTrackingTelemetrySignature = queued.signature;
        state.diagnostics.trackingTelemetry = result && result.recorded === false ? 'deduplicated' : 'reported';
        if (result && result.tracking) {
          state.snapshot.sceneTracking = result.tracking;
          scheduleEventRender();
        }
      }).catch(function (error) {
        state.diagnostics.trackingTelemetry = 'retrying';
        state.diagnostics.lastEvent = formatError(error);
        if (queued.attempt < 2 && !pendingTrackingTelemetry) {
          queued.attempt += 1;
          pendingTrackingTelemetry = queued;
          window.setTimeout(flushTrackingTelemetry, 1000 * queued.attempt);
        }
      }).then(function () {
        trackingTelemetryInFlight = false;
        flushTrackingTelemetry();
      });
    }

    function queueTrackingTelemetry(tracking) {
      var approval = state.snapshot.activeApproval;
      var approved = approval && approval.status === 'approved';
      if (!tracking || !tracking.objectId || !tracking.bounds || (!approved && !tracking.guidanceId)) return;
      var evidence = perceptionTrackingFields(tracking);
      var source = isOpenCVTrackingSource(evidence.source) || evidence.source === 'browser-multiscale-template'
        ? evidence.source
        : 'browser-multiscale-template';
      // The support console publishes only enhanced geometry. The phone owns
      // the shared Canvas fallback, avoiding two low-resolution trackers
      // racing to replace one another when OpenCV is unavailable.
      if (source === 'browser-multiscale-template') return;
      var depthConfidence = evidence.depthConfidence === null ? 0 : evidence.depthConfidence;
      var modelRelativeDepth = evidence.modelRelativeDepth === null ? 0 : evidence.modelRelativeDepth;
      var depthSource = evidence.depthSource;
      if (isDepthBackedTrackingSource(source) && (!depthSource || depthConfidence <= 0 || modelRelativeDepth < 0.25)) {
        source = 'opencv-homography';
      }
      var payload = {
        approvalId: approved ? approval.id : '',
        guidanceId: tracking.guidanceId || (approved ? approval.guidanceId : ''),
        objectId: tracking.objectId,
        referenceObjectId: tracking.referenceObjectId || '',
        baseSceneVersion: sceneVersion(state.snapshot.scene),
        status: tracking.lost ? 'reacquire_required' : (tracking.recalibrationRequired ? 'recalibration_required' : (tracking.fallback ? 'calibrated_fallback' : (tracking.moved ? 'following_camera_drift' : 'locked'))),
        confidence: Math.round(Number(tracking.confidence || 0) * 1000000) / 1000000,
        bounds: tracking.bounds,
        source: source,
        poseState: evidence.poseState,
        poseFailureReason: evidence.poseFailureReason,
        poseInliers: Math.round(evidence.poseInliers),
        poseInlierRatio: Math.round(evidence.poseInlierRatio * 1000000) / 1000000,
        partialVisibility: evidence.partialVisibility,
        visibleFraction: Math.round(evidence.visibleFraction * 1000000) / 1000000,
        anchorVisible: evidence.anchorVisible
      };
      var transportQuad = trackingQuadForTransport(tracking.quad, tracking.bounds, evidence.partialVisibility);
      if (transportQuad) payload.quad = transportQuad;
      if (normalizedPoint(tracking.anchor)) payload.anchor = normalizedPoint(tracking.anchor);
      if (isDepthBackedTrackingSource(source)) {
        payload.depthSource = depthSource;
        payload.depthScore = clamp(evidence.depthScore === null ? 0 : evidence.depthScore, 0, 1);
        payload.depthConfidence = clamp(depthConfidence, 0, 1);
        payload.modelRelativeDepth = clamp(modelRelativeDepth, 0.25, 4);
      }
      var signature = JSON.stringify(payload);
      if (signature === lastTrackingTelemetrySignature || (pendingTrackingTelemetry && pendingTrackingTelemetry.signature === signature)) return;
      pendingTrackingTelemetry = { payload: payload, signature: signature, attempt: 0 };
      flushTrackingTelemetry();
    }

    function setToolButtonBusy(id, busy) {
      var button = byId(id);
      if (button) button.disabled = busy;
    }

    function sceneActionError(error) {
      var message = formatError(error);
      state.actionStatus = 'Scene action failed · ' + message;
      state.diagnostics.lastEvent = message;
      render();
    }

    var calibrationGesture = null;
    var calibrationOverlay = byId('support-overlay');
	var calibrationPurpose = 'calibrate';
	var pendingTargetLabel = '';
	var calibrationObjectID = 'wan-port';

    function stopCalibration(message) {
      state.calibrationMode = false;
      calibrationGesture = null;
	  calibrationPurpose = 'calibrate';
	  pendingTargetLabel = '';
	  calibrationObjectID = 'wan-port';
      if (calibrationOverlay) calibrationOverlay.classList.remove('calibration-active');
      if (message) state.actionStatus = message;
      render();
    }

    function calibrationPoint(event) {
      var video = byId('remote-video');
      var rect = calibrationOverlay.getBoundingClientRect();
      var media = containedMediaRect(calibrationOverlay, video);
      var x = event.clientX - rect.left;
      var y = event.clientY - rect.top;
      if (x < media.left || y < media.top || x > media.left + media.width || y > media.top + media.height) return null;
      return {
        x: clamp((x - media.left) / media.width, 0, 1),
        y: clamp((y - media.top) / media.height, 0, 1),
        media: media
      };
    }

    if (calibrationOverlay) {
      calibrationOverlay.addEventListener('pointerdown', function (event) {
        if (!state.calibrationMode || state.calibrating) return;
        var point = calibrationPoint(event);
        if (!point) return;
        event.preventDefault();
        calibrationOverlay.setPointerCapture(event.pointerId);
        calibrationGesture = { pointerId: event.pointerId, start: point, current: point };
      });
      calibrationOverlay.addEventListener('pointermove', function (event) {
        if (!calibrationGesture || calibrationGesture.pointerId !== event.pointerId) return;
        var point = calibrationPoint(event);
        if (!point) return;
        calibrationGesture.current = point;
        var x = Math.min(calibrationGesture.start.x, point.x);
        var y = Math.min(calibrationGesture.start.y, point.y);
        var bounds = { x: x, y: y, width: Math.abs(point.x - calibrationGesture.start.x), height: Math.abs(point.y - calibrationGesture.start.y) };
        var draft = calibrationOverlay.querySelector('.calibration-draft');
        if (!draft) {
          draft = document.createElement('div');
          draft.className = 'calibration-draft';
          calibrationOverlay.appendChild(draft);
        }
        draft.style.left = (point.media.left + bounds.x * point.media.width) + 'px';
        draft.style.top = (point.media.top + bounds.y * point.media.height) + 'px';
        draft.style.width = (bounds.width * point.media.width) + 'px';
        draft.style.height = (bounds.height * point.media.height) + 'px';
      });
      calibrationOverlay.addEventListener('pointerup', function (event) {
        if (!calibrationGesture || calibrationGesture.pointerId !== event.pointerId) return;
        var start = calibrationGesture.start;
        var end = calibrationGesture.current;
        calibrationGesture = null;
        var bounds = {
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y)
        };
        if (bounds.width < 0.01 || bounds.height < 0.01) {
          state.actionStatus = 'Calibration region is too small · drag a larger box';
          render();
          return;
        }
		state.calibrating = true;
		var creatingTarget = calibrationPurpose === 'create';
		var recalibratingTarget = calibrationPurpose === 'recalibrate';
		state.actionStatus = creatingTarget ? 'Adding observed target…' : (recalibratingTarget ? 'Recalibrating observed target…' : 'Saving calibrated WAN region…');
		render();
		var path = creatingTarget ? '/api/session/scene/objects' : '/api/session/scene/calibration';
		var input = creatingTarget ? {
		  label: pendingTargetLabel,
		  kind: 'device-control',
		  bounds: bounds,
		  baseSceneVersion: sceneVersion(state.snapshot.scene)
		} : {
		  objectId: recalibratingTarget ? calibrationObjectID : 'wan-port',
		  bounds: bounds,
		  baseSceneVersion: sceneVersion(state.snapshot.scene)
		};
		runTool(path, input).then(function (result) {
		  if (result && result.scene) state.setScene(result.scene);
		  if (result && result.timelineItem) state.addTimeline(result.timelineItem);
		  stopCalibration(creatingTarget
			? 'Observed target added · WebMCP can inspect and highlight it'
			: (recalibratingTarget ? 'Target recalibrated · tracking will lock to the new bounds' : 'WAN region calibrated · scene bounds updated'));
		}).catch(sceneActionError).then(function () {
		  state.calibrating = false;
		  render();
		});
      });
    }

    var approveButton = byId('approve-cable-move');
    if (approveButton) approveButton.addEventListener('click', function () {
      var guidanceId = approveButton.getAttribute('data-guidance-id') || '';
      if (!guidanceId) {
        state.actionStatus = 'Highlight or point to the WAN port before approval';
        render();
        return;
      }
      approveButton.disabled = true;
      state.actionStatus = 'Recording human support approval…';
      render();
      runTool('/api/support/approve-action', { guidanceId: guidanceId }).then(function (result) {
        if (result && result.approval) state.snapshot.activeApproval = result.approval;
        state.actionStatus = 'Cable move approved · operator may now confirm the physical step';
        render();
      }).catch(sceneActionError);
    });

	var resolveButton = byId('resolve-case');
	if (resolveButton) resolveButton.addEventListener('click', function () {
	  resolveButton.disabled = true;
	  state.actionStatus = 'Recording human verification…';
	  render();
	  runTool('/api/support/resolve-case', {}).then(function (result) {
		if (result && result.case) state.snapshot.caseContext = result.case;
		if (result && result.timelineItem) state.addTimeline(result.timelineItem);
		state.actionStatus = 'Case resolved · WAN connection verified';
		render();
	  }).catch(sceneActionError);
	});

    var calibrateButton = byId('calibrate-wan');
    if (calibrateButton) calibrateButton.addEventListener('click', function () {
      if (state.calibrating) return;
	  if (state.calibrationMode) {
		stopCalibration('Calibration cancelled');
		return;
	  }
	  calibrationPurpose = 'calibrate';
	  calibrationObjectID = 'wan-port';
	  pendingTargetLabel = '';
	  state.calibrationMode = true;
	  if (calibrationOverlay) calibrationOverlay.classList.add('calibration-active');
	  state.actionStatus = 'Drag a box around the WAN port in the live video';
      render();
    });

	var addTargetButton = byId('add-scene-target');
	var targetLabelInput = byId('target-label');
	if (addTargetButton) addTargetButton.addEventListener('click', function () {
	  if (state.calibrating) return;
	  var label = targetLabelInput ? String(targetLabelInput.value || '').trim() : '';
	  if (!label) {
	    state.actionStatus = 'Name the observed control or target first';
	    if (targetLabelInput) targetLabelInput.focus();
	    render();
	    return;
	  }
	  calibrationPurpose = 'create';
	  pendingTargetLabel = label;
	  state.calibrationMode = true;
	  if (calibrationOverlay) calibrationOverlay.classList.add('calibration-active');
	  state.actionStatus = 'Drag a box around “' + label + '” in the live video';
	  render();
	});

	var sceneObjectList = byId('scene-object-list');
	if (sceneObjectList) sceneObjectList.addEventListener('click', function (event) {
	  var recalibrate = event.target && event.target.closest ? event.target.closest('.scene-object-recalibrate') : null;
	  if (recalibrate) {
		if (state.calibrating) return;
		calibrationPurpose = 'recalibrate';
		calibrationObjectID = recalibrate.getAttribute('data-object-id') || '';
		pendingTargetLabel = recalibrate.getAttribute('data-object-label') || 'target';
		if (!calibrationObjectID) return;
		state.calibrationMode = true;
		if (calibrationOverlay) calibrationOverlay.classList.add('calibration-active');
		state.actionStatus = 'Drag a fresh box around “' + pendingTargetLabel + '” in the live video';
		render();
		return;
	  }
	  var button = event.target && event.target.closest ? event.target.closest('.scene-object-highlight') : null;
	  if (!button) return;
	  var objectId = button.getAttribute('data-object-id') || '';
	  if (!objectId) return;
	  button.disabled = true;
	  runTool('/api/tools/highlight-object', { objectId: objectId }).then(function (result) {
	    if (result && result.annotation) state.addAnnotation(result.annotation);
	    state.actionStatus = 'Observed target highlighted · waiting for operator';
	    render();
	  }).catch(sceneActionError).then(function () {
	    button.disabled = false;
	  });
	});

    var operatorQR = byId('operator-qr');
    if (operatorQR) {
	  var qrRetryDelays = [2000, 8000, 20000, 40000];
	  var qrRetryAttempt = 0;
	  var qrRetryTimer = 0;
	  var qrSource = (operatorQR.getAttribute('src') || '/api/session/operator-qr').split('?')[0];
      var showQRReady = function () {
		if (qrRetryTimer) window.clearTimeout(qrRetryTimer);
		qrRetryTimer = 0;
		qrRetryAttempt = 0;
        var qrCard = operatorQR.closest('.qr-card');
        var qrFallback = byId('qr-fallback');
        operatorQR.hidden = false;
        if (qrCard) qrCard.removeAttribute('data-state');
        if (qrFallback) qrFallback.hidden = true;
        setText('qr-status', 'Ready to scan · secure link expires with this session');
      };
      var showQRFallback = function () {
        operatorQR.hidden = true;
        var qrCard = operatorQR.closest('.qr-card');
        var qrFallback = byId('qr-fallback');
        if (qrCard) qrCard.setAttribute('data-state', 'unavailable');
        if (qrFallback) qrFallback.hidden = false;
		if (qrRetryTimer) return;
		if (qrRetryAttempt >= qrRetryDelays.length) {
		  setText('qr-status', 'QR unavailable · copy the secure link instead');
		  return;
		}
		var delay = qrRetryDelays[qrRetryAttempt];
		qrRetryAttempt += 1;
		setText('qr-status', 'QR service busy · retrying automatically');
		qrRetryTimer = window.setTimeout(function () {
		  qrRetryTimer = 0;
		  setText('qr-status', 'Regenerating secure QR…');
		  operatorQR.src = qrSource + '?retry=' + qrRetryAttempt;
		}, delay);
      };
      operatorQR.addEventListener('load', showQRReady);
      operatorQR.addEventListener('error', showQRFallback);
      if (operatorQR.complete) {
        if (operatorQR.naturalWidth > 0) showQRReady();
        else showQRFallback();
      }
	  window.addEventListener('pagehide', function () {
		if (qrRetryTimer) window.clearTimeout(qrRetryTimer);
	  }, { once: true });
    }
    var highlightButton = byId('highlight-wan');
    if (highlightButton) highlightButton.addEventListener('click', function () {
      setToolButtonBusy('highlight-wan', true);
      runTool('/api/tools/highlight-object', { objectId: 'wan-port' }).then(function (result) {
        if (result && result.annotation) state.addAnnotation(result.annotation);
        state.actionStatus = 'WAN port highlighted · waiting for operator';
        render();
      }).catch(sceneActionError).then(function () {
        setToolButtonBusy('highlight-wan', false);
      });
    });

    var closeupButton = byId('request-closeup');
    if (closeupButton) closeupButton.addEventListener('click', function () {
      var objectId = closeupButton.getAttribute('data-object-id') || 'wan-port';
      setToolButtonBusy('request-closeup', true);
      state.actionStatus = 'Requesting a closer look at ' + objectId + '…';
      render();
      runTool('/api/tools/request-closeup', { objectId: objectId }).then(function (result) {
        if (result && result.annotation) state.addAnnotation(result.annotation);
        state.actionStatus = 'Close-up requested · guidance is live for the operator';
        render();
      }).catch(sceneActionError).then(function () {
        setToolButtonBusy('request-closeup', false);
      });
    });

    var captureButton = byId('capture-snapshot');
    if (captureButton) captureButton.addEventListener('click', function () {
      setToolButtonBusy('capture-snapshot', true);
      state.actionStatus = 'Capturing scene snapshot…';
      render();
      runTool('/api/tools/capture-snapshot', {}).then(function (result) {
        var captured = result && (result.snapshot || result.capture || result.data && result.data.snapshot);
        if (captured) state.addSnapshot(captured);
        state.actionStatus = captured ? 'Snapshot captured · saved to this session' : 'Snapshot request completed';
        render();
      }).catch(sceneActionError).then(function () {
        setToolButtonBusy('capture-snapshot', false);
      });
    });

    var clearButton = byId('clear-annotations');
    if (clearButton) clearButton.addEventListener('click', function () {
      setToolButtonBusy('clear-annotations', true);
      runTool('/api/tools/clear-annotations').then(function () {
        state.snapshot.annotations = [];
        state.guidanceResolved = false;
        state.confirmStatus = '';
        state.actionStatus = 'Guidance cleared · ready for another instruction';
        render();
      }).catch(sceneActionError).then(function () {
        setToolButtonBusy('clear-annotations', false);
      });
    });

    renderWebMCPCapability();
    announceFieldAssistReady('support', root);
    render();
    Promise.all([loadCurrentSession(), loadICEConfiguration()]).then(function (loaded) {
      var current = loaded[0];
      state.operatorPath = current.operatorPath || '';
      state.setSnapshot(current.snapshot);
      if (state.operatorPath) {
        var link = byId('operator-link');
        if (link) {
          try {
            var absolute = new URL(state.operatorPath, window.location.origin).href;
            link.href = absolute;
            link.textContent = absolute;
            link.title = absolute;
          } catch (_error) {
            link.href = state.operatorPath;
            link.textContent = state.operatorPath;
          }
        }
      }
      renderWebMCPCapability();
      render();
      socket = new SocketController('support', state.sessionId, eventReceived, socketStatus);
      peer = new PeerController('support', socket, state, render);
      peer.onPose = function (pose) {
        if (changeDetector) changeDetector.updatePose(pose);
      };
      var remoteVideo = byId('remote-video');
      if (remoteVideo) {
        remoteVideo.addEventListener('loadedmetadata', render);
        changeDetector = new VisualChangeDetector(remoteVideo, function () {}, function () {}, function (tracking) {
          queueTrackingTelemetry(tracking);
        }, function (status) {
          state.diagnostics.perception = status;
          setPerceptionStatus(status, 'support-perception-status');
          scheduleEventRender();
        }, {
          enhanced: true,
          sampleDelay: 220,
          perception: { depth: true, maximumWidth: 640 }
        });
      }
      window.addEventListener('resize', render);
      socket.start();
      render();
    }).catch(function (error) {
      setStatus('peer-status', 'Session unavailable', 'error');
      setStatus('webmcp-status', 'Session unavailable', 'error');
      state.diagnostics.lastEvent = formatError(error);
      render();
    });

    window.addEventListener('pagehide', function () {
      window.removeEventListener('resize', render);
      if (changeDetector) changeDetector.stop();
      if (eventRenderTimer) window.clearTimeout(eventRenderTimer);
      if (peer) peer.destroy();
      if (socket) socket.close();
    });
  }

  function initOperator() {
    var root = byId('operator-app');
    if (!root) return;
    document.documentElement.classList.add('operator-page');
    document.body.classList.add('operator-page');
    var state = new SessionState('operator', pathSessionId());
    var operatorStatusHUD = byId('operator-status-hud');
    var operatorStatusTrigger = byId('operator-status-trigger');
    var closeOperatorStatus = function () {
      if (!operatorStatusHUD || !operatorStatusHUD.open) return;
      operatorStatusHUD.open = false;
      if (operatorStatusTrigger) {
        operatorStatusTrigger.setAttribute('aria-expanded', 'false');
        operatorStatusTrigger.focus({ preventScroll: true });
      }
    };
    if (operatorStatusHUD && operatorStatusTrigger) {
      operatorStatusHUD.addEventListener('toggle', function () {
        operatorStatusTrigger.setAttribute('aria-expanded', operatorStatusHUD.open ? 'true' : 'false');
      });
      operatorStatusHUD.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !operatorStatusHUD.open) return;
        event.preventDefault();
        closeOperatorStatus();
      });
      document.addEventListener('pointerdown', function (event) {
        if (operatorStatusHUD.open && !operatorStatusHUD.contains(event.target)) closeOperatorStatus();
      });
    }
    state.diagnostics.perception = {
      state: 'idle',
      source: 'calibrated-region',
      label: 'Spatial perception idle',
      reason: ''
    };
    setPerceptionStatus(state.diagnostics.perception);
    var socket;
    var peer;
    var changeDetector;
    var startingCamera = false;
    var pendingTrackingTelemetry = null;
    var trackingTelemetryInFlight = false;
    var lastTrackingTelemetrySignature = '';
    var pendingAnnotationAcknowledgement = null;
    var annotationAcknowledgementInFlight = false;
    var annotationAcknowledgementScheduled = false;
    var acknowledgedAnnotationVersions = Object.create(null);
    var poseOffset = { x: 0, y: 0, yaw: 0, pitch: 0, roll: 0 };
    var poseFrame = 0;
    var lastPoseSentAt = 0;
    var eventRenderTimer = 0;
    var posePredictor = new DevicePosePredictor(function (offset) {
      poseOffset = offset;
      state.diagnostics.pose = {
        permission: posePredictor.permission,
        yaw: Math.round(Number(offset.yaw || 0) * 10) / 10,
        pitch: Math.round(Number(offset.pitch || 0) * 10) / 10,
        roll: Math.round(Number(offset.roll || 0) * 10) / 10
      };
      if (poseFrame) return;
      poseFrame = window.requestAnimationFrame(function () {
        poseFrame = 0;
        applyPosePrediction(byId('operator-overlay'), byId('local-video'), poseOffset);
      });
    }, function (pose) {
      var now = Date.now();
      var tracking = state.diagnostics.tracking || {};
      var trackingStatus = String(tracking.status || '').replace(/_/g, ' ');
      var localTrackingHealthy = Boolean(tracking.objectId && state.trackedBounds[tracking.objectId] &&
        isOpenCVTrackingSource(tracking.source) &&
        trackingStatus !== 'recalibration required' && trackingStatus !== 'reacquire required');
      if (!peer || !localTrackingHealthy || now - lastPoseSentAt < 66) return;
      if (peer.sendPose(pose)) lastPoseSentAt = now;
    });

	function syncVisualViewportHeight() {
	  var height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
	  document.documentElement.style.setProperty('--app-height', Math.max(1, Math.round(height)) + 'px');
	}
	syncVisualViewportHeight();
	window.addEventListener('resize', syncVisualViewportHeight);
	if (window.visualViewport) window.visualViewport.addEventListener('resize', syncVisualViewportHeight);

    function flushAnnotationAcknowledgements() {
      if (annotationAcknowledgementInFlight || !pendingAnnotationAcknowledgement) return;
      var queued = pendingAnnotationAcknowledgement;
      pendingAnnotationAcknowledgement = null;
      annotationAcknowledgementInFlight = true;
      fetchJSON('/api/operator/annotation-acknowledgements', {
        method: 'POST',
        headers: requestHeaders(true),
        body: JSON.stringify(queued.payload)
      }).then(function (result) {
        var receipts = result && Array.isArray(result.receipts) ? result.receipts : [];
        receipts.forEach(function (receipt) {
          if (!receipt || !receipt.annotationId) return;
          acknowledgedAnnotationVersions[receipt.annotationId + ':' + receipt.sceneVersion] = true;
        });
        state.diagnostics.annotationDelivery = result && result.recorded === false ? 'already acknowledged' : 'acknowledged';
      }).catch(function (error) {
        state.diagnostics.annotationDelivery = 'retrying';
        state.diagnostics.lastEvent = formatError(error);
        if (queued.attempt < 2 && !pendingAnnotationAcknowledgement) {
          queued.attempt += 1;
          pendingAnnotationAcknowledgement = queued;
          window.setTimeout(flushAnnotationAcknowledgements, queued.attempt * 750);
        }
      }).then(function () {
        annotationAcknowledgementInFlight = false;
        flushAnnotationAcknowledgements();
      });
    }

    function queueVisibleAnnotationAcknowledgements() {
      var sceneVersionValue = sceneVersion(state.snapshot.scene);
      var ids = Array.prototype.map.call(
        document.querySelectorAll('#operator-overlay .field-annotation[data-annotation-id]'),
        function (element) {
          var annotationId = element.getAttribute('data-annotation-id') || '';
          if (!annotationId) return '';
          if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
            delete acknowledgedAnnotationVersions[annotationId + ':' + sceneVersionValue];
            return '';
          }
          return annotationId;
        }
      ).filter(function (annotationId, index, values) {
        return annotationId && values.indexOf(annotationId) === index &&
          !acknowledgedAnnotationVersions[annotationId + ':' + sceneVersionValue];
      });
      if (!ids.length) return;
      var payload = { annotationIds: ids, sceneVersion: sceneVersionValue };
      var signature = JSON.stringify(payload);
      if (pendingAnnotationAcknowledgement && pendingAnnotationAcknowledgement.signature === signature) return;
      pendingAnnotationAcknowledgement = { payload: payload, signature: signature, attempt: 0 };
      flushAnnotationAcknowledgements();
    }

    function scheduleAnnotationAcknowledgements() {
      if (annotationAcknowledgementScheduled) return;
      annotationAcknowledgementScheduled = true;
      window.requestAnimationFrame(function () {
        annotationAcknowledgementScheduled = false;
        queueVisibleAnnotationAcknowledgements();
      });
    }

    function flushTrackingTelemetry() {
      if (trackingTelemetryInFlight || !pendingTrackingTelemetry) return;
      var queued = pendingTrackingTelemetry;
      pendingTrackingTelemetry = null;
      trackingTelemetryInFlight = true;
      fetchJSON('/api/operator/scene-tracking', {
        method: 'POST',
        headers: requestHeaders(true),
        body: JSON.stringify(queued.payload)
      }).then(function (result) {
        lastTrackingTelemetrySignature = queued.signature;
        state.diagnostics.trackingTelemetry = result && result.recorded === false ? 'deduplicated' : 'reported';
        if (result && result.tracking) {
          state.snapshot.sceneTracking = result.tracking;
          scheduleEventRender();
        }
      }).catch(function (error) {
        state.diagnostics.trackingTelemetry = 'retrying';
        state.diagnostics.lastEvent = formatError(error);
        var bindingStillActive = queued.payload.approvalId
          ? state.snapshot.activeApproval && state.snapshot.activeApproval.id === queued.payload.approvalId
          : Array.isArray(state.snapshot.annotations) && state.snapshot.annotations.some(function (annotation) {
            return annotation && annotation.id === queued.payload.guidanceId;
          });
        if (queued.attempt < 2 && bindingStillActive && !pendingTrackingTelemetry) {
          queued.attempt += 1;
          pendingTrackingTelemetry = queued;
          window.setTimeout(flushTrackingTelemetry, 1000 * queued.attempt);
        }
      }).then(function () {
        trackingTelemetryInFlight = false;
        flushTrackingTelemetry();
      });
    }

    function queueTrackingTelemetry(tracking) {
      var approval = state.snapshot.activeApproval;
      var approved = approval && approval.status === 'approved';
      if (!tracking || !tracking.objectId || !tracking.bounds || (!approved && !tracking.guidanceId)) return;
      var status = tracking.lost
        ? 'reacquire_required'
		: (tracking.recalibrationRequired
		? 'recalibration_required'
        : (tracking.fallback
		? 'calibrated_fallback'
		: (tracking.moved ? 'following_camera_drift' : 'locked')));
      var evidence = perceptionTrackingFields(tracking);
      var source = isOpenCVTrackingSource(evidence.source) || evidence.source === 'browser-multiscale-template'
        ? evidence.source
        : 'browser-multiscale-template';
      var depthScore = evidence.depthScore === null ? 0 : evidence.depthScore;
      var depthConfidence = evidence.depthConfidence === null ? 0 : evidence.depthConfidence;
      var modelRelativeDepth = evidence.modelRelativeDepth === null ? 0 : evidence.modelRelativeDepth;
      var depthSource = evidence.depthSource;
      if (isDepthBackedTrackingSource(source) && (!depthSource || depthConfidence <= 0 || modelRelativeDepth < 0.25)) {
        source = 'opencv-homography';
        depthScore = 0;
        depthConfidence = 0;
        modelRelativeDepth = 0;
        depthSource = '';
      }
      var payload = {
        approvalId: approved ? approval.id : '',
        guidanceId: tracking.guidanceId || (approved ? approval.guidanceId : ''),
        objectId: tracking.objectId,
        referenceObjectId: tracking.referenceObjectId || '',
        baseSceneVersion: sceneVersion(state.snapshot.scene),
        status: status,
        confidence: Math.round(Number(tracking.confidence || 0) * 1000000) / 1000000,
        bounds: tracking.bounds,
        source: source,
        poseState: evidence.poseState,
        poseFailureReason: evidence.poseFailureReason,
        poseInliers: Math.round(evidence.poseInliers),
        poseInlierRatio: Math.round(evidence.poseInlierRatio * 1000000) / 1000000,
        partialVisibility: evidence.partialVisibility,
        visibleFraction: Math.round(evidence.visibleFraction * 1000000) / 1000000,
        anchorVisible: evidence.anchorVisible
      };
      var transportQuad = trackingQuadForTransport(tracking.quad, tracking.bounds, evidence.partialVisibility);
      if (transportQuad) payload.quad = transportQuad;
      if (normalizedPoint(tracking.anchor)) payload.anchor = normalizedPoint(tracking.anchor);
      if (isDepthBackedTrackingSource(source)) {
        payload.depthSource = depthSource;
        payload.depthScore = clamp(depthScore, 0, 1);
        payload.depthConfidence = clamp(depthConfidence, 0, 1);
        payload.modelRelativeDepth = clamp(modelRelativeDepth, 0.25, 4);
      }
      var signature = JSON.stringify(payload);
      if (signature === lastTrackingTelemetrySignature || (pendingTrackingTelemetry && signature === pendingTrackingTelemetry.signature)) return;
      pendingTrackingTelemetry = { payload: payload, signature: signature, attempt: 0 };
      flushTrackingTelemetry();
    }

    function render() {
      renderOperator(state, socket, peer);
      applyPosePrediction(
        byId('operator-overlay'),
        byId('local-video'),
        state.posePredictionAllowed ? poseOffset : null
      );
      scheduleAnnotationAcknowledgements();
      if (changeDetector) {
        changeDetector.sync(
          state.snapshot.activeApproval,
          state.snapshot.scene,
          state.guidanceResolved,
          state.snapshot.annotations
        );
      }
      var connection = peer ? peer.connectionState() : 'not created';
      if (!state.cameraError && connection === 'connected') setStatus('operator-status', 'Connected', 'connected');
      else if (!state.cameraError && (state.diagnostics.signaling === 'connected' || state.diagnostics.signaling === 'ready sent')) {
        setStatus('operator-status', 'Ready for support', 'pending');
      }
    }

    function scheduleEventRender() {
      if (eventRenderTimer) return;
      eventRenderTimer = window.setTimeout(function () {
        eventRenderTimer = 0;
        render();
      }, 0);
    }

    function socketStatus(status, detail) {
      state.diagnostics.websocket = status;
      if (state.cameraError) {
        state.diagnostics.signaling = status === 'open' ? 'connected' : (detail || status);
        setStatus('operator-status', 'Camera unavailable', 'error');
        render();
        return;
      }
      if (status === 'open') {
        state.diagnostics.signaling = 'connected';
        if (peer) peer.onSocketOpen();
        setStatus('operator-status', peer && peer.localStream ? 'Ready for support' : 'Connected · camera needed', 'pending');
      } else if (status === 'connecting') {
        setStatus('operator-status', 'Joining session…', 'pending');
      } else if (status === 'retrying') {
        state.diagnostics.reconnectAttempt += 1;
        setStatus('operator-status', 'Reconnecting…', 'pending');
      } else if (status === 'error') {
        state.diagnostics.signaling = detail || 'error';
        setStatus('operator-status', 'Connection error', 'error');
      } else if (status === 'closed') {
        state.diagnostics.signaling = 'closed';
        setStatus('operator-status', 'Session disconnected', 'error');
      }
      scheduleEventRender();
    }

    function eventReceived(event) {
      var payload = parseMaybeJSON(event && event.payload);
      var relayed = payload && typeof payload === 'object' && hasOwn.call(payload, 'data');
      var data = relayed ? parseMaybeJSON(payload.data) : payload;
      var fromRole = relayed ? payload.fromRole : '';
      state.applyIncoming(event);
      if (event && event.type === 'scene.tracking_updated' && data && data.tracking) {
        var incomingTracking = data.tracking;
        var incomingLost = incomingTracking.needsRecalibration || incomingTracking.status === 'recalibration_required' || incomingTracking.status === 'reacquire_required';
        var localSource = String(state.diagnostics.tracking && state.diagnostics.tracking.source || '');
        if (!isOpenCVTrackingSource(localSource)) {
          if (incomingLost || !incomingTracking.anchor) posePredictor.clear();
          else posePredictor.lock();
        }
      }
      if (peer && event && event.type && event.type.indexOf('webrtc.') === 0) {
        peer.handleSignal(event, data, fromRole);
      }
      if (state.snapshot.operatorIssue && !state.cameraError && peer && !peer.localStream) startCamera();
      scheduleEventRender();
    }

    function cameraError(error) {
      var message = formatError(error);
      if (error && error.name === 'NotAllowedError') {
        message = 'Camera permission was denied. Allow camera access, then try again.';
      } else if (error && error.name === 'NotFoundError') {
        message = 'No camera was found on this device.';
      }
      state.diagnostics.media = 'error';
      state.diagnostics.lastEvent = message;
      state.cameraError = message;
      setText('operator-instruction', message);
      setStatus('operator-status', 'Camera unavailable', 'error');
      render();
    }

    function getRearCamera() {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        return Promise.reject(new Error('This browser does not expose camera access.'));
      }
      var constraints = {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 24, max: 30 }
        }
      };
      return navigator.mediaDevices.getUserMedia(constraints).catch(function (error) {
        // Some Safari versions reject ideal constraints even though they can
        // honor the facingMode hint.  Retry a simpler rear-camera request.
        if (error && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
          return navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: 'environment' }
          });
        }
        throw error;
      });
    }

    function startCamera() {
      if (startingCamera || (peer && peer.localStream)) return;
      startingCamera = true;
      state.cameraError = '';
      setStatus('operator-status', 'Requesting rear camera…', 'pending');
      setText('operator-instruction', 'Allow camera access to join the live field view.');
      getRearCamera().then(function (stream) {
        if (!peer) throw new Error('Session connection is not ready.');
        state.cameraError = '';
        peer.setLocalStream(stream);
        var permission = byId('camera-permission');
        if (permission) permission.hidden = true;
        if (socket && socket.isOpen()) peer.startReadyPulse();
        else setStatus('operator-status', 'Camera ready · joining support', 'pending');
        render();
      }).catch(cameraError).then(function () {
        startingCamera = false;
      });
    }

    var cameraButton = byId('start-camera');
    if (cameraButton) cameraButton.addEventListener('click', function () {
      posePredictor.requestPermission();
      startCamera();
    });

    function selectOperatorIssue(payload) {
      if (state.selectingIssue || state.snapshot.operatorIssue) return;
      // iOS requires the orientation permission request to happen directly
      // inside a user gesture. The demo choice is the earliest honest moment.
      posePredictor.requestPermission();
      state.selectingIssue = true;
      state.issueError = '';
      render();
      fetchJSON('/api/operator/issue', {
        method: 'POST',
        headers: requestHeaders(true),
        body: JSON.stringify(payload)
      }).then(function (result) {
        if (!result || !result.issue) throw new Error('The support request was not accepted.');
        state.snapshot.operatorIssue = result.issue;
        state.issueError = '';
        startCamera();
      }).catch(function (error) {
        state.diagnostics.lastEvent = formatError(error);
        state.issueError = 'Could not start · ' + formatError(error);
      }).then(function () {
        state.selectingIssue = false;
        render();
      });
    }

    var tvDemoButton = byId('operator-tv-demo');
    if (tvDemoButton) tvDemoButton.addEventListener('click', function () {
      selectOperatorIssue({ mode: 'preset', presetId: tvDemoButton.getAttribute('data-preset-id') || 'lost-tv-controller' });
    });

    var freeformIssueForm = byId('operator-freeform-issue-form');
    if (freeformIssueForm) freeformIssueForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = byId('operator-freeform-issue');
      var summary = input ? String(input.value || '').trim() : '';
      if (!summary) {
        state.issueError = 'Describe what you need help with.';
        render();
        if (input) input.focus();
        return;
      }
      selectOperatorIssue({ mode: 'freeform', summary: summary });
    });

    function setOperatorChatOpen(open) {
      state.chatOpen = Boolean(open);
      state.messageError = '';
      render();
      if (state.chatOpen) {
        var input = byId('operator-chat-input');
        if (input) input.focus();
      }
    }

    var operatorChatToggle = byId('operator-chat-toggle');
    if (operatorChatToggle) operatorChatToggle.addEventListener('click', function () {
      setOperatorChatOpen(!state.chatOpen);
    });
    var operatorChatClose = byId('operator-chat-close');
    if (operatorChatClose) operatorChatClose.addEventListener('click', function () {
      setOperatorChatOpen(false);
    });
    var operatorChatForm = byId('operator-chat-form');
    if (operatorChatForm) operatorChatForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (state.sendingMessage) return;
      var input = byId('operator-chat-input');
      var text = input ? String(input.value || '').trim() : '';
      if (!text) {
        state.messageError = 'Write a message first.';
        render();
        if (input) input.focus();
        return;
      }
      state.sendingMessage = true;
      state.messageError = '';
      state.messageStatus = 'Sending…';
      if (input) input.disabled = true;
      render();
      fetchJSON('/api/operator/messages', {
        method: 'POST', headers: requestHeaders(true), body: JSON.stringify({ text: text })
      }).then(function (result) {
        if (!result || !result.message) throw new Error('The message was not accepted.');
        state.addMessage(result.message);
        if (input) input.value = '';
        state.messageStatus = 'Sent';
      }).catch(function (error) {
        state.messageError = 'Could not send · ' + formatError(error);
        state.messageStatus = '';
      }).then(function () {
        state.sendingMessage = false;
        if (input) input.disabled = false;
        render();
      });
    });

    var questionOptions = byId('operator-question-options');
    if (questionOptions) questionOptions.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('[data-option-id]') : null;
      if (!button || state.answeringQuestion) return;
      var questionID = button.getAttribute('data-question-id') || '';
      var optionID = button.getAttribute('data-option-id') || '';
      if (!questionID || !optionID) return;
      state.answeringQuestion = true;
      state.questionError = '';
      render();
      fetchJSON('/api/operator/questions/answer', {
        method: 'POST',
        headers: requestHeaders(true),
        body: JSON.stringify({ questionId: questionID, optionId: optionID })
      }).then(function (result) {
        if (!result || !result.question) throw new Error('The response was not accepted.');
        state.snapshot.activeQuestion = result.question;
      }).catch(function (error) {
        state.diagnostics.lastEvent = formatError(error);
        state.questionError = 'Could not send · ' + formatError(error);
      }).then(function () {
        state.answeringQuestion = false;
        render();
      });
    });

    var confirmButton = byId('confirm-cable-moved');
    if (confirmButton) confirmButton.addEventListener('click', function () {
      if (state.confirmingGuidance) return;
      state.confirmingGuidance = true;
      state.confirmStatus = 'Confirming cable movement…';
      render();
      fetchJSON('/api/operator/confirm-cable-moved', {
        method: 'POST',
        headers: requestHeaders(true),
        body: JSON.stringify({ approvalId: state.snapshot.activeApproval && state.snapshot.activeApproval.id })
      }).then(function (result) {
        if (result && result.success === false) throw new Error(result.message || 'The cable movement was not confirmed.');
        state.resolveGuidance(result || {});
        render();
      }).catch(function (error) {
        state.confirmStatus = 'Could not confirm · ' + formatError(error);
        state.diagnostics.lastEvent = formatError(error);
        render();
      }).then(function () {
        state.confirmingGuidance = false;
        render();
      });
    });

    announceFieldAssistReady('operator', root);

    Promise.all([loadCurrentSession(), loadICEConfiguration()]).then(function (loaded) {
      var current = loaded[0];
      state.setSnapshot(current.snapshot);
      setStatus('operator-status', 'Connecting to support…', 'pending');
      render();
      socket = new SocketController('operator', state.sessionId, eventReceived, socketStatus);
      peer = new PeerController('operator', socket, state, render);
      var localVideo = byId('local-video');
      if (localVideo) {
        localVideo.addEventListener('loadedmetadata', render);
        changeDetector = new VisualChangeDetector(localVideo, function (label, activityState) {
          state.sceneActivityStatus = label;
          state.sceneActivityState = activityState;
          renderOperator(state, socket, peer);
        }, function (activityInput) {
          if (state.sceneActivityReporting) return;
          state.sceneActivityReporting = true;
          fetchJSON('/api/operator/scene-activity', {
            method: 'POST',
            headers: requestHeaders(true),
            body: JSON.stringify(activityInput)
          }).then(function (result) {
            if (result && result.activity) state.snapshot.sceneActivity = result.activity;
            state.sceneActivityStatus = 'View changed · confirm cable is seated';
            state.sceneActivityState = 'connected';
          }).catch(function (error) {
            state.sceneActivityStatus = 'Visual check retrying';
            state.sceneActivityState = 'error';
            state.diagnostics.lastEvent = formatError(error);
            if (changeDetector) changeDetector.allowRetry();
          }).then(function () {
            state.sceneActivityReporting = false;
            renderOperator(state, socket, peer);
          });
        }, function (tracking) {
          var perceptionFields = perceptionTrackingFields(tracking);
          if (!tracking || !tracking.objectId || !tracking.bounds) {
            state.trackedBounds = Object.create(null);
            state.trackingLostObjectID = '';
            state.diagnostics.tracking = Object.assign({
              status: 'calibrated fallback',
              objectId: 'wan-port'
            }, perceptionFields);
            posePredictor.clear();
          } else if (tracking.lost || tracking.recalibrationRequired) {
            delete state.trackedBounds[tracking.objectId];
            state.trackingLostObjectID = tracking.objectId;
            state.diagnostics.tracking = Object.assign({
              status: tracking.lost ? 'reacquire required' : 'recalibration required',
              objectId: tracking.objectId,
              confidence: tracking.lost ? 0 : Math.round(Number(tracking.confidence || 0) * 1000) / 1000,
              bounds: tracking.bounds,
              quad: null,
              anchor: null
            }, perceptionFields);
            posePredictor.clear();
            queueTrackingTelemetry(tracking);
          } else {
            state.trackingLostObjectID = '';
            state.trackedBounds[tracking.objectId] = {
              bounds: tracking.bounds,
              quad: tracking.quad,
              anchor: tracking.anchor,
              partialVisibility: Boolean(tracking.partialVisibility),
              anchorVisible: tracking.anchorVisible !== false
            };
            state.diagnostics.tracking = Object.assign({
              status: tracking.fallback ? 'calibrated fallback' : (tracking.moved ? 'following camera drift' : 'locked'),
              objectId: tracking.objectId,
              confidence: Math.round(Number(tracking.confidence || 0) * 1000) / 1000,
              bounds: tracking.bounds,
              quad: tracking.quad || null,
              anchor: tracking.anchor || null
            }, perceptionFields);
            if (tracking.fallback || !tracking.anchor) posePredictor.clear();
            else posePredictor.lock();
            queueTrackingTelemetry(tracking);
          }
          renderOperator(state, socket, peer);
        }, function (status) {
          state.diagnostics.perception = status;
          setPerceptionStatus(status);
          renderOperator(state, socket, peer);
        }, {
          // The support computer owns OpenCV and Depth Anything. The phone
          // keeps only its cheap Canvas/gyro bridge so two independent
          // enhanced trackers cannot race to place the same annotation.
          enhanced: false,
          sampleDelay: 150,
          perception: { depth: false, maximumWidth: 320 }
        });
      }
      window.addEventListener('resize', render);
      socket.start();
      render();
      // The issue choice is deliberate state: support and Codex receive no
      // request context until the operator selects or submits it. A returning
      // operator can resume camera capture immediately from the saved choice.
      if (state.snapshot.operatorIssue) startCamera();
    }).catch(function (error) {
      setStatus('operator-status', 'Session unavailable', 'error');
      setText('operator-instruction', formatError(error));
      state.diagnostics.lastEvent = formatError(error);
      render();
    });

    window.addEventListener('pagehide', function () {
      window.removeEventListener('resize', render);
	  window.removeEventListener('resize', syncVisualViewportHeight);
	  if (window.visualViewport) window.visualViewport.removeEventListener('resize', syncVisualViewportHeight);
      if (changeDetector) changeDetector.stop();
      if (poseFrame) window.cancelAnimationFrame(poseFrame);
      if (eventRenderTimer) window.clearTimeout(eventRenderTimer);
      posePredictor.stop();
      if (peer) peer.destroy();
      if (socket) socket.close();
    });
  }

  function init() {
    initLanding();
    initSupport();
    initOperator();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
