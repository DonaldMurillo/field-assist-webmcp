package main

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestValidateFieldAssistContextVersion(t *testing.T) {
	const expected = "field-assist/v2:session-context"
	tests := []struct {
		name        string
		initialized bool
		provided    string
		wantErr     error
	}{
		{name: "not initialized", provided: expected, wantErr: ErrFieldAssistContextRequired},
		{name: "missing", initialized: true, wantErr: ErrFieldAssistContextRequired},
		{name: "wrong session", initialized: true, provided: "field-assist/v2:other", wantErr: ErrFieldAssistContextStale},
		{name: "wrong protocol", initialized: true, provided: "field-assist/v1:session-context", wantErr: ErrFieldAssistContextStale},
		{name: "exact value", initialized: true, provided: expected},
		{name: "trimmed exact value", initialized: true, provided: "  " + expected + "  "},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateFieldAssistContextVersion(test.initialized, test.provided, expected)
			if test.wantErr == nil {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v, want %v", err, test.wantErr)
			}
		})
	}
}

func TestFieldAssistContextVersionFromBody(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		want    string
		wantErr bool
	}{
		{name: "context field", body: `{"contextVersion":"field-assist/v2:abc","objectId":"control"}`, want: "field-assist/v2:abc"},
		{name: "missing field", body: `{"objectId":"control"}`},
		{name: "empty body"},
		{name: "malformed JSON", body: `{"contextVersion":`, wantErr: true},
		{name: "non-string field", body: `{"contextVersion":42}`, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := fieldAssistContextVersionFromBody([]byte(test.body))
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, test.wantErr)
			}
			if err == nil && got != test.want {
				t.Fatalf("version = %q, want %q", got, test.want)
			}
		})
	}
}

func TestValidateDrawArrowTargetRequiresNarrowControl(t *testing.T) {
	scene := Scene{Objects: []SceneObject{
		{ID: "appliance", Kind: "appliance"},
		{ID: "button", Kind: "device-control"},
		{ID: "wan", Kind: "ethernet-port", Attributes: map[string]any{"targetType": "device-control"}},
		{ID: "unverified", Kind: "ethernet-port"},
	}}
	if err := validateDrawArrowTarget(scene, "button"); err != nil {
		t.Fatalf("device-control target rejected: %v", err)
	}
	if err := validateDrawArrowTarget(scene, "wan"); err != nil {
		t.Fatalf("explicitly verified domain control rejected: %v", err)
	}
	for _, objectID := range []string{"appliance", "unverified"} {
		if err := validateDrawArrowTarget(scene, objectID); !errors.Is(err, ErrInvalidDrawArrowTarget) {
			t.Fatalf("target %q error = %v, want %v", objectID, err, ErrInvalidDrawArrowTarget)
		}
	}
	if err := validateDrawArrowTarget(scene, "missing"); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("missing target error = %v, want %v", err, ErrObjectNotFound)
	}
}

func TestWithFieldAssistContextSchemaRequiresContextVersion(t *testing.T) {
	input := withFieldAssistContextSchema(json.RawMessage(`{"type":"object","properties":{"objectId":{"type":"string"}},"required":["objectId"]}`))
	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
		Required   []string                   `json:"required"`
	}
	if err := json.Unmarshal(input, &schema); err != nil {
		t.Fatal(err)
	}
	if _, ok := schema.Properties["contextVersion"]; !ok {
		t.Fatal("contextVersion property missing")
	}
	found := false
	for _, field := range schema.Required {
		if field == "contextVersion" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("required fields = %#v, contextVersion missing", schema.Required)
	}
}
