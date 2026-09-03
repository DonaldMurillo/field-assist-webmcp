package main

import (
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSnapshotEventSequenceMatchesRolePayload(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatalf("newSession: %v", err)
	}
	defer session.Stop()

	if _, _, err := session.SendOperatorInstruction("HOLD STEADY", "Keep the device in view.", "Support representative"); err != nil {
		t.Fatalf("SendOperatorInstruction: %v", err)
	}

	supportEvent := session.SnapshotEvent(RoleSupport)
	supportSnapshot, ok := supportEvent.Payload.(SessionSnapshot)
	if !ok {
		t.Fatalf("support payload type = %T, want SessionSnapshot", supportEvent.Payload)
	}
	if supportEvent.Sequence != supportSnapshot.Sequence {
		t.Fatalf("support event sequence = %d, payload sequence = %d", supportEvent.Sequence, supportSnapshot.Sequence)
	}

	operatorEvent := session.SnapshotEvent(RoleOperator)
	operatorSnapshot, ok := operatorEvent.Payload.(OperatorSessionSnapshot)
	if !ok {
		t.Fatalf("operator payload type = %T, want OperatorSessionSnapshot", operatorEvent.Payload)
	}
	if operatorEvent.Sequence != operatorSnapshot.Sequence {
		t.Fatalf("operator event sequence = %d, payload sequence = %d", operatorEvent.Sequence, operatorSnapshot.Sequence)
	}
}

func TestMoveModemConnectionToWAN(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatalf("newSession: %v", err)
	}
	defer session.Stop()

	before := session.Scene()
	moment := time.Date(2026, time.August, 30, 1, 2, 3, 4, time.UTC)
	after, err := moveModemConnectionToWAN(before, moment)
	if err != nil {
		t.Fatalf("moveModemConnectionToWAN: %v", err)
	}
	if after.Version != before.Version+1 {
		t.Fatalf("version = %d, want %d", after.Version, before.Version+1)
	}
	if !after.Timestamp.Equal(moment) {
		t.Fatalf("timestamp = %s, want %s", after.Timestamp, moment)
	}
	if got := sceneObjectAttribute(after, "lan-port", "connectionState"); got != "empty" {
		t.Fatalf("LAN connectionState = %q, want empty", got)
	}
	if got := sceneObjectAttribute(after, "wan-port", "connectionState"); got != "occupied" {
		t.Fatalf("WAN connectionState = %q, want occupied", got)
	}
	if got := sceneObjectAttribute(after, "wan-port", "connectedDeviceId"); got != "modem-1" {
		t.Fatalf("WAN connectedDeviceId = %q, want modem-1", got)
	}
	if got := sceneObjectAttribute(after, "modem-1", "connectedTo"); got != "wan-port" {
		t.Fatalf("modem connectedTo = %q, want wan-port", got)
	}
	if got := sceneObjectAttribute(before, "lan-port", "connectionState"); got != "occupied" {
		t.Fatalf("transition mutated input scene; LAN connectionState = %q", got)
	}
	if _, err := moveModemConnectionToWAN(after, moment.Add(time.Second)); !errors.Is(err, ErrCableAlreadyMoved) {
		t.Fatalf("second transition error = %v, want ErrCableAlreadyMoved", err)
	}
}

func TestConfirmCableMovedCreatesAfterSnapshotAndTimeline(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatalf("newSession: %v", err)
	}
	defer session.Stop()

	before, err := session.CaptureSnapshot("before-cable-move", "Support representative")
	if err != nil {
		t.Fatalf("CaptureSnapshot: %v", err)
	}
	guidance, err := session.HighlightObject("wan-port", "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	approval, err := session.ApproveCableMove(guidance.ID, "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	scene, after, err := session.ConfirmCableMoved(approval.ID, "Operator", "physically verified")
	if err != nil {
		t.Fatalf("ConfirmCableMoved: %v", err)
	}
	if scene.Version != before.Scene.Version+1 {
		t.Fatalf("scene version = %d, want %d", scene.Version, before.Scene.Version+1)
	}
	if after.Label != "after-cable-move" {
		t.Fatalf("after snapshot label = %q", after.Label)
	}
	if after.Scene.Version != scene.Version {
		t.Fatalf("after snapshot version = %d, returned scene version = %d", after.Scene.Version, scene.Version)
	}
	comparison := CompareSnapshots(before, after)
	if comparison.Same || !comparison.SceneChanged || len(comparison.Changed) != 4 || len(comparison.ChangedRelationships) != 1 {
		t.Fatalf("comparison = %+v, want four changed objects and one relationship", comparison)
	}
	if len(session.Snapshot().Snapshots) != 2 {
		t.Fatalf("stored snapshots = %d, want 2", len(session.Snapshot().Snapshots))
	}
	timeline := session.Snapshot().Timeline
	if len(timeline) < 5 {
		t.Fatalf("timeline length = %d, want snapshot + guidance + approval + transition + after snapshot", len(timeline))
	}
	if !strings.Contains(timeline[len(timeline)-2].Message, "modem cable moved from LAN to WAN") {
		t.Fatalf("transition timeline message = %q", timeline[len(timeline)-2].Message)
	}
}

func TestCompareScenesIsDeterministicAndIgnoresCaptureTimestamp(t *testing.T) {
	before := Scene{
		ID:        "router-1",
		Label:     "Network router",
		Version:   4,
		Timestamp: time.Date(2026, 8, 30, 1, 0, 0, 0, time.UTC),
		Objects: []SceneObject{
			{ID: "wan-port", Label: "WAN port", Kind: "ethernet-port", Confidence: 0.93, ParentID: "router-1", Attributes: map[string]any{"connectionState": "empty", "portRole": "WAN"}},
			{ID: "router-1", Label: "Network router", Kind: "router", Confidence: 0.96, Attributes: map[string]any{"model": "field-assist-router"}},
		},
	}
	afterA := Scene{
		ID:        before.ID,
		Label:     before.Label,
		Version:   5,
		Timestamp: before.Timestamp.Add(10 * time.Minute),
		Objects: []SceneObject{
			{ID: "router-1", Label: "Network router", Kind: "router", Confidence: 0.96, Attributes: map[string]any{"model": "field-assist-router"}},
			{ID: "wan-port", Label: "WAN port", Kind: "ethernet-port", Confidence: 0.93, ParentID: "router-1", Attributes: map[string]any{"portRole": "WAN", "connectionState": "occupied", "connectedDeviceId": "modem-1"}},
			{ID: "modem-1", Label: "Cable modem", Kind: "modem", Confidence: 0.94, Attributes: map[string]any{"connectedTo": "wan-port"}},
		},
	}
	afterB := afterA
	afterB.Timestamp = afterA.Timestamp.Add(time.Hour)
	afterB.Objects = []SceneObject{afterA.Objects[2], afterA.Objects[0], afterA.Objects[1]}

	comparisonA := CompareScenes(before, afterA)
	comparisonB := CompareScenes(before, afterB)
	if !reflect.DeepEqual(comparisonA, comparisonB) {
		t.Fatalf("comparison changed with insertion/timestamp order:\nA=%+v\nB=%+v", comparisonA, comparisonB)
	}
	if comparisonA.Same || !comparisonA.VersionChanged || len(comparisonA.Added) != 1 || len(comparisonA.Changed) != 1 {
		t.Fatalf("comparison = %+v, want one added and one changed object", comparisonA)
	}
	if comparisonA.Added[0].ID != "modem-1" || comparisonA.Changed[0].ID != "wan-port" {
		t.Fatalf("comparison order = added %q, changed %q", comparisonA.Added[0].ID, comparisonA.Changed[0].ID)
	}
	encodedA, err := json.Marshal(comparisonA)
	if err != nil {
		t.Fatalf("marshal comparison A: %v", err)
	}
	encodedB, err := json.Marshal(comparisonB)
	if err != nil {
		t.Fatalf("marshal comparison B: %v", err)
	}
	if string(encodedA) != string(encodedB) {
		t.Fatalf("comparison JSON is not deterministic:\n%s\n%s", encodedA, encodedB)
	}

	unchanged := before
	unchanged.Timestamp = before.Timestamp.Add(24 * time.Hour)
	unchanged.Objects = []SceneObject{before.Objects[1], before.Objects[0]}
	if comparison := CompareScenes(before, unchanged); !comparison.Same || comparison.SceneChanged {
		t.Fatalf("timestamp-only comparison = %+v, want same", comparison)
	}
}

func TestOperatorJoinTokenIsOneTimeAndSeparateFromCookieToken(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatalf("newSession: %v", err)
	}
	defer session.Stop()

	joinToken := session.operatorJoinToken
	if joinToken == "" || joinToken == session.OperatorToken {
		t.Fatal("join and persistent operator tokens must be distinct")
	}
	if session.ValidToken(RoleOperator, joinToken) {
		t.Fatal("join token must not authenticate as the persistent operator token")
	}
	session.operatorQRCode = []byte("cached-join-capability")
	if !session.ConsumeOperatorJoinToken(joinToken) {
		t.Fatal("first join-token exchange should succeed")
	}
	if len(session.operatorQRCode) != 0 {
		t.Fatal("consuming the join token should clear its cached QR")
	}
	if session.ConsumeOperatorJoinToken(joinToken) {
		t.Fatal("second join-token exchange should fail")
	}
	if !session.ValidToken(RoleOperator, session.OperatorToken) {
		t.Fatal("persistent operator token should remain valid after exchange")
	}
}

func TestToolInputValidation(t *testing.T) {
	for _, value := range []string{"", "  ", strings.Repeat("x", 129), "wan\nport"} {
		if _, err := validatedObjectID(value); err == nil {
			t.Fatalf("validatedObjectID(%q) unexpectedly succeeded", value)
		}
	}
	if got, err := validatedObjectID(" wan-port "); err != nil || got != "wan-port" {
		t.Fatalf("validatedObjectID valid input = %q, %v", got, err)
	}
	for _, value := range []string{"", strings.Repeat("x", 241), "label\rtext"} {
		if _, err := validatedAnnotationText(value); err == nil {
			t.Fatalf("validatedAnnotationText(%q) unexpectedly succeeded", value)
		}
	}
	if got, err := validatedAnnotationText("  Check WAN  "); err != nil || got != "Check WAN" {
		t.Fatalf("validatedAnnotationText valid input = %q, %v", got, err)
	}
	for _, value := range []string{"", strings.Repeat("x", maxInstructionTitle+1), "move\ncloser", "hold\x00still"} {
		if _, err := validatedInstructionText(value, "title", maxInstructionTitle); err == nil {
			t.Fatalf("validatedInstructionText(%q) unexpectedly succeeded", value)
		}
	}
	if got, err := validatedInstructionText("  HOLD STEADY  ", "title", maxInstructionTitle); err != nil || got != "HOLD STEADY" {
		t.Fatalf("validatedInstructionText valid input = %q, %v", got, err)
	}
	if _, err := validatedSnapshotID("", "beforeSnapshotId"); err == nil {
		t.Fatal("empty snapshot id unexpectedly succeeded")
	}
}

func TestOperatorInstructionIsBackendSyncedAndIndependentOfAnnotations(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	first, item, err := session.SendOperatorInstruction("MOVE CLOSER SLOWLY", "Take eight seconds, then hold still.", "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == "" || first.SentAt.IsZero() || first.SentBy != "Codex via WebMCP" || item.Type != "operator.instruction_updated" {
		t.Fatalf("instruction=%#v item=%#v", first, item)
	}
	second, _, err := session.SendOperatorInstruction("HOLD STEADY", "Keep the television fully visible.", "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	if current := session.GetOperatorInstruction(); current == nil || current.ID != second.ID || current.ID == first.ID {
		t.Fatalf("current instruction=%#v", current)
	}
	if _, err := session.HighlightObject("wan-port", "Codex via WebMCP"); err != nil {
		t.Fatal(err)
	}
	session.ClearAnnotations("Codex via WebMCP")
	operatorSnapshot := session.SnapshotForRole(RoleOperator).(OperatorSessionSnapshot)
	if operatorSnapshot.OperatorInstruction == nil || operatorSnapshot.OperatorInstruction.ID != second.ID {
		t.Fatalf("operator instruction missing after annotation clear: %#v", operatorSnapshot.OperatorInstruction)
	}
	filtered, ok := eventForRole(RoleOperator, Event{Type: "operator.instruction_updated", Payload: map[string]any{
		"instruction": second, "timelineItem": item,
	}})
	if !ok {
		t.Fatal("operator instruction event was filtered out")
	}
	payload := filtered.Payload.(map[string]any)
	if _, leaked := payload["timelineItem"]; leaked {
		t.Fatalf("operator instruction leaked timeline payload: %#v", payload)
	}
	if _, _, err := session.SendOperatorInstruction("", "detail", "Codex via WebMCP"); !errors.Is(err, ErrInvalidInstruction) {
		t.Fatalf("invalid instruction error = %v", err)
	}
	clearedItem, cleared := session.ClearOperatorInstruction("Support representative")
	if !cleared || clearedItem.Type != "operator.instruction_updated" || session.GetOperatorInstruction() != nil {
		t.Fatalf("clear result = %#v %v instruction=%#v", clearedItem, cleared, session.GetOperatorInstruction())
	}
	operatorSnapshot = session.SnapshotForRole(RoleOperator).(OperatorSessionSnapshot)
	if operatorSnapshot.OperatorInstruction != nil {
		t.Fatalf("cleared instruction survived in operator snapshot: %#v", operatorSnapshot.OperatorInstruction)
	}
	clearedEvent, ok := eventForRole(RoleOperator, Event{Type: "operator.instruction_updated", Payload: map[string]any{
		"instruction": nil, "timelineItem": clearedItem,
	}})
	if !ok {
		t.Fatal("cleared instruction event was filtered out")
	}
	clearedPayload := clearedEvent.Payload.(map[string]any)
	if instruction, exists := clearedPayload["instruction"]; !exists || instruction != nil {
		t.Fatalf("cleared instruction payload = %#v", clearedPayload)
	}
	if _, clearedAgain := session.ClearOperatorInstruction("Support representative"); clearedAgain {
		t.Fatal("clearing an already empty instruction was not idempotent")
	}
}

func TestArrowTargetMustStayInsideRegisteredObject(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	television, scene, _, err := session.AddSceneObject("Television", "television", Bounds{X: 0.1, Y: 0.1, Width: 0.8, Height: 0.6}, session.Scene().Version, "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.DrawArrow(television.ID, "POWER BUTTON", "Codex via WebMCP", ObjectAnchor{X: 0.5, Y: 1.04}); !errors.Is(err, ErrInvalidBounds) {
		t.Fatalf("outside-object anchor error = %v", err)
	}
	if _, err := session.DrawArrow(television.ID, "THIS IS YOUR TV", "Codex via WebMCP", ObjectAnchor{X: 0.5, Y: 0.5}); err != nil {
		t.Fatalf("inside-TV anchor = %v", err)
	}
	control, _, _, err := session.AddSceneObject("TV power button", "device-control", Bounds{X: 0.7, Y: 0.6, Width: 0.1, Height: 0.08}, scene.Version, "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	if control.Confidence >= 1 || sceneAttributeString(control, "localizationStatus") != "provisional" ||
		sceneAttributeString(control, "trackingReferenceObjectId") != television.ID {
		t.Fatalf("manual control was treated as verified spatial truth: %#v", control)
	}
	if _, err := session.DrawArrow(control.ID, "POWER BUTTON", "Codex via WebMCP", ObjectAnchor{X: 0.5, Y: 0.5}); err != nil {
		t.Fatalf("separate control anchor = %v", err)
	}
	partialControl, _, _, err := session.AddSceneObject("Outside control", "device-control", Bounds{X: 0.86, Y: 0.2, Width: 0.08, Height: 0.08}, session.Scene().Version, "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	if referenceID := sceneAttributeString(partialControl, "trackingReferenceObjectId"); referenceID != "" {
		t.Fatalf("partially outside control inherited clamped parent reference %q", referenceID)
	}
}

func TestConversationMessagesAreBoundedSharedAndRoleSafe(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	operatorMessage, _, err := session.SendConversationMessage("The label reads MODEL 42.", RoleOperator, "Operator")
	if err != nil {
		t.Fatal(err)
	}
	supportMessage, _, err := session.SendConversationMessage("Thanks. Keep that label visible.", RoleSupport, "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	messages := session.GetConversationMessages()
	if len(messages) != 2 || messages[0].ID != operatorMessage.ID || messages[1].ID != supportMessage.ID {
		t.Fatalf("messages = %#v", messages)
	}
	operatorSnapshot := session.SnapshotForRole(RoleOperator).(OperatorSessionSnapshot)
	if len(operatorSnapshot.Messages) != 2 || operatorSnapshot.Messages[1].Actor != "Codex via WebMCP" {
		t.Fatalf("operator messages = %#v", operatorSnapshot.Messages)
	}
	filtered, ok := eventForRole(RoleOperator, Event{Type: "conversation.message_sent", Payload: map[string]any{
		"message": supportMessage, "timelineItem": TimelineItem{Message: "support-only"},
	}})
	if !ok {
		t.Fatal("conversation event was filtered out")
	}
	payload := filtered.Payload.(map[string]any)
	if payload["message"] == nil || payload["timelineItem"] != nil {
		t.Fatalf("operator conversation payload = %#v", payload)
	}
	if _, _, err := session.SendConversationMessage(" ", RoleOperator, "Operator"); !errors.Is(err, ErrInvalidConversation) {
		t.Fatalf("blank conversation error = %v", err)
	}
	if _, _, err := session.SendConversationMessage(strings.Repeat("x", maxConversationText+1), RoleOperator, "Operator"); !errors.Is(err, ErrInvalidConversation) {
		t.Fatalf("oversized conversation error = %v", err)
	}
	for range maxConversationItems + 1 {
		if _, _, err := session.SendConversationMessage("bounded message", RoleOperator, "Operator"); err != nil {
			t.Fatal(err)
		}
	}
	bounded := session.GetConversationMessages()
	if len(bounded) != maxConversationItems || bounded[0].ID == operatorMessage.ID {
		t.Fatalf("bounded messages = %d, oldest original retained = %v", len(bounded), bounded[0].ID == operatorMessage.ID)
	}
}

func TestSessionStoreCanDisableSeededDemoScene(t *testing.T) {
	store := NewSessionStoreWithDemoMode(time.Hour, false)
	defer store.StopAll()
	session, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	scene := session.Scene()
	if scene.ID != "unobserved-scene" || len(scene.Objects) != 0 {
		t.Fatalf("non-demo scene = %#v, want empty unobserved scene", scene)
	}
}

func TestOperatorIssueIsExplicitCanonicalAndRoleSafe(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	if issue := session.GetOperatorIssue(); issue != nil {
		t.Fatalf("new session exposed an operator issue: %#v", issue)
	}
	if _, _, err := session.SelectOperatorIssue(OperatorIssueModeFreeform, "", "   ", "Operator"); !errors.Is(err, ErrInvalidOperatorIssue) {
		t.Fatalf("empty free-form issue = %v, want ErrInvalidOperatorIssue", err)
	}
	issue, _, err := session.SelectOperatorIssue(OperatorIssueModePreset, OperatorIssuePresetTV, "untrusted replacement", "Operator")
	if err != nil {
		t.Fatal(err)
	}
	if issue.Summary != "I lost my controller. How do I control my TV?" {
		t.Fatalf("preset issue = %#v", issue)
	}
	if _, _, err := session.SelectOperatorIssue(OperatorIssueModeFreeform, "", "replace it", "Operator"); !errors.Is(err, ErrOperatorIssueSelected) {
		t.Fatalf("duplicate issue = %v, want ErrOperatorIssueSelected", err)
	}

	if got := session.Snapshot().OperatorIssue; got == nil || got.Summary != issue.Summary {
		t.Fatalf("support snapshot issue = %#v", got)
	}
	operatorSnapshot, ok := session.SnapshotForRole(RoleOperator).(OperatorSessionSnapshot)
	if !ok {
		t.Fatalf("operator snapshot has unexpected type %T", session.SnapshotForRole(RoleOperator))
	}
	if operatorSnapshot.OperatorIssue == nil || operatorSnapshot.OperatorIssue.Summary != issue.Summary {
		t.Fatalf("operator reconnect snapshot issue = %#v", operatorSnapshot.OperatorIssue)
	}

	event, ok := eventForRole(RoleOperator, Event{Type: "operator.issue_selected", Payload: map[string]any{
		"issue":        issue,
		"message":      ConversationMessage{ID: "message-1", Text: issue.Summary, Sender: RoleOperator},
		"timelineItem": TimelineItem{Message: "support-only history"},
		"internal":     "must-not-leak",
	}})
	if !ok {
		t.Fatal("operator issue event was filtered out")
	}
	payload, ok := event.Payload.(map[string]any)
	if !ok || payload["issue"] == nil || payload["message"] == nil || payload["timelineItem"] != nil || payload["internal"] != nil {
		t.Fatalf("operator issue payload was not minimized: %#v", event.Payload)
	}
}

func TestSessionStoreCapsActiveSessions(t *testing.T) {
	store := newSessionStoreWithLimit(time.Hour, true, 2)
	defer store.StopAll()
	for i := 0; i < 2; i++ {
		if _, err := store.Create(); err != nil {
			t.Fatalf("Create %d: %v", i, err)
		}
	}
	if _, err := store.Create(); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("third Create error = %v, want ErrSessionLimit", err)
	}
}

func TestSessionStoreReportsExpiredSessionsAfterRemoval(t *testing.T) {
	store := NewSessionStore(time.Millisecond)
	defer store.StopAll()
	session, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	var observedID string
	var observedExpiry time.Time
	store.SetExpiryObserver(func(sessionID string, expiredAt time.Time) {
		observedID = sessionID
		observedExpiry = expiredAt
	})
	store.removeExpired(session.ExpiresAt.Add(time.Nanosecond))
	if observedID != session.ID || !observedExpiry.Equal(session.ExpiresAt) {
		t.Fatalf("expiry observation = %q %s, want %q %s", observedID, observedExpiry, session.ID, session.ExpiresAt)
	}
	if _, err := store.Get(session.ID); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("expired session remained in store: %v", err)
	}
}

func TestRoomContextIsSceneBoundAndSupportOnly(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	observations := []RoomObservation{
		{Label: "Television", Detail: "Large dark display centered on the wall"},
		{Label: "Media console", Detail: "Low cabinet directly below the display"},
	}
	if _, _, err := session.UpdateRoomContext("Living room with a wall-mounted television", observations, 99, "Codex via WebMCP"); !errors.Is(err, ErrSceneVersionStale) {
		t.Fatalf("stale UpdateRoomContext error = %v", err)
	}
	context, item, err := session.UpdateRoomContext("Living room with a wall-mounted television", observations, session.Scene().Version, "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	if context.UpdatedBy != "Codex via WebMCP" || len(context.Observations) != 2 || item.Type != "room.context_updated" {
		t.Fatalf("room context=%#v item=%#v", context, item)
	}
	if got := session.GetRoomContext(); got == nil || got.Summary != context.Summary {
		t.Fatalf("GetRoomContext = %#v", got)
	}
	supportSnapshot, err := json.Marshal(session.SnapshotForRole(RoleSupport))
	if err != nil {
		t.Fatal(err)
	}
	operatorSnapshot, err := json.Marshal(session.SnapshotForRole(RoleOperator))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(supportSnapshot), `"roomContext"`) {
		t.Fatalf("support snapshot omitted room context: %s", supportSnapshot)
	}
	if strings.Contains(string(operatorSnapshot), `"roomContext"`) || strings.Contains(string(operatorSnapshot), context.Summary) {
		t.Fatalf("operator snapshot leaked room context: %s", operatorSnapshot)
	}
	event := Event{Type: "room.context_updated", Payload: map[string]any{"roomContext": context}}
	if _, ok := eventForRole(RoleOperator, event); ok {
		t.Fatal("operator unexpectedly received room.context_updated")
	}
}

func TestOperatorQuestionUsesServerIssuedChoicesAndAnswersOnce(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	question, item, err := session.AskOperator("Is the power light on?", []string{"Yes", "No"}, "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	if question.Status != "pending" || question.Options[0].ID != "option-1" || question.Options[1].ID != "option-2" || item.Type != "operator.question_asked" {
		t.Fatalf("question=%#v item=%#v", question, item)
	}
	if _, _, err := session.AskOperator("Competing prompt", []string{"A", "B"}, "Codex via WebMCP"); !errors.Is(err, ErrQuestionPending) {
		t.Fatalf("second pending question error = %v", err)
	}
	if _, _, err := session.AnswerOperatorQuestion(question.ID, "untrusted-option", "Operator"); !errors.Is(err, ErrInvalidQuestionOption) {
		t.Fatalf("invalid option error = %v", err)
	}
	answered, answerItem, err := session.AnswerOperatorQuestion(question.ID, question.Options[0].ID, "Operator")
	if err != nil {
		t.Fatal(err)
	}
	if answered.Status != "answered" || answered.Answer != "Yes" || answered.AnswerID != "option-1" || answered.AnsweredAt == nil || answerItem.Type != "operator.question_answered" {
		t.Fatalf("answered=%#v item=%#v", answered, answerItem)
	}
	if _, _, err := session.AnswerOperatorQuestion(question.ID, question.Options[1].ID, "Operator"); !errors.Is(err, ErrQuestionAnswered) {
		t.Fatalf("second answer error = %v", err)
	}
	operatorSnapshot, ok := session.SnapshotForRole(RoleOperator).(OperatorSessionSnapshot)
	if !ok {
		t.Fatal("operator snapshot had the wrong concrete type")
	}
	if operatorSnapshot.ActiveQuestion == nil || operatorSnapshot.ActiveQuestion.Answer != "Yes" {
		t.Fatalf("operator active question = %#v", operatorSnapshot.ActiveQuestion)
	}
	event := Event{Type: "operator.question_asked", Payload: map[string]any{"question": question, "timelineItem": item}}
	filtered, ok := eventForRole(RoleOperator, event)
	if !ok {
		t.Fatal("operator question event was filtered out")
	}
	payload := filtered.Payload.(map[string]any)
	if _, leaked := payload["timelineItem"]; leaked {
		t.Fatalf("operator question leaked timeline payload: %#v", payload)
	}
}

func TestSessionCapsSnapshotsAndAnnotations(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	for i := 0; i < maxSceneSnapshots+3; i++ {
		if _, err := session.CaptureSnapshot("bounded", "Support representative"); err != nil {
			t.Fatalf("CaptureSnapshot %d: %v", i, err)
		}
	}
	if got := len(session.Snapshot().Snapshots); got != maxSceneSnapshots {
		t.Fatalf("snapshot count = %d, want %d", got, maxSceneSnapshots)
	}

	for i := 0; i < maxActiveAnnotations+3; i++ {
		if _, err := session.AnnotateObject("wan-port", "bounded", "Support representative"); err != nil {
			t.Fatalf("AnnotateObject %d: %v", i, err)
		}
	}
	if got := len(session.Snapshot().Annotations); got != maxActiveAnnotations {
		t.Fatalf("annotation count = %d, want %d", got, maxActiveAnnotations)
	}
}

func TestSceneRelationshipsCaseAndGuidancePrimitives(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	scene := session.Scene()
	if len(scene.Relationships) != 1 || scene.Relationships[0].ToObjectID != "lan-port" {
		t.Fatalf("seed relationship = %#v", scene.Relationships)
	}
	if scene.Calibration.CoordinateSpace != "normalized-video" {
		t.Fatalf("calibration = %#v", scene.Calibration)
	}
	if _, _, err := session.SelectOperatorIssue(OperatorIssueModeFreeform, "", "The network device is offline.", "Operator"); err != nil {
		t.Fatal(err)
	}
	if suggestion := session.SuggestNextStep(); suggestion.StepID != "choose-guidance-target" || suggestion.RequiresSupportApproval {
		t.Fatalf("suggestion = %#v", suggestion)
	}

	arrow, err := session.DrawArrow("wan-port", "Blue port", "Codex via WebMCP", ObjectAnchor{X: 0.5, Y: 0.98})
	if err != nil || arrow.Kind != AnnotationKindArrow || arrow.Anchor == nil || *arrow.Anchor != (ObjectAnchor{X: 0.5, Y: 0.98}) {
		t.Fatalf("DrawArrow = %#v, %v", arrow, err)
	}
	arrow.Anchor.X = -0.25
	storedArrow := session.Snapshot().Annotations[0]
	if storedArrow.Anchor == nil || *storedArrow.Anchor != (ObjectAnchor{X: 0.5, Y: 0.98}) {
		t.Fatalf("returned arrow mutated stored anchor: %#v", storedArrow.Anchor)
	}
	storedArrow.Anchor.Y = -0.25
	if current := session.Snapshot().Annotations[0]; current.Anchor == nil || *current.Anchor != (ObjectAnchor{X: 0.5, Y: 0.98}) {
		t.Fatalf("snapshot arrow mutated stored anchor: %#v", current.Anchor)
	}
	if _, err := session.DrawArrow("wan-port", "Invalid", "Codex via WebMCP", ObjectAnchor{X: 2, Y: 0.5}); !errors.Is(err, ErrInvalidBounds) {
		t.Fatalf("invalid arrow anchor error = %v", err)
	}
	region, err := session.ShowRegion(Bounds{X: 0.1, Y: 0.2, Width: 0.3, Height: 0.4}, "Region", "Codex via WebMCP")
	if err != nil || region.Kind != AnnotationKindRegion || region.ObjectID != "" {
		t.Fatalf("ShowRegion = %#v, %v", region, err)
	}
	move, err := session.RequestMove(MoveDirectionCloser, "Codex via WebMCP")
	if err != nil || move.Direction != MoveDirectionCloser {
		t.Fatalf("RequestMove = %#v, %v", move, err)
	}
	view, err := session.RequestOperatorView("port-panel", "Codex via WebMCP")
	if err != nil || view.Kind != AnnotationKindView || view.Label != "SHOW PORT PANEL" {
		t.Fatalf("RequestOperatorView = %#v, %v", view, err)
	}
	if _, err := session.RequestOperatorView(" ", "Codex via WebMCP"); !errors.Is(err, ErrInvalidOperatorView) {
		t.Fatalf("invalid RequestOperatorView error = %v", err)
	}
	if _, err := session.ClearAnnotation(arrow.ID, "Support representative"); err != nil {
		t.Fatal(err)
	}
	if got := len(session.Snapshot().Annotations); got != 3 {
		t.Fatalf("annotations after clear-one = %d, want 3", got)
	}
}

func TestResolveCaseRequiresVerifiedTransitionAndIsOneTime(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	if _, _, err := session.ResolveCase("Support representative"); !errors.Is(err, ErrCaseNotReady) {
		t.Fatalf("premature ResolveCase error = %v", err)
	}
	guidance, err := session.HighlightObject("wan-port", "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	approval, err := session.ApproveCableMove(guidance.ID, "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := session.ConfirmCableMoved(approval.ID, "Operator", "verified"); err != nil {
		t.Fatal(err)
	}
	context, item, err := session.ResolveCase("Support representative")
	if err != nil {
		t.Fatal(err)
	}
	if context.Status != "resolved" || context.CurrentStepID != "" || item.Type != "case.resolved" {
		t.Fatalf("ResolveCase context=%#v item=%#v", context, item)
	}
	verifyComplete := false
	for _, step := range context.Steps {
		if step.ID == "verify-wan-connection" && step.Status == "complete" {
			verifyComplete = true
		}
	}
	if !verifyComplete {
		t.Fatalf("verify step not complete: %#v", context.Steps)
	}
	if _, _, err := session.ResolveCase("Support representative"); !errors.Is(err, ErrCaseResolved) {
		t.Fatalf("repeated ResolveCase error = %v", err)
	}
	if suggestion := session.SuggestNextStep(); suggestion.Status != "complete" {
		t.Fatalf("resolved suggestion = %#v", suggestion)
	}
}

func TestCalibrationRequiresCurrentSceneVersion(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	bounds := Bounds{X: 0.61, Y: 0.5, Width: 0.2, Height: 0.2}
	if _, _, err := session.CalibrateObject("wan-port", bounds, 99, "Support representative"); !errors.Is(err, ErrSceneVersionStale) {
		t.Fatalf("stale calibration error = %v", err)
	}
	scene, item, err := session.CalibrateObject("wan-port", bounds, session.Scene().Version, "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	if scene.Version != 2 || scene.Calibration.Source != "manual" || item.Type != "scene.calibrated" {
		t.Fatalf("calibration result scene=%#v item=%#v", scene, item)
	}
	object, _ := session.InspectObject("wan-port")
	if object.Bounds != bounds {
		t.Fatalf("calibrated bounds = %#v, want %#v", object.Bounds, bounds)
	}
	if _, _, err := session.CalibrateObject("wan-port", Bounds{X: 0.9, Y: 0.9, Width: 0.2, Height: 0.2}, scene.Version, "Support representative"); !errors.Is(err, ErrInvalidBounds) {
		t.Fatalf("invalid bounds error = %v", err)
	}

	guidance, err := session.HighlightObject("wan-port", "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	approval, err := session.ApproveCableMove(guidance.ID, "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	if _, recorded, err := session.RecordSceneTracking(approval.ID, "", "wan-port", scene.Version, SceneTrackingLocked, 0.9, bounds); err != nil || !recorded {
		t.Fatalf("tracking before recalibration recorded=%v err=%v", recorded, err)
	}
	if _, _, recorded, err := session.RecordSceneActivity(approval.ID, scene.Version, 0.2); err != nil || !recorded {
		t.Fatalf("activity before recalibration recorded=%v err=%v", recorded, err)
	}
	objectCount := len(scene.Objects)
	relationshipsBefore := cloneSceneRelationships(scene.Relationships)
	recalibratedBounds := Bounds{X: 0.52, Y: 0.42, Width: 0.28, Height: 0.3}
	recalibrated, recalibrationItem, err := session.CalibrateObject("wan-port", recalibratedBounds, scene.Version, "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	if recalibrated.Version != scene.Version+1 || len(recalibrated.Objects) != objectCount || !reflect.DeepEqual(recalibrated.Relationships, relationshipsBefore) || recalibrated.Calibration.Source != "codex-vision" || recalibrationItem.Actor != "Codex via WebMCP" {
		t.Fatalf("Codex recalibration scene=%#v item=%#v", recalibrated, recalibrationItem)
	}
	recalibratedObject, err := session.InspectObject("wan-port")
	if err != nil {
		t.Fatal(err)
	}
	if recalibratedObject.Bounds != recalibratedBounds || sceneAttributeString(recalibratedObject, "boundsSource") != "codex-vision" {
		t.Fatalf("recalibrated object = %#v", recalibratedObject)
	}
	if sceneAttributeString(recalibratedObject, "recalibratedBy") != "" || sceneAttributeString(recalibratedObject, "recalibratedAt") != "" {
		t.Fatalf("recalibration polluted semantic attributes: %#v", recalibratedObject.Attributes)
	}
	snapshot := session.Snapshot()
	if snapshot.SceneTracking != nil || snapshot.SceneActivity != nil || snapshot.ActiveApproval != nil {
		t.Fatalf("stale transient state survived recalibration: tracking=%#v activity=%#v approval=%#v", snapshot.SceneTracking, snapshot.SceneActivity, snapshot.ActiveApproval)
	}
	var updatedGuidance *Annotation
	for _, annotation := range session.Snapshot().Annotations {
		if annotation.ID == guidance.ID {
			copy := annotation
			updatedGuidance = &copy
			break
		}
	}
	if updatedGuidance == nil || updatedGuidance.Bounds != recalibratedBounds {
		t.Fatalf("guidance was not rebound to recalibrated bounds: %#v", updatedGuidance)
	}
}

func TestCableMoveApprovalIsRequiredAndOneTime(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	if _, _, err := session.ConfirmCableMoved("missing", "Operator", ""); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("confirmation without approval = %v", err)
	}
	guidance, err := session.HighlightObject("wan-port", "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	approval, err := session.ApproveCableMove(guidance.ID, "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := session.ConfirmCableMoved(approval.ID, "Operator", "seated"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := session.ConfirmCableMoved(approval.ID, "Operator", "replay"); !errors.Is(err, ErrApprovalConsumed) {
		t.Fatalf("approval replay error = %v", err)
	}
	context := session.GetCaseContext()
	if context.Status != "verifying" || context.CurrentStepID != "verify-wan-connection" {
		t.Fatalf("case context after move = %#v", context)
	}
}

func TestSceneActivityIsApprovalBoundAdvisoryAndIdempotent(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	if _, _, _, err := session.RecordSceneActivity("missing", session.Scene().Version, 0.2); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("activity without approval = %v", err)
	}
	if _, _, _, err := session.RecordSceneActivity("missing", session.Scene().Version, math.NaN()); !errors.Is(err, ErrInvalidSceneActivity) {
		t.Fatalf("invalid activity score = %v", err)
	}

	guidance, err := session.HighlightObject("wan-port", "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	approval, err := session.ApproveCableMove(guidance.ID, "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	activity, item, recorded, err := session.RecordSceneActivity(approval.ID, approval.SceneVersion, 0.2)
	if err != nil {
		t.Fatal(err)
	}
	if !recorded || activity.ObjectID != "wan-port" || activity.Source != "browser-frame-difference" || item.Type != "scene.activity_detected" {
		t.Fatalf("activity=%#v item=%#v recorded=%v", activity, item, recorded)
	}
	if snapshot := session.Snapshot(); snapshot.SceneActivity == nil || snapshot.SceneActivity.ID != activity.ID {
		t.Fatalf("support snapshot activity = %#v", snapshot.SceneActivity)
	}
	timelineCount := len(session.GetCaseTimeline())
	repeated, repeatedItem, recorded, err := session.RecordSceneActivity(approval.ID, approval.SceneVersion, 0.8)
	if err != nil {
		t.Fatal(err)
	}
	if recorded || repeated.ID != activity.ID || repeatedItem.ID != "" || len(session.GetCaseTimeline()) != timelineCount {
		t.Fatalf("idempotent activity=%#v item=%#v recorded=%v timeline=%d", repeated, repeatedItem, recorded, len(session.GetCaseTimeline()))
	}
	if _, _, _, err := session.RecordSceneActivity(approval.ID, approval.SceneVersion+1, 0.2); !errors.Is(err, ErrSceneVersionStale) {
		t.Fatalf("stale activity version = %v", err)
	}
	if _, _, err := session.ConfirmCableMoved(approval.ID, "Operator", "seated"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := session.RecordSceneActivity(approval.ID, approval.SceneVersion, 0.2); !errors.Is(err, ErrApprovalConsumed) {
		t.Fatalf("activity after confirmation = %v", err)
	}
}

func TestSceneTrackingIsApprovalBoundTransientAndDoesNotMutateScene(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	before := session.Scene()
	anchor, err := session.InspectObject("wan-port")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := session.RecordSceneTracking("missing", "", "wan-port", before.Version, SceneTrackingLocked, 0.9, anchor.Bounds); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("tracking without approval = %v", err)
	}

	guidance, err := session.HighlightObject("wan-port", "Support representative")
	if err != nil {
		t.Fatal(err)
	}
	approval, err := session.ApproveCableMove(guidance.ID, "Support representative")
	if err != nil {
		t.Fatal(err)
	}

	fallback, recorded, err := session.RecordSceneTracking(
		approval.ID,
		"",
		"wan-port",
		approval.SceneVersion,
		SceneTrackingCalibratedFallback,
		0,
		anchor.Bounds,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !recorded || fallback.Status != SceneTrackingCalibratedFallback || fallback.Source != "browser-multiscale-template" || fallback.Scale != 1 || fallback.RelativeDepth != 1 || fallback.ScaleSource != "visual-relative" {
		t.Fatalf("fallback=%#v recorded=%v", fallback, recorded)
	}
	if fallback.GuidanceID != guidance.ID {
		t.Fatalf("approval tracking guidance = %q want %q", fallback.GuidanceID, guidance.ID)
	}
	if repeated, recorded, err := session.RecordSceneTracking(approval.ID, "", "wan-port", approval.SceneVersion, SceneTrackingCalibratedFallback, 0, anchor.Bounds); err != nil || recorded || repeated.UpdatedAt.Before(fallback.UpdatedAt) {
		t.Fatalf("duplicate fallback=%#v recorded=%v err=%v", repeated, recorded, err)
	}

	trackedBounds := anchor.Bounds
	trackedBounds.X += 0.04
	locked, recorded, err := session.RecordSceneTracking(
		approval.ID,
		"",
		"wan-port",
		approval.SceneVersion,
		SceneTrackingLocked,
		0.92,
		trackedBounds,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !recorded || locked.Status != SceneTrackingLocked || locked.Bounds != trackedBounds {
		t.Fatalf("locked=%#v recorded=%v", locked, recorded)
	}
	if locked.Scale != 1 || locked.RelativeDepth != 1 {
		t.Fatalf("translation-only tracking changed relative scale: %#v", locked)
	}
	if current := session.TrackingForObject("wan-port"); current == nil || *current != locked {
		t.Fatalf("tracking lookup=%#v want %#v", current, locked)
	}

	after := session.Scene()
	if after.Version != before.Version || !reflect.DeepEqual(after.Objects, before.Objects) {
		t.Fatalf("tracking mutated scene: before=%#v after=%#v", before, after)
	}
	if len(session.GetCaseTimeline()) != 2 {
		t.Fatalf("tracking added timeline entries: %#v", session.GetCaseTimeline())
	}

	scaled := anchor.Bounds
	scaled.Width *= 1.2
	scaled.Height *= 1.2
	scaled.X -= (scaled.Width - anchor.Bounds.Width) / 2
	scaled.Y -= (scaled.Height - anchor.Bounds.Height) / 2
	depthTracked, recorded, err := session.RecordSceneTracking(approval.ID, "", "wan-port", approval.SceneVersion, SceneTrackingFollowingDrift, 0.88, scaled)
	if err != nil || !recorded || math.Abs(depthTracked.Scale-1.2) > 0.0001 || math.Abs(depthTracked.RelativeDepth-(1.0/1.2)) > 0.0001 {
		t.Fatalf("scaled tracking=%#v recorded=%v err=%v", depthTracked, recorded, err)
	}
	enhanced, recorded, err := session.RecordSceneTracking(
		approval.ID,
		"",
		"wan-port",
		approval.SceneVersion,
		SceneTrackingFollowingDrift,
		0.91,
		scaled,
		SceneTrackingEvidence{
			Source: "opencv-homography+depth-anything", DepthScore: 0.64, DepthConfidence: 0.82,
			ModelRelativeDepth: 0.87, DepthSource: "depth-anything-v2-small-q4f16",
			Quad: &TrackingQuad{
				{X: scaled.X, Y: scaled.Y},
				{X: scaled.X + scaled.Width, Y: scaled.Y},
				{X: scaled.X + scaled.Width, Y: scaled.Y + scaled.Height},
				{X: scaled.X, Y: scaled.Y + scaled.Height},
			},
			Anchor: &Point{X: scaled.X + scaled.Width/2, Y: scaled.Y + scaled.Height},
		},
	)
	if err != nil || !recorded || enhanced.Source != "opencv-homography+depth-anything" || enhanced.DepthSource != "depth-anything-v2-small-q4f16" || enhanced.ScaleSource != "homography-depth-validated" || enhanced.ModelRelativeDepth != 0.87 || enhanced.Quad == nil || enhanced.Anchor == nil {
		t.Fatalf("enhanced tracking=%#v recorded=%v err=%v", enhanced, recorded, err)
	}
	enhanced.Quad[0].X = 0
	enhanced.Anchor.X = 0
	currentEnhanced := session.TrackingForObject("wan-port")
	if currentEnhanced == nil || currentEnhanced.Quad == nil || currentEnhanced.Anchor == nil || currentEnhanced.Quad[0].X != scaled.X || currentEnhanced.Anchor.X != scaled.X+scaled.Width/2 {
		t.Fatalf("returned tracking mutated stored geometry: %#v", currentEnhanced)
	}
	pnpTracked, recorded, err := session.RecordSceneTracking(
		approval.ID,
		"",
		"wan-port",
		approval.SceneVersion,
		SceneTrackingFollowingDrift,
		0.93,
		scaled,
		SceneTrackingEvidence{
			Source: "opencv-pnp+depth-anything", DepthScore: 0.64, DepthConfidence: 0.82,
			ModelRelativeDepth: 0.87, DepthSource: "depth-anything-v2-small-q4f16",
			PoseState: "active", PoseInliers: 18, PoseInlierRatio: 0.72,
			Quad: &TrackingQuad{
				{X: scaled.X, Y: scaled.Y},
				{X: scaled.X + scaled.Width, Y: scaled.Y},
				{X: scaled.X + scaled.Width, Y: scaled.Y + scaled.Height},
				{X: scaled.X, Y: scaled.Y + scaled.Height},
			},
			Anchor: &Point{X: scaled.X + scaled.Width/2, Y: scaled.Y + scaled.Height},
		},
	)
	if err != nil || !recorded || pnpTracked.Source != "opencv-pnp+depth-anything" || pnpTracked.ScaleSource != "pnp-world-relative" || pnpTracked.Quad == nil || pnpTracked.Anchor == nil || pnpTracked.PoseState != "active" || pnpTracked.PoseInliers != 18 || pnpTracked.PoseInlierRatio != 0.72 {
		t.Fatalf("PnP tracking=%#v recorded=%v err=%v", pnpTracked, recorded, err)
	}
	partialQuad := TrackingQuad{
		{X: 0.90, Y: anchor.Bounds.Y},
		{X: 1.07, Y: anchor.Bounds.Y},
		{X: 1.07, Y: anchor.Bounds.Y + anchor.Bounds.Height},
		{X: 0.90, Y: anchor.Bounds.Y + anchor.Bounds.Height},
	}
	partialBounds := Bounds{X: 0.90, Y: anchor.Bounds.Y, Width: 0.10, Height: anchor.Bounds.Height}
	partialVisibleFraction := 0.10 / 0.17
	partial, recorded, err := session.RecordSceneTracking(
		approval.ID,
		"",
		"wan-port",
		approval.SceneVersion,
		SceneTrackingFollowingDrift,
		0.89,
		partialBounds,
		SceneTrackingEvidence{
			Source: "opencv-homography+depth-anything", DepthScore: 0.62, DepthConfidence: 0.81,
			ModelRelativeDepth: 0.91, DepthSource: "depth-anything-v2-small-q4f16",
			Quad: &partialQuad, Anchor: &Point{X: 0.985, Y: anchor.Bounds.Y + anchor.Bounds.Height},
			PartialVisibility: true, VisibleFraction: partialVisibleFraction, AnchorVisible: true,
		},
	)
	if err != nil || !recorded || !partial.PartialVisibility || !partial.AnchorVisible ||
		math.Abs(partial.VisibleFraction-partialVisibleFraction) > 0.0001 || partial.Quad == nil || partial.Quad[1].X <= 1 || partial.Bounds != partialBounds {
		t.Fatalf("partial tracking=%#v recorded=%v err=%v", partial, recorded, err)
	}
	invalidQuad := TrackingQuad{
		{X: scaled.X, Y: scaled.Y},
		{X: scaled.X + scaled.Width, Y: scaled.Y + scaled.Height},
		{X: scaled.X + scaled.Width, Y: scaled.Y},
		{X: scaled.X, Y: scaled.Y + scaled.Height},
	}
	if _, _, err := session.RecordSceneTracking(
		approval.ID, "", "wan-port", approval.SceneVersion, SceneTrackingFollowingDrift, 0.91, scaled,
		SceneTrackingEvidence{
			Source: "opencv-homography+depth-anything", Quad: &invalidQuad,
			DepthConfidence: 0.8, ModelRelativeDepth: 0.9, DepthSource: "depth-anything-v2-small-q4f16",
		},
	); !errors.Is(err, ErrInvalidTracking) {
		t.Fatalf("non-convex tracking quad error = %v", err)
	}
	if _, _, err := session.RecordSceneTracking(
		approval.ID,
		"",
		"wan-port",
		approval.SceneVersion,
		SceneTrackingFollowingDrift,
		0.91,
		scaled,
		SceneTrackingEvidence{Source: "opencv-homography+depth-anything", DepthConfidence: 0.8, ModelRelativeDepth: 0.9, DepthSource: "unreleased-model"},
	); !errors.Is(err, ErrInvalidTracking) {
		t.Fatalf("invalid depth evidence = %v", err)
	}
	recalibrationRequired, recorded, err := session.RecordSceneTracking(approval.ID, "", "wan-port", approval.SceneVersion, SceneTrackingRecalibrationRequired, 0.68, scaled)
	if err != nil || !recorded || !recalibrationRequired.NeedsRecalibration || recalibrationRequired.Status != SceneTrackingRecalibrationRequired {
		t.Fatalf("recalibration-required tracking=%#v recorded=%v err=%v", recalibrationRequired, recorded, err)
	}
	if _, _, err := session.RecordSceneTracking(approval.ID, "", "wan-port", approval.SceneVersion, SceneTrackingRecalibrationRequired, 0.72, scaled); !errors.Is(err, ErrInvalidTracking) {
		t.Fatalf("invalid recalibration confidence = %v", err)
	}

	outside := anchor.Bounds
	outside.X += 0.2
	if _, _, err := session.RecordSceneTracking(approval.ID, "", "wan-port", approval.SceneVersion, SceneTrackingFollowingDrift, 0.8, outside); !errors.Is(err, ErrInvalidTracking) {
		t.Fatalf("out-of-envelope tracking = %v", err)
	}
	if _, _, err := session.RecordSceneTracking(approval.ID, "", "wan-port", approval.SceneVersion, SceneTrackingCalibratedFallback, 0.1, anchor.Bounds); !errors.Is(err, ErrInvalidTracking) {
		t.Fatalf("invalid fallback confidence = %v", err)
	}

	operatorJSON, err := json.Marshal(session.SnapshotForRole(RoleOperator))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(operatorJSON), `"sceneTracking"`) {
		t.Fatalf("operator snapshot omitted shared overlay tracking geometry: %s", operatorJSON)
	}
	trackingEvent, ok := eventForRole(RoleOperator, Event{Type: "scene.tracking_updated", Payload: map[string]any{
		"tracking": locked,
		"internal": "must-not-leak",
	}})
	if !ok || trackingEvent.Type != "scene.tracking_updated" {
		t.Fatalf("operator did not receive shared overlay tracking event: %#v ok=%v", trackingEvent, ok)
	}
	trackingPayload, ok := trackingEvent.Payload.(map[string]any)
	if !ok || trackingPayload["tracking"] == nil || trackingPayload["internal"] != nil {
		t.Fatalf("operator tracking payload was not minimized: %#v", trackingEvent.Payload)
	}

	if _, _, err := session.ConfirmCableMoved(approval.ID, "Operator", "seated"); err != nil {
		t.Fatal(err)
	}
	if session.Snapshot().SceneTracking != nil {
		t.Fatalf("tracking survived approval consumption: %#v", session.Snapshot().SceneTracking)
	}
}

func TestSceneTrackingAcceptsActiveObjectBoundGuidanceWithoutApproval(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	anchor, err := session.InspectObject("wan-port")
	if err != nil {
		t.Fatal(err)
	}
	guidance, err := session.HighlightObject("wan-port", "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	tracking, recorded, err := session.RecordSceneTracking(
		"",
		guidance.ID,
		"wan-port",
		session.Scene().Version,
		SceneTrackingLocked,
		0.91,
		anchor.Bounds,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !recorded || tracking.ApprovalID != "" || tracking.GuidanceID != guidance.ID || tracking.Status != SceneTrackingLocked {
		t.Fatalf("tracking=%#v recorded=%v", tracking, recorded)
	}
	if _, _, err := session.RecordSceneTracking("", "missing", "wan-port", session.Scene().Version, SceneTrackingLocked, 0.9, anchor.Bounds); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("tracking with missing guidance = %v", err)
	}
	if _, err := session.ClearAnnotation(guidance.ID, "Codex via WebMCP"); err != nil {
		t.Fatal(err)
	}
	if session.Snapshot().SceneTracking != nil {
		t.Fatalf("tracking survived guidance removal: %#v", session.Snapshot().SceneTracking)
	}
}

func TestAnnotationAcknowledgementsAreIdempotentSupportOnlyDeliveryEvidence(t *testing.T) {
	session, err := newSession(time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Stop()

	annotation, err := session.HighlightObject("wan-port", "Codex via WebMCP")
	if err != nil {
		t.Fatal(err)
	}
	before := session.Scene()
	timelineCount := len(session.GetCaseTimeline())
	receipts, recorded, err := session.AcknowledgeAnnotations([]string{annotation.ID, annotation.ID}, before.Version)
	if err != nil {
		t.Fatal(err)
	}
	if !recorded || len(receipts) != 1 {
		t.Fatalf("receipts=%#v recorded=%v", receipts, recorded)
	}
	receipt := receipts[0]
	if receipt.AnnotationID != annotation.ID || receipt.ObjectID != "wan-port" || receipt.SceneVersion != before.Version || receipt.Source != "operator-rendered-overlay" {
		t.Fatalf("receipt=%#v", receipt)
	}
	if after := session.Scene(); !reflect.DeepEqual(after, before) {
		t.Fatalf("acknowledgement mutated scene: before=%#v after=%#v", before, after)
	}
	if len(session.GetCaseTimeline()) != timelineCount {
		t.Fatalf("acknowledgement added timeline evidence: %#v", session.GetCaseTimeline())
	}

	repeated, recorded, err := session.AcknowledgeAnnotations([]string{annotation.ID}, before.Version)
	if err != nil || recorded || len(repeated) != 1 || repeated[0] != receipt {
		t.Fatalf("idempotent receipts=%#v recorded=%v err=%v", repeated, recorded, err)
	}
	if _, _, err := session.AcknowledgeAnnotations([]string{"missing"}, before.Version); !errors.Is(err, ErrAnnotationNotFound) {
		t.Fatalf("missing annotation acknowledgement = %v", err)
	}
	if _, _, err := session.AcknowledgeAnnotations([]string{annotation.ID}, before.Version+1); !errors.Is(err, ErrSceneVersionStale) {
		t.Fatalf("stale acknowledgement = %v", err)
	}

	snapshot := session.Snapshot()
	if len(snapshot.AnnotationReceipts) != 1 || snapshot.AnnotationReceipts[0] != receipt {
		t.Fatalf("support receipts=%#v", snapshot.AnnotationReceipts)
	}
	operatorJSON, err := json.Marshal(session.SnapshotForRole(RoleOperator))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(operatorJSON), "annotationReceipts") {
		t.Fatalf("operator snapshot leaked delivery receipts: %s", operatorJSON)
	}
	if event, ok := eventForRole(RoleOperator, Event{Type: "annotation.acknowledged", Payload: map[string]any{"receipts": receipts}}); ok || event.Type != "" {
		t.Fatalf("operator received support-only acknowledgement event: %#v ok=%v", event, ok)
	}

	if _, err := session.ClearAnnotation(annotation.ID, "Support representative"); err != nil {
		t.Fatal(err)
	}
	if len(session.Snapshot().AnnotationReceipts) != 0 {
		t.Fatalf("receipt survived annotation removal: %#v", session.Snapshot().AnnotationReceipts)
	}
}

func sceneObjectAttribute(scene Scene, objectID, key string) string {
	for _, object := range scene.Objects {
		if object.ID == objectID {
			return sceneAttributeString(object, key)
		}
	}
	return ""
}
