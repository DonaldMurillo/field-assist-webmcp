package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"strings"
)

// fieldAssistProtocolVersion identifies the operating contract that a WebMCP
// caller receives from the application. Keep this separate from the opaque
// per-session context version: changing the protocol must make previously
// issued context versions unusable after a deploy.
const fieldAssistProtocolVersion = "field-assist/v2"

const (
	fieldAssistContextVersionPrefix = fieldAssistProtocolVersion + ":"
	maxFieldAssistContextVersion    = 256
	maxFieldAssistContextBodyBytes  = 1 << 20
)

var (
	// ErrFieldAssistContextRequired is returned when a WebMCP mutation arrives
	// before the caller has loaded the app-provided operating context.
	ErrFieldAssistContextRequired = errors.New("field assist WebMCP context is required")
	// ErrFieldAssistContextStale is returned when a caller presents a context
	// issued for another session or protocol revision.
	ErrFieldAssistContextStale = errors.New("field assist WebMCP context is stale")
	// ErrInvalidDrawArrowTarget prevents broad objects (for example an entire
	// appliance or display) from receiving a precision arrow. The caller must
	// register or select a verified, actionable device control instead.
	ErrInvalidDrawArrowTarget = errors.New("draw_arrow requires a verified device-control target")
)

// validFieldAssistContextVersion performs the pure shape and equality check
// used by the request boundary. Constant-time comparison avoids making the
// opaque session-bound value an observable prefix oracle.
func validFieldAssistContextVersion(provided, expected string) bool {
	provided = strings.TrimSpace(provided)
	expected = strings.TrimSpace(expected)
	if provided == "" || expected == "" || len(provided) > maxFieldAssistContextVersion || len(expected) > maxFieldAssistContextVersion {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

// validateFieldAssistContextVersion distinguishes an omitted initialization
// from a stale value so the HTTP boundary can give deterministic recovery
// instructions while preserving a pure helper for unit coverage.
func validateFieldAssistContextVersion(initialized bool, provided, expected string) error {
	if !initialized || strings.TrimSpace(provided) == "" {
		return ErrFieldAssistContextRequired
	}
	if !validFieldAssistContextVersion(provided, expected) {
		return ErrFieldAssistContextStale
	}
	return nil
}

// fieldAssistContextVersionFromBody extracts only the contextVersion key from
// a mutation payload. Full payload validation remains the responsibility of
// GoFastr's strict typed binder; this helper exists so the middleware can
// validate initialization before a mutating handler is reached.
func fieldAssistContextVersionFromBody(body []byte) (string, error) {
	if len(body) == 0 {
		return "", nil
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", err
	}
	raw, ok := envelope["contextVersion"]
	if !ok {
		return "", nil
	}
	var version string
	if err := json.Unmarshal(raw, &version); err != nil {
		return "", err
	}
	return version, nil
}

// verifiedDeviceControl reports whether an object is narrow enough for a
// precision arrow. The explicit attribute is used by seeded controls whose
// domain kind is more specific (for example, a WAN ethernet port). New
// objects registered through WebMCP should use kind=device-control.
func verifiedDeviceControl(object SceneObject) bool {
	if strings.EqualFold(strings.TrimSpace(object.Kind), "device-control") {
		return true
	}
	for _, key := range []string{"targetType", "targetKind", "controlKind"} {
		if strings.EqualFold(strings.TrimSpace(sceneAttributeString(object, key)), "device-control") {
			return true
		}
	}
	if value, ok := object.Attributes["verifiedDeviceControl"].(bool); ok && value {
		return true
	}
	return false
}

// validateDrawArrowTarget is intentionally pure. It is shared by the
// WebMCP handler and focused unit tests, and keeps target eligibility separate
// from annotation creation and transport state.
func validateDrawArrowTarget(scene Scene, objectID string) error {
	objectID = strings.TrimSpace(objectID)
	for _, object := range scene.Objects {
		if object.ID != objectID {
			continue
		}
		if !verifiedDeviceControl(object) {
			return ErrInvalidDrawArrowTarget
		}
		return nil
	}
	return ErrObjectNotFound
}
