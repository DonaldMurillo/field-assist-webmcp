package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/DonaldMurillo/gofastr/core/handler"
	"github.com/DonaldMurillo/gofastr/core/middleware"
	"github.com/DonaldMurillo/gofastr/core/router"
	"github.com/DonaldMurillo/gofastr/core/stream"
	"github.com/DonaldMurillo/gofastr/framework"
	"github.com/DonaldMurillo/gofastr/framework/experimental/webmcp"
)

const (
	supportCookieName           = "gofastr_field_support"
	operatorCookieName          = "gofastr_field_operator"
	anonymousSessionCreateBurst = 24
)

type service struct {
	sessions        *SessionStore
	barcodeBaseURL  string
	barcodeAPIKey   string
	barcodeClient   *http.Client
	publicBaseURL   *url.URL
	allowedOrigins  map[string]struct{}
	iceServers      []iceServerConfig
	demoMode        bool
	applicationMode string
	logger          func() *slog.Logger
	webMCPDebug     bool
}

type createdSession struct {
	ID           string    `json:"id"`
	SupportPath  string    `json:"supportPath"`
	OperatorPath string    `json:"operatorPath"`
	ExpiresAt    time.Time `json:"expiresAt"`
}

type createSessionInput struct {
	Mode string `json:"mode,omitempty"`
}

type currentSessionResponse struct {
	Role         Role   `json:"role"`
	OperatorPath string `json:"operatorPath,omitempty"`
	Snapshot     any    `json:"snapshot"`
}

type appInfoResponse struct {
	Name                  string              `json:"name"`
	Purpose               string              `json:"purpose"`
	DemoMode              bool                `json:"demoMode"`
	Runtime               string              `json:"runtime"`
	Architecture          []string            `json:"architecture"`
	DemoFlow              []string            `json:"demoFlow"`
	OperatingExpectations []string            `json:"operatingExpectations"`
	ContextVersion        string              `json:"contextVersion"`
	ProtocolVersion       string              `json:"protocolVersion"`
	Protocol              fieldAssistProtocol `json:"protocol"`
	Workflows             []string            `json:"workflows"`
	LiveSession           SessionSnapshot     `json:"liveSession"`
	CurrentRequest        *OperatorIssue      `json:"currentRequest,omitempty"`
}

// fieldAssistProtocol is the app-provided operating contract. It is returned
// through WebMCP so a new Codex run can acquire the workflow, confidence
// vocabulary, and targeting rules without installing a separate skill.
type fieldAssistProtocol struct {
	Version               string            `json:"version"`
	Sequence              []string          `json:"sequence"`
	ConfidenceDefinitions map[string]string `json:"confidenceDefinitions"`
	TargetingRules        []string          `json:"targetingRules"`
	MutationRules         []string          `json:"mutationRules"`
}

// fieldAssistMutationInput is embedded in WebMCP mutation inputs so the
// released bridge's strict JSON binder accepts the required contextVersion
// while the same handlers remain callable by the manual support UI (which is
// not marked as WebMCP and therefore does not need the field).
type fieldAssistMutationInput struct {
	ContextVersion string `json:"contextVersion,omitempty"`
}

type iceConfigResponse struct {
	ICEServers []iceServerConfig `json:"iceServers"`
}

type highlightInput struct {
	fieldAssistMutationInput
	ObjectID string `json:"objectId"`
}

type annotateObjectInput struct {
	fieldAssistMutationInput
	ObjectID string `json:"objectId"`
	Text     string `json:"text"`
}

type operatorInstructionInput struct {
	fieldAssistMutationInput
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

type operatorInstructionResponse struct {
	Success      bool                `json:"success"`
	Instruction  OperatorInstruction `json:"instruction"`
	TimelineItem TimelineItem        `json:"timelineItem"`
}

type clearOperatorInstructionResponse struct {
	Success      bool          `json:"success"`
	Cleared      bool          `json:"cleared"`
	TimelineItem *TimelineItem `json:"timelineItem,omitempty"`
}

type conversationMessageInput struct {
	fieldAssistMutationInput
	Text string `json:"text"`
}

type conversationMessageResponse struct {
	Success      bool                `json:"success"`
	Message      ConversationMessage `json:"message"`
	TimelineItem TimelineItem        `json:"timelineItem"`
}

type drawArrowInput struct {
	fieldAssistMutationInput
	ObjectID string        `json:"objectId"`
	Text     string        `json:"text,omitempty"`
	Anchor   *ObjectAnchor `json:"anchor,omitempty"`
}

type regionInput struct {
	fieldAssistMutationInput
	Bounds Bounds `json:"bounds"`
	Text   string `json:"text,omitempty"`
}

type moveInput struct {
	fieldAssistMutationInput
	Direction MoveDirection `json:"direction"`
}

type operatorViewInput struct {
	fieldAssistMutationInput
	Target string `json:"target"`
}

type clearAnnotationInput struct {
	fieldAssistMutationInput
	AnnotationID string `json:"annotationId"`
}

type clearAnnotationsInput struct {
	fieldAssistMutationInput
}

type calibrationInput struct {
	fieldAssistMutationInput
	ObjectID         string `json:"objectId"`
	Bounds           Bounds `json:"bounds"`
	BaseSceneVersion uint64 `json:"baseSceneVersion"`
}

type calibrationResponse struct {
	Success bool         `json:"success"`
	Scene   Scene        `json:"scene"`
	Item    TimelineItem `json:"timelineItem"`
}

type createSceneObjectInput struct {
	fieldAssistMutationInput
	Label            string `json:"label"`
	Kind             string `json:"kind,omitempty"`
	Bounds           Bounds `json:"bounds"`
	BaseSceneVersion uint64 `json:"baseSceneVersion"`
}

type createSceneObjectResponse struct {
	Success bool         `json:"success"`
	Object  SceneObject  `json:"object"`
	Scene   Scene        `json:"scene"`
	Item    TimelineItem `json:"timelineItem"`
}

type approvalInput struct {
	GuidanceID string `json:"guidanceId"`
}

type approvalResponse struct {
	Success  bool           `json:"success"`
	Approval ActionApproval `json:"approval"`
}

type resolveCaseResponse struct {
	Success bool         `json:"success"`
	Case    CaseContext  `json:"case"`
	Item    TimelineItem `json:"timelineItem"`
}

type caseContextResponse struct {
	Success bool        `json:"success"`
	Case    CaseContext `json:"case"`
}

type caseTimelineResponse struct {
	Success  bool           `json:"success"`
	Timeline []TimelineItem `json:"timeline"`
}

type nextStepResponse struct {
	Success    bool               `json:"success"`
	Suggestion NextStepSuggestion `json:"suggestion"`
}

type inspectObjectResponse struct {
	Success      bool                    `json:"success"`
	Object       SceneObject             `json:"object"`
	Visible      bool                    `json:"visible"`
	SceneVersion uint64                  `json:"sceneVersion"`
	Tracking     *SceneTrackingTelemetry `json:"tracking,omitempty"`
}

type highlightResponse struct {
	Success    bool       `json:"success"`
	Annotation Annotation `json:"annotation"`
	Message    string     `json:"message"`
}

type clearResponse struct {
	Success bool `json:"success"`
	Cleared int  `json:"cleared"`
}

type observationInput struct {
	fieldAssistMutationInput
	Text string `json:"text"`
}

type observationResponse struct {
	Success     bool         `json:"success"`
	Observation TimelineItem `json:"observation"`
}

type inspectSceneResponse struct {
	Scene
	RoomContext         *RoomContext          `json:"roomContext,omitempty"`
	OperatorIssue       *OperatorIssue        `json:"operatorIssue,omitempty"`
	ActiveQuestion      *OperatorQuestion     `json:"activeQuestion,omitempty"`
	OperatorInstruction *OperatorInstruction  `json:"operatorInstruction,omitempty"`
	Messages            []ConversationMessage `json:"messages,omitempty"`
}

type roomContextInput struct {
	fieldAssistMutationInput
	Summary          string            `json:"summary"`
	Observations     []RoomObservation `json:"observations"`
	BaseSceneVersion uint64            `json:"baseSceneVersion"`
}

type roomContextResponse struct {
	Success      bool         `json:"success"`
	RoomContext  RoomContext  `json:"roomContext"`
	TimelineItem TimelineItem `json:"timelineItem"`
}

type askOperatorInput struct {
	fieldAssistMutationInput
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

type operatorQuestionResponse struct {
	Success      bool             `json:"success"`
	Question     OperatorQuestion `json:"question"`
	TimelineItem TimelineItem     `json:"timelineItem"`
}

type answerOperatorQuestionInput struct {
	QuestionID string `json:"questionId"`
	OptionID   string `json:"optionId"`
}

type selectOperatorIssueInput struct {
	Mode     string `json:"mode"`
	PresetID string `json:"presetId,omitempty"`
	Summary  string `json:"summary,omitempty"`
}

type operatorIssueResponse struct {
	Success      bool          `json:"success"`
	Issue        OperatorIssue `json:"issue"`
	TimelineItem TimelineItem  `json:"timelineItem"`
}

type captureSnapshotInput struct {
	fieldAssistMutationInput
	Label string `json:"label,omitempty"`
}

type snapshotResponse struct {
	Success  bool          `json:"success"`
	Snapshot SceneSnapshot `json:"snapshot"`
	Message  string        `json:"message"`
}

type compareSnapshotsInput struct {
	BeforeSnapshotID string `json:"beforeSnapshotId"`
	AfterSnapshotID  string `json:"afterSnapshotId"`
}

type compareSnapshotsResponse struct {
	Success    bool            `json:"success"`
	Comparison SceneComparison `json:"comparison"`
}

type confirmCableMovedInput struct {
	ApprovalID string `json:"approvalId"`
	Note       string `json:"note,omitempty"`
}

type sceneActivityInput struct {
	ApprovalID       string  `json:"approvalId"`
	BaseSceneVersion uint64  `json:"baseSceneVersion"`
	ChangeScore      float64 `json:"changeScore"`
}

type sceneActivityResponse struct {
	Success      bool          `json:"success"`
	Recorded     bool          `json:"recorded"`
	Activity     SceneActivity `json:"activity"`
	TimelineItem *TimelineItem `json:"timelineItem,omitempty"`
}

type sceneTrackingInput struct {
	ApprovalID         string              `json:"approvalId"`
	GuidanceID         string              `json:"guidanceId"`
	ObjectID           string              `json:"objectId"`
	ReferenceObjectID  string              `json:"referenceObjectId"`
	BaseSceneVersion   uint64              `json:"baseSceneVersion"`
	Status             SceneTrackingStatus `json:"status"`
	Confidence         float64             `json:"confidence"`
	Bounds             Bounds              `json:"bounds"`
	Quad               []Point             `json:"quad,omitempty"`
	Anchor             *Point              `json:"anchor,omitempty"`
	Source             string              `json:"source"`
	DepthScore         float64             `json:"depthScore"`
	DepthConfidence    float64             `json:"depthConfidence"`
	ModelRelativeDepth float64             `json:"modelRelativeDepth"`
	DepthSource        string              `json:"depthSource"`
	PoseState          string              `json:"poseState"`
	PoseFailureReason  string              `json:"poseFailureReason"`
	PoseInliers        int                 `json:"poseInliers"`
	PoseInlierRatio    float64             `json:"poseInlierRatio"`
	PartialVisibility  bool                `json:"partialVisibility"`
	VisibleFraction    float64             `json:"visibleFraction"`
	AnchorVisible      bool                `json:"anchorVisible"`
}

type sceneTrackingResponse struct {
	Success  bool                   `json:"success"`
	Recorded bool                   `json:"recorded"`
	Tracking SceneTrackingTelemetry `json:"tracking"`
}

type annotationAcknowledgementInput struct {
	AnnotationIDs []string `json:"annotationIds"`
	SceneVersion  uint64   `json:"sceneVersion"`
}

type annotationAcknowledgementResponse struct {
	Success  bool                `json:"success"`
	Recorded bool                `json:"recorded"`
	Receipts []AnnotationReceipt `json:"receipts"`
}

type confirmCableMovedResponse struct {
	Success       bool          `json:"success"`
	Scene         Scene         `json:"scene"`
	AfterSnapshot SceneSnapshot `json:"afterSnapshot"`
	Message       string        `json:"message"`
}

type debugCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

type debugConnectionReportResponse struct {
	DebugMode   bool      `json:"debugMode"`
	GeneratedAt time.Time `json:"generatedAt"`
	Runtime     string    `json:"runtime"`
	Session     struct {
		ID           string       `json:"id"`
		Sequence     uint64       `json:"sequence"`
		Participants map[Role]int `json:"participants"`
		CreatedAt    time.Time    `json:"createdAt"`
		ExpiresAt    time.Time    `json:"expiresAt"`
	} `json:"session"`
	Scene struct {
		ID                string `json:"id"`
		Version           uint64 `json:"version"`
		Objects           int    `json:"objects"`
		Relationships     int    `json:"relationships"`
		CalibrationSource string `json:"calibrationSource"`
	} `json:"scene"`
	Guidance struct {
		Active       int `json:"active"`
		Acknowledged int `json:"acknowledged"`
		Pending      int `json:"pending"`
	} `json:"guidance"`
	Collections struct {
		Timeline  int `json:"timeline"`
		Snapshots int `json:"snapshots"`
	} `json:"collections"`
	WebRTC   map[Role]WebRTCRoleDebug `json:"webRTC"`
	Tracking *SceneTrackingTelemetry  `json:"tracking,omitempty"`
	Activity *SceneActivity           `json:"activity,omitempty"`
	Checks   []debugCheck             `json:"checks"`
}

type debugPingInput struct {
	fieldAssistMutationInput
	ObjectID string `json:"objectId,omitempty"`
}

func (s *service) registerRoutes(app *framework.App) {
	rt := app.Router()
	createLimit := middleware.RateLimit(middleware.RateLimitConfig{
		// Five consecutive acceptance/demo cycles create twenty-five sessions.
		// A 24-token burst plus the slow refill covers that explicit hardening
		// gate while the independent 64-session store cap bounds total memory.
		Capacity:     anonymousSessionCreateBurst,
		RefillEvery:  5 * time.Second,
		RefillBy:     1,
		ErrorMessage: "too many sessions created; try again shortly",
	})
	rt.Post("/sessions/new", createLimit(http.HandlerFunc(s.createSessionRedirect)))
	rt.Post("/api/sessions", createLimit(http.HandlerFunc(s.createSessionJSON)))
	privateGet := func(path string, next http.Handler) {
		rt.Get(path, s.noStoreAuthenticated(next))
	}
	privateGet("/api/session/current", handler.HandlerAdapter(s.currentSession))
	privateGet("/api/session/ice-config", handler.HandlerAdapter(s.iceConfig))
	privateToolGet := func(path, name string, next http.Handler) {
		privateGet(path, s.observeToolOutcome(name, next))
	}
	privateGet("/api/session/operator-qr", http.HandlerFunc(s.operatorQRCode))
	privateToolGet("/api/tools/app-info", "get_app_info", handler.HandlerAdapter(s.appInfo))
	protectedPost := func(path string, next http.Handler) {
		rt.Post(path, s.requireSameOriginMutation(next))
	}
	protectedToolPost := func(path, name string, next http.Handler) {
		protectedPost(path, s.observeToolOutcome(name, s.requireWebMCPContext(next)))
	}
	protectedReadOnlyToolPost := func(path, name string, next http.Handler) {
		protectedPost(path, s.observeToolOutcome(name, next))
	}
	protectedReadOnlyToolPost("/api/tools/inspect-scene", "inspect_scene", handler.HandlerAdapter(s.inspectScene))
	protectedToolPost("/api/tools/update-room-context", "update_room_context", handler.HandlerAdapter(s.updateRoomContext))
	protectedReadOnlyToolPost("/api/tools/inspect-object", "inspect_object", handler.HandlerAdapter(s.inspectObject))
	protectedToolPost("/api/tools/recalibrate-object", "recalibrate_object", handler.HandlerAdapter(s.calibrateSceneObject))
	protectedToolPost("/api/tools/register-scene-object", "register_scene_object", handler.HandlerAdapter(s.createSceneObject))
	protectedToolPost("/api/tools/highlight-object", "highlight_object", handler.HandlerAdapter(s.highlightObject))
	protectedToolPost("/api/tools/annotate-object", "annotate_object", handler.HandlerAdapter(s.annotateObject))
	protectedToolPost("/api/tools/send-operator-instruction", "send_operator_instruction", handler.HandlerAdapter(s.sendOperatorInstruction))
	protectedToolPost("/api/tools/send-operator-message", "send_operator_message", handler.HandlerAdapter(s.sendOperatorMessage))
	protectedToolPost("/api/tools/request-closeup", "request_closeup", handler.HandlerAdapter(s.requestCloseup))
	protectedToolPost("/api/tools/request-different-angle", "request_different_angle", handler.HandlerAdapter(s.requestDifferentAngle))
	protectedToolPost("/api/tools/draw-arrow", "draw_arrow", handler.HandlerAdapter(s.drawArrow))
	protectedToolPost("/api/tools/show-region", "show_region", handler.HandlerAdapter(s.showRegion))
	protectedToolPost("/api/tools/request-move", "request_move", handler.HandlerAdapter(s.requestMove))
	protectedToolPost("/api/tools/request-operator-view", "request_operator_view", handler.HandlerAdapter(s.requestOperatorView))
	protectedToolPost("/api/tools/ask-operator", "ask_operator", handler.HandlerAdapter(s.askOperator))
	protectedToolPost("/api/tools/capture-snapshot", "capture_snapshot", handler.HandlerAdapter(s.captureSnapshot))
	protectedReadOnlyToolPost("/api/tools/compare-snapshots", "compare_snapshots", handler.HandlerAdapter(s.compareSnapshots))
	protectedToolPost("/api/tools/clear-annotation", "clear_annotation", handler.HandlerAdapter(s.clearAnnotation))
	protectedToolPost("/api/tools/clear-annotations", "clear_annotations", handler.HandlerAdapter(s.clearAnnotations))
	protectedToolPost("/api/tools/record-observation", "record_observation", handler.HandlerAdapter(s.recordObservation))
	protectedPost("/api/session/scene/calibration", handler.HandlerAdapter(s.calibrateSceneObject))
	protectedPost("/api/session/scene/objects", handler.HandlerAdapter(s.createSceneObject))
	protectedPost("/api/support/approve-action", handler.HandlerAdapter(s.approveCableMove))
	protectedPost("/api/support/resolve-case", handler.HandlerAdapter(s.resolveCase))
	protectedPost("/api/support/scene-tracking", handler.HandlerAdapter(s.recordSupportSceneTracking))
	protectedPost("/api/operator/annotation-acknowledgements", handler.HandlerAdapter(s.acknowledgeAnnotations))
	protectedPost("/api/operator/scene-tracking", handler.HandlerAdapter(s.recordSceneTracking))
	protectedPost("/api/operator/scene-activity", handler.HandlerAdapter(s.recordSceneActivity))
	protectedPost("/api/operator/confirm-cable-moved", handler.HandlerAdapter(s.confirmCableMoved))
	protectedPost("/api/operator/questions/answer", handler.HandlerAdapter(s.answerOperatorQuestion))
	protectedPost("/api/operator/issue", handler.HandlerAdapter(s.selectOperatorIssue))
	protectedPost("/api/operator/messages", handler.HandlerAdapter(s.sendOperatorChatMessage))
	protectedPost("/api/support/messages", handler.HandlerAdapter(s.sendSupportChatMessage))
	protectedPost("/api/support/operator-instruction/clear", handler.HandlerAdapter(s.clearOperatorInstruction))
	privateToolGet("/api/tools/case-context", "get_case_context", handler.HandlerAdapter(s.caseContext))
	privateToolGet("/api/tools/case-timeline", "get_case_timeline", handler.HandlerAdapter(s.caseTimeline))
	privateToolGet("/api/tools/suggest-next-step", "suggest_next_step", handler.HandlerAdapter(s.suggestNextStep))
	if s.webMCPDebug {
		privateToolGet("/api/tools/debug/connection-report", "debug_connection_report", handler.HandlerAdapter(s.debugConnectionReport))
		protectedToolPost("/api/tools/debug/ping-operator", "debug_ping_operator", handler.HandlerAdapter(s.debugPingOperator))
	}
	rt.Get("/ws/sessions/{sessionId}", http.HandlerFunc(s.sessionWebSocket))
}

func (s *service) operatorQRCode(w http.ResponseWriter, r *http.Request) {
	session, err := s.authenticate(r, RoleSupport)
	if err != nil {
		handler.WriteError(w, err)
		return
	}
	session.mu.RLock()
	joinToken := session.operatorJoinToken
	joinExpiresAt := session.operatorJoinExpiresAt
	session.mu.RUnlock()
	if joinToken == "" || time.Now().UTC().After(joinExpiresAt) {
		handler.WriteError(w, handler.Errorf(http.StatusGone, "operator QR expired; create a new session"))
		return
	}

	// The QR payload is stable for the lifetime of the one-time join token.
	// Serialize generation per session so refreshes and duplicate image loads do
	// not consume the external barcode service's anonymous request budget.
	session.qrMu.Lock()
	defer session.qrMu.Unlock()
	if len(session.operatorQRCode) > 0 {
		writeOperatorQRCode(w, session.operatorQRCode)
		return
	}

	joinURL := s.absoluteRequestURL(r, operatorPathWithToken(session.ID, joinToken))
	payload, err := json.Marshal(map[string]any{
		"type":   "qr",
		"data":   joinURL,
		"format": "png",
		"size":   "320",
		"ec":     "H",
		"fg":     "#17201f",
		"bg":     "#fbfaf5",
	})
	if err != nil {
		handler.WriteError(w, handler.WrapError(http.StatusInternalServerError, "could not prepare operator QR code", err))
		return
	}

	endpointPath := "/api/generate"
	if s.barcodeAPIKey != "" {
		endpointPath = "/api/v1/generate"
	}
	endpoint := strings.TrimRight(s.barcodeBaseURL, "/") + endpointPath
	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		handler.WriteError(w, handler.WrapError(http.StatusInternalServerError, "could not prepare barcode request", err))
		return
	}
	upstream.Header.Set("Accept", "image/png")
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("User-Agent", "gofastr-field-assist/1.0")
	if s.barcodeAPIKey != "" {
		upstream.Header.Set("Authorization", "Bearer "+s.barcodeAPIKey)
	}

	response, err := s.barcodeClient.Do(upstream)
	if err != nil {
		s.log().Warn("barcode.qr.failed", "session_id", session.ID, "error", err)
		handler.WriteError(w, handler.WrapError(http.StatusBadGateway, "operator QR service unavailable; use the copy link", err))
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		s.log().Warn("barcode.qr.failed", "session_id", session.ID, "upstream_status", response.StatusCode)
		for _, header := range []string{"Retry-After", "X-RateLimit-Reset"} {
			if value := response.Header.Get(header); value != "" {
				w.Header().Set(header, value)
			}
		}
		status := http.StatusBadGateway
		if response.StatusCode == http.StatusTooManyRequests {
			status = http.StatusTooManyRequests
		}
		handler.WriteError(w, handler.Errorf(status, "operator QR service returned %s; use the copy link", response.Status))
		return
	}
	if contentType := strings.ToLower(response.Header.Get("Content-Type")); !strings.HasPrefix(contentType, "image/png") {
		s.log().Warn("barcode.qr.failed", "session_id", session.ID, "reason", "unexpected_media_type")
		handler.WriteError(w, handler.Errorf(http.StatusBadGateway, "operator QR service returned an unexpected media type"))
		return
	}

	const maxQRCodeBytes = 2 << 20
	imageBytes, err := io.ReadAll(io.LimitReader(response.Body, maxQRCodeBytes+1))
	if err != nil {
		s.log().Warn("barcode.qr.failed", "session_id", session.ID, "reason", "read_response", "error", err)
		handler.WriteError(w, handler.WrapError(http.StatusBadGateway, "could not read operator QR code", err))
		return
	}
	if len(imageBytes) > maxQRCodeBytes {
		s.log().Warn("barcode.qr.failed", "session_id", session.ID, "reason", "response_too_large")
		handler.WriteError(w, handler.Errorf(http.StatusBadGateway, "operator QR code response was too large"))
		return
	}

	session.operatorQRCode = append([]byte(nil), imageBytes...)
	writeOperatorQRCode(w, imageBytes)
	s.log().Info("barcode.qr.generated", "session_id", session.ID, "bytes", len(imageBytes))
}

func writeOperatorQRCode(w http.ResponseWriter, imageBytes []byte) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(imageBytes)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(imageBytes)
}

func (s *service) absoluteRequestURL(r *http.Request, path string) string {
	if s.publicBaseURL != nil {
		base := *s.publicBaseURL
		reference, err := url.Parse(path)
		if err == nil {
			base.Path = strings.TrimRight(base.Path, "/") + reference.Path
			base.RawQuery = reference.RawQuery
		} else {
			base.Path = strings.TrimRight(base.Path, "/") + path
			base.RawQuery = ""
		}
		base.RawPath = ""
		base.Fragment = ""
		return base.String()
	}
	scheme := "http"
	if requestIsSecure(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host + path
}

func (s *service) createSessionRedirect(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	mode := strings.ToLower(strings.TrimSpace(r.FormValue("mode")))
	session, err := s.sessions.CreateWithDemoMode(s.demoMode && mode == "demo")
	if err != nil {
		if errors.Is(err, ErrSessionLimit) {
			handler.WriteError(w, handler.Errorf(http.StatusServiceUnavailable, "the demo is at its active session limit; try again after an existing session expires"))
			return
		}
		handler.WriteError(w, handler.WrapError(http.StatusInternalServerError, "could not create session", err))
		return
	}
	setRoleCookie(w, r, RoleSupport, session.ID, session.SupportToken, session.ExpiresAt)
	s.log().Info("session.created", "session_id", session.ID, "expires_at", session.ExpiresAt)
	http.Redirect(w, r, "/session/"+url.PathEscape(session.ID), http.StatusSeeOther)
}

func (s *service) createSessionJSON(w http.ResponseWriter, r *http.Request) {
	var input createSessionInput
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil && !errors.Is(err, io.EOF) {
		handler.WriteError(w, handler.Errorf(http.StatusBadRequest, "invalid session request"))
		return
	}
	input.Mode = strings.ToLower(strings.TrimSpace(input.Mode))
	if input.Mode != "" && input.Mode != "demo" && input.Mode != "live" {
		handler.WriteError(w, handler.Errorf(http.StatusBadRequest, "mode must be demo or live"))
		return
	}
	session, err := s.sessions.CreateWithDemoMode(s.demoMode && input.Mode == "demo")
	if err != nil {
		if errors.Is(err, ErrSessionLimit) {
			handler.WriteError(w, handler.Errorf(http.StatusServiceUnavailable, "the demo is at its active session limit; try again after an existing session expires"))
			return
		}
		handler.WriteError(w, handler.WrapError(http.StatusInternalServerError, "could not create session", err))
		return
	}
	setRoleCookie(w, r, RoleSupport, session.ID, session.SupportToken, session.ExpiresAt)
	s.log().Info("session.created", "session_id", session.ID, "expires_at", session.ExpiresAt)
	handler.Respond(w, r, createdSession{
		ID:           session.ID,
		SupportPath:  "/session/" + url.PathEscape(session.ID),
		OperatorPath: operatorPath(session),
		ExpiresAt:    session.ExpiresAt,
	})
}

func (s *service) currentSession(ctx context.Context, _ struct{}) (currentSessionResponse, error) {
	r, ok := handler.RequestFromContext(ctx)
	if !ok {
		return currentSessionResponse{}, handler.Errorf(http.StatusInternalServerError, "request context unavailable")
	}
	session, role, err := s.authenticateAny(r)
	if err != nil {
		return currentSessionResponse{}, err
	}
	response := currentSessionResponse{Role: role, Snapshot: session.SnapshotForRole(role)}
	if role == RoleSupport {
		response.OperatorPath = operatorPath(session)
	}
	return response, nil
}

func (s *service) iceConfig(ctx context.Context, _ struct{}) (iceConfigResponse, error) {
	r, ok := handler.RequestFromContext(ctx)
	if !ok {
		return iceConfigResponse{}, handler.Errorf(http.StatusInternalServerError, "request context unavailable")
	}
	if _, _, err := s.authenticateAny(r); err != nil {
		return iceConfigResponse{}, err
	}
	servers := make([]iceServerConfig, len(s.iceServers))
	copy(servers, s.iceServers)
	return iceConfigResponse{ICEServers: servers}, nil
}

func (s *service) appInfo(ctx context.Context, _ struct{}) (appInfoResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return appInfoResponse{}, err
	}
	demoFlow := []string{
		"Wait for inspect_scene to return the operator's request or conversation; do not infer a problem merely because the phone joined",
		"Read only the operator's words and observable live-frame evidence before deciding what to inspect or ask next",
		"Use conversation for discussion, bounded questions when choices help, banners for hands-busy directions, and spatial guidance only on verified targets",
	}
	contextVersion := session.LoadWebMCPContext()
	snapshot := session.Snapshot()
	return appInfoResponse{
		Name:            "GoFastr Field Assist",
		Purpose:         "A shared physical support workspace for an operator, an accountable support representative, and Codex.",
		DemoMode:        s.demoMode,
		Runtime:         s.applicationMode,
		ContextVersion:  contextVersion,
		ProtocolVersion: fieldAssistProtocolVersion,
		Protocol: fieldAssistProtocol{
			Version: fieldAssistProtocolVersion,
			Sequence: []string{
				"Load this context before any mutating WebMCP call and send contextVersion unchanged",
				"Use model knowledge to form a likely device/control hypothesis, then use vision to map it onto the current frame",
				"Inspect the live session and current scene before acting; refresh inspection after an answer or meaningful camera change",
				"Separate identity confidence, localization confidence, tracking confidence, and delivery confidence",
				"Register the device first, then register an actionable control as a separate child target when needed",
				"Use the least ambiguous reversible guidance and verify that the operator received it through shared state",
			},
			ConfidenceDefinitions: map[string]string{
				"identity":     "How likely the object label matches the physical device or control",
				"localization": "How precisely the registered bounds map to the current video frame",
				"tracking":     "How reliably browser perception is following an already verified target; it is not identity or localization proof",
				"delivery":     "Whether the operator browser acknowledged rendering the server-issued guidance",
			},
			TargetingRules: []string{
				"Use normalized coordinates from remote-video pixels only; exclude page chrome, letterbox, and adjacent objects",
				"Use stable object IDs returned by inspect_scene or register_scene_object",
				"Manual or Codex-vision bounds are provisional seeds, never verified spatial truth; precision arrows stay hidden until backend-confirmed tracking locks",
				"draw_arrow requires a device-control target; register the containing device first so OpenCV and Depth Anything track its feature-rich plane while projecting the control anchor",
				"The containing reference must hug one visually stable physical plane that includes the control; do not span a top surface and front control face in one reference",
				"If a control lies outside the parent device bounds, register that control separately before pointing to it",
				"If tracking is lost or stale, fail closed by suppressing the precision marker and request reacquisition; never fall back to fixed screen coordinates",
			},
			MutationRules: []string{
				"Every WebMCP mutation must include the contextVersion returned by this response",
				"A missing contextVersion means initialization was skipped; reload get_app_info and retry",
				"A stale contextVersion means the protocol or session context changed; reload get_app_info before retrying",
				"Scene mutations must use the current scene version returned by inspect_scene",
				"Human support retains approval authority for consequential physical actions",
			},
		},
		Workflows: []string{
			"inspect the operator request and current live scene",
			"identify and verify a device or actionable control with vision",
			"register a narrow device or control target when no verified object exists",
			"place reversible phone, conversation, or spatial guidance",
			"verify delivery and refresh state after operator feedback",
		},
		LiveSession:    snapshot,
		CurrentRequest: snapshot.OperatorIssue,
		Architecture: []string{
			"GoFastr server-rendered application and typed HTTP tools",
			"GoFastr WebSocket signaling and session events",
			"Browser-to-browser WebRTC camera media with environment-driven STUN/TURN",
			"GoFastr experimental WebMCP bridge for semantic page tools",
		},
		DemoFlow: demoFlow,
		OperatingExpectations: []string{
			"Inspect the current scene before choosing or changing guidance, and inspect again after an operator answer or meaningful camera change",
			"Ground object identity and location in the operator's words plus visible-frame evidence; ask a bounded question when evidence is ambiguous",
			"Put every hands-busy movement or hold instruction in the backend-synchronized phone banner instead of leaving it only in chat",
			"Use draw_arrow for a precise point, annotate_object for a label, and highlight_object only when a boxed region is genuinely clearer",
			"Use stable object ids and current scene versions, recalibrate lost targets, and clear completed or uncertain guidance rather than allowing a stale overlay to drift",
			"Confirm operator answers and guidance delivery through inspect_scene or the shared timeline; never treat a tool call alone as physical completion",
		},
	}, nil
}

func (s *service) debugConnectionReport(ctx context.Context, _ struct{}) (debugConnectionReportResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return debugConnectionReportResponse{}, err
	}
	if !s.webMCPDebug {
		return debugConnectionReportResponse{}, handler.Errorf(http.StatusNotFound, "WebMCP debug tools are disabled")
	}
	snapshot := session.Snapshot()
	report := debugConnectionReportResponse{
		DebugMode:   true,
		GeneratedAt: time.Now().UTC(),
		Runtime:     s.applicationMode,
		WebRTC:      session.WebRTCDebug(),
		Tracking:    snapshot.SceneTracking,
		Activity:    snapshot.SceneActivity,
	}
	report.Session.ID = snapshot.ID
	report.Session.Sequence = snapshot.Sequence
	report.Session.Participants = snapshot.Participants
	report.Session.CreatedAt = snapshot.CreatedAt
	report.Session.ExpiresAt = snapshot.ExpiresAt
	report.Scene.ID = snapshot.Scene.ID
	report.Scene.Version = snapshot.Scene.Version
	report.Scene.Objects = len(snapshot.Scene.Objects)
	report.Scene.Relationships = len(snapshot.Scene.Relationships)
	report.Scene.CalibrationSource = snapshot.Scene.Calibration.Source
	report.Guidance.Active = len(snapshot.Annotations)
	acknowledged := make(map[string]struct{}, len(snapshot.AnnotationReceipts))
	for _, receipt := range snapshot.AnnotationReceipts {
		if receipt.SceneVersion == snapshot.Scene.Version {
			acknowledged[receipt.AnnotationID] = struct{}{}
		}
	}
	for _, annotation := range snapshot.Annotations {
		if _, ok := acknowledged[annotation.ID]; ok {
			report.Guidance.Acknowledged++
		}
	}
	report.Guidance.Pending = report.Guidance.Active - report.Guidance.Acknowledged
	report.Collections.Timeline = len(snapshot.Timeline)
	report.Collections.Snapshots = len(snapshot.Snapshots)

	participantStatus := func(role Role) string {
		if snapshot.Participants[role] > 0 {
			return "pass"
		}
		return "waiting"
	}
	report.Checks = append(report.Checks,
		debugCheck{Name: "support-websocket", Status: participantStatus(RoleSupport), Detail: fmt.Sprintf("%d authenticated support socket(s)", snapshot.Participants[RoleSupport])},
		debugCheck{Name: "operator-websocket", Status: participantStatus(RoleOperator), Detail: fmt.Sprintf("%d authenticated operator socket(s)", snapshot.Participants[RoleOperator])},
	)
	peerReady := false
	for _, state := range report.WebRTC {
		if state.ConnectionState == "connected" || state.ICEState == "connected" || state.ICEState == "completed" {
			peerReady = true
			break
		}
	}
	peerStatus := "waiting"
	peerDetail := "No browser has reported a connected peer yet"
	if peerReady {
		peerStatus = "pass"
		peerDetail = "A browser reported a connected WebRTC peer"
	}
	report.Checks = append(report.Checks,
		debugCheck{Name: "webrtc-peer", Status: peerStatus, Detail: peerDetail},
		debugCheck{Name: "guidance-delivery", Status: map[bool]string{true: "pass", false: "waiting"}[report.Guidance.Active > 0 && report.Guidance.Pending == 0], Detail: fmt.Sprintf("%d active, %d rendered, %d pending", report.Guidance.Active, report.Guidance.Acknowledged, report.Guidance.Pending)},
	)
	return report, nil
}

func (s *service) debugPingOperator(ctx context.Context, input debugPingInput) (highlightResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return highlightResponse{}, err
	}
	if !s.webMCPDebug {
		return highlightResponse{}, handler.Errorf(http.StatusNotFound, "WebMCP debug tools are disabled")
	}
	objectID := strings.TrimSpace(input.ObjectID)
	if objectID == "" {
		scene := session.Scene()
		if len(scene.Objects) == 0 {
			return highlightResponse{}, handler.Errorf(http.StatusConflict, "the live scene has no observed object to ping")
		}
		objectID = scene.Objects[0].ID
	}
	objectID, err = validatedObjectID(objectID)
	if err != nil {
		return highlightResponse{}, err
	}
	annotation, err := session.AnnotateObject(objectID, "DEBUG PING", actorFor(r))
	if errors.Is(err, ErrObjectNotFound) {
		return highlightResponse{}, handler.Errorf(http.StatusNotFound, "scene object %q was not found", objectID)
	}
	if err != nil {
		return highlightResponse{}, handler.WrapError(http.StatusInternalServerError, "could not send operator debug ping", err)
	}
	return highlightResponse{Success: true, Annotation: annotation, Message: "Debug ping sent; call debug_connection_report to verify operator rendering"}, nil
}

func (s *service) inspectScene(ctx context.Context, _ struct{}) (inspectSceneResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return inspectSceneResponse{}, err
	}
	return inspectSceneResponse{
		Scene:               session.Scene(),
		RoomContext:         session.GetRoomContext(),
		OperatorIssue:       session.GetOperatorIssue(),
		ActiveQuestion:      session.GetActiveQuestion(),
		OperatorInstruction: session.GetOperatorInstruction(),
		Messages:            session.GetConversationMessages(),
	}, nil
}

func (s *service) inspectObject(ctx context.Context, input highlightInput) (inspectObjectResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return inspectObjectResponse{}, err
	}
	objectID, err := validatedObjectID(input.ObjectID)
	if err != nil {
		return inspectObjectResponse{}, err
	}
	object, err := session.InspectObject(objectID)
	if errors.Is(err, ErrObjectNotFound) {
		return inspectObjectResponse{}, handler.Errorf(http.StatusNotFound, "scene object %q was not found", objectID)
	}
	if err != nil {
		return inspectObjectResponse{}, handler.WrapError(http.StatusInternalServerError, "could not inspect scene object", err)
	}
	return inspectObjectResponse{
		Success:      true,
		Object:       object,
		Visible:      true,
		SceneVersion: session.Scene().Version,
		Tracking:     session.TrackingForObject(objectID),
	}, nil
}

func (s *service) highlightObject(ctx context.Context, input highlightInput) (highlightResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return highlightResponse{}, err
	}
	input.ObjectID, err = validatedObjectID(input.ObjectID)
	if err != nil {
		return highlightResponse{}, err
	}
	annotation, err := session.HighlightObject(input.ObjectID, actorFor(r))
	if errors.Is(err, ErrObjectNotFound) {
		return highlightResponse{}, handler.Errorf(http.StatusNotFound, "scene object %q was not found", input.ObjectID)
	}
	if err != nil {
		return highlightResponse{}, handler.WrapError(http.StatusInternalServerError, "could not create annotation", err)
	}
	return highlightResponse{
		Success: true, Annotation: annotation,
		Message: fmt.Sprintf("%s is now highlighted for the operator", input.ObjectID),
	}, nil
}

func (s *service) annotateObject(ctx context.Context, input annotateObjectInput) (highlightResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return highlightResponse{}, err
	}
	input.ObjectID, err = validatedObjectID(input.ObjectID)
	if err != nil {
		return highlightResponse{}, err
	}
	text, err := validatedAnnotationText(input.Text)
	if err != nil {
		return highlightResponse{}, err
	}
	annotation, err := session.AnnotateObject(input.ObjectID, text, actorFor(r))
	if errors.Is(err, ErrObjectNotFound) {
		return highlightResponse{}, handler.Errorf(http.StatusNotFound, "scene object %q was not found", input.ObjectID)
	}
	if err != nil {
		return highlightResponse{}, handler.WrapError(http.StatusInternalServerError, "could not create annotation", err)
	}
	return highlightResponse{
		Success: true, Annotation: annotation,
		Message: fmt.Sprintf("Annotation added to %s", input.ObjectID),
	}, nil
}

func (s *service) sendOperatorInstruction(ctx context.Context, input operatorInstructionInput) (operatorInstructionResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return operatorInstructionResponse{}, err
	}
	input.Title, err = validatedInstructionText(input.Title, "title", 80)
	if err != nil {
		return operatorInstructionResponse{}, err
	}
	input.Detail, err = validatedInstructionText(input.Detail, "detail", 180)
	if err != nil {
		return operatorInstructionResponse{}, err
	}
	instruction, item, err := session.SendOperatorInstruction(input.Title, input.Detail, actorFor(r))
	if errors.Is(err, ErrInvalidInstruction) {
		return operatorInstructionResponse{}, handler.ValidationError(map[string][]string{
			"instruction": {"title and detail must be bounded, single-line text"},
		})
	}
	if err != nil {
		return operatorInstructionResponse{}, handler.WrapError(http.StatusInternalServerError, "could not send operator instruction", err)
	}
	return operatorInstructionResponse{Success: true, Instruction: instruction, TimelineItem: item}, nil
}

func (s *service) clearOperatorInstruction(ctx context.Context, _ struct{}) (clearOperatorInstructionResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return clearOperatorInstructionResponse{}, err
	}
	item, cleared := session.ClearOperatorInstruction(actorFor(r))
	response := clearOperatorInstructionResponse{Success: true, Cleared: cleared}
	if cleared {
		response.TimelineItem = &item
	}
	return response, nil
}

func conversationResponse(session *Session, input conversationMessageInput, sender Role, actor string) (conversationMessageResponse, error) {
	text, err := validatedConversationText(input.Text)
	if err != nil {
		return conversationMessageResponse{}, err
	}
	message, item, err := session.SendConversationMessage(text, sender, actor)
	if errors.Is(err, ErrInvalidConversation) {
		return conversationMessageResponse{}, handler.ValidationError(map[string][]string{
			"text": {"must contain 1 to 500 characters"},
		})
	}
	if err != nil {
		return conversationMessageResponse{}, handler.WrapError(http.StatusInternalServerError, "could not send conversation message", err)
	}
	return conversationMessageResponse{Success: true, Message: message, TimelineItem: item}, nil
}

func (s *service) sendOperatorMessage(ctx context.Context, input conversationMessageInput) (conversationMessageResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return conversationMessageResponse{}, err
	}
	return conversationResponse(session, input, RoleSupport, actorFor(r))
}

func (s *service) sendSupportChatMessage(ctx context.Context, input conversationMessageInput) (conversationMessageResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return conversationMessageResponse{}, err
	}
	return conversationResponse(session, input, RoleSupport, actorFor(r))
}

func (s *service) sendOperatorChatMessage(ctx context.Context, input conversationMessageInput) (conversationMessageResponse, error) {
	session, r, err := s.operatorSession(ctx)
	if err != nil {
		return conversationMessageResponse{}, err
	}
	return conversationResponse(session, input, RoleOperator, operatorActorFor(r))
}

func (s *service) requestCloseup(ctx context.Context, input highlightInput) (highlightResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return highlightResponse{}, err
	}
	input.ObjectID, err = validatedObjectID(input.ObjectID)
	if err != nil {
		return highlightResponse{}, err
	}
	annotation, err := session.RequestCloseup(input.ObjectID, actorFor(r))
	if errors.Is(err, ErrObjectNotFound) {
		return highlightResponse{}, handler.Errorf(http.StatusNotFound, "scene object %q was not found", input.ObjectID)
	}
	if err != nil {
		return highlightResponse{}, handler.WrapError(http.StatusInternalServerError, "could not request a closer view", err)
	}
	return highlightResponse{
		Success: true, Annotation: annotation,
		Message: fmt.Sprintf("Closer view requested for %s", input.ObjectID),
	}, nil
}

func (s *service) requestDifferentAngle(ctx context.Context, input highlightInput) (highlightResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return highlightResponse{}, err
	}
	input.ObjectID, err = validatedObjectID(input.ObjectID)
	if err != nil {
		return highlightResponse{}, err
	}
	annotation, err := session.RequestDifferentAngle(input.ObjectID, actorFor(r))
	if errors.Is(err, ErrObjectNotFound) {
		return highlightResponse{}, handler.Errorf(http.StatusNotFound, "scene object %q was not found", input.ObjectID)
	}
	if err != nil {
		return highlightResponse{}, handler.WrapError(http.StatusInternalServerError, "could not request another angle", err)
	}
	return highlightResponse{Success: true, Annotation: annotation, Message: "Different angle requested"}, nil
}

func (s *service) drawArrow(ctx context.Context, input drawArrowInput) (highlightResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return highlightResponse{}, err
	}
	input.ObjectID, err = validatedObjectID(input.ObjectID)
	if err != nil {
		return highlightResponse{}, err
	}
	if strings.TrimSpace(input.Text) != "" {
		input.Text, err = validatedAnnotationText(input.Text)
		if err != nil {
			return highlightResponse{}, err
		}
	}
	if input.Anchor != nil && !validObjectAnchor(*input.Anchor) {
		return highlightResponse{}, handler.ValidationError(map[string][]string{
			"anchor": {"must use finite object-relative x/y coordinates"},
		})
	}
	// WebMCP precision guidance is intentionally narrower than the shared
	// support annotation primitives: a broad appliance or parent device is not
	// an actionable target. Seeded domain controls may opt in with an explicit
	// targetType attribute; newly registered controls use kind=device-control.
	if actorFor(r) == "Codex via WebMCP" {
		if err := validateDrawArrowTarget(session.Scene(), input.ObjectID); errors.Is(err, ErrObjectNotFound) {
			return highlightResponse{}, handler.Errorf(http.StatusNotFound, "scene object %q was not found", input.ObjectID)
		} else if errors.Is(err, ErrInvalidDrawArrowTarget) {
			return highlightResponse{}, handler.Errorf(http.StatusUnprocessableEntity, "draw_arrow requires a verified device-control target; register the specific control before pointing to it")
		} else if err != nil {
			return highlightResponse{}, handler.WrapError(http.StatusInternalServerError, "could not validate arrow target", err)
		}
	}
	var annotation Annotation
	if input.Anchor == nil {
		annotation, err = session.DrawArrow(input.ObjectID, input.Text, actorFor(r))
	} else {
		annotation, err = session.DrawArrow(input.ObjectID, input.Text, actorFor(r), *input.Anchor)
	}
	if errors.Is(err, ErrObjectNotFound) {
		return highlightResponse{}, handler.Errorf(http.StatusNotFound, "scene object %q was not found", input.ObjectID)
	}
	if errors.Is(err, ErrInvalidBounds) {
		return highlightResponse{}, handler.ValidationError(map[string][]string{
			"anchor": {"must stay inside the registered object; register a separate control for anything outside it"},
		})
	}
	if err != nil {
		return highlightResponse{}, handler.WrapError(http.StatusInternalServerError, "could not draw arrow", err)
	}
	return highlightResponse{Success: true, Annotation: annotation, Message: "Arrow guidance is visible"}, nil
}

func (s *service) showRegion(ctx context.Context, input regionInput) (highlightResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return highlightResponse{}, err
	}
	if err := validateBounds(input.Bounds); err != nil {
		return highlightResponse{}, handler.ValidationError(map[string][]string{"bounds": {"must be finite normalized coordinates inside the video frame"}})
	}
	if strings.TrimSpace(input.Text) != "" {
		input.Text, err = validatedAnnotationText(input.Text)
		if err != nil {
			return highlightResponse{}, err
		}
	}
	annotation, err := session.ShowRegion(input.Bounds, input.Text, actorFor(r))
	if err != nil {
		return highlightResponse{}, handler.WrapError(http.StatusInternalServerError, "could not show region", err)
	}
	return highlightResponse{Success: true, Annotation: annotation, Message: "Region guidance is visible"}, nil
}

func (s *service) requestMove(ctx context.Context, input moveInput) (highlightResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return highlightResponse{}, err
	}
	annotation, err := session.RequestMove(input.Direction, actorFor(r))
	if errors.Is(err, ErrInvalidMoveDirection) {
		return highlightResponse{}, handler.ValidationError(map[string][]string{"direction": {err.Error()}})
	}
	if err != nil {
		return highlightResponse{}, handler.WrapError(http.StatusInternalServerError, "could not request camera movement", err)
	}
	return highlightResponse{Success: true, Annotation: annotation, Message: "Movement guidance is visible"}, nil
}

func (s *service) requestOperatorView(ctx context.Context, input operatorViewInput) (highlightResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return highlightResponse{}, err
	}
	annotation, err := session.RequestOperatorView(input.Target, actorFor(r))
	if errors.Is(err, ErrInvalidOperatorView) {
		return highlightResponse{}, handler.ValidationError(map[string][]string{"target": {err.Error()}})
	}
	if err != nil {
		return highlightResponse{}, handler.WrapError(http.StatusInternalServerError, "could not request operator view", err)
	}
	return highlightResponse{Success: true, Annotation: annotation, Message: "Operator view guidance is visible"}, nil
}

func (s *service) captureSnapshot(ctx context.Context, input captureSnapshotInput) (snapshotResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return snapshotResponse{}, err
	}
	input.Label = strings.TrimSpace(input.Label)
	if len(input.Label) > 128 || strings.ContainsAny(input.Label, "\r\n") {
		return snapshotResponse{}, handler.ValidationError(map[string][]string{"label": {"must contain at most 128 characters and no line breaks"}})
	}
	snapshot, err := session.CaptureSnapshot(input.Label, actorFor(r))
	if err != nil {
		return snapshotResponse{}, handler.WrapError(http.StatusInternalServerError, "could not capture scene snapshot", err)
	}
	return snapshotResponse{
		Success:  true,
		Snapshot: snapshot,
		Message:  fmt.Sprintf("Captured %s", snapshot.Label),
	}, nil
}

func (s *service) compareSnapshots(ctx context.Context, input compareSnapshotsInput) (compareSnapshotsResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return compareSnapshotsResponse{}, err
	}
	input.BeforeSnapshotID, err = validatedSnapshotID(input.BeforeSnapshotID, "beforeSnapshotId")
	if err != nil {
		return compareSnapshotsResponse{}, err
	}
	input.AfterSnapshotID, err = validatedSnapshotID(input.AfterSnapshotID, "afterSnapshotId")
	if err != nil {
		return compareSnapshotsResponse{}, err
	}
	if input.BeforeSnapshotID == input.AfterSnapshotID {
		return compareSnapshotsResponse{}, handler.ValidationError(map[string][]string{"afterSnapshotId": {"must refer to a different snapshot than beforeSnapshotId"}})
	}
	before, err := session.SnapshotByID(input.BeforeSnapshotID)
	if errors.Is(err, ErrSnapshotNotFound) {
		return compareSnapshotsResponse{}, handler.Errorf(http.StatusNotFound, "snapshot %q was not found", input.BeforeSnapshotID)
	}
	if err != nil {
		return compareSnapshotsResponse{}, handler.WrapError(http.StatusInternalServerError, "could not load before snapshot", err)
	}
	after, err := session.SnapshotByID(input.AfterSnapshotID)
	if errors.Is(err, ErrSnapshotNotFound) {
		return compareSnapshotsResponse{}, handler.Errorf(http.StatusNotFound, "snapshot %q was not found", input.AfterSnapshotID)
	}
	if err != nil {
		return compareSnapshotsResponse{}, handler.WrapError(http.StatusInternalServerError, "could not load after snapshot", err)
	}
	return compareSnapshotsResponse{Success: true, Comparison: CompareSnapshots(before, after)}, nil
}

func (s *service) clearAnnotation(ctx context.Context, input clearAnnotationInput) (clearResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return clearResponse{}, err
	}
	input.AnnotationID, err = validatedOpaqueID(input.AnnotationID, "annotationId")
	if err != nil {
		return clearResponse{}, err
	}
	if _, err := session.ClearAnnotation(input.AnnotationID, actorFor(r)); errors.Is(err, ErrAnnotationNotFound) {
		return clearResponse{}, handler.Errorf(http.StatusNotFound, "annotation was not found")
	} else if err != nil {
		return clearResponse{}, handler.WrapError(http.StatusInternalServerError, "could not clear annotation", err)
	}
	return clearResponse{Success: true, Cleared: 1}, nil
}

func (s *service) clearAnnotations(ctx context.Context, _ clearAnnotationsInput) (clearResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return clearResponse{}, err
	}
	response := clearResponse{Success: true, Cleared: session.ClearAnnotations(actorFor(r))}
	return response, nil
}

func (s *service) recordObservation(ctx context.Context, input observationInput) (observationResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return observationResponse{}, err
	}
	input.Text = strings.TrimSpace(input.Text)
	if input.Text == "" || len(input.Text) > 500 {
		return observationResponse{}, handler.ValidationError(map[string][]string{"text": {"must contain 1 to 500 characters"}})
	}
	response := observationResponse{
		Success:     true,
		Observation: session.RecordObservation(input.Text, actorFor(r)),
	}
	return response, nil
}

func (s *service) updateRoomContext(ctx context.Context, input roomContextInput) (roomContextResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return roomContextResponse{}, err
	}
	input.Summary = strings.TrimSpace(input.Summary)
	fields := map[string][]string{}
	if input.Summary == "" || len(input.Summary) > 500 || strings.ContainsAny(input.Summary, "\r\n") {
		fields["summary"] = []string{"must contain 1 to 500 characters on one line"}
	}
	if input.BaseSceneVersion == 0 {
		fields["baseSceneVersion"] = []string{"must identify the current scene version"}
	}
	if len(input.Observations) > maxRoomObservations {
		fields["observations"] = []string{"must contain at most 8 factual landmarks"}
	}
	for index := range input.Observations {
		input.Observations[index].Label = strings.TrimSpace(input.Observations[index].Label)
		input.Observations[index].Detail = strings.TrimSpace(input.Observations[index].Detail)
		if input.Observations[index].Label == "" || len(input.Observations[index].Label) > 80 || strings.ContainsAny(input.Observations[index].Label, "\r\n") ||
			input.Observations[index].Detail == "" || len(input.Observations[index].Detail) > 240 || strings.ContainsAny(input.Observations[index].Detail, "\r\n") {
			fields["observations"] = []string{fmt.Sprintf("item %d needs a label up to 80 characters and detail up to 240 characters", index)}
			break
		}
	}
	if len(fields) > 0 {
		return roomContextResponse{}, handler.ValidationError(fields)
	}
	context, item, err := session.UpdateRoomContext(input.Summary, input.Observations, input.BaseSceneVersion, actorFor(r))
	if errors.Is(err, ErrSceneVersionStale) {
		return roomContextResponse{}, handler.Errorf(http.StatusConflict, "scene changed; inspect the current frame before updating room context")
	}
	if errors.Is(err, ErrInvalidRoomContext) {
		return roomContextResponse{}, handler.ValidationError(map[string][]string{"roomContext": {"must contain bounded factual observations"}})
	}
	if err != nil {
		return roomContextResponse{}, handler.WrapError(http.StatusInternalServerError, "could not update room context", err)
	}
	return roomContextResponse{Success: true, RoomContext: context, TimelineItem: item}, nil
}

func (s *service) askOperator(ctx context.Context, input askOperatorInput) (operatorQuestionResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return operatorQuestionResponse{}, err
	}
	input.Question = strings.TrimSpace(input.Question)
	if input.Question == "" || len(input.Question) > 240 || strings.ContainsAny(input.Question, "\r\n") || len(input.Options) < 2 || len(input.Options) > maxOperatorOptions {
		return operatorQuestionResponse{}, handler.ValidationError(map[string][]string{
			"question": {"must contain 1 to 240 characters on one line"},
			"options":  {"must contain 2 to 4 distinct choices"},
		})
	}
	for index := range input.Options {
		input.Options[index] = strings.TrimSpace(input.Options[index])
	}
	question, item, err := session.AskOperator(input.Question, input.Options, actorFor(r))
	if errors.Is(err, ErrQuestionPending) {
		return operatorQuestionResponse{}, handler.Errorf(http.StatusConflict, "wait for the operator to answer the current question")
	}
	if errors.Is(err, ErrInvalidQuestion) || errors.Is(err, ErrInvalidQuestionOption) {
		return operatorQuestionResponse{}, handler.ValidationError(map[string][]string{"options": {"must contain 2 to 4 distinct choices of at most 80 characters"}})
	}
	if err != nil {
		return operatorQuestionResponse{}, handler.WrapError(http.StatusInternalServerError, "could not ask the operator", err)
	}
	return operatorQuestionResponse{Success: true, Question: question, TimelineItem: item}, nil
}

func (s *service) answerOperatorQuestion(ctx context.Context, input answerOperatorQuestionInput) (operatorQuestionResponse, error) {
	session, r, err := s.operatorSession(ctx)
	if err != nil {
		return operatorQuestionResponse{}, err
	}
	input.QuestionID, err = validatedOpaqueID(input.QuestionID, "questionId")
	if err != nil {
		return operatorQuestionResponse{}, err
	}
	input.OptionID, err = validatedOpaqueID(input.OptionID, "optionId")
	if err != nil {
		return operatorQuestionResponse{}, err
	}
	question, item, err := session.AnswerOperatorQuestion(input.QuestionID, input.OptionID, operatorActorFor(r))
	if errors.Is(err, ErrQuestionNotFound) {
		return operatorQuestionResponse{}, handler.Errorf(http.StatusNotFound, "operator question is no longer active")
	}
	if errors.Is(err, ErrQuestionAnswered) {
		return operatorQuestionResponse{}, handler.Errorf(http.StatusConflict, "operator question was already answered")
	}
	if errors.Is(err, ErrInvalidQuestionOption) {
		return operatorQuestionResponse{}, handler.ValidationError(map[string][]string{"optionId": {"must identify one of the active question choices"}})
	}
	if err != nil {
		return operatorQuestionResponse{}, handler.WrapError(http.StatusInternalServerError, "could not answer operator question", err)
	}
	return operatorQuestionResponse{Success: true, Question: question, TimelineItem: item}, nil
}

func (s *service) selectOperatorIssue(ctx context.Context, input selectOperatorIssueInput) (operatorIssueResponse, error) {
	session, r, err := s.operatorSession(ctx)
	if err != nil {
		return operatorIssueResponse{}, err
	}
	issue, item, err := session.SelectOperatorIssue(input.Mode, input.PresetID, input.Summary, operatorActorFor(r))
	if errors.Is(err, ErrInvalidOperatorIssue) {
		return operatorIssueResponse{}, handler.ValidationError(map[string][]string{
			"issue": {"choose an available starter or enter 1 to 280 characters"},
		})
	}
	if errors.Is(err, ErrOperatorIssueSelected) {
		return operatorIssueResponse{}, handler.Errorf(http.StatusConflict, "the operator already selected this session's request")
	}
	if err != nil {
		return operatorIssueResponse{}, handler.WrapError(http.StatusInternalServerError, "could not select the operator request", err)
	}
	return operatorIssueResponse{Success: true, Issue: issue, TimelineItem: item}, nil
}

func (s *service) caseContext(ctx context.Context, _ struct{}) (caseContextResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return caseContextResponse{}, err
	}
	return caseContextResponse{Success: true, Case: session.GetCaseContext()}, nil
}

func (s *service) caseTimeline(ctx context.Context, _ struct{}) (caseTimelineResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return caseTimelineResponse{}, err
	}
	return caseTimelineResponse{Success: true, Timeline: session.GetCaseTimeline()}, nil
}

func (s *service) suggestNextStep(ctx context.Context, _ struct{}) (nextStepResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return nextStepResponse{}, err
	}
	return nextStepResponse{Success: true, Suggestion: session.SuggestNextStep()}, nil
}

func (s *service) calibrateSceneObject(ctx context.Context, input calibrationInput) (calibrationResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return calibrationResponse{}, err
	}
	input.ObjectID, err = validatedObjectID(input.ObjectID)
	if err != nil {
		return calibrationResponse{}, err
	}
	if err := validateBounds(input.Bounds); err != nil {
		return calibrationResponse{}, handler.ValidationError(map[string][]string{"bounds": {"must be finite normalized coordinates inside the video frame"}})
	}
	actor := actorFor(r)
	scene, item, err := session.CalibrateObject(input.ObjectID, input.Bounds, input.BaseSceneVersion, actor)
	if errors.Is(err, ErrSceneVersionStale) {
		return calibrationResponse{}, handler.Errorf(http.StatusConflict, "scene changed; start calibration again")
	}
	if errors.Is(err, ErrObjectNotFound) {
		return calibrationResponse{}, handler.Errorf(http.StatusNotFound, "scene object %q was not found", input.ObjectID)
	}
	if err != nil {
		return calibrationResponse{}, handler.WrapError(http.StatusInternalServerError, "could not calibrate scene object", err)
	}
	s.log().Info(
		"scene.version.changed",
		"session_id", session.ID,
		"reason", calibrationSourceForActor(actor),
		"object_id", input.ObjectID,
		"previous_version", input.BaseSceneVersion,
		"scene_version", scene.Version,
	)
	return calibrationResponse{Success: true, Scene: scene, Item: item}, nil
}

func (s *service) createSceneObject(ctx context.Context, input createSceneObjectInput) (createSceneObjectResponse, error) {
	session, r, err := s.supportSession(ctx)
	if err != nil {
		return createSceneObjectResponse{}, err
	}
	input.Label = strings.TrimSpace(input.Label)
	if input.Label == "" || len(input.Label) > 120 || strings.ContainsAny(input.Label, "\r\n") {
		return createSceneObjectResponse{}, handler.ValidationError(map[string][]string{"label": {"must contain 1 to 120 characters and no line breaks"}})
	}
	input.Kind = strings.ToLower(strings.TrimSpace(input.Kind))
	if input.Kind == "" || len(input.Kind) > 64 || strings.ContainsAny(input.Kind, "\r\n\t ") {
		return createSceneObjectResponse{}, handler.ValidationError(map[string][]string{"kind": {"must be a short identifier without whitespace"}})
	}
	if err := validateBounds(input.Bounds); err != nil {
		return createSceneObjectResponse{}, handler.ValidationError(map[string][]string{"bounds": {"must be finite normalized coordinates inside the video frame"}})
	}
	object, scene, item, err := session.AddSceneObject(input.Label, input.Kind, input.Bounds, input.BaseSceneVersion, actorFor(r))
	if errors.Is(err, ErrSceneVersionStale) {
		return createSceneObjectResponse{}, handler.Errorf(http.StatusConflict, "scene changed; add the target again")
	}
	if err != nil {
		return createSceneObjectResponse{}, handler.WrapError(http.StatusInternalServerError, "could not add observed target", err)
	}
	s.log().Info("scene.object.added", "session_id", session.ID, "object_id", object.ID, "scene_version", scene.Version)
	return createSceneObjectResponse{Success: true, Object: object, Scene: scene, Item: item}, nil
}

func (s *service) approveCableMove(ctx context.Context, input approvalInput) (approvalResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return approvalResponse{}, err
	}
	// This support-role command is intentionally absent from the WebMCP tool
	// manifest. The cookie is the authorization boundary; UI presence or a
	// caller-supplied source header is not treated as proof of human presence.
	input.GuidanceID, err = validatedOpaqueID(input.GuidanceID, "guidanceId")
	if err != nil {
		return approvalResponse{}, err
	}
	approval, err := session.ApproveCableMove(input.GuidanceID, "Support representative")
	if errors.Is(err, ErrGuidanceNotFound) {
		return approvalResponse{}, handler.Errorf(http.StatusConflict, "active WAN guidance is required before approval")
	}
	if errors.Is(err, ErrCableAlreadyMoved) {
		return approvalResponse{}, handler.Errorf(http.StatusConflict, "cable move has already been confirmed")
	}
	if err != nil {
		return approvalResponse{}, handler.WrapError(http.StatusInternalServerError, "could not approve cable move", err)
	}
	return approvalResponse{Success: true, Approval: approval}, nil
}

func (s *service) resolveCase(ctx context.Context, _ struct{}) (resolveCaseResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return resolveCaseResponse{}, err
	}
	// Resolution is a support-role manual control, not a WebMCP capability.
	context, item, err := session.ResolveCase("Support representative")
	if errors.Is(err, ErrCaseNotReady) {
		return resolveCaseResponse{}, handler.Errorf(http.StatusConflict, "verify the approved WAN cable move before resolving the case")
	}
	if errors.Is(err, ErrCaseResolved) {
		return resolveCaseResponse{}, handler.Errorf(http.StatusConflict, "case has already been resolved")
	}
	if err != nil {
		return resolveCaseResponse{}, handler.WrapError(http.StatusInternalServerError, "could not resolve case", err)
	}
	s.log().Info("case.resolved", "session_id", session.ID)
	return resolveCaseResponse{Success: true, Case: context, Item: item}, nil
}

func (s *service) confirmCableMoved(ctx context.Context, input confirmCableMovedInput) (confirmCableMovedResponse, error) {
	session, r, err := s.operatorSession(ctx)
	if err != nil {
		return confirmCableMovedResponse{}, err
	}
	input.Note = strings.TrimSpace(input.Note)
	if len(input.Note) > 500 || strings.ContainsAny(input.Note, "\r\n") {
		return confirmCableMovedResponse{}, handler.ValidationError(map[string][]string{"note": {"must contain at most 500 characters and no line breaks"}})
	}
	input.ApprovalID, err = validatedOpaqueID(input.ApprovalID, "approvalId")
	if err != nil {
		return confirmCableMovedResponse{}, err
	}
	scene, after, err := session.ConfirmCableMoved(input.ApprovalID, operatorActorFor(r), input.Note)
	if errors.Is(err, ErrCableAlreadyMoved) {
		return confirmCableMovedResponse{}, handler.Errorf(http.StatusConflict, "cable move has already been confirmed")
	}
	if errors.Is(err, ErrSceneTransition) {
		return confirmCableMovedResponse{}, handler.Errorf(http.StatusConflict, "scene is not ready for the cable-move confirmation")
	}
	if errors.Is(err, ErrApprovalRequired) {
		return confirmCableMovedResponse{}, handler.Errorf(http.StatusConflict, "support approval is required before confirmation")
	}
	if errors.Is(err, ErrApprovalConsumed) {
		return confirmCableMovedResponse{}, handler.Errorf(http.StatusConflict, "support approval has already been used")
	}
	if errors.Is(err, ErrApprovalStale) {
		return confirmCableMovedResponse{}, handler.Errorf(http.StatusConflict, "support approval expired or the scene changed")
	}
	if err != nil {
		return confirmCableMovedResponse{}, handler.WrapError(http.StatusInternalServerError, "could not confirm cable move", err)
	}
	s.log().Info("operator.cable_move.confirmed", "session_id", session.ID, "scene_version", scene.Version)
	s.log().Info(
		"scene.version.changed",
		"session_id", session.ID,
		"reason", "operator_confirmed_cable_move",
		"previous_version", scene.Version-1,
		"scene_version", scene.Version,
	)
	return confirmCableMovedResponse{
		Success:       true,
		Scene:         scene,
		AfterSnapshot: after,
		Message:       "Cable move confirmed; the modem is now connected to WAN",
	}, nil
}

func (s *service) recordSceneActivity(ctx context.Context, input sceneActivityInput) (sceneActivityResponse, error) {
	session, _, err := s.operatorSession(ctx)
	if err != nil {
		return sceneActivityResponse{}, err
	}
	input.ApprovalID, err = validatedOpaqueID(input.ApprovalID, "approvalId")
	if err != nil {
		return sceneActivityResponse{}, err
	}
	if input.BaseSceneVersion == 0 {
		return sceneActivityResponse{}, handler.ValidationError(map[string][]string{"baseSceneVersion": {"must identify the current scene version"}})
	}
	if math.IsNaN(input.ChangeScore) || math.IsInf(input.ChangeScore, 0) || input.ChangeScore < 0.05 || input.ChangeScore > 1 {
		return sceneActivityResponse{}, handler.ValidationError(map[string][]string{"changeScore": {"must be a finite value from 0.05 through 1"}})
	}
	activity, item, recorded, err := session.RecordSceneActivity(input.ApprovalID, input.BaseSceneVersion, input.ChangeScore)
	if errors.Is(err, ErrInvalidSceneActivity) {
		return sceneActivityResponse{}, handler.ValidationError(map[string][]string{"changeScore": {"must be a finite value from 0.05 through 1"}})
	}
	if errors.Is(err, ErrApprovalRequired) {
		return sceneActivityResponse{}, handler.Errorf(http.StatusConflict, "active support approval is required before visual-change telemetry")
	}
	if errors.Is(err, ErrApprovalConsumed) {
		return sceneActivityResponse{}, handler.Errorf(http.StatusConflict, "support approval has already been used")
	}
	if errors.Is(err, ErrApprovalStale) || errors.Is(err, ErrSceneVersionStale) {
		return sceneActivityResponse{}, handler.Errorf(http.StatusConflict, "visual-change telemetry does not match the current approved scene")
	}
	if err != nil {
		return sceneActivityResponse{}, handler.WrapError(http.StatusInternalServerError, "could not record visual-change telemetry", err)
	}
	response := sceneActivityResponse{Success: true, Recorded: recorded, Activity: activity}
	if recorded {
		response.TimelineItem = &item
		s.log().Info("operator.scene_activity.detected", "session_id", session.ID, "scene_version", activity.BaseSceneVersion, "change_score", activity.ChangeScore)
	}
	return response, nil
}

func (s *service) recordSceneTracking(ctx context.Context, input sceneTrackingInput) (sceneTrackingResponse, error) {
	session, _, err := s.operatorSession(ctx)
	if err != nil {
		return sceneTrackingResponse{}, err
	}
	return s.recordSceneTrackingForSession(input, session, "operator")
}

func (s *service) recordSupportSceneTracking(ctx context.Context, input sceneTrackingInput) (sceneTrackingResponse, error) {
	session, _, err := s.supportSession(ctx)
	if err != nil {
		return sceneTrackingResponse{}, err
	}
	return s.recordSceneTrackingForSession(input, session, "support")
}

func trackingSourceAuthority(source string) int {
	switch source {
	case "opencv-pnp+depth-anything":
		return 4
	case "opencv-homography+depth-anything":
		return 3
	case "opencv-homography":
		return 2
	case "browser-multiscale-template":
		return 1
	default:
		return 0
	}
}

func shouldPreserveFreshTracking(current *SceneTrackingTelemetry, input sceneTrackingInput) bool {
	incomingLoss := input.Status == SceneTrackingRecalibrationRequired || input.Status == SceneTrackingReacquireRequired
	if current == nil || current.NeedsRecalibration || incomingLoss ||
		current.ObjectID != input.ObjectID || current.GuidanceID != input.GuidanceID ||
		current.BaseSceneVersion != input.BaseSceneVersion || time.Since(current.UpdatedAt) >= 3*time.Second {
		return false
	}
	return trackingSourceAuthority(current.Source) > trackingSourceAuthority(input.Source)
}

func (s *service) recordSceneTrackingForSession(input sceneTrackingInput, session *Session, reportingRole string) (sceneTrackingResponse, error) {
	var err error
	input.ApprovalID = strings.TrimSpace(input.ApprovalID)
	input.GuidanceID = strings.TrimSpace(input.GuidanceID)
	if input.ApprovalID != "" {
		input.ApprovalID, err = validatedOpaqueID(input.ApprovalID, "approvalId")
		if err != nil {
			return sceneTrackingResponse{}, err
		}
	}
	if input.GuidanceID != "" {
		input.GuidanceID, err = validatedOpaqueID(input.GuidanceID, "guidanceId")
		if err != nil {
			return sceneTrackingResponse{}, err
		}
	}
	input.ObjectID, err = validatedObjectID(input.ObjectID)
	if err != nil {
		return sceneTrackingResponse{}, err
	}
	if strings.TrimSpace(input.ReferenceObjectID) != "" {
		input.ReferenceObjectID, err = validatedObjectID(input.ReferenceObjectID)
		if err != nil {
			return sceneTrackingResponse{}, err
		}
	}
	fields := map[string][]string{}
	if input.ApprovalID == "" && input.GuidanceID == "" {
		fields["guidanceId"] = []string{"must identify active object-bound guidance when approvalId is absent"}
	}
	if input.BaseSceneVersion == 0 {
		fields["baseSceneVersion"] = []string{"must identify the current scene version"}
	}
	if !validSceneTrackingStatus(input.Status) {
		fields["status"] = []string{"must be calibrated_fallback, locked, following_camera_drift, recalibration_required, or reacquire_required"}
	}
	if math.IsNaN(input.Confidence) || math.IsInf(input.Confidence, 0) || input.Confidence < 0 || input.Confidence > 1 {
		fields["confidence"] = []string{"must be a finite value from 0 through 1"}
	}
	if validateBounds(input.Bounds) != nil {
		fields["bounds"] = []string{"must be normalized with positive dimensions"}
	}
	var trackingQuad *TrackingQuad
	if len(input.Quad) == 4 {
		value := TrackingQuad{input.Quad[0], input.Quad[1], input.Quad[2], input.Quad[3]}
		trackingQuad = &value
	}
	if !input.PartialVisibility || input.Anchor != nil {
		input.AnchorVisible = true
	}
	computedVisibleFraction, geometryValid := trackingGeometryVisibility(trackingQuad, input.Anchor, input.PartialVisibility)
	if (len(input.Quad) != 0 && len(input.Quad) != 4) || !geometryValid || (input.PartialVisibility && input.AnchorVisible && input.Anchor == nil) {
		fields["geometry"] = []string{"quad must contain four bounded points with enough visible area and any visible anchor must be normalized"}
	}
	if input.PartialVisibility {
		if math.IsNaN(input.VisibleFraction) || math.IsInf(input.VisibleFraction, 0) || input.VisibleFraction < 0 || input.VisibleFraction > 1 ||
			math.Abs(input.VisibleFraction-computedVisibleFraction) > 0.02 {
			fields["visibleFraction"] = []string{"must match the server-computed visible portion of the quad"}
		}
		input.VisibleFraction = computedVisibleFraction
	} else {
		input.VisibleFraction = 1
	}
	input.Source = strings.TrimSpace(input.Source)
	input.DepthSource = strings.TrimSpace(input.DepthSource)
	input.PoseState = strings.TrimSpace(input.PoseState)
	input.PoseFailureReason = strings.TrimSpace(input.PoseFailureReason)
	if input.Source == "" {
		input.Source = "browser-multiscale-template"
	}
	if !validSceneTrackingSource(input.Source) {
		fields["source"] = []string{"must be browser-multiscale-template, opencv-homography, opencv-homography+depth-anything, or opencv-pnp+depth-anything"}
	}
	if input.PoseState == "" {
		input.PoseState = "unavailable"
	}
	if !validPoseState(input.PoseState) {
		fields["poseState"] = []string{"must be unavailable, degraded, or active"}
	}
	if len(input.PoseFailureReason) > 96 || strings.ContainsAny(input.PoseFailureReason, "\r\n") {
		fields["poseFailureReason"] = []string{"must contain at most 96 characters and no line breaks"}
	}
	if input.PoseInliers < 0 || math.IsNaN(input.PoseInlierRatio) || math.IsInf(input.PoseInlierRatio, 0) || input.PoseInlierRatio < 0 || input.PoseInlierRatio > 1 {
		fields["poseEvidence"] = []string{"must contain non-negative inliers and a finite ratio from 0 through 1"}
	}
	if math.IsNaN(input.DepthScore) || math.IsInf(input.DepthScore, 0) || input.DepthScore < 0 || input.DepthScore > 1 {
		fields["depthScore"] = []string{"must be a finite value from 0 through 1"}
	}
	if math.IsNaN(input.DepthConfidence) || math.IsInf(input.DepthConfidence, 0) || input.DepthConfidence < 0 || input.DepthConfidence > 1 {
		fields["depthConfidence"] = []string{"must be a finite value from 0 through 1"}
	}
	if math.IsNaN(input.ModelRelativeDepth) || math.IsInf(input.ModelRelativeDepth, 0) || input.ModelRelativeDepth < 0 || input.ModelRelativeDepth > 4 {
		fields["modelRelativeDepth"] = []string{"must be zero or a finite relative value no greater than 4"}
	}
	if isDepthBackedTrackingSource(input.Source) {
		if !validDepthSource(input.DepthSource) {
			fields["depthSource"] = []string{"must identify the released Depth Anything model"}
		}
		if input.DepthConfidence <= 0 || input.ModelRelativeDepth < 0.25 {
			fields["depthConfidence"] = []string{"must include a valid local depth estimate"}
		}
	} else if input.DepthSource != "" || input.DepthScore != 0 || input.DepthConfidence != 0 || input.ModelRelativeDepth != 0 {
		fields["depth"] = []string{"must be omitted unless source includes Depth Anything"}
	}
	if len(fields) > 0 {
		return sceneTrackingResponse{}, handler.ValidationError(fields)
	}
	// The support computer is the primary host for OpenCV/Depth Anything. A
	// phone may still publish its lightweight Canvas fallback for immediate
	// continuity, but it must not overwrite a fresh enhanced result for the
	// same target while the desktop tracker is healthy.
	if reportingRole == "operator" && input.Source == "browser-multiscale-template" {
		if current := session.TrackingForObject(input.ObjectID); current != nil &&
			isOpenCVTrackingSource(current.Source) &&
			current.BaseSceneVersion == input.BaseSceneVersion &&
			time.Since(current.UpdatedAt) < 5*time.Second {
			return sceneTrackingResponse{Success: true, Recorded: false, Tracking: *current}, nil
		}
	}
	// Both the phone and support computer can observe the same frame. Preserve
	// a fresh world/depth lock instead of allowing a delayed lower-authority
	// healthy homography or Canvas sample to move the shared arrow. Explicit
	// durable loss still fails closed immediately. The
	// short lease expires naturally if the stronger tracker actually stops.
	if current := session.TrackingForObject(input.ObjectID); shouldPreserveFreshTracking(current, input) {
		return sceneTrackingResponse{Success: true, Recorded: false, Tracking: *current}, nil
	}
	tracking, recorded, err := session.RecordSceneTracking(
		input.ApprovalID,
		input.GuidanceID,
		input.ObjectID,
		input.BaseSceneVersion,
		input.Status,
		input.Confidence,
		input.Bounds,
		SceneTrackingEvidence{
			Source: input.Source, ReferenceObjectID: input.ReferenceObjectID, Quad: trackingQuad, Anchor: input.Anchor,
			PartialVisibility: input.PartialVisibility, VisibleFraction: input.VisibleFraction, AnchorVisible: input.AnchorVisible,
			DepthScore: input.DepthScore, DepthConfidence: input.DepthConfidence,
			ModelRelativeDepth: input.ModelRelativeDepth, DepthSource: input.DepthSource,
			PoseState: input.PoseState, PoseFailureReason: input.PoseFailureReason,
			PoseInliers: input.PoseInliers, PoseInlierRatio: input.PoseInlierRatio,
		},
	)
	if errors.Is(err, ErrInvalidTracking) {
		return sceneTrackingResponse{}, handler.ValidationError(map[string][]string{
			"tracking": {"must remain inside the approved object's calibrated drift envelope"},
		})
	}
	if errors.Is(err, ErrApprovalRequired) {
		return sceneTrackingResponse{}, handler.Errorf(http.StatusConflict, "active object-bound guidance or support approval is required before tracking telemetry")
	}
	if errors.Is(err, ErrApprovalConsumed) {
		return sceneTrackingResponse{}, handler.Errorf(http.StatusConflict, "support approval has already been used")
	}
	if errors.Is(err, ErrApprovalStale) || errors.Is(err, ErrSceneVersionStale) {
		return sceneTrackingResponse{}, handler.Errorf(http.StatusConflict, "tracking telemetry does not match the current approved scene")
	}
	if err != nil {
		return sceneTrackingResponse{}, handler.WrapError(http.StatusInternalServerError, "could not record tracking telemetry", err)
	}
	if recorded {
		s.log().Info(
			reportingRole+".scene_tracking.updated",
			"session_id", session.ID,
			"scene_version", tracking.BaseSceneVersion,
			"status", tracking.Status,
			"confidence", tracking.Confidence,
		)
	}
	return sceneTrackingResponse{Success: true, Recorded: recorded, Tracking: tracking}, nil
}

func (s *service) acknowledgeAnnotations(ctx context.Context, input annotationAcknowledgementInput) (annotationAcknowledgementResponse, error) {
	session, _, err := s.operatorSession(ctx)
	if err != nil {
		return annotationAcknowledgementResponse{}, err
	}
	fields := map[string][]string{}
	if len(input.AnnotationIDs) == 0 || len(input.AnnotationIDs) > maxActiveAnnotations {
		fields["annotationIds"] = []string{"must contain from 1 through 32 active annotation ids"}
	} else {
		for index, annotationID := range input.AnnotationIDs {
			validated, validationErr := validatedOpaqueID(annotationID, "annotationIds")
			if validationErr != nil {
				fields["annotationIds"] = []string{fmt.Sprintf("item %d must be a valid server-issued annotation id", index)}
				break
			}
			input.AnnotationIDs[index] = validated
		}
	}
	if input.SceneVersion == 0 {
		fields["sceneVersion"] = []string{"must identify the current scene version"}
	}
	if len(fields) > 0 {
		return annotationAcknowledgementResponse{}, handler.ValidationError(fields)
	}
	receipts, recorded, err := session.AcknowledgeAnnotations(input.AnnotationIDs, input.SceneVersion)
	if errors.Is(err, ErrAnnotationNotFound) {
		return annotationAcknowledgementResponse{}, handler.Errorf(http.StatusConflict, "one or more annotations are no longer active")
	}
	if errors.Is(err, ErrSceneVersionStale) {
		return annotationAcknowledgementResponse{}, handler.Errorf(http.StatusConflict, "annotation delivery does not match the current scene")
	}
	if err != nil {
		return annotationAcknowledgementResponse{}, handler.WrapError(http.StatusInternalServerError, "could not acknowledge annotation delivery", err)
	}
	if recorded {
		s.log().Info(
			"operator.annotation.acknowledged",
			"session_id", session.ID,
			"scene_version", input.SceneVersion,
			"annotation_count", len(receipts),
		)
	}
	return annotationAcknowledgementResponse{Success: true, Recorded: recorded, Receipts: receipts}, nil
}

func (s *service) supportSession(ctx context.Context) (*Session, *http.Request, error) {
	r, ok := handler.RequestFromContext(ctx)
	if !ok {
		return nil, nil, handler.Errorf(http.StatusInternalServerError, "request context unavailable")
	}
	session, err := s.authenticate(r, RoleSupport)
	if err != nil {
		return nil, r, err
	}
	return session, r, nil
}

func (s *service) operatorSession(ctx context.Context) (*Session, *http.Request, error) {
	r, ok := handler.RequestFromContext(ctx)
	if !ok {
		return nil, nil, handler.Errorf(http.StatusInternalServerError, "request context unavailable")
	}
	session, err := s.authenticate(r, RoleOperator)
	if err != nil {
		return nil, r, err
	}
	return session, r, nil
}

// requireWebMCPContext is the mutation boundary for page tools. Human
// support commands use the same typed handlers but are not marked with the
// WebMCP header, so they intentionally retain their existing authorization
// path. A WebMCP mutation must carry the exact contextVersion returned by
// get_app_info (the app-provided operating-context loader); missing and stale
// values receive distinct, deterministic recovery errors.
func (s *service) requireWebMCPContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Gofastr-WebMCP") != "1" {
			next.ServeHTTP(w, r)
			return
		}
		session, err := s.authenticate(r, RoleSupport)
		if err != nil {
			handler.WriteError(w, err)
			return
		}

		var body []byte
		if r.Body != nil {
			body, err = io.ReadAll(io.LimitReader(r.Body, maxFieldAssistContextBodyBytes+1))
			_ = r.Body.Close()
			r.Body = io.NopCloser(bytes.NewReader(body))
			if err != nil {
				handler.WriteError(w, handler.Errorf(http.StatusBadRequest, "invalid WebMCP mutation body"))
				return
			}
			if len(body) > maxFieldAssistContextBodyBytes {
				handler.WriteError(w, handler.Errorf(http.StatusRequestEntityTooLarge, "WebMCP mutation body is too large"))
				return
			}
		}
		provided, parseErr := fieldAssistContextVersionFromBody(body)
		if parseErr != nil {
			// Restore the body and let the strict typed binder report the normal
			// malformed-JSON response instead of turning it into a context error.
			next.ServeHTTP(w, r)
			return
		}
		if contextErr := session.ValidateWebMCPContext(provided); contextErr != nil {
			status := http.StatusConflict
			message := "context_stale: reload get_app_info and use its contextVersion"
			if errors.Is(contextErr, ErrFieldAssistContextRequired) {
				status = http.StatusPreconditionRequired
				message = "context_required: call get_app_info before this WebMCP mutation and use its contextVersion"
			}
			handler.WriteError(w, handler.Errorf(status, "%s", message))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func validatedObjectID(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "\r\n") {
		return "", handler.ValidationError(map[string][]string{"objectId": {"must name a scene object using at most 128 characters"}})
	}
	return value, nil
}

func validatedAnnotationText(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 240 || strings.ContainsAny(value, "\r\n") {
		return "", handler.ValidationError(map[string][]string{"text": {"must contain 1 to 240 characters and no line breaks"}})
	}
	return value, nil
}

func validatedInstructionText(value, field string, maximum int) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maximum || strings.ContainsAny(value, "\r\n\x00") {
		return "", handler.ValidationError(map[string][]string{
			field: {fmt.Sprintf("must contain 1 to %d characters and no line breaks", maximum)},
		})
	}
	return value, nil
}

func validatedConversationText(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxConversationText || strings.ContainsRune(value, '\x00') {
		return "", handler.ValidationError(map[string][]string{
			"text": {"must contain 1 to 500 characters"},
		})
	}
	return value, nil
}

func validatedSnapshotID(value, field string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "\r\n") {
		return "", handler.ValidationError(map[string][]string{field: {"must identify a snapshot using at most 128 characters"}})
	}
	return value, nil
}

func validatedOpaqueID(value, field string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "\r\n") {
		return "", handler.ValidationError(map[string][]string{field: {"must identify a server-issued record using at most 128 characters"}})
	}
	return value, nil
}

func actorFor(r *http.Request) string {
	if r.Header.Get("X-Gofastr-WebMCP") == "1" {
		return "Codex via WebMCP"
	}
	return "Support representative"
}

func operatorActorFor(_ *http.Request) string {
	return "Operator"
}

func operatorPath(session *Session) string {
	session.mu.RLock()
	joinToken := session.operatorJoinToken
	session.mu.RUnlock()
	return operatorPathWithToken(session.ID, joinToken)
}

func operatorPathWithToken(sessionID, joinToken string) string {
	return "/session/" + url.PathEscape(sessionID) + "/operator?token=" + url.QueryEscape(joinToken)
}

// sessionPageTarget extracts the concrete path handled by the UIHost screen
// routes. UIHost dispatches screens from its NotFound handler, so these
// requests arrive before the net/http mux has populated Request.Pattern or
// PathValue. Do not use router.Param here: it is intentionally scoped to
// framework routes and returns an empty value for UIHost's screen fallback.
func sessionPageTarget(path string) (string, Role, bool) {
	const prefix = "/session/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}

	rest := strings.TrimPrefix(path, prefix)
	if rest == "" {
		return "", "", false
	}
	// core-ui resolves a trailing slash for a dynamic screen, but multiple
	// trailing slashes (or an empty middle segment) are not a valid screen
	// route. Accept one trailing slash so auth and rendering agree.
	if strings.HasSuffix(rest, "/") {
		rest = strings.TrimSuffix(rest, "/")
		if rest == "" || strings.HasSuffix(rest, "/") {
			return "", "", false
		}
	}
	segments := strings.Split(rest, "/")
	if len(segments) == 1 && segments[0] != "" {
		return segments[0], RoleSupport, true
	}
	if len(segments) == 2 && segments[0] != "" && segments[1] == "operator" {
		return segments[0], RoleOperator, true
	}
	return "", "", false
}

func (s *service) sessionPageAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet &&
			(r.URL.Path == webmcp.ScriptRoute || r.URL.Path == webmcp.ManifestRoute) {
			if _, err := s.authenticate(r, RoleSupport); err != nil {
				handler.WriteError(w, err)
				return
			}
			// The released bridge marks its content-addressed script public and
			// immutable. That is appropriate for a globally mounted bridge, but
			// this app deliberately scopes tool discovery to the authority-bearing
			// support session. Override the inner cache policy at write time so an
			// intermediary cannot replay an authenticated response anonymously.
			next.ServeHTTP(&privateNoStoreResponseWriter{ResponseWriter: w}, r)
			return
		}
		if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/session/") {
			next.ServeHTTP(w, r)
			return
		}

		sessionID, role, ok := sessionPageTarget(r.URL.Path)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		if role == RoleOperator {
			if token := r.URL.Query().Get("token"); token != "" {
				session, err := s.sessions.Get(sessionID)
				if err != nil || !session.ConsumeOperatorJoinToken(token) {
					serveSessionUnavailable(next, w, r)
					return
				}
				setRoleCookie(w, r, role, sessionID, session.OperatorToken, session.ExpiresAt)
				w.Header().Set("Cache-Control", "no-store")
				http.Redirect(w, r, "/session/"+url.PathEscape(sessionID)+"/operator", http.StatusSeeOther)
				return
			}
		}

		session, err := s.authenticate(r, role)
		if err != nil || session.ID != sessionID {
			serveSessionUnavailable(next, w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// serveSessionUnavailable lets GoFastr render the application's branded
// recovery screen while keeping the original browser URL and a truthful 404
// response. The sentinel path is internal-only: the request is cloned before
// UIHost's not-found renderer sees it, so middleware never mutates shared
// request state.
func serveSessionUnavailable(next http.Handler, w http.ResponseWriter, r *http.Request) {
	request := r.Clone(r.Context())
	requestURL := *r.URL
	requestURL.Path = unavailableSessionPath
	requestURL.RawPath = ""
	request.URL = &requestURL
	next.ServeHTTP(&privateNoStoreResponseWriter{ResponseWriter: w}, request)
}

type privateNoStoreResponseWriter struct {
	http.ResponseWriter
}

func (w *privateNoStoreResponseWriter) applyPolicy() {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Add("Vary", "Cookie")
}

func (w *privateNoStoreResponseWriter) WriteHeader(statusCode int) {
	w.applyPolicy()
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *privateNoStoreResponseWriter) Write(body []byte) (int, error) {
	w.applyPolicy()
	return w.ResponseWriter.Write(body)
}

func (s *service) authenticateAny(r *http.Request) (*Session, Role, error) {
	if session, err := s.authenticate(r, RoleSupport); err == nil {
		return session, RoleSupport, nil
	}
	if session, err := s.authenticate(r, RoleOperator); err == nil {
		return session, RoleOperator, nil
	}
	return nil, "", handler.Errorf(http.StatusUnauthorized, "a valid session is required")
}

func (s *service) authenticate(r *http.Request, role Role) (*Session, error) {
	cookieName := supportCookieName
	if role == RoleOperator {
		cookieName = operatorCookieName
	}
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return nil, handler.Errorf(http.StatusUnauthorized, "a valid %s session is required", role)
	}
	parts := strings.SplitN(cookie.Value, ".", 2)
	if len(parts) != 2 {
		return nil, handler.Errorf(http.StatusUnauthorized, "invalid session credentials")
	}
	session, err := s.sessions.Get(parts[0])
	if errors.Is(err, ErrSessionNotFound) || errors.Is(err, ErrSessionExpired) {
		return nil, handler.Errorf(http.StatusUnauthorized, "session expired or unavailable")
	}
	if err != nil {
		return nil, handler.WrapError(http.StatusInternalServerError, "could not load session", err)
	}
	if !session.ValidToken(role, parts[1]) {
		return nil, handler.Errorf(http.StatusUnauthorized, "invalid session credentials")
	}
	return session, nil
}

func setRoleCookie(w http.ResponseWriter, r *http.Request, role Role, sessionID, token string, expires time.Time) {
	name := supportCookieName
	if role == RoleOperator {
		name = operatorCookieName
	}
	secure := useSecureSessionCookie(r)
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: sessionID + "." + token, Path: "/", Expires: expires,
		MaxAge: int(time.Until(expires).Seconds()), HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode,
	})
}

// useSecureSessionCookie keeps cookies usable for local HTTP development while
// ensuring a deployed non-loopback origin never receives a bearer token over
// plaintext HTTP. The framework's own session-cookie policy follows this same
// loopback exception; X-Forwarded-Proto is honored for TLS-terminating proxies.
func useSecureSessionCookie(r *http.Request) bool {
	return requestIsSecure(r) || !requestIsLoopback(r)
}

func requestIsSecure(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

func requestIsLoopback(r *http.Request) bool {
	host := strings.TrimSpace(r.Host)
	if host == "" && r.URL != nil {
		host = strings.TrimSpace(r.URL.Host)
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(strings.ToLower(host), "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// requireSameOriginMutation adds a server-side browser boundary around every
// cookie-authenticated POST. SameSite=Strict remains defense in depth, while
// this check prevents a future cookie-policy change from silently exposing
// consequential commands to cross-site form or fetch requests.
func (s *service) requireSameOriginMutation(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin == "" {
			if referer := strings.TrimSpace(r.Header.Get("Referer")); referer != "" {
				parsed, err := url.Parse(referer)
				if err == nil && parsed.Scheme != "" && parsed.Host != "" {
					origin = parsed.Scheme + "://" + parsed.Host
				}
			}
		}
		if origin == "" || !sameRequestOrigin(r, origin) {
			http.Error(w, "cross-origin mutation rejected", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// noStoreAuthenticated prevents role-specific state and one-time join URLs
// from being retained by browser or intermediary caches. Vary documents the
// request fields that select the authenticated representation.
func (s *service) noStoreAuthenticated(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Add("Vary", "Cookie")
		w.Header().Add("Vary", "Origin")
		next.ServeHTTP(w, r)
	})
}

func sameRequestOrigin(r *http.Request, rawOrigin string) bool {
	u, err := url.Parse(rawOrigin)
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	expectedScheme := "http"
	if requestIsSecure(r) {
		expectedScheme = "https"
	}
	return strings.EqualFold(u.Scheme, expectedScheme) && strings.EqualFold(u.Host, r.Host)
}

// sameOriginWebSocket retains support for non-browser clients (which omit
// Origin) while requiring browser upgrades to match both the request host and
// externally visible scheme. Host-only checks permit a cross-scheme origin.
func sameOriginWebSocket(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	return sameRequestOrigin(r, origin)
}

func allowedOriginSet(origins []string) map[string]struct{} {
	if len(origins) == 0 {
		return nil
	}
	set := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		set[strings.ToLower(strings.TrimRight(origin, "/"))] = struct{}{}
	}
	return set
}

func (s *service) websocketOriginAllowed(r *http.Request) bool {
	if sameOriginWebSocket(r) {
		return true
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	_, ok := s.allowedOrigins[strings.ToLower(parsed.Scheme+"://"+parsed.Host)]
	return ok
}

type socketInput struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func (s *service) sessionWebSocket(w http.ResponseWriter, r *http.Request) {
	sessionID := router.Param(r, "sessionId")
	role := Role(r.URL.Query().Get("role"))
	if role != RoleSupport && role != RoleOperator {
		http.Error(w, "role must be support or operator", http.StatusBadRequest)
		return
	}
	session, err := s.authenticate(r, role)
	if err != nil || session.ID != sessionID {
		http.Error(w, "unauthorized session", http.StatusUnauthorized)
		return
	}
	if !s.websocketOriginAllowed(r) {
		http.Error(w, "cross-origin websocket upgrade rejected", http.StatusForbidden)
		return
	}

	conn, err := stream.Upgrade(w, r, stream.WSConfig{
		ReadLimit:   128 << 10,
		SendBuffer:  64,
		CheckOrigin: s.websocketOriginAllowed,
	})
	if err != nil {
		http.Error(w, "invalid websocket upgrade request", http.StatusBadRequest)
		return
	}
	session.Connect(role, conn)
	s.log().Info("websocket.connected", "session_id", session.ID, "role", role)
	defer func() {
		session.Disconnect(role, conn)
		_ = conn.Close()
		s.log().Info("websocket.disconnected", "session_id", session.ID, "role", role)
	}()

	if snapshot, err := json.Marshal(session.SnapshotEvent(role)); err == nil {
		_ = conn.Write(snapshot)
	}

	for {
		message, err := conn.Read()
		if err != nil {
			return
		}
		var input socketInput
		if err := json.Unmarshal(message, &input); err != nil {
			continue
		}
		if !allowedSocketEvent(role, input.Type) || len(input.Payload) > 96<<10 {
			s.log().Warn("websocket.event.rejected", "session_id", session.ID, "role", role, "event_type", input.Type, "payload_bytes", len(input.Payload))
			continue
		}
		if s.webMCPDebug {
			signal := WebRTCSignalDebug{Type: input.Type}
			switch input.Type {
			case "webrtc.state_changed":
				signal.ConnectionState, signal.ICEState = safeWebRTCStates(input.Payload)
				signal.CandidatePair = safeCandidatePair(input.Payload)
			case "webrtc.ice_candidate":
				signal.CandidateType = safeICECandidateType(input.Payload)
			}
			session.RecordWebRTCDebugSignal(role, signal)
		}
		attrs := []any{"session_id", session.ID, "from_role", role, "event_type", input.Type, "payload_bytes", len(input.Payload)}
		if input.Type == "webrtc.ice_candidate" {
			attrs = append(attrs, "candidate_type", safeICECandidateType(input.Payload))
		}
		if input.Type == "webrtc.state_changed" {
			connectionState, iceState := safeWebRTCStates(input.Payload)
			attrs = append(attrs, "connection_state", connectionState, "ice_state", iceState)
		}
		s.log().Info("webrtc.signal.relayed", attrs...)
		session.Relay(input.Type, role, input.Payload)
	}
}

func (s *service) log() *slog.Logger {
	if s.logger != nil {
		if logger := s.logger(); logger != nil {
			return logger
		}
	}
	return slog.Default()
}

type outcomeResponseWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *outcomeResponseWriter) WriteHeader(status int) {
	if w.wrote {
		return
	}
	w.status = status
	w.wrote = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *outcomeResponseWriter) Write(body []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *outcomeResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func requestToolSource(r *http.Request) string {
	source := "manual"
	if r != nil && r.Header.Get("X-Gofastr-WebMCP") == "1" {
		source = "webmcp"
	}
	return source
}

func (s *service) observeToolOutcome(name string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessionID := ""
		if session, err := s.authenticate(r, RoleSupport); err == nil {
			sessionID = session.ID
		}
		source := requestToolSource(r)
		started := time.Now()
		s.log().Info("tool.invoked", "session_id", sessionID, "tool", name, "source", source)
		observed := &outcomeResponseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(observed, r)
		outcome := "succeeded"
		if observed.status < 200 || observed.status >= 400 {
			outcome = "failed"
		}
		s.log().Info(
			"tool.completed",
			"session_id", sessionID,
			"tool", name,
			"source", source,
			"outcome", outcome,
			"http_status", observed.status,
			"duration_ms", time.Since(started).Milliseconds(),
		)
	})
}

func safeICECandidateType(payload json.RawMessage) string {
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return "unknown"
	}
	for depth := 0; depth < 3; depth++ {
		object, ok := value.(map[string]any)
		if !ok {
			break
		}
		next, exists := object["candidate"]
		if !exists {
			break
		}
		value = next
	}
	candidate, _ := value.(string)
	fields := strings.Fields(candidate)
	for index := 0; index+1 < len(fields); index++ {
		if strings.EqualFold(fields[index], "typ") {
			switch strings.ToLower(fields[index+1]) {
			case "host", "srflx", "prflx", "relay":
				return strings.ToLower(fields[index+1])
			}
			return "unknown"
		}
	}
	return "unknown"
}

func safeWebRTCStates(payload json.RawMessage) (string, string) {
	var value map[string]any
	if json.Unmarshal(payload, &value) != nil {
		return "unknown", "unknown"
	}
	return allowlistedWebRTCState(value["connectionState"]), allowlistedWebRTCState(value["iceConnectionState"])
}

func safeCandidatePair(payload json.RawMessage) *WebRTCCandidatePairDebug {
	var value struct {
		CandidatePair *struct {
			LocalType  string `json:"localType"`
			RemoteType string `json:"remoteType"`
			Protocol   string `json:"protocol"`
		} `json:"candidatePair"`
	}
	if json.Unmarshal(payload, &value) != nil || value.CandidatePair == nil {
		return nil
	}
	localType := allowlistedCandidateType(value.CandidatePair.LocalType)
	remoteType := allowlistedCandidateType(value.CandidatePair.RemoteType)
	protocol := strings.ToLower(value.CandidatePair.Protocol)
	if protocol != "udp" && protocol != "tcp" && protocol != "tls" {
		protocol = "unknown"
	}
	return &WebRTCCandidatePairDebug{
		LocalType: localType, RemoteType: remoteType, Protocol: protocol,
		Relay: localType == "relay" || remoteType == "relay",
	}
}

func allowlistedCandidateType(value string) string {
	switch strings.ToLower(value) {
	case "host", "srflx", "prflx", "relay":
		return strings.ToLower(value)
	default:
		return "unknown"
	}
}

func allowlistedWebRTCState(value any) string {
	state, _ := value.(string)
	switch strings.ToLower(state) {
	case "new", "checking", "connecting", "connected", "completed", "disconnected", "failed", "closed":
		return strings.ToLower(state)
	default:
		return "unknown"
	}
}

func allowedSocketEvent(role Role, eventType string) bool {
	switch eventType {
	case "webrtc.ice_candidate", "webrtc.state_changed":
		return role == RoleSupport || role == RoleOperator
	case "webrtc.offer", "webrtc.renegotiate":
		return role == RoleSupport
	case "webrtc.ready", "webrtc.answer":
		return role == RoleOperator
	default:
		return false
	}
}
