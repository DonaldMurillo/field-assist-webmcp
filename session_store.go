package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/DonaldMurillo/gofastr/core/stream"
)

const (
	maxTimelineItems     = 200
	maxSceneSnapshots    = 50
	maxActiveAnnotations = 32
	maxRoomObservations  = 8
	maxOperatorOptions   = 4
	maxInstructionTitle  = 80
	maxInstructionDetail = 180
	maxOperatorIssueText = 280
	maxConversationText  = 500
	maxConversationItems = 64
	maxDebugSignals      = 24
	defaultMaxSessions   = 64
)

var (
	ErrSessionNotFound       = errors.New("session not found")
	ErrSessionExpired        = errors.New("session expired")
	ErrSessionLimit          = errors.New("active session limit reached")
	ErrObjectNotFound        = errors.New("scene object not found")
	ErrAnnotationNotFound    = errors.New("annotation not found")
	ErrSnapshotNotFound      = errors.New("scene snapshot not found")
	ErrSceneTransition       = errors.New("scene is not in the expected state for this transition")
	ErrCableAlreadyMoved     = errors.New("modem connection is already on the WAN port")
	ErrInvalidBounds         = errors.New("scene bounds must be normalized and have positive dimensions")
	ErrInvalidMoveDirection  = errors.New("move direction must be up, down, left, right, closer, or farther")
	ErrInvalidOperatorView   = errors.New("operator view target must contain 1 to 80 characters")
	ErrApprovalRequired      = errors.New("support approval is required")
	ErrApprovalStale         = errors.New("support approval is stale or expired")
	ErrApprovalConsumed      = errors.New("support approval has already been consumed")
	ErrGuidanceNotFound      = errors.New("eligible WAN guidance was not found")
	ErrSceneVersionStale     = errors.New("scene version is stale")
	ErrCaseNotReady          = errors.New("case is not ready to resolve")
	ErrCaseResolved          = errors.New("case has already been resolved")
	ErrInvalidSceneActivity  = errors.New("scene activity score must be finite and between 0.05 and 1")
	ErrInvalidTracking       = errors.New("tracking telemetry is invalid or outside the calibrated drift envelope")
	ErrInvalidRoomContext    = errors.New("room context is invalid")
	ErrQuestionPending       = errors.New("an operator question is already pending")
	ErrQuestionNotFound      = errors.New("operator question was not found")
	ErrQuestionAnswered      = errors.New("operator question has already been answered")
	ErrInvalidQuestion       = errors.New("operator question is invalid")
	ErrInvalidQuestionOption = errors.New("operator question option is invalid")
	ErrInvalidOperatorIssue  = errors.New("operator issue selection is invalid")
	ErrOperatorIssueSelected = errors.New("operator issue has already been selected")
	ErrInvalidInstruction    = errors.New("operator instruction is invalid")
	ErrInvalidConversation   = errors.New("conversation message is invalid")
)

type Role string

const (
	RoleSupport  Role = "support"
	RoleOperator Role = "operator"
)

type Bounds struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Point is a normalized video-space coordinate. Tracking points are transient
// and never mutate the authoritative scene calibration.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type TrackingQuad [4]Point

// ObjectAnchor identifies a point relative to an object's calibrated bounds.
// Values just outside the unit square let guidance target a control immediately
// beside an otherwise easier-to-track planar object, such as a TV's lower edge.
type ObjectAnchor struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type SceneObject struct {
	ID          string         `json:"id"`
	Label       string         `json:"label"`
	Kind        string         `json:"kind"`
	Description string         `json:"description"`
	Confidence  float64        `json:"confidence"`
	Bounds      Bounds         `json:"bounds"`
	ParentID    string         `json:"parentId,omitempty"`
	Attributes  map[string]any `json:"attributes,omitempty"`
}

// SceneRelationship describes a semantic connection between two detected
// objects. IDs are stable within a session so an agent can reason about a
// physical connection without inferring it from pixel coordinates.
type SceneRelationship struct {
	ID           string  `json:"id"`
	Type         string  `json:"type"`
	FromObjectID string  `json:"fromObjectId"`
	ToObjectID   string  `json:"toObjectId"`
	Confidence   float64 `json:"confidence"`
	Source       string  `json:"source"`
}

// SceneCalibration records how normalized bounds were established. The
// current demo supports fixture and human calibration; a future browser CV
// layer can add its own source without changing the scene contract.
type SceneCalibration struct {
	Source          string    `json:"source"`
	CoordinateSpace string    `json:"coordinateSpace"`
	UpdatedAt       time.Time `json:"updatedAt"`
	UpdatedBy       string    `json:"updatedBy,omitempty"`
}

type Scene struct {
	ID            string              `json:"id"`
	Label         string              `json:"label"`
	Version       uint64              `json:"version"`
	Timestamp     time.Time           `json:"timestamp"`
	Objects       []SceneObject       `json:"objects"`
	Relationships []SceneRelationship `json:"relationships,omitempty"`
	Calibration   SceneCalibration    `json:"calibration"`
}

type AnnotationKind string

const (
	AnnotationKindHighlight AnnotationKind = "highlight"
	AnnotationKindLabel     AnnotationKind = "label"
	AnnotationKindArrow     AnnotationKind = "arrow"
	AnnotationKindRegion    AnnotationKind = "region"
	AnnotationKindMove      AnnotationKind = "move"
	AnnotationKindCloseup   AnnotationKind = "closeup"
	AnnotationKindAngle     AnnotationKind = "angle"
	AnnotationKindView      AnnotationKind = "view"
)

type MoveDirection string

const (
	MoveDirectionUp      MoveDirection = "up"
	MoveDirectionDown    MoveDirection = "down"
	MoveDirectionLeft    MoveDirection = "left"
	MoveDirectionRight   MoveDirection = "right"
	MoveDirectionCloser  MoveDirection = "closer"
	MoveDirectionFarther MoveDirection = "farther"
)

type Annotation struct {
	ID        string         `json:"id"`
	ObjectID  string         `json:"objectId,omitempty"`
	Kind      AnnotationKind `json:"kind"`
	Label     string         `json:"label"`
	Bounds    Bounds         `json:"bounds"`
	Direction MoveDirection  `json:"direction,omitempty"`
	Actor     string         `json:"actor"`
	Intent    string         `json:"intent,omitempty"`
	Anchor    *ObjectAnchor  `json:"anchor,omitempty"`
	CreatedAt time.Time      `json:"createdAt"`
}

// AnnotationReceipt records that the operator document actually rendered an
// annotation for a specific authoritative scene version. It proves delivery
// to the browser UI, not that the operator followed the instruction.
type AnnotationReceipt struct {
	AnnotationID   string    `json:"annotationId"`
	ObjectID       string    `json:"objectId,omitempty"`
	SceneVersion   uint64    `json:"sceneVersion"`
	Source         string    `json:"source"`
	AcknowledgedAt time.Time `json:"acknowledgedAt"`
}

// RoomObservation is a bounded, factual landmark description authored by the
// support-side Codex session after inspecting the live frame. It is context
// for reasoning, not an object detection result or physical-state proof.
type RoomObservation struct {
	Label  string `json:"label"`
	Detail string `json:"detail"`
}

type RoomContext struct {
	Summary          string            `json:"summary"`
	Observations     []RoomObservation `json:"observations"`
	BaseSceneVersion uint64            `json:"baseSceneVersion"`
	UpdatedBy        string            `json:"updatedBy"`
	UpdatedAt        time.Time         `json:"updatedAt"`
}

type OperatorQuestionOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// OperatorQuestion carries one bounded question at a time. The operator can
// only choose a server-issued option; arbitrary text never crosses from the
// phone into support state.
type OperatorQuestion struct {
	ID         string                   `json:"id"`
	Prompt     string                   `json:"prompt"`
	Options    []OperatorQuestionOption `json:"options"`
	Status     string                   `json:"status"`
	AnswerID   string                   `json:"answerId,omitempty"`
	Answer     string                   `json:"answer,omitempty"`
	AskedBy    string                   `json:"askedBy"`
	AskedAt    time.Time                `json:"askedAt"`
	AnsweredAt *time.Time               `json:"answeredAt,omitempty"`
}

// OperatorInstruction is the current one-way, backend-synchronized banner
// shown over the operator camera. It is intentionally independent of spatial
// annotations so camera tracking and annotation clearing cannot hide it.
type OperatorInstruction struct {
	ID     string    `json:"id"`
	Title  string    `json:"title"`
	Detail string    `json:"detail"`
	SentBy string    `json:"sentBy"`
	SentAt time.Time `json:"sentAt"`
}

// ConversationMessage is bounded, persisted session text shared by the
// operator, support representative, and Codex. Sender is the transport role;
// Actor identifies the accountable human or WebMCP caller behind it.
type ConversationMessage struct {
	ID     string    `json:"id"`
	Text   string    `json:"text"`
	Sender Role      `json:"sender"`
	Actor  string    `json:"actor"`
	SentAt time.Time `json:"sentAt"`
}

const (
	OperatorIssueModePreset   = "preset"
	OperatorIssueModeFreeform = "freeform"
	OperatorIssuePresetTV     = "lost-tv-controller"
)

// OperatorIssue is the phone-selected request that starts the assistance
// workflow. It remains nil until the operator explicitly chooses a preset or
// submits bounded free-form text, so support and Codex receive no inferred
// problem statement merely because the phone joined.
type OperatorIssue struct {
	Summary    string    `json:"summary"`
	SelectedAt time.Time `json:"selectedAt"`
}

type TroubleshootingStep struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	Status           string `json:"status"`
	RequiresApproval bool   `json:"requiresApproval"`
}

// CaseContext is deliberately small and deterministic for the networking
// fixture. It gives the support UI and agent a shared workflow state without
// introducing accounts, a database, or a generalized case-management model.
type CaseContext struct {
	ID            string                `json:"id"`
	Title         string                `json:"title"`
	Problem       string                `json:"problem"`
	Status        string                `json:"status"`
	CurrentStepID string                `json:"currentStepId"`
	Steps         []TroubleshootingStep `json:"steps"`
	UpdatedAt     time.Time             `json:"updatedAt"`
}

type NextStepSuggestion struct {
	StepID                  string `json:"stepId"`
	Title                   string `json:"title"`
	Rationale               string `json:"rationale"`
	TargetObjectID          string `json:"targetObjectId,omitempty"`
	RequiresSupportApproval bool   `json:"requiresSupportApproval"`
	Status                  string `json:"status"`
}

// ActionApproval is the narrow human-in-the-loop contract for the only
// consequential demo action. It is bound to one server-issued guidance item
// and scene version, expires quickly, and is consumed atomically.
type ActionApproval struct {
	ID             string     `json:"id"`
	Action         string     `json:"action"`
	TargetObjectID string     `json:"targetObjectId"`
	GuidanceID     string     `json:"guidanceId"`
	SceneVersion   uint64     `json:"sceneVersion"`
	Status         string     `json:"status"`
	ApprovedBy     string     `json:"approvedBy"`
	ApprovedAt     time.Time  `json:"approvedAt"`
	ExpiresAt      time.Time  `json:"expiresAt"`
	ConsumedAt     *time.Time `json:"consumedAt,omitempty"`
}

// SceneActivity is an advisory browser-CV signal, not proof that a physical
// repair happened. The operator browser computes a bounded frame difference
// around the calibrated target; GoFastr validates that it belongs to the
// current approval and scene version before exposing it to support.
type SceneActivity struct {
	ID               string    `json:"id"`
	ApprovalID       string    `json:"approvalId"`
	ObjectID         string    `json:"objectId"`
	BaseSceneVersion uint64    `json:"baseSceneVersion"`
	ChangeScore      float64   `json:"changeScore"`
	Source           string    `json:"source"`
	DetectedAt       time.Time `json:"detectedAt"`
}

type SceneTrackingStatus string

const (
	SceneTrackingCalibratedFallback    SceneTrackingStatus = "calibrated_fallback"
	SceneTrackingLocked                SceneTrackingStatus = "locked"
	SceneTrackingFollowingDrift        SceneTrackingStatus = "following_camera_drift"
	SceneTrackingRecalibrationRequired SceneTrackingStatus = "recalibration_required"
	SceneTrackingReacquireRequired     SceneTrackingStatus = "reacquire_required"
)

// SceneTrackingTelemetry is transient, privacy-preserving browser-CV state.
// It tells support whether the operator overlay is using authoritative
// calibration or following a confident local match. Bounds here never mutate
// the shared scene graph and disappear with the active guidance they describe.
type SceneTrackingTelemetry struct {
	ApprovalID         string              `json:"approvalId,omitempty"`
	GuidanceID         string              `json:"guidanceId,omitempty"`
	ObjectID           string              `json:"objectId"`
	ReferenceObjectID  string              `json:"referenceObjectId,omitempty"`
	BaseSceneVersion   uint64              `json:"baseSceneVersion"`
	Status             SceneTrackingStatus `json:"status"`
	Confidence         float64             `json:"confidence"`
	NeedsRecalibration bool                `json:"needsRecalibration"`
	Bounds             Bounds              `json:"bounds"`
	Quad               *TrackingQuad       `json:"quad,omitempty"`
	Anchor             *Point              `json:"anchor,omitempty"`
	Scale              float64             `json:"scale,omitempty"`
	RelativeDepth      float64             `json:"relativeDepth,omitempty"`
	ScaleSource        string              `json:"scaleSource,omitempty"`
	DepthScore         float64             `json:"depthScore,omitempty"`
	DepthConfidence    float64             `json:"depthConfidence,omitempty"`
	ModelRelativeDepth float64             `json:"modelRelativeDepth,omitempty"`
	DepthSource        string              `json:"depthSource,omitempty"`
	PoseState          string              `json:"poseState,omitempty"`
	PoseFailureReason  string              `json:"poseFailureReason,omitempty"`
	PoseInliers        int                 `json:"poseInliers,omitempty"`
	PoseInlierRatio    float64             `json:"poseInlierRatio,omitempty"`
	PartialVisibility  bool                `json:"partialVisibility,omitempty"`
	VisibleFraction    float64             `json:"visibleFraction,omitempty"`
	AnchorVisible      bool                `json:"anchorVisible"`
	Source             string              `json:"source"`
	UpdatedAt          time.Time           `json:"updatedAt"`
}

// SceneTrackingEvidence identifies the local perception engine that produced
// advisory geometry. Only bounded scalar summaries cross the browser boundary;
// frames, feature descriptors, homographies, and depth maps remain local.
type SceneTrackingEvidence struct {
	Source             string
	ReferenceObjectID  string
	Quad               *TrackingQuad
	Anchor             *Point
	DepthScore         float64
	DepthConfidence    float64
	ModelRelativeDepth float64
	DepthSource        string
	PoseState          string
	PoseFailureReason  string
	PoseInliers        int
	PoseInlierRatio    float64
	PartialVisibility  bool
	VisibleFraction    float64
	AnchorVisible      bool
}

// WebRTCCandidatePairDebug is the allowlisted portion of browser getStats()
// needed to distinguish a direct peer path from TURN relay use. It never
// contains addresses, ports, candidate strings, credentials, or SDP.
type WebRTCCandidatePairDebug struct {
	LocalType  string `json:"localType"`
	RemoteType string `json:"remoteType"`
	Protocol   string `json:"protocol"`
	Relay      bool   `json:"relay"`
}

// WebRTCSignalDebug records only event categories and allowlisted states.
// The raw WebSocket payload is deliberately discarded before storage.
type WebRTCSignalDebug struct {
	Type            string                    `json:"type"`
	At              time.Time                 `json:"at"`
	ConnectionState string                    `json:"connectionState,omitempty"`
	ICEState        string                    `json:"iceState,omitempty"`
	CandidateType   string                    `json:"candidateType,omitempty"`
	CandidatePair   *WebRTCCandidatePairDebug `json:"candidatePair,omitempty"`
}

type WebRTCRoleDebug struct {
	ConnectionState string                    `json:"connectionState"`
	ICEState        string                    `json:"iceState"`
	LastCandidate   string                    `json:"lastCandidateType,omitempty"`
	CandidatePair   *WebRTCCandidatePairDebug `json:"candidatePair,omitempty"`
	SignalCounts    map[string]int            `json:"signalCounts"`
	RecentSignals   []WebRTCSignalDebug       `json:"recentSignals"`
	UpdatedAt       time.Time                 `json:"updatedAt,omitempty"`
}

// SceneSnapshot is an immutable, structured capture of the scene graph at a
// point in time. It deliberately contains no camera bytes: the browser owns
// the media stream and the server only keeps the semantic state needed for
// agent reasoning and deterministic comparisons.
type SceneSnapshot struct {
	ID         string    `json:"id"`
	Label      string    `json:"label"`
	CapturedAt time.Time `json:"capturedAt"`
	Scene      Scene     `json:"scene"`
}

// ObjectChange describes one deterministic object-level difference between
// two scene snapshots. Before and After are nil for added/removed objects.
type ObjectChange struct {
	ID            string       `json:"id"`
	Before        *SceneObject `json:"before,omitempty"`
	After         *SceneObject `json:"after,omitempty"`
	ChangedFields []string     `json:"changedFields,omitempty"`
}

type RelationshipChange struct {
	ID            string             `json:"id"`
	Before        *SceneRelationship `json:"before,omitempty"`
	After         *SceneRelationship `json:"after,omitempty"`
	ChangedFields []string           `json:"changedFields,omitempty"`
}

// SceneComparison is intentionally stable: objects and changed fields are
// sorted by identifiers and field order, so equal inputs produce equal JSON
// regardless of map or insertion order.
type SceneComparison struct {
	BeforeSnapshotID     string               `json:"beforeSnapshotId,omitempty"`
	AfterSnapshotID      string               `json:"afterSnapshotId,omitempty"`
	BeforeVersion        uint64               `json:"beforeVersion"`
	AfterVersion         uint64               `json:"afterVersion"`
	VersionChanged       bool                 `json:"versionChanged"`
	SceneChanged         bool                 `json:"sceneChanged"`
	Same                 bool                 `json:"same"`
	Added                []SceneObject        `json:"added,omitempty"`
	Removed              []SceneObject        `json:"removed,omitempty"`
	Changed              []ObjectChange       `json:"changed,omitempty"`
	AddedRelationships   []SceneRelationship  `json:"addedRelationships,omitempty"`
	RemovedRelationships []SceneRelationship  `json:"removedRelationships,omitempty"`
	ChangedRelationships []RelationshipChange `json:"changedRelationships,omitempty"`
	CalibrationChanged   bool                 `json:"calibrationChanged"`
	Summary              string               `json:"summary"`
}

type TimelineItem struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Message   string    `json:"message"`
	Actor     string    `json:"actor"`
	CreatedAt time.Time `json:"createdAt"`
}

type Event struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Sequence  uint64 `json:"sequence"`
	Timestamp string `json:"timestamp"`
	Payload   any    `json:"payload"`
}

type SessionSnapshot struct {
	ID                  string                  `json:"id"`
	CreatedAt           time.Time               `json:"createdAt"`
	ExpiresAt           time.Time               `json:"expiresAt"`
	Sequence            uint64                  `json:"sequence"`
	Participants        map[Role]int            `json:"participants"`
	Scene               Scene                   `json:"scene"`
	CaseContext         CaseContext             `json:"caseContext"`
	ActiveApproval      *ActionApproval         `json:"activeApproval,omitempty"`
	SceneActivity       *SceneActivity          `json:"sceneActivity,omitempty"`
	SceneTracking       *SceneTrackingTelemetry `json:"sceneTracking,omitempty"`
	RoomContext         *RoomContext            `json:"roomContext,omitempty"`
	OperatorIssue       *OperatorIssue          `json:"operatorIssue,omitempty"`
	ActiveQuestion      *OperatorQuestion       `json:"activeQuestion,omitempty"`
	OperatorInstruction *OperatorInstruction    `json:"operatorInstruction,omitempty"`
	Messages            []ConversationMessage   `json:"messages,omitempty"`
	Snapshots           []SceneSnapshot         `json:"snapshots,omitempty"`
	Annotations         []Annotation            `json:"annotations"`
	AnnotationReceipts  []AnnotationReceipt     `json:"annotationReceipts,omitempty"`
	Timeline            []TimelineItem          `json:"timeline"`
}

// OperatorSessionSnapshot is the least-privilege realtime view needed by the
// phone. It intentionally excludes support case context, timeline entries,
// semantic history, and support-only notes while retaining the operational
// scene, transient overlay geometry, guidance, participant counts, and
// one-time approval needed to render and confirm the physical instruction.
type OperatorSessionSnapshot struct {
	ID                  string                  `json:"id"`
	CreatedAt           time.Time               `json:"createdAt"`
	ExpiresAt           time.Time               `json:"expiresAt"`
	Sequence            uint64                  `json:"sequence"`
	Participants        map[Role]int            `json:"participants"`
	Scene               Scene                   `json:"scene"`
	ActiveApproval      *ActionApproval         `json:"activeApproval,omitempty"`
	SceneTracking       *SceneTrackingTelemetry `json:"sceneTracking,omitempty"`
	OperatorIssue       *OperatorIssue          `json:"operatorIssue,omitempty"`
	ActiveQuestion      *OperatorQuestion       `json:"activeQuestion,omitempty"`
	OperatorInstruction *OperatorInstruction    `json:"operatorInstruction,omitempty"`
	Messages            []ConversationMessage   `json:"messages,omitempty"`
	Annotations         []Annotation            `json:"annotations"`
}

type Session struct {
	ID            string
	SupportToken  string
	OperatorToken string
	// webMCPContextVersion is opaque, session-bound state returned only after
	// an authenticated support caller loads the app-provided operating
	// contract. Mutating WebMCP requests must present the exact value.
	webMCPContextVersion  string
	webMCPContextLoaded   bool
	webMCPContextLoadedAt time.Time
	// operatorJoinToken is separate from OperatorToken. It is accepted only
	// once by the initial operator URL and then erased; the persistent role
	// cookie never appears in a URL.
	operatorJoinToken     string
	operatorJoinExpiresAt time.Time
	CreatedAt             time.Time
	ExpiresAt             time.Time
	qrMu                  sync.Mutex
	operatorQRCode        []byte

	mu                  sync.RWMutex
	sequence            uint64
	participants        map[Role]int
	scene               Scene
	caseContext         CaseContext
	activeApproval      *ActionApproval
	sceneActivity       *SceneActivity
	sceneTracking       *SceneTrackingTelemetry
	roomContext         *RoomContext
	operatorIssue       *OperatorIssue
	activeQuestion      *OperatorQuestion
	operatorInstruction *OperatorInstruction
	messages            []ConversationMessage
	annotations         map[string]Annotation
	annotationReceipts  map[string]AnnotationReceipt
	timeline            []TimelineItem
	snapshots           map[string]SceneSnapshot
	snapshotOrder       []string
	webRTCDebug         map[Role]WebRTCRoleDebug
	hubs                map[Role]*stream.Hub
}

func newSession(ttl time.Duration) (*Session, error) {
	id, err := secureToken(12)
	if err != nil {
		return nil, fmt.Errorf("generate session id: %w", err)
	}
	supportToken, err := secureToken(32)
	if err != nil {
		return nil, fmt.Errorf("generate support token: %w", err)
	}
	operatorToken, err := secureToken(32)
	if err != nil {
		return nil, fmt.Errorf("generate operator token: %w", err)
	}
	operatorJoinToken, err := secureToken(32)
	if err != nil {
		return nil, fmt.Errorf("generate operator join token: %w", err)
	}
	contextNonce, err := secureToken(18)
	if err != nil {
		return nil, fmt.Errorf("generate WebMCP context version: %w", err)
	}

	now := time.Now().UTC()
	s := &Session{
		ID:                    id,
		SupportToken:          supportToken,
		OperatorToken:         operatorToken,
		webMCPContextVersion:  fieldAssistContextVersionPrefix + contextNonce,
		operatorJoinToken:     operatorJoinToken,
		operatorJoinExpiresAt: now.Add(10 * time.Minute),
		CreatedAt:             now,
		ExpiresAt:             now.Add(ttl),
		participants: map[Role]int{
			RoleSupport:  0,
			RoleOperator: 0,
		},
		annotations:        make(map[string]Annotation),
		annotationReceipts: make(map[string]AnnotationReceipt),
		snapshots:          make(map[string]SceneSnapshot),
		webRTCDebug: map[Role]WebRTCRoleDebug{
			RoleSupport:  {ConnectionState: "unknown", ICEState: "unknown", SignalCounts: make(map[string]int)},
			RoleOperator: {ConnectionState: "unknown", ICEState: "unknown", SignalCounts: make(map[string]int)},
		},
		hubs: map[Role]*stream.Hub{
			RoleSupport:  stream.NewHub(),
			RoleOperator: stream.NewHub(),
		},
		scene: Scene{
			ID:        "router-1",
			Label:     "Network router",
			Version:   1,
			Timestamp: now,
			Calibration: SceneCalibration{
				Source:          "fixture",
				CoordinateSpace: "normalized-video",
				UpdatedAt:       now,
				UpdatedBy:       "fixture",
			},
			Objects: []SceneObject{
				{
					ID:          "router-1",
					Label:       "Network router",
					Kind:        "router",
					Description: "Seeded demo router shown in the operator camera view.",
					Confidence:  0.96,
					Bounds:      Bounds{X: 0.15, Y: 0.18, Width: 0.70, Height: 0.64},
					Attributes: map[string]any{
						"deviceState": "online",
						"model":       "field-assist-router",
					},
				},
				{
					ID:          "modem-1",
					Label:       "Cable modem",
					Kind:        "modem",
					Description: "The modem supplying the incoming network connection.",
					Confidence:  0.94,
					Bounds:      Bounds{X: 0.02, Y: 0.30, Width: 0.25, Height: 0.32},
					Attributes: map[string]any{
						"connectionState": "connected",
						"connectedTo":     "lan-port",
					},
				},
				{
					ID:          "lan-port",
					Label:       "LAN port",
					Kind:        "ethernet-port",
					Description: "The occupied local network port currently holding the modem cable.",
					Confidence:  0.94,
					Bounds:      Bounds{X: 0.43, Y: 0.55, Width: 0.17, Height: 0.16},
					ParentID:    "router-1",
					Attributes: map[string]any{
						"portRole":          "LAN",
						"connectionState":   "occupied",
						"connectedDeviceId": "modem-1",
					},
				},
				{
					ID:          "wan-port",
					Label:       "WAN port",
					Kind:        "ethernet-port",
					Description: "The blue uplink port where the incoming network cable belongs.",
					Confidence:  0.93,
					Bounds:      Bounds{X: 0.67, Y: 0.55, Width: 0.17, Height: 0.16},
					ParentID:    "router-1",
					Attributes: map[string]any{
						"portRole":        "WAN",
						"connectionState": "empty",
						// The WAN port is a narrow actionable control even though
						// its domain kind remains ethernet-port for scene semantics.
						"targetType": "device-control",
					},
				},
				{
					ID:          "ethernet-cable-1",
					Label:       "Modem ethernet cable",
					Kind:        "ethernet-cable",
					Description: "The ethernet cable currently connecting the modem to the router.",
					Confidence:  0.90,
					Bounds:      Bounds{X: 0.22, Y: 0.43, Width: 0.43, Height: 0.12},
					Attributes: map[string]any{
						"connectionState": "seated",
						"fromObjectId":    "modem-1",
						"toObjectId":      "lan-port",
						"boundsSource":    "fixture",
					},
				},
			},
			Relationships: []SceneRelationship{
				{
					ID:           "modem-cable-connection",
					Type:         "connected_to",
					FromObjectID: "modem-1",
					ToObjectID:   "lan-port",
					Confidence:   0.94,
					Source:       "fixture",
				},
			},
		},
		caseContext: newCaseContext(id, now),
	}
	for _, hub := range s.hubs {
		go hub.Run()
	}
	return s, nil
}

func secureToken(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func newCaseContext(sessionID string, now time.Time) CaseContext {
	return CaseContext{
		ID:            "case-" + sessionID,
		Title:         "WAN connection troubleshooting",
		Problem:       "Internet is not working",
		Status:        "investigating",
		CurrentStepID: "move-modem-cable-to-wan",
		Steps: []TroubleshootingStep{
			{
				ID:               "inspect-scene",
				Title:            "Inspect router and modem connections",
				Status:           "complete",
				RequiresApproval: false,
			},
			{
				ID:               "move-modem-cable-to-wan",
				Title:            "Move the modem cable to the WAN port",
				Status:           "active",
				RequiresApproval: true,
			},
			{
				ID:               "verify-wan-connection",
				Title:            "Verify the WAN connection",
				Status:           "pending",
				RequiresApproval: false,
			},
		},
		UpdatedAt: now.UTC(),
	}
}

func newLiveCaseContext(sessionID string, now time.Time) CaseContext {
	return CaseContext{
		ID:            "case-" + sessionID,
		Title:         "Live device assistance",
		Problem:       "Identify the observed device and help the operator use it safely",
		Status:        "investigating",
		CurrentStepID: "observe-device",
		Steps: []TroubleshootingStep{
			{ID: "pair-operator", Title: "Pair the operator camera", Status: "active"},
			{ID: "observe-device", Title: "Identify the device and controls", Status: "pending"},
			{ID: "guide-operator", Title: "Place reversible visual guidance", Status: "pending"},
			{ID: "verify-result", Title: "Verify the observed result", Status: "pending"},
		},
		UpdatedAt: now.UTC(),
	}
}

func cloneCaseContext(context CaseContext) CaseContext {
	context.Steps = append([]TroubleshootingStep(nil), context.Steps...)
	return context
}

func cloneActionApproval(approval *ActionApproval) *ActionApproval {
	if approval == nil {
		return nil
	}
	clone := *approval
	if approval.ConsumedAt != nil {
		consumedAt := *approval.ConsumedAt
		clone.ConsumedAt = &consumedAt
	}
	return &clone
}

func cloneSceneActivity(activity *SceneActivity) *SceneActivity {
	if activity == nil {
		return nil
	}
	clone := *activity
	return &clone
}

func cloneSceneTracking(tracking *SceneTrackingTelemetry) *SceneTrackingTelemetry {
	if tracking == nil {
		return nil
	}
	clone := *tracking
	clone.Quad = cloneQuad(tracking.Quad)
	clone.Anchor = clonePoint(tracking.Anchor)
	return &clone
}

func cloneObjectAnchor(anchor *ObjectAnchor) *ObjectAnchor {
	if anchor == nil {
		return nil
	}
	clone := *anchor
	return &clone
}

func cloneAnnotation(annotation Annotation) Annotation {
	annotation.Anchor = cloneObjectAnchor(annotation.Anchor)
	return annotation
}

func cloneRoomContext(context *RoomContext) *RoomContext {
	if context == nil {
		return nil
	}
	clone := *context
	clone.Observations = append([]RoomObservation(nil), context.Observations...)
	return &clone
}

func cloneOperatorQuestion(question *OperatorQuestion) *OperatorQuestion {
	if question == nil {
		return nil
	}
	clone := *question
	clone.Options = append([]OperatorQuestionOption(nil), question.Options...)
	if question.AnsweredAt != nil {
		answeredAt := *question.AnsweredAt
		clone.AnsweredAt = &answeredAt
	}
	return &clone
}

func cloneOperatorInstruction(instruction *OperatorInstruction) *OperatorInstruction {
	if instruction == nil {
		return nil
	}
	clone := *instruction
	return &clone
}

func cloneOperatorIssue(issue *OperatorIssue) *OperatorIssue {
	if issue == nil {
		return nil
	}
	clone := *issue
	return &clone
}

func cloneConversationMessages(messages []ConversationMessage) []ConversationMessage {
	return append([]ConversationMessage(nil), messages...)
}

func (s *Session) ValidToken(role Role, token string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if time.Now().UTC().After(s.ExpiresAt) {
		return false
	}
	switch role {
	case RoleSupport:
		return constantTimeTokenMatch(token, s.SupportToken)
	case RoleOperator:
		return constantTimeTokenMatch(token, s.OperatorToken)
	default:
		return false
	}
}

// ConsumeOperatorJoinToken atomically validates and consumes the one-time
// operator URL credential. The caller must exchange the returned success for
// the persistent OperatorToken in an HttpOnly cookie; the join token is never
// itself reused as a session credential.
func (s *Session) ConsumeOperatorJoinToken(token string) bool {
	s.mu.Lock()
	now := time.Now().UTC()
	if now.After(s.ExpiresAt) || now.After(s.operatorJoinExpiresAt) || s.operatorJoinToken == "" {
		s.mu.Unlock()
		return false
	}
	if !constantTimeTokenMatch(token, s.operatorJoinToken) {
		s.mu.Unlock()
		return false
	}
	s.operatorJoinToken = ""
	s.mu.Unlock()

	// A cached QR contains the consumed bearer capability and must not remain
	// available for the rest of the support session.
	s.qrMu.Lock()
	s.operatorQRCode = nil
	s.qrMu.Unlock()
	return true
}

// constantTimeTokenMatch compares fixed-length digests so malformed token
// lengths do not take a shorter comparison path. Session tokens are bearer
// credentials, so avoid ordinary string equality here even though the values
// are generated with crypto/rand.
func constantTimeTokenMatch(got, want string) bool {
	if got == "" || want == "" {
		return false
	}
	gotDigest := sha256.Sum256([]byte(got))
	wantDigest := sha256.Sum256([]byte(want))
	return subtle.ConstantTimeCompare(gotDigest[:], wantDigest[:]) == 1
}

func (s *Session) Snapshot() SessionSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	annotations := make([]Annotation, 0, len(s.annotations))
	for _, annotation := range s.annotations {
		annotations = append(annotations, cloneAnnotation(annotation))
	}
	// Annotation storage is a map; stable ordering keeps snapshots and the
	// initial WebSocket payload deterministic for clients and tests.
	sort.Slice(annotations, func(i, j int) bool {
		if annotations[i].CreatedAt.Equal(annotations[j].CreatedAt) {
			return annotations[i].ID < annotations[j].ID
		}
		return annotations[i].CreatedAt.Before(annotations[j].CreatedAt)
	})
	receipts := make([]AnnotationReceipt, 0, len(s.annotationReceipts))
	for _, receipt := range s.annotationReceipts {
		receipts = append(receipts, receipt)
	}
	sort.Slice(receipts, func(i, j int) bool {
		if receipts[i].AcknowledgedAt.Equal(receipts[j].AcknowledgedAt) {
			return receipts[i].AnnotationID < receipts[j].AnnotationID
		}
		return receipts[i].AcknowledgedAt.Before(receipts[j].AcknowledgedAt)
	})
	snapshots := make([]SceneSnapshot, 0, len(s.snapshotOrder))
	for _, id := range s.snapshotOrder {
		if snapshot, ok := s.snapshots[id]; ok {
			snapshots = append(snapshots, cloneSceneSnapshot(snapshot))
		}
	}
	return SessionSnapshot{
		ID:        s.ID,
		CreatedAt: s.CreatedAt,
		ExpiresAt: s.ExpiresAt,
		Sequence:  s.sequence,
		Participants: map[Role]int{
			RoleSupport:  s.participants[RoleSupport],
			RoleOperator: s.participants[RoleOperator],
		},
		Scene: Scene{
			ID:            s.scene.ID,
			Label:         s.scene.Label,
			Version:       s.scene.Version,
			Timestamp:     s.scene.Timestamp,
			Objects:       cloneSceneObjects(s.scene.Objects),
			Relationships: cloneSceneRelationships(s.scene.Relationships),
			Calibration:   s.scene.Calibration,
		},
		CaseContext:         cloneCaseContext(s.caseContext),
		ActiveApproval:      cloneActionApproval(s.activeApproval),
		SceneActivity:       cloneSceneActivity(s.sceneActivity),
		SceneTracking:       cloneSceneTracking(s.sceneTracking),
		RoomContext:         cloneRoomContext(s.roomContext),
		OperatorIssue:       cloneOperatorIssue(s.operatorIssue),
		ActiveQuestion:      cloneOperatorQuestion(s.activeQuestion),
		OperatorInstruction: cloneOperatorInstruction(s.operatorInstruction),
		Messages:            cloneConversationMessages(s.messages),
		Snapshots:           snapshots,
		Annotations:         annotations,
		AnnotationReceipts:  receipts,
		Timeline:            append([]TimelineItem(nil), s.timeline...),
	}
}

// SnapshotForRole prevents the operator transport from inheriting fields
// added to the richer support snapshot in the future.
func (s *Session) SnapshotForRole(role Role) any {
	full := s.Snapshot()
	return snapshotForRole(full, role)
}

// snapshotForRole derives every role-specific representation from the same
// immutable snapshot. In particular, the WebSocket envelope sequence must
// describe the exact payload it carries; taking those two reads separately
// lets a concurrent mutation make an older payload look newer than it is.
func snapshotForRole(full SessionSnapshot, role Role) any {
	if role != RoleOperator {
		return full
	}
	return OperatorSessionSnapshot{
		ID:                  full.ID,
		CreatedAt:           full.CreatedAt,
		ExpiresAt:           full.ExpiresAt,
		Sequence:            full.Sequence,
		Participants:        full.Participants,
		Scene:               full.Scene,
		ActiveApproval:      full.ActiveApproval,
		SceneTracking:       full.SceneTracking,
		OperatorIssue:       full.OperatorIssue,
		ActiveQuestion:      full.ActiveQuestion,
		OperatorInstruction: full.OperatorInstruction,
		Messages:            cloneConversationMessages(full.Messages),
		Annotations:         full.Annotations,
	}
}

func (s *Session) Scene() Scene {
	return s.Snapshot().Scene
}

// LoadWebMCPContext marks the support-side WebMCP caller as initialized and
// returns the opaque context version bound to this session. The protocol
// itself is supplied by the application response; this value only authorizes
// subsequent mutation requests to use that response.
func (s *Session) LoadWebMCPContext() string {
	s.mu.Lock()
	s.webMCPContextLoaded = true
	s.webMCPContextLoadedAt = time.Now().UTC()
	version := s.webMCPContextVersion
	s.mu.Unlock()
	return version
}

// ValidateWebMCPContext verifies that a mutation was preceded by a context
// load for this session and that it still presents the exact version returned
// by that load. It deliberately does not expose the expected value on error;
// callers can recover by invoking the read-only context tool again.
func (s *Session) ValidateWebMCPContext(provided string) error {
	s.mu.RLock()
	initialized := s.webMCPContextLoaded
	expected := s.webMCPContextVersion
	s.mu.RUnlock()
	return validateFieldAssistContextVersion(initialized, provided, expected)
}

// GetCaseContext returns a copy of the bounded troubleshooting context so
// callers cannot mutate session workflow state without going through a
// session command.
func (s *Session) GetCaseContext() CaseContext {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneCaseContext(s.caseContext)
}

func (s *Session) GetRoomContext() *RoomContext {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneRoomContext(s.roomContext)
}

func (s *Session) GetOperatorIssue() *OperatorIssue {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneOperatorIssue(s.operatorIssue)
}

func (s *Session) GetActiveQuestion() *OperatorQuestion {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneOperatorQuestion(s.activeQuestion)
}

func (s *Session) GetOperatorInstruction() *OperatorInstruction {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneOperatorInstruction(s.operatorInstruction)
}

func (s *Session) GetConversationMessages() []ConversationMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneConversationMessages(s.messages)
}

// GetCaseTimeline returns a stable copy of the case activity retained by the
// session. Timeline entries are already bounded by appendTimelineLocked.
func (s *Session) GetCaseTimeline() []TimelineItem {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]TimelineItem(nil), s.timeline...)
}

// SuggestNextStep derives the next deterministic action from the current
// relationship-aware scene. It intentionally performs no mutation, making it
// safe for both the support UI and a read-only WebMCP tool.
func (s *Session) SuggestNextStep() NextStepSuggestion {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.caseContext.Status == "resolved" {
		return NextStepSuggestion{
			StepID: "", Title: "Case resolved",
			Rationale: "The support representative marked this session complete.", Status: "complete",
		}
	}
	return suggestNextStep(s.scene, s.operatorIssue, len(s.annotations))
}

// InspectObject returns a copy so callers cannot mutate the session's scene
// graph through a map or slice held by the returned value.
func (s *Session) InspectObject(objectID string) (SceneObject, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, object := range s.scene.Objects {
		if object.ID == objectID {
			return cloneSceneObject(object), nil
		}
	}
	return SceneObject{}, ErrObjectNotFound
}

func (s *Session) TrackingForObject(objectID string) *SceneTrackingTelemetry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.sceneTracking == nil || s.sceneTracking.ObjectID != objectID {
		return nil
	}
	return cloneSceneTracking(s.sceneTracking)
}

// RecordWebRTCDebugSignal stores a bounded, metadata-only transport trace for
// development diagnostics. Callers must sanitize the event before it reaches
// this method; raw signaling payloads are never retained.
func (s *Session) RecordWebRTCDebugSignal(role Role, signal WebRTCSignalDebug) {
	if role != RoleSupport && role != RoleOperator {
		return
	}
	s.mu.Lock()
	state := s.webRTCDebug[role]
	if state.SignalCounts == nil {
		state.SignalCounts = make(map[string]int)
	}
	state.SignalCounts[signal.Type]++
	if signal.ConnectionState != "" {
		state.ConnectionState = signal.ConnectionState
	}
	if signal.ICEState != "" {
		state.ICEState = signal.ICEState
	}
	if signal.CandidateType != "" {
		state.LastCandidate = signal.CandidateType
	}
	if signal.CandidatePair != nil {
		pair := *signal.CandidatePair
		state.CandidatePair = &pair
	}
	signal.At = time.Now().UTC()
	state.UpdatedAt = signal.At
	state.RecentSignals = append(state.RecentSignals, signal)
	if len(state.RecentSignals) > maxDebugSignals {
		state.RecentSignals = append([]WebRTCSignalDebug(nil), state.RecentSignals[len(state.RecentSignals)-maxDebugSignals:]...)
	}
	s.webRTCDebug[role] = state
	s.mu.Unlock()
}

func (s *Session) WebRTCDebug() map[Role]WebRTCRoleDebug {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[Role]WebRTCRoleDebug, len(s.webRTCDebug))
	for role, state := range s.webRTCDebug {
		copyState := state
		copyState.SignalCounts = make(map[string]int, len(state.SignalCounts))
		for eventType, count := range state.SignalCounts {
			copyState.SignalCounts[eventType] = count
		}
		copyState.RecentSignals = append([]WebRTCSignalDebug(nil), state.RecentSignals...)
		if state.CandidatePair != nil {
			pair := *state.CandidatePair
			copyState.CandidatePair = &pair
		}
		result[role] = copyState
	}
	return result
}

// SnapshotByID returns an immutable copy of a previously captured scene.
func (s *Session) SnapshotByID(id string) (SceneSnapshot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	snapshot, ok := s.snapshots[id]
	if !ok {
		return SceneSnapshot{}, ErrSnapshotNotFound
	}
	return cloneSceneSnapshot(snapshot), nil
}

// CalibrateObject records a normalized region for a known object from either
// the support drag UI or Codex vision through WebMCP. The stable object ID and
// active guidance survive while stale tracking telemetry is discarded.
func (s *Session) CalibrateObject(objectID string, bounds Bounds, baseSceneVersion uint64, actor string) (Scene, TimelineItem, error) {
	if err := validateBounds(bounds); err != nil {
		return Scene{}, TimelineItem{}, err
	}

	s.mu.Lock()
	if baseSceneVersion == 0 || baseSceneVersion != s.scene.Version {
		s.mu.Unlock()
		return Scene{}, TimelineItem{}, ErrSceneVersionStale
	}
	var object *SceneObject
	for i := range s.scene.Objects {
		if s.scene.Objects[i].ID == objectID {
			object = &s.scene.Objects[i]
			break
		}
	}
	if object == nil {
		s.mu.Unlock()
		return Scene{}, TimelineItem{}, ErrObjectNotFound
	}

	now := time.Now().UTC()
	calibrationSource := calibrationSourceForActor(actor)
	s.sceneTracking = nil
	s.sceneActivity = nil
	s.activeApproval = nil
	s.annotationReceipts = make(map[string]AnnotationReceipt)
	object.Bounds = bounds
	setSceneAttribute(object, "boundsSource", calibrationSource)
	for id, annotation := range s.annotations {
		if annotation.ObjectID != objectID {
			continue
		}
		annotation.Bounds = bounds
		s.annotations[id] = annotation
	}
	s.scene.Calibration = SceneCalibration{
		Source:          calibrationSource,
		CoordinateSpace: "normalized-video",
		UpdatedAt:       now,
		UpdatedBy:       actor,
	}
	s.scene.Version++
	s.scene.Timestamp = now
	s.caseContext.UpdatedAt = now

	event := s.newEventLocked("scene.updated", nil)
	message := "Calibrated " + object.Label + " region"
	if calibrationSource == "codex-vision" {
		message = "Recalibrated " + object.Label + " region"
	}
	timelineItem := TimelineItem{
		ID:        event.ID,
		Type:      "scene.calibrated",
		Message:   message,
		Actor:     actor,
		CreatedAt: now,
	}
	s.appendTimelineLocked(timelineItem)
	event.Payload = map[string]any{
		"scene":          cloneScene(s.scene),
		"activeApproval": nil,
		"sceneActivity":  nil,
		"timelineItem":   timelineItem,
	}
	scene := cloneScene(s.scene)
	s.mu.Unlock()
	s.broadcast(event)
	return scene, timelineItem, nil
}

func calibrationSourceForActor(actor string) string {
	if actor == "Codex via WebMCP" {
		return "codex-vision"
	}
	return "manual"
}

// AddSceneObject creates a human-observed semantic target in a live session.
// It stores only the label, kind, and normalized geometry; camera pixels stay
// in the browsers. WebMCP can inspect and annotate the new stable object ID.
func (s *Session) AddSceneObject(label, kind string, bounds Bounds, baseSceneVersion uint64, actor string) (SceneObject, Scene, TimelineItem, error) {
	if err := validateBounds(bounds); err != nil {
		return SceneObject{}, Scene{}, TimelineItem{}, err
	}
	idSuffix, err := secureToken(6)
	if err != nil {
		return SceneObject{}, Scene{}, TimelineItem{}, err
	}

	s.mu.Lock()
	if baseSceneVersion == 0 || baseSceneVersion != s.scene.Version {
		s.mu.Unlock()
		return SceneObject{}, Scene{}, TimelineItem{}, ErrSceneVersionStale
	}
	now := time.Now().UTC()
	attributes := map[string]any{
		"boundsSource":       "manual-provisional",
		"localizationStatus": "provisional",
		"observedBy":         actor,
		"trackingRequired":   true,
	}
	if strings.EqualFold(strings.TrimSpace(kind), "device-control") {
		bestArea := math.Inf(1)
		bestPriority := -1
		for _, candidate := range s.scene.Objects {
			if strings.EqualFold(strings.TrimSpace(candidate.Kind), "device-control") || candidate.Bounds.Width <= 0 || candidate.Bounds.Height <= 0 {
				continue
			}
			inside := bounds.X >= candidate.Bounds.X && bounds.Y >= candidate.Bounds.Y &&
				bounds.X+bounds.Width <= candidate.Bounds.X+candidate.Bounds.Width &&
				bounds.Y+bounds.Height <= candidate.Bounds.Y+candidate.Bounds.Height
			area := candidate.Bounds.Width * candidate.Bounds.Height
			priority := 0
			if strings.EqualFold(sceneAttributeString(candidate, "localizationStatus"), "provisional") {
				priority = 1
			}
			if inside && (priority > bestPriority || (priority == bestPriority && area < bestArea)) {
				bestPriority = priority
				bestArea = area
				attributes["trackingReferenceObjectId"] = candidate.ID
			}
		}
	}
	object := SceneObject{
		ID:          "observed-" + idSuffix,
		Label:       label,
		Kind:        kind,
		Description: "Provisional human-observed target awaiting browser spatial tracking.",
		Confidence:  0.55,
		Bounds:      bounds,
		Attributes:  attributes,
	}
	if len(s.scene.Objects) == 0 || s.scene.ID == "unobserved-scene" {
		s.scene.ID = "live-scene-" + s.ID
		s.scene.Label = "Live device scene"
	}
	s.scene.Objects = append(s.scene.Objects, object)
	s.sceneTracking = nil
	s.sceneActivity = nil
	s.activeApproval = nil
	s.annotationReceipts = make(map[string]AnnotationReceipt)
	s.scene.Calibration = SceneCalibration{
		Source:          "manual",
		CoordinateSpace: "normalized-video",
		UpdatedAt:       now,
		UpdatedBy:       actor,
	}
	s.scene.Version++
	s.scene.Timestamp = now
	s.caseContext.CurrentStepID = "guide-operator"
	s.caseContext.UpdatedAt = now
	for index := range s.caseContext.Steps {
		switch s.caseContext.Steps[index].ID {
		case "pair-operator", "observe-device":
			s.caseContext.Steps[index].Status = "complete"
		case "guide-operator":
			s.caseContext.Steps[index].Status = "active"
		}
	}
	event := s.newEventLocked("scene.updated", nil)
	item := TimelineItem{
		ID:        event.ID,
		Type:      "scene.object_added",
		Message:   "Added observed target " + label,
		Actor:     actor,
		CreatedAt: now,
	}
	s.appendTimelineLocked(item)
	event.Payload = map[string]any{
		"scene":          cloneScene(s.scene),
		"activeApproval": nil,
		"sceneActivity":  nil,
		"timelineItem":   item,
	}
	scene := cloneScene(s.scene)
	s.mu.Unlock()
	s.broadcast(event)
	return cloneSceneObject(object), scene, item, nil
}

// validateBounds accepts the normalized video coordinate space used by the
// scene and overlay contracts. Rejecting NaN and infinity is important here:
// comparisons against those values otherwise pass through range checks.
func validateBounds(bounds Bounds) error {
	values := []float64{bounds.X, bounds.Y, bounds.Width, bounds.Height}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return ErrInvalidBounds
		}
	}
	if bounds.X < 0 || bounds.Y < 0 || bounds.Width <= 0 || bounds.Height <= 0 ||
		bounds.X+bounds.Width > 1 || bounds.Y+bounds.Height > 1 {
		return ErrInvalidBounds
	}
	return nil
}

func (s *Session) updateCaseAfterCableMoveLocked(now time.Time) {
	s.caseContext.Status = "verifying"
	s.caseContext.CurrentStepID = "verify-wan-connection"
	s.caseContext.UpdatedAt = now
	for i := range s.caseContext.Steps {
		switch s.caseContext.Steps[i].ID {
		case "move-modem-cable-to-wan":
			s.caseContext.Steps[i].Status = "complete"
		case "verify-wan-connection":
			s.caseContext.Steps[i].Status = "active"
		}
	}
}

func suggestNextStep(scene Scene, issue *OperatorIssue, annotationCount int) NextStepSuggestion {
	if issue == nil {
		return NextStepSuggestion{
			StepID: "wait-for-request", Title: "Wait for the operator request",
			Rationale: "No user-provided problem context is available yet.", Status: "waiting",
		}
	}
	if len(scene.Objects) == 0 {
		return NextStepSuggestion{
			StepID: "inspect-live-view", Title: "Inspect the live view",
			Rationale: "Use the operator's request and observable camera evidence to identify the relevant object.", Status: "recommended",
		}
	}
	if annotationCount == 0 {
		return NextStepSuggestion{
			StepID: "choose-guidance-target", Title: "Choose a verified target",
			Rationale: "Inspect the observed objects and ask for missing context before placing reversible guidance.", Status: "recommended",
		}
	}
	return NextStepSuggestion{
		StepID: "verify-guidance", Title: "Verify the operator can follow the guidance",
		Rationale: "Keep the conversation open and adjust only from user feedback or new visual evidence.", Status: "recommended",
	}
}

func sceneHasRelationship(scene Scene, fromObjectID, toObjectID string) bool {
	for _, relationship := range scene.Relationships {
		if relationship.Type == "connected_to" && relationship.FromObjectID == fromObjectID && relationship.ToObjectID == toObjectID {
			return true
		}
	}
	return false
}

func sceneAttributeValue(scene Scene, objectID, key string) string {
	for _, object := range scene.Objects {
		if object.ID == objectID {
			return sceneAttributeString(object, key)
		}
	}
	return ""
}

func cloneAttributes(attributes map[string]any) map[string]any {
	if len(attributes) == 0 {
		return nil
	}
	clone := make(map[string]any, len(attributes))
	for key, value := range attributes {
		switch typed := value.(type) {
		case map[string]any:
			clone[key] = cloneAttributes(typed)
		case []any:
			items := make([]any, len(typed))
			for i, item := range typed {
				if nested, ok := item.(map[string]any); ok {
					items[i] = cloneAttributes(nested)
				} else {
					items[i] = item
				}
			}
			clone[key] = items
		default:
			clone[key] = value
		}
	}
	return clone
}

func cloneSceneObject(object SceneObject) SceneObject {
	object.Attributes = cloneAttributes(object.Attributes)
	return object
}

func cloneSceneObjects(objects []SceneObject) []SceneObject {
	if objects == nil {
		return nil
	}
	clone := make([]SceneObject, len(objects))
	for i, object := range objects {
		clone[i] = cloneSceneObject(object)
	}
	return clone
}

func cloneSceneRelationships(relationships []SceneRelationship) []SceneRelationship {
	if relationships == nil {
		return nil
	}
	return append([]SceneRelationship(nil), relationships...)
}

func cloneScene(scene Scene) Scene {
	scene.Objects = cloneSceneObjects(scene.Objects)
	scene.Relationships = cloneSceneRelationships(scene.Relationships)
	return scene
}

func cloneSceneSnapshot(snapshot SceneSnapshot) SceneSnapshot {
	snapshot.Scene = cloneScene(snapshot.Scene)
	return snapshot
}

// moveModemConnectionToWAN is the pure state transition behind the
// operator confirmation endpoint. It accepts only the known initial state so
// a stale or malformed command cannot silently overwrite an unrelated scene.
func moveModemConnectionToWAN(scene Scene, now time.Time) (Scene, error) {
	updated := cloneScene(scene)
	lan, wan, modem := -1, -1, -1
	for i := range updated.Objects {
		switch updated.Objects[i].ID {
		case "lan-port":
			lan = i
		case "wan-port":
			wan = i
		case "modem-1":
			modem = i
		}
	}
	if lan < 0 || wan < 0 || modem < 0 {
		return Scene{}, ErrSceneTransition
	}

	lanState := sceneAttributeString(updated.Objects[lan], "connectionState")
	wanState := sceneAttributeString(updated.Objects[wan], "connectionState")
	modemTarget := sceneAttributeString(updated.Objects[modem], "connectedTo")
	if lanState == "empty" && wanState == "occupied" && modemTarget == "wan-port" {
		return Scene{}, ErrCableAlreadyMoved
	}
	if lanState != "occupied" || wanState != "empty" || modemTarget != "lan-port" {
		return Scene{}, ErrSceneTransition
	}

	setSceneAttribute(&updated.Objects[lan], "connectionState", "empty")
	deleteSceneAttribute(&updated.Objects[lan], "connectedDeviceId")
	deleteSceneAttribute(&updated.Objects[lan], "connectedDevice")
	setSceneAttribute(&updated.Objects[wan], "connectionState", "occupied")
	setSceneAttribute(&updated.Objects[wan], "connectedDeviceId", "modem-1")
	deleteSceneAttribute(&updated.Objects[wan], "connectedDevice")
	setSceneAttribute(&updated.Objects[modem], "connectedTo", "wan-port")
	setSceneAttribute(&updated.Objects[modem], "connectionState", "connected")
	for i := range updated.Objects {
		if updated.Objects[i].Kind != "ethernet-cable" {
			continue
		}
		setSceneAttribute(&updated.Objects[i], "toObjectId", "wan-port")
		setSceneAttribute(&updated.Objects[i], "boundsSource", "manual")
	}
	for i := range updated.Relationships {
		if updated.Relationships[i].ID == "modem-cable-connection" ||
			(updated.Relationships[i].Type == "connected_to" && updated.Relationships[i].FromObjectID == "modem-1") {
			updated.Relationships[i].ToObjectID = "wan-port"
			updated.Relationships[i].Source = "manual"
		}
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	updated.Version++
	updated.Timestamp = now.UTC()
	return updated, nil
}

func sceneAttributeString(object SceneObject, key string) string {
	value, ok := object.Attributes[key]
	if !ok {
		return ""
	}
	text, _ := value.(string)
	return text
}

func setSceneAttribute(object *SceneObject, key string, value any) {
	if object.Attributes == nil {
		object.Attributes = make(map[string]any)
	}
	object.Attributes[key] = value
}

func deleteSceneAttribute(object *SceneObject, key string) {
	delete(object.Attributes, key)
}

// CompareScenes compares semantic scene state, ignoring capture timestamps.
// That makes repeated captures of an unchanged scene compare equal while
// still reporting version changes from an actual state transition.
func CompareScenes(before, after Scene) SceneComparison {
	beforeByID := make(map[string]SceneObject, len(before.Objects))
	afterByID := make(map[string]SceneObject, len(after.Objects))
	for _, object := range before.Objects {
		beforeByID[object.ID] = cloneSceneObject(object)
	}
	for _, object := range after.Objects {
		afterByID[object.ID] = cloneSceneObject(object)
	}

	comparison := SceneComparison{
		BeforeVersion:  before.Version,
		AfterVersion:   after.Version,
		VersionChanged: before.Version != after.Version,
	}
	addedIDs := make([]string, 0)
	removedIDs := make([]string, 0)
	for id := range afterByID {
		if _, ok := beforeByID[id]; !ok {
			addedIDs = append(addedIDs, id)
		}
	}
	for id := range beforeByID {
		if _, ok := afterByID[id]; !ok {
			removedIDs = append(removedIDs, id)
		}
	}
	sort.Strings(addedIDs)
	sort.Strings(removedIDs)
	for _, id := range addedIDs {
		comparison.Added = append(comparison.Added, afterByID[id])
	}
	for _, id := range removedIDs {
		comparison.Removed = append(comparison.Removed, beforeByID[id])
	}
	sharedIDs := make([]string, 0)
	for id := range beforeByID {
		if _, ok := afterByID[id]; ok {
			sharedIDs = append(sharedIDs, id)
		}
	}
	sort.Strings(sharedIDs)
	for _, id := range sharedIDs {
		fields := changedSceneObjectFields(beforeByID[id], afterByID[id])
		if len(fields) == 0 {
			continue
		}
		comparison.Changed = append(comparison.Changed, ObjectChange{
			ID:            id,
			Before:        sceneObjectPointer(beforeByID[id]),
			After:         sceneObjectPointer(afterByID[id]),
			ChangedFields: fields,
		})
	}

	beforeRelationships := sceneRelationshipMap(before.Relationships)
	afterRelationships := sceneRelationshipMap(after.Relationships)
	addedRelationshipIDs := make([]string, 0)
	removedRelationshipIDs := make([]string, 0)
	for id := range afterRelationships {
		if _, ok := beforeRelationships[id]; !ok {
			addedRelationshipIDs = append(addedRelationshipIDs, id)
		}
	}
	for id := range beforeRelationships {
		if _, ok := afterRelationships[id]; !ok {
			removedRelationshipIDs = append(removedRelationshipIDs, id)
		}
	}
	sort.Strings(addedRelationshipIDs)
	sort.Strings(removedRelationshipIDs)
	for _, id := range addedRelationshipIDs {
		comparison.AddedRelationships = append(comparison.AddedRelationships, afterRelationships[id])
	}
	for _, id := range removedRelationshipIDs {
		comparison.RemovedRelationships = append(comparison.RemovedRelationships, beforeRelationships[id])
	}
	sharedRelationshipIDs := make([]string, 0)
	for id := range beforeRelationships {
		if _, ok := afterRelationships[id]; ok {
			sharedRelationshipIDs = append(sharedRelationshipIDs, id)
		}
	}
	sort.Strings(sharedRelationshipIDs)
	for _, id := range sharedRelationshipIDs {
		beforeRelationship := beforeRelationships[id]
		afterRelationship := afterRelationships[id]
		fields := changedSceneRelationshipFields(beforeRelationship, afterRelationship)
		if len(fields) == 0 {
			continue
		}
		comparison.ChangedRelationships = append(comparison.ChangedRelationships, RelationshipChange{
			ID:            id,
			Before:        sceneRelationshipPointer(beforeRelationship),
			After:         sceneRelationshipPointer(afterRelationship),
			ChangedFields: fields,
		})
	}
	comparison.CalibrationChanged = sceneCalibrationChanged(before.Calibration, after.Calibration)
	comparison.SceneChanged = comparison.VersionChanged || before.ID != after.ID || before.Label != after.Label || len(comparison.Added) > 0 || len(comparison.Removed) > 0 || len(comparison.Changed) > 0 || len(comparison.AddedRelationships) > 0 || len(comparison.RemovedRelationships) > 0 || len(comparison.ChangedRelationships) > 0 || comparison.CalibrationChanged
	comparison.Same = !comparison.SceneChanged
	comparison.Summary = comparisonSummary(comparison)
	return comparison
}

func sceneRelationshipMap(relationships []SceneRelationship) map[string]SceneRelationship {
	result := make(map[string]SceneRelationship, len(relationships))
	for _, relationship := range relationships {
		key := relationship.ID
		if key == "" {
			key = relationship.Type + ":" + relationship.FromObjectID + ":" + relationship.ToObjectID
		}
		result[key] = relationship
	}
	return result
}

func sceneRelationshipPointer(relationship SceneRelationship) *SceneRelationship {
	clone := relationship
	return &clone
}

func changedSceneRelationshipFields(before, after SceneRelationship) []string {
	fields := make([]string, 0, 5)
	if before.Type != after.Type {
		fields = append(fields, "type")
	}
	if before.FromObjectID != after.FromObjectID {
		fields = append(fields, "fromObjectId")
	}
	if before.ToObjectID != after.ToObjectID {
		fields = append(fields, "toObjectId")
	}
	if before.Confidence != after.Confidence {
		fields = append(fields, "confidence")
	}
	if before.Source != after.Source {
		fields = append(fields, "source")
	}
	return fields
}

func sceneCalibrationChanged(before, after SceneCalibration) bool {
	return before.Source != after.Source || before.CoordinateSpace != after.CoordinateSpace || before.UpdatedBy != after.UpdatedBy
}

func sceneObjectPointer(object SceneObject) *SceneObject {
	clone := cloneSceneObject(object)
	return &clone
}

func changedSceneObjectFields(before, after SceneObject) []string {
	fields := make([]string, 0, 7)
	if before.Label != after.Label {
		fields = append(fields, "label")
	}
	if before.Kind != after.Kind {
		fields = append(fields, "kind")
	}
	if before.Description != after.Description {
		fields = append(fields, "description")
	}
	if before.Confidence != after.Confidence {
		fields = append(fields, "confidence")
	}
	if before.Bounds != after.Bounds {
		fields = append(fields, "bounds")
	}
	if before.ParentID != after.ParentID {
		fields = append(fields, "parentId")
	}
	if !reflect.DeepEqual(before.Attributes, after.Attributes) && !(len(before.Attributes) == 0 && len(after.Attributes) == 0) {
		fields = append(fields, "attributes")
	}
	return fields
}

func CompareSnapshots(before, after SceneSnapshot) SceneComparison {
	comparison := CompareScenes(before.Scene, after.Scene)
	comparison.BeforeSnapshotID = before.ID
	comparison.AfterSnapshotID = after.ID
	return comparison
}

func comparisonSummary(comparison SceneComparison) string {
	parts := make([]string, 0, 6)
	if len(comparison.Added) > 0 {
		parts = append(parts, fmt.Sprintf("%d object(s) added", len(comparison.Added)))
	}
	if len(comparison.Removed) > 0 {
		parts = append(parts, fmt.Sprintf("%d object(s) removed", len(comparison.Removed)))
	}
	if len(comparison.Changed) > 0 {
		parts = append(parts, fmt.Sprintf("%d object(s) changed", len(comparison.Changed)))
	}
	relationshipChanges := len(comparison.AddedRelationships) + len(comparison.RemovedRelationships) + len(comparison.ChangedRelationships)
	if relationshipChanges > 0 {
		parts = append(parts, fmt.Sprintf("%d relationship(s) changed", relationshipChanges))
	}
	if comparison.CalibrationChanged {
		parts = append(parts, "scene calibration changed")
	}
	if comparison.VersionChanged && len(parts) == 0 {
		parts = append(parts, fmt.Sprintf("scene version changed from %d to %d", comparison.BeforeVersion, comparison.AfterVersion))
	}
	if len(parts) == 0 {
		return "No scene changes detected"
	}
	return strings.Join(parts, "; ")
}

func (s *Session) Connect(role Role, conn *stream.WebSocketConn) {
	s.hubs[role].Register(conn)
	s.mu.Lock()
	s.participants[role]++
	event := s.newEventLocked("participant.joined", map[string]any{
		"role":  role,
		"count": s.participants[role],
	})
	s.appendTimelineLocked(TimelineItem{
		ID: event.ID, Type: event.Type, Actor: string(role), CreatedAt: time.Now().UTC(),
		Message: fmt.Sprintf("%s joined the session", role),
	})
	s.mu.Unlock()
	s.broadcast(event)
}

func (s *Session) Disconnect(role Role, conn *stream.WebSocketConn) {
	s.hubs[role].Unregister(conn)
	s.mu.Lock()
	if s.participants[role] > 0 {
		s.participants[role]--
	}
	event := s.newEventLocked("participant.left", map[string]any{
		"role":  role,
		"count": s.participants[role],
	})
	s.mu.Unlock()
	s.broadcast(event)
}

func (s *Session) SnapshotEvent(role Role) Event {
	full := s.Snapshot()
	return Event{
		ID:        "snapshot-" + s.ID,
		Type:      "session.snapshot",
		SessionID: s.ID,
		Sequence:  full.Sequence,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:   snapshotForRole(full, role),
	}
}

func (s *Session) Relay(eventType string, from Role, data json.RawMessage) Event {
	s.mu.Lock()
	event := s.newEventLocked(eventType, map[string]any{
		"fromRole": from,
		"data":     data,
	})
	s.mu.Unlock()
	s.broadcast(event)
	return event
}

func (s *Session) HighlightObject(objectID, actor string) (Annotation, error) {
	return s.createObjectAnnotation(objectID, "CONNECT HERE", AnnotationKindHighlight, "highlight", actor, "Highlighted ")
}

// AnnotateObject places caller-provided, human-readable guidance on an
// object. The handler validates the text; keeping the state operation here
// means human controls and WebMCP use the same command path.
func (s *Session) AnnotateObject(objectID, text, actor string) (Annotation, error) {
	return s.createObjectAnnotation(objectID, text, AnnotationKindLabel, "annotation", actor, "Annotated ")
}

// RequestCloseup is an assist-class action: it creates a visible instruction
// at the selected object while leaving the operator in control of the camera.
func (s *Session) RequestCloseup(objectID, actor string) (Annotation, error) {
	return s.createObjectAnnotation(objectID, "MOVE CAMERA CLOSER", AnnotationKindCloseup, "closeup", actor, "Requested a closer view of ")
}

func (s *Session) createAnnotation(objectID, label, intent, actor, timelinePrefix string) (Annotation, error) {
	return s.createObjectAnnotation(objectID, label, AnnotationKind(intent), intent, actor, timelinePrefix)
}

// DrawArrow creates object-anchored directional guidance. The bounds are
// copied from the target object so the browser can render the arrow in the
// same normalized coordinate space as a highlight.
func (s *Session) DrawArrow(objectID, text, actor string, anchorInput ...ObjectAnchor) (Annotation, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		text = "LOOK HERE"
	}
	var anchor *ObjectAnchor
	if len(anchorInput) > 0 {
		value := anchorInput[0]
		if !validObjectAnchor(value) {
			return Annotation{}, ErrInvalidBounds
		}
		anchor = &value
	}
	return s.createAnnotationAtBounds(objectID, text, Bounds{}, AnnotationKindArrow, "arrow", "", anchor, actor, "Drew an arrow to ")
}

// ShowRegion creates a freeform normalized region annotation that does not
// need to correspond to a known scene object.
func (s *Session) ShowRegion(bounds Bounds, text, actor string) (Annotation, error) {
	if err := validateBounds(bounds); err != nil {
		return Annotation{}, err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		text = "FOCUS REGION"
	}
	return s.createAnnotationAtBounds("", text, bounds, AnnotationKindRegion, "region", "", nil, actor, "Marked a focus region")
}

// RequestMove creates a visible, reversible direction request for the
// operator. It uses a broad normalized region because the instruction is about
// camera movement rather than a single detected object.
func (s *Session) RequestMove(direction MoveDirection, actor string) (Annotation, error) {
	if !validMoveDirection(direction) {
		return Annotation{}, ErrInvalidMoveDirection
	}
	label := "MOVE " + strings.ToUpper(string(direction))
	bounds := Bounds{X: 0.05, Y: 0.10, Width: 0.90, Height: 0.80}
	return s.createAnnotationAtBounds("", label, bounds, AnnotationKindMove, "move", direction, nil, actor, "Requested operator move "+string(direction))
}

// RequestOperatorView asks for one semantically useful camera composition.
// It remains reversible visual guidance: the browser never takes control of
// the operator's camera. The target is bounded text derived from the current
// user conversation and observed scene rather than a device-specific enum.
func (s *Session) RequestOperatorView(target, actor string) (Annotation, error) {
	target = strings.Join(strings.Fields(target), " ")
	if target == "" || len(target) > 80 || strings.ContainsRune(target, '\x00') {
		return Annotation{}, ErrInvalidOperatorView
	}
	label := "SHOW " + strings.ToUpper(strings.ReplaceAll(target, "-", " "))
	bounds := Bounds{X: 0.05, Y: 0.10, Width: 0.90, Height: 0.80}
	return s.createAnnotationAtBounds("", label, bounds, AnnotationKindView, "operator-view", "", nil, actor, "Requested operator view "+target)
}

// RequestDifferentAngle asks the operator for a different view while keeping
// the target object identity available to the browser and agent.
func (s *Session) RequestDifferentAngle(objectID, actor string) (Annotation, error) {
	return s.createObjectAnnotation(objectID, "TURN DEVICE FOR A BETTER VIEW", AnnotationKindAngle, "different-angle", actor, "Requested a different angle for ")
}

func validMoveDirection(direction MoveDirection) bool {
	switch direction {
	case MoveDirectionUp, MoveDirectionDown, MoveDirectionLeft, MoveDirectionRight, MoveDirectionCloser, MoveDirectionFarther:
		return true
	default:
		return false
	}
}

func (s *Session) createObjectAnnotation(objectID, label string, kind AnnotationKind, intent, actor, timelinePrefix string) (Annotation, error) {
	return s.createAnnotationAtBounds(objectID, label, Bounds{}, kind, intent, "", nil, actor, timelinePrefix)
}

func anchorInsideObject(anchor *ObjectAnchor) bool {
	return anchor == nil || (anchor.X >= 0 && anchor.X <= 1 && anchor.Y >= 0 && anchor.Y <= 1)
}

func (s *Session) createAnnotationAtBounds(objectID, label string, bounds Bounds, kind AnnotationKind, intent string, direction MoveDirection, anchor *ObjectAnchor, actor, timelineMessage string) (Annotation, error) {
	s.mu.Lock()

	var object *SceneObject
	if objectID != "" {
		for i := range s.scene.Objects {
			if s.scene.Objects[i].ID == objectID {
				object = &s.scene.Objects[i]
				break
			}
		}
		if object == nil {
			s.mu.Unlock()
			return Annotation{}, ErrObjectNotFound
		}
		if kind == AnnotationKindArrow && !anchorInsideObject(anchor) {
			s.mu.Unlock()
			return Annotation{}, ErrInvalidBounds
		}
	}
	if objectID == "" {
		if err := validateBounds(bounds); err != nil {
			s.mu.Unlock()
			return Annotation{}, err
		}
	} else {
		bounds = object.Bounds
	}

	id, err := secureToken(9)
	if err != nil {
		s.mu.Unlock()
		return Annotation{}, err
	}
	annotation := Annotation{
		ID:        id,
		ObjectID:  objectID,
		Kind:      kind,
		Label:     label,
		Bounds:    bounds,
		Direction: direction,
		Actor:     actor,
		Intent:    intent,
		Anchor:    cloneObjectAnchor(anchor),
		CreatedAt: time.Now().UTC(),
	}
	if objectID == "" {
		annotation.ObjectID = ""
	}
	replacedAnnotationIDs := make([]string, 0)
	if kind == AnnotationKindArrow {
		for candidateID, candidate := range s.annotations {
			switch candidate.Kind {
			case AnnotationKindCloseup, AnnotationKindAngle, AnnotationKindMove, AnnotationKindView, AnnotationKindRegion:
				replacedAnnotationIDs = append(replacedAnnotationIDs, candidateID)
				delete(s.annotations, candidateID)
				delete(s.annotationReceipts, candidateID)
				if s.sceneTracking != nil && s.sceneTracking.GuidanceID == candidateID {
					s.sceneTracking = nil
				}
			}
		}
		sort.Strings(replacedAnnotationIDs)
	}
	s.annotations[annotation.ID] = annotation
	if len(s.annotations) > maxActiveAnnotations {
		oldestID := ""
		var oldestTime time.Time
		for candidateID, candidate := range s.annotations {
			if candidateID == annotation.ID {
				continue
			}
			if oldestID == "" || candidate.CreatedAt.Before(oldestTime) {
				oldestID = candidateID
				oldestTime = candidate.CreatedAt
			}
		}
		delete(s.annotations, oldestID)
		delete(s.annotationReceipts, oldestID)
		if s.sceneTracking != nil && s.sceneTracking.GuidanceID == oldestID {
			s.sceneTracking = nil
		}
	}
	event := s.newEventLocked("annotation.created", nil)
	message := timelineMessage
	if object != nil {
		message += object.Label
	}
	timelineItem := TimelineItem{
		ID: event.ID, Type: event.Type, Message: message,
		Actor: actor, CreatedAt: annotation.CreatedAt,
	}
	s.appendTimelineLocked(timelineItem)
	event.Payload = map[string]any{
		"annotation":            cloneAnnotation(annotation),
		"replacedAnnotationIds": replacedAnnotationIDs,
		"timelineItem":          timelineItem,
	}
	s.mu.Unlock()
	s.broadcast(event)
	return cloneAnnotation(annotation), nil
}

// ClearAnnotation removes one visible annotation and records the removal as a
// reversible assist action. The removed value is returned for an event client
// or audit log that needs to identify exactly what disappeared.
func (s *Session) ClearAnnotation(annotationID, actor string) (Annotation, error) {
	annotationID = strings.TrimSpace(annotationID)
	s.mu.Lock()
	annotation, ok := s.annotations[annotationID]
	if !ok {
		s.mu.Unlock()
		return Annotation{}, ErrAnnotationNotFound
	}
	delete(s.annotations, annotationID)
	delete(s.annotationReceipts, annotationID)
	if s.sceneTracking != nil && s.sceneTracking.GuidanceID == annotationID {
		s.sceneTracking = nil
	}
	event := s.newEventLocked("annotation.removed", nil)
	timelineItem := TimelineItem{
		ID:        event.ID,
		Type:      event.Type,
		Message:   "Cleared annotation " + annotation.Label,
		Actor:     actor,
		CreatedAt: time.Now().UTC(),
	}
	s.appendTimelineLocked(timelineItem)
	event.Payload = map[string]any{
		"id":           annotation.ID,
		"annotation":   cloneAnnotation(annotation),
		"actor":        actor,
		"timelineItem": timelineItem,
	}
	s.mu.Unlock()
	s.broadcast(event)
	return cloneAnnotation(annotation), nil
}

// CaptureSnapshot stores a structured copy of the current scene and emits a
// snapshot.created event. Labels are kept as supplied after handler-level
// trimming so agents can refer to "before-cable-move" and
// "after-cable-move" without any image storage or opaque server state.
func (s *Session) CaptureSnapshot(label, actor string) (SceneSnapshot, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		label = "scene snapshot"
	}
	s.mu.Lock()
	id, err := secureToken(9)
	if err != nil {
		s.mu.Unlock()
		return SceneSnapshot{}, err
	}
	now := time.Now().UTC()
	snapshot := SceneSnapshot{
		ID:         id,
		Label:      label,
		CapturedAt: now,
		Scene:      cloneScene(s.scene),
	}
	if s.snapshots == nil {
		s.snapshots = make(map[string]SceneSnapshot)
	}
	s.storeSnapshotLocked(snapshot)
	event := s.newEventLocked("snapshot.created", nil)
	timelineItem := TimelineItem{
		ID: event.ID, Type: event.Type, Message: "Captured " + label,
		Actor: actor, CreatedAt: now,
	}
	s.appendTimelineLocked(timelineItem)
	event.Payload = map[string]any{"snapshot": cloneSceneSnapshot(snapshot), "actor": actor, "timelineItem": timelineItem}
	s.mu.Unlock()
	s.broadcast(event)
	return cloneSceneSnapshot(snapshot), nil
}

// ApproveCableMove records support-role approval for one active WAN guidance
// item. Approval is deliberately not exposed as a WebMCP tool.
func (s *Session) ApproveCableMove(guidanceID, actor string) (ActionApproval, error) {
	s.mu.Lock()
	guidance, ok := s.annotations[guidanceID]
	if !ok || guidance.ObjectID != "wan-port" {
		s.mu.Unlock()
		return ActionApproval{}, ErrGuidanceNotFound
	}
	if guidance.Kind != AnnotationKindHighlight && guidance.Kind != AnnotationKindArrow && guidance.Kind != AnnotationKindLabel {
		s.mu.Unlock()
		return ActionApproval{}, ErrGuidanceNotFound
	}
	if sceneHasRelationship(s.scene, "modem-1", "wan-port") {
		s.mu.Unlock()
		return ActionApproval{}, ErrCableAlreadyMoved
	}
	id, err := secureToken(12)
	if err != nil {
		s.mu.Unlock()
		return ActionApproval{}, err
	}
	now := time.Now().UTC()
	approval := ActionApproval{
		ID: id, Action: "move_cable_to_wan", TargetObjectID: "wan-port",
		GuidanceID: guidance.ID, SceneVersion: s.scene.Version, Status: "approved",
		ApprovedBy: actor, ApprovedAt: now, ExpiresAt: now.Add(10 * time.Minute),
	}
	s.activeApproval = &approval
	s.sceneActivity = nil
	s.sceneTracking = nil
	s.caseContext.UpdatedAt = now
	event := s.newEventLocked("action.approved", nil)
	timelineItem := TimelineItem{
		ID: event.ID, Type: event.Type,
		Message: "Support representative approved moving the modem cable to the WAN port",
		Actor:   actor, CreatedAt: now,
	}
	s.appendTimelineLocked(timelineItem)
	event.Payload = map[string]any{"approval": approval, "timelineItem": timelineItem}
	s.mu.Unlock()
	s.broadcast(event)
	return approval, nil
}

func validSceneTrackingStatus(status SceneTrackingStatus) bool {
	switch status {
	case SceneTrackingCalibratedFallback, SceneTrackingLocked, SceneTrackingFollowingDrift, SceneTrackingRecalibrationRequired, SceneTrackingReacquireRequired:
		return true
	default:
		return false
	}
}

func validSceneTrackingSource(source string) bool {
	switch source {
	case "browser-multiscale-template", "opencv-homography", "opencv-homography+depth-anything", "opencv-pnp+depth-anything":
		return true
	default:
		return false
	}
}

func validPoseState(state string) bool {
	switch state {
	case "unavailable", "degraded", "active":
		return true
	default:
		return false
	}
}

func isOpenCVTrackingSource(source string) bool {
	return source == "opencv-homography" || source == "opencv-homography+depth-anything" || source == "opencv-pnp+depth-anything"
}

func isDepthBackedTrackingSource(source string) bool {
	return source == "opencv-homography+depth-anything" || source == "opencv-pnp+depth-anything"
}

func validDepthSource(source string) bool {
	return source == "depth-anything-v2-small-q4f16" || source == "depth-anything-v2-small-int8"
}

func trackingBoundsWithinAnchor(anchor, tracked Bounds) bool {
	const tolerance = 0.001
	const maxDrift = 0.16
	if anchor.Width <= 0 || anchor.Height <= 0 || tracked.Width <= 0 || tracked.Height <= 0 {
		return false
	}
	widthScale := tracked.Width / anchor.Width
	heightScale := tracked.Height / anchor.Height
	if widthScale < 0.65 || widthScale > 1.55 || heightScale < 0.65 || heightScale > 1.55 || math.Abs(widthScale-heightScale) > 0.16 {
		return false
	}
	anchorCenterX := anchor.X + anchor.Width/2
	anchorCenterY := anchor.Y + anchor.Height/2
	trackedCenterX := tracked.X + tracked.Width/2
	trackedCenterY := tracked.Y + tracked.Height/2
	return math.Abs(anchorCenterX-trackedCenterX) <= maxDrift+tolerance &&
		math.Abs(anchorCenterY-trackedCenterY) <= maxDrift+tolerance
}

func trackingBoundsWithinWorldAnchor(anchor, tracked Bounds) bool {
	if anchor.Width <= 0 || anchor.Height <= 0 || tracked.Width <= 0 || tracked.Height <= 0 {
		return false
	}
	widthScale := tracked.Width / anchor.Width
	heightScale := tracked.Height / anchor.Height
	anchorCenterX := anchor.X + anchor.Width/2
	anchorCenterY := anchor.Y + anchor.Height/2
	trackedCenterX := tracked.X + tracked.Width/2
	trackedCenterY := tracked.Y + tracked.Height/2
	return widthScale >= 0.3 && widthScale <= 3 && heightScale >= 0.3 && heightScale <= 3 &&
		math.Abs(widthScale-heightScale) <= 0.4 &&
		math.Abs(trackedCenterX-anchorCenterX) <= 0.65 && math.Abs(trackedCenterY-anchorCenterY) <= 0.65
}

func finitePoint(point Point) bool {
	return !math.IsNaN(point.X) && !math.IsInf(point.X, 0) && !math.IsNaN(point.Y) && !math.IsInf(point.Y, 0)
}

func validObjectAnchor(anchor ObjectAnchor) bool {
	return finitePoint(Point(anchor)) && anchor.X >= -0.5 && anchor.X <= 1.5 && anchor.Y >= -0.5 && anchor.Y <= 1.5
}

func trackingPolygonArea(points []Point) float64 {
	if len(points) < 3 {
		return 0
	}
	area := 0.0
	for index := range points {
		current := points[index]
		next := points[(index+1)%len(points)]
		area += current.X*next.Y - next.X*current.Y
	}
	return math.Abs(area) / 2
}

func clipTrackingPolygon(points []Point, axis byte, boundary float64, keepGreater bool) []Point {
	clipped := make([]Point, 0, len(points)+2)
	if len(points) == 0 {
		return clipped
	}
	coordinate := func(point Point) float64 {
		if axis == 'x' {
			return point.X
		}
		return point.Y
	}
	for index, current := range points {
		previous := points[(index+len(points)-1)%len(points)]
		currentValue := coordinate(current)
		previousValue := coordinate(previous)
		currentInside := currentValue >= boundary
		previousInside := previousValue >= boundary
		if !keepGreater {
			currentInside = currentValue <= boundary
			previousInside = previousValue <= boundary
		}
		if currentInside != previousInside {
			denominator := currentValue - previousValue
			if math.Abs(denominator) > 0.0000001 {
				ratio := (boundary - previousValue) / denominator
				intersection := Point{
					X: previous.X + (current.X-previous.X)*ratio,
					Y: previous.Y + (current.Y-previous.Y)*ratio,
				}
				if axis == 'x' {
					intersection.X = boundary
				} else {
					intersection.Y = boundary
				}
				clipped = append(clipped, intersection)
			}
		}
		if currentInside {
			clipped = append(clipped, current)
		}
	}
	return clipped
}

func clippedTrackingQuad(quad *TrackingQuad) []Point {
	if quad == nil {
		return nil
	}
	points := append([]Point(nil), quad[:]...)
	points = clipTrackingPolygon(points, 'x', 0, true)
	points = clipTrackingPolygon(points, 'x', 1, false)
	points = clipTrackingPolygon(points, 'y', 0, true)
	return clipTrackingPolygon(points, 'y', 1, false)
}

func trackingGeometryVisibility(quad *TrackingQuad, anchor *Point, partialVisibility bool) (float64, bool) {
	if quad != nil {
		for _, point := range quad {
			minimum, maximum := 0.0, 1.0
			if partialVisibility {
				minimum, maximum = -1, 2
			}
			if !finitePoint(point) || point.X < minimum || point.X > maximum || point.Y < minimum || point.Y > maximum {
				return 0, false
			}
		}
		crossSign := 0
		for index := range quad {
			a := quad[index]
			b := quad[(index+1)%len(quad)]
			c := quad[(index+2)%len(quad)]
			cross := (b.X-a.X)*(c.Y-b.Y) - (b.Y-a.Y)*(c.X-b.X)
			if math.Abs(cross) < 0.000001 {
				return 0, false
			}
			currentSign := 1
			if cross < 0 {
				currentSign = -1
			}
			if crossSign != 0 && currentSign != crossSign {
				return 0, false
			}
			crossSign = currentSign
		}
		fullArea := trackingPolygonArea(quad[:])
		visibleArea := trackingPolygonArea(clippedTrackingQuad(quad))
		if fullArea <= 0 {
			return 0, false
		}
		visibleFraction := math.Max(0, math.Min(1, visibleArea/fullArea))
		if partialVisibility && (visibleFraction < 0.2 || visibleArea < 0.006) {
			return visibleFraction, false
		}
		if !partialVisibility && visibleFraction < 0.999999 {
			return visibleFraction, false
		}
		if anchor != nil && (!finitePoint(*anchor) || anchor.X < 0 || anchor.X > 1 || anchor.Y < 0 || anchor.Y > 1) {
			return visibleFraction, false
		}
		return visibleFraction, true
	}
	if partialVisibility {
		return 0, false
	}
	return 1, anchor == nil || (finitePoint(*anchor) && anchor.X >= 0 && anchor.X <= 1 && anchor.Y >= 0 && anchor.Y <= 1)
}

func trackingQuadBounds(quad *TrackingQuad) (Bounds, bool) {
	if quad == nil {
		return Bounds{}, false
	}
	minimumX, minimumY := math.Inf(1), math.Inf(1)
	maximumX, maximumY := math.Inf(-1), math.Inf(-1)
	for _, point := range quad {
		minimumX = math.Min(minimumX, point.X)
		minimumY = math.Min(minimumY, point.Y)
		maximumX = math.Max(maximumX, point.X)
		maximumY = math.Max(maximumY, point.Y)
	}
	bounds := Bounds{X: minimumX, Y: minimumY, Width: maximumX - minimumX, Height: maximumY - minimumY}
	return bounds, bounds.Width > 0 && bounds.Height > 0
}

func trackingBoundsWithinPartialAnchor(anchor, tracked Bounds) bool {
	if anchor.Width <= 0 || anchor.Height <= 0 || tracked.Width <= 0 || tracked.Height <= 0 {
		return false
	}
	widthScale := tracked.Width / anchor.Width
	heightScale := tracked.Height / anchor.Height
	anchorCenterX := anchor.X + anchor.Width/2
	anchorCenterY := anchor.Y + anchor.Height/2
	trackedCenterX := tracked.X + tracked.Width/2
	trackedCenterY := tracked.Y + tracked.Height/2
	return widthScale >= 0.65 && widthScale <= 1.55 && heightScale >= 0.65 && heightScale <= 1.55 &&
		math.Abs(widthScale-heightScale) <= 0.16 &&
		math.Abs(trackedCenterX-anchorCenterX) <= 0.55 && math.Abs(trackedCenterY-anchorCenterY) <= 0.55
}

func trackingFloatClose(left, right, tolerance float64) bool {
	return math.Abs(left-right) <= tolerance
}

func trackingBoundsClose(left, right Bounds) bool {
	return trackingFloatClose(left.X, right.X, 0.0025) &&
		trackingFloatClose(left.Y, right.Y, 0.0025) &&
		trackingFloatClose(left.Width, right.Width, 0.0025) &&
		trackingFloatClose(left.Height, right.Height, 0.0025)
}

func trackingPointClose(left, right *Point) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return trackingFloatClose(left.X, right.X, 0.003) && trackingFloatClose(left.Y, right.Y, 0.003)
}

func trackingQuadClose(left, right *TrackingQuad) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	for index := range left {
		if !trackingFloatClose(left[index].X, right[index].X, 0.003) || !trackingFloatClose(left[index].Y, right[index].Y, 0.003) {
			return false
		}
	}
	return true
}

func cloneQuad(quad *TrackingQuad) *TrackingQuad {
	if quad == nil {
		return nil
	}
	clone := *quad
	return &clone
}

func clonePoint(point *Point) *Point {
	if point == nil {
		return nil
	}
	clone := *point
	return &clone
}

// RecordSceneTracking replaces the latest shared overlay tracking telemetry.
// It does not update SceneObject.Bounds, scene version, the case timeline, or
// any approval state. Repeated updates are transition-throttled so a browser
// cannot turn a tiny local sampling loop into an unbounded event stream.
func (s *Session) RecordSceneTracking(approvalID, guidanceID, objectID string, baseSceneVersion uint64, status SceneTrackingStatus, confidence float64, bounds Bounds, evidenceInput ...SceneTrackingEvidence) (SceneTrackingTelemetry, bool, error) {
	if !validSceneTrackingStatus(status) || math.IsNaN(confidence) || math.IsInf(confidence, 0) || confidence < 0 || confidence > 1 || validateBounds(bounds) != nil {
		return SceneTrackingTelemetry{}, false, ErrInvalidTracking
	}
	evidence := SceneTrackingEvidence{Source: "browser-multiscale-template"}
	if len(evidenceInput) > 0 {
		evidence = evidenceInput[0]
		if strings.TrimSpace(evidence.Source) == "" {
			evidence.Source = "browser-multiscale-template"
		}
	}
	evidence.PoseState = strings.TrimSpace(evidence.PoseState)
	if evidence.PoseState == "" {
		evidence.PoseState = "unavailable"
	}
	evidence.PoseFailureReason = strings.TrimSpace(evidence.PoseFailureReason)
	computedVisibleFraction, geometryValid := trackingGeometryVisibility(evidence.Quad, evidence.Anchor, evidence.PartialVisibility)
	if evidence.PartialVisibility {
		if math.IsNaN(evidence.VisibleFraction) || math.IsInf(evidence.VisibleFraction, 0) ||
			evidence.VisibleFraction < 0 || evidence.VisibleFraction > 1 || math.Abs(evidence.VisibleFraction-computedVisibleFraction) > 0.02 {
			return SceneTrackingTelemetry{}, false, ErrInvalidTracking
		}
		evidence.VisibleFraction = computedVisibleFraction
	} else {
		evidence.VisibleFraction = 1
	}
	if !evidence.PartialVisibility || evidence.Anchor != nil {
		evidence.AnchorVisible = true
	}
	if !validSceneTrackingSource(evidence.Source) ||
		!validPoseState(evidence.PoseState) || len(evidence.PoseFailureReason) > 96 || strings.ContainsAny(evidence.PoseFailureReason, "\r\n") ||
		evidence.PoseInliers < 0 || math.IsNaN(evidence.PoseInlierRatio) || math.IsInf(evidence.PoseInlierRatio, 0) || evidence.PoseInlierRatio < 0 || evidence.PoseInlierRatio > 1 ||
		!geometryValid || (evidence.PartialVisibility && evidence.AnchorVisible && evidence.Anchor == nil) ||
		math.IsNaN(evidence.DepthScore) || math.IsInf(evidence.DepthScore, 0) || evidence.DepthScore < 0 || evidence.DepthScore > 1 ||
		math.IsNaN(evidence.DepthConfidence) || math.IsInf(evidence.DepthConfidence, 0) || evidence.DepthConfidence < 0 || evidence.DepthConfidence > 1 ||
		math.IsNaN(evidence.ModelRelativeDepth) || math.IsInf(evidence.ModelRelativeDepth, 0) || evidence.ModelRelativeDepth < 0 || evidence.ModelRelativeDepth > 4 {
		return SceneTrackingTelemetry{}, false, ErrInvalidTracking
	}
	if (status == SceneTrackingCalibratedFallback || status == SceneTrackingRecalibrationRequired || status == SceneTrackingReacquireRequired) &&
		(evidence.Quad != nil || evidence.Anchor != nil) {
		return SceneTrackingTelemetry{}, false, ErrInvalidTracking
	}
	if (status == SceneTrackingLocked || status == SceneTrackingFollowingDrift) && isOpenCVTrackingSource(evidence.Source) && evidence.Quad == nil {
		return SceneTrackingTelemetry{}, false, ErrInvalidTracking
	}
	if isDepthBackedTrackingSource(evidence.Source) {
		if !validDepthSource(evidence.DepthSource) || evidence.DepthConfidence <= 0 || evidence.ModelRelativeDepth < 0.25 {
			return SceneTrackingTelemetry{}, false, ErrInvalidTracking
		}
	} else if evidence.DepthSource != "" || evidence.DepthScore != 0 || evidence.DepthConfidence != 0 || evidence.ModelRelativeDepth != 0 {
		return SceneTrackingTelemetry{}, false, ErrInvalidTracking
	}
	now := time.Now().UTC()
	s.mu.Lock()
	boundGuidanceID := strings.TrimSpace(guidanceID)
	if approvalID != "" {
		if s.activeApproval == nil || s.activeApproval.ID != approvalID || objectID != s.activeApproval.TargetObjectID {
			s.mu.Unlock()
			return SceneTrackingTelemetry{}, false, ErrApprovalRequired
		}
		if s.activeApproval.Status == "consumed" {
			s.mu.Unlock()
			return SceneTrackingTelemetry{}, false, ErrApprovalConsumed
		}
		if now.After(s.activeApproval.ExpiresAt) || s.activeApproval.SceneVersion != s.scene.Version {
			s.mu.Unlock()
			return SceneTrackingTelemetry{}, false, ErrApprovalStale
		}
		if boundGuidanceID != "" && boundGuidanceID != s.activeApproval.GuidanceID {
			s.mu.Unlock()
			return SceneTrackingTelemetry{}, false, ErrApprovalRequired
		}
		boundGuidanceID = s.activeApproval.GuidanceID
	} else {
		guidance, ok := s.annotations[boundGuidanceID]
		if !ok || guidance.ObjectID == "" || guidance.ObjectID != objectID {
			s.mu.Unlock()
			return SceneTrackingTelemetry{}, false, ErrApprovalRequired
		}
	}
	if baseSceneVersion != s.scene.Version {
		s.mu.Unlock()
		return SceneTrackingTelemetry{}, false, ErrSceneVersionStale
	}
	var anchor *SceneObject
	for i := range s.scene.Objects {
		if s.scene.Objects[i].ID == objectID {
			anchor = &s.scene.Objects[i]
			break
		}
	}
	referenceObjectID := strings.TrimSpace(evidence.ReferenceObjectID)
	validationAnchor := anchor
	expectedReferenceObjectID := ""
	if anchor != nil {
		expectedReferenceObjectID = sceneAttributeString(*anchor, "trackingReferenceObjectId")
	}
	if expectedReferenceObjectID != "" && referenceObjectID != expectedReferenceObjectID {
		s.mu.Unlock()
		return SceneTrackingTelemetry{}, false, ErrInvalidTracking
	}
	if referenceObjectID != "" {
		if anchor == nil || !strings.EqualFold(strings.TrimSpace(anchor.Kind), "device-control") ||
			sceneAttributeString(*anchor, "trackingReferenceObjectId") != referenceObjectID {
			s.mu.Unlock()
			return SceneTrackingTelemetry{}, false, ErrInvalidTracking
		}
		validationAnchor = nil
		for i := range s.scene.Objects {
			if s.scene.Objects[i].ID == referenceObjectID {
				validationAnchor = &s.scene.Objects[i]
				break
			}
		}
	}
	measurementBounds := bounds
	if evidence.PartialVisibility {
		if rawBounds, ok := trackingQuadBounds(evidence.Quad); ok {
			measurementBounds = rawBounds
		}
	}
	withinAnchor := validationAnchor != nil && trackingBoundsWithinAnchor(validationAnchor.Bounds, measurementBounds)
	if validationAnchor != nil && evidence.PartialVisibility {
		withinAnchor = trackingBoundsWithinPartialAnchor(validationAnchor.Bounds, measurementBounds)
	}
	if validationAnchor != nil && evidence.Source == "opencv-pnp+depth-anything" {
		withinAnchor = trackingBoundsWithinWorldAnchor(validationAnchor.Bounds, measurementBounds)
	}
	if validationAnchor == nil || !withinAnchor {
		s.mu.Unlock()
		return SceneTrackingTelemetry{}, false, ErrInvalidTracking
	}
	if status == SceneTrackingCalibratedFallback && (confidence != 0 || !reflect.DeepEqual(validationAnchor.Bounds, bounds)) {
		s.mu.Unlock()
		return SceneTrackingTelemetry{}, false, ErrInvalidTracking
	}
	if status == SceneTrackingReacquireRequired && confidence != 0 {
		s.mu.Unlock()
		return SceneTrackingTelemetry{}, false, ErrInvalidTracking
	}
	if status == SceneTrackingRecalibrationRequired && (confidence <= 0 || confidence >= 0.72) {
		s.mu.Unlock()
		return SceneTrackingTelemetry{}, false, ErrInvalidTracking
	}
	if previous := s.sceneTracking; previous != nil && previous.ApprovalID == approvalID && previous.GuidanceID == boundGuidanceID {
		sameEngine := previous.Source == evidence.Source && previous.DepthSource == evidence.DepthSource &&
			previous.ReferenceObjectID == referenceObjectID &&
			previous.PoseState == evidence.PoseState && previous.PoseFailureReason == evidence.PoseFailureReason
		unchanged := previous.Status == status && math.Abs(previous.Confidence-confidence) < 0.01 && trackingBoundsClose(previous.Bounds, bounds) &&
			trackingQuadClose(previous.Quad, evidence.Quad) && trackingPointClose(previous.Anchor, evidence.Anchor) &&
			previous.PartialVisibility == evidence.PartialVisibility && previous.AnchorVisible == evidence.AnchorVisible &&
			math.Abs(previous.VisibleFraction-evidence.VisibleFraction) < 0.001 &&
			sameEngine && math.Abs(previous.DepthScore-evidence.DepthScore) < 0.001 &&
			math.Abs(previous.DepthConfidence-evidence.DepthConfidence) < 0.001 &&
			math.Abs(previous.ModelRelativeDepth-evidence.ModelRelativeDepth) < 0.001 &&
			previous.PoseInliers == evidence.PoseInliers && math.Abs(previous.PoseInlierRatio-evidence.PoseInlierRatio) < 0.001
		// Never suppress a semantic transition such as fallback -> locked.
		// Bound only same-status coordinate/confidence refreshes.
		if unchanged || (previous.Status == status && sameEngine && now.Sub(previous.UpdatedAt) < 250*time.Millisecond) {
			// Refresh the observation lease without broadcasting identical
			// geometry. Handler-level authority arbitration uses this timestamp
			// to distinguish a live strong tracker from an abandoned lock.
			previous.UpdatedAt = now
			tracking := *cloneSceneTracking(previous)
			s.mu.Unlock()
			return tracking, false, nil
		}
	}
	scale := math.Sqrt((measurementBounds.Width * measurementBounds.Height) / (validationAnchor.Bounds.Width * validationAnchor.Bounds.Height))
	relativeDepth := 0.0
	if scale > 0 {
		relativeDepth = 1 / scale
	}
	tracking := SceneTrackingTelemetry{
		ApprovalID: approvalID, GuidanceID: boundGuidanceID, ObjectID: objectID, ReferenceObjectID: referenceObjectID, BaseSceneVersion: baseSceneVersion,
		Status: status, Confidence: confidence, NeedsRecalibration: status == SceneTrackingRecalibrationRequired || status == SceneTrackingReacquireRequired, Bounds: bounds,
		Quad: cloneQuad(evidence.Quad), Anchor: clonePoint(evidence.Anchor),
		Scale: scale, RelativeDepth: relativeDepth, ScaleSource: "visual-relative",
		DepthScore: evidence.DepthScore, DepthConfidence: evidence.DepthConfidence,
		ModelRelativeDepth: evidence.ModelRelativeDepth, DepthSource: evidence.DepthSource,
		PoseState: evidence.PoseState, PoseFailureReason: evidence.PoseFailureReason,
		PoseInliers: evidence.PoseInliers, PoseInlierRatio: evidence.PoseInlierRatio,
		PartialVisibility: evidence.PartialVisibility, VisibleFraction: evidence.VisibleFraction, AnchorVisible: evidence.AnchorVisible,
		Source: evidence.Source, UpdatedAt: now,
	}
	if evidence.Source == "opencv-homography" || evidence.Source == "opencv-homography+depth-anything" {
		tracking.ScaleSource = "homography-relative"
	}
	if evidence.Source == "opencv-homography+depth-anything" {
		tracking.ScaleSource = "homography-depth-validated"
	}
	if evidence.Source == "opencv-pnp+depth-anything" {
		tracking.ScaleSource = "pnp-world-relative"
	}
	if tracking.NeedsRecalibration && boundGuidanceID != "" {
		delete(s.annotationReceipts, boundGuidanceID)
	}
	s.sceneTracking = cloneSceneTracking(&tracking)
	event := s.newEventLocked("scene.tracking_updated", map[string]any{"tracking": *cloneSceneTracking(&tracking)})
	s.mu.Unlock()
	s.broadcast(event)
	return *cloneSceneTracking(&tracking), true, nil
}

// RecordSceneActivity stores at most one local visual-change signal per
// approval. It is deliberately advisory: it does not mutate the scene graph,
// consume the approval, or authorize the cable transition. The human operator
// still confirms the physical result through ConfirmCableMoved.
func (s *Session) RecordSceneActivity(approvalID string, baseSceneVersion uint64, changeScore float64) (SceneActivity, TimelineItem, bool, error) {
	if math.IsNaN(changeScore) || math.IsInf(changeScore, 0) || changeScore < 0.05 || changeScore > 1 {
		return SceneActivity{}, TimelineItem{}, false, ErrInvalidSceneActivity
	}
	now := time.Now().UTC()
	s.mu.Lock()
	if s.activeApproval == nil || approvalID == "" || s.activeApproval.ID != approvalID {
		s.mu.Unlock()
		return SceneActivity{}, TimelineItem{}, false, ErrApprovalRequired
	}
	if s.activeApproval.Status == "consumed" {
		s.mu.Unlock()
		return SceneActivity{}, TimelineItem{}, false, ErrApprovalConsumed
	}
	if now.After(s.activeApproval.ExpiresAt) || s.activeApproval.SceneVersion != s.scene.Version {
		s.mu.Unlock()
		return SceneActivity{}, TimelineItem{}, false, ErrApprovalStale
	}
	if baseSceneVersion != s.scene.Version {
		s.mu.Unlock()
		return SceneActivity{}, TimelineItem{}, false, ErrSceneVersionStale
	}
	if s.sceneActivity != nil && s.sceneActivity.ApprovalID == approvalID {
		activity := *s.sceneActivity
		s.mu.Unlock()
		return activity, TimelineItem{}, false, nil
	}
	id, err := secureToken(9)
	if err != nil {
		s.mu.Unlock()
		return SceneActivity{}, TimelineItem{}, false, err
	}
	activity := SceneActivity{
		ID: id, ApprovalID: approvalID, ObjectID: s.activeApproval.TargetObjectID,
		BaseSceneVersion: baseSceneVersion, ChangeScore: changeScore,
		Source: "browser-frame-difference", DetectedAt: now,
	}
	s.sceneActivity = &activity
	s.caseContext.UpdatedAt = now
	event := s.newEventLocked("scene.activity_detected", nil)
	item := TimelineItem{
		ID: event.ID, Type: event.Type,
		Message: "Browser detected a visual change near the WAN port; awaiting operator confirmation",
		Actor:   "Operator camera · local CV", CreatedAt: now,
	}
	s.appendTimelineLocked(item)
	event.Payload = map[string]any{"activity": activity, "timelineItem": item}
	s.mu.Unlock()
	s.broadcast(event)
	return activity, item, true, nil
}

// ConfirmCableMoved applies the only consequential demo transition after a
// one-time support approval. The approval consumption, state update, timeline
// item, scene.updated event, and after snapshot are atomic under one lock.
func (s *Session) ConfirmCableMoved(approvalID, actor, note string) (Scene, SceneSnapshot, error) {
	now := time.Now().UTC()
	s.mu.Lock()
	if s.activeApproval == nil || approvalID == "" || s.activeApproval.ID != approvalID {
		s.mu.Unlock()
		return Scene{}, SceneSnapshot{}, ErrApprovalRequired
	}
	if s.activeApproval.Status == "consumed" {
		s.mu.Unlock()
		return Scene{}, SceneSnapshot{}, ErrApprovalConsumed
	}
	if now.After(s.activeApproval.ExpiresAt) || s.activeApproval.SceneVersion != s.scene.Version {
		s.mu.Unlock()
		return Scene{}, SceneSnapshot{}, ErrApprovalStale
	}
	guidance, ok := s.annotations[s.activeApproval.GuidanceID]
	if !ok || guidance.ObjectID != s.activeApproval.TargetObjectID {
		s.mu.Unlock()
		return Scene{}, SceneSnapshot{}, ErrApprovalStale
	}
	updated, err := moveModemConnectionToWAN(s.scene, now)
	if err != nil {
		s.mu.Unlock()
		return Scene{}, SceneSnapshot{}, err
	}
	snapshotID, err := secureToken(9)
	if err != nil {
		s.mu.Unlock()
		return Scene{}, SceneSnapshot{}, err
	}
	s.activeApproval.Status = "consumed"
	s.activeApproval.ConsumedAt = &now
	s.sceneTracking = nil
	s.annotationReceipts = make(map[string]AnnotationReceipt)
	s.scene = updated
	s.updateCaseAfterCableMoveLocked(now)
	sceneEvent := s.newEventLocked("scene.updated", nil)
	message := "Operator confirmed modem cable moved from LAN to WAN"
	if note != "" {
		message += ": " + note
	}
	actionItem := TimelineItem{
		ID: sceneEvent.ID, Type: sceneEvent.Type, Message: message,
		Actor: actor, CreatedAt: now,
	}
	s.appendTimelineLocked(actionItem)
	sceneEvent.Payload = map[string]any{
		"scene":        cloneScene(updated),
		"caseContext":  cloneCaseContext(s.caseContext),
		"timelineItem": actionItem,
	}
	after := SceneSnapshot{
		ID:         snapshotID,
		Label:      "after-cable-move",
		CapturedAt: now,
		Scene:      cloneScene(updated),
	}
	if s.snapshots == nil {
		s.snapshots = make(map[string]SceneSnapshot)
	}
	s.storeSnapshotLocked(after)
	snapshotEvent := s.newEventLocked("snapshot.created", nil)
	snapshotItem := TimelineItem{
		ID: snapshotEvent.ID, Type: snapshotEvent.Type, Message: "Captured after-cable-move",
		Actor: actor, CreatedAt: now,
	}
	s.appendTimelineLocked(snapshotItem)
	snapshotEvent.Payload = map[string]any{"snapshot": cloneSceneSnapshot(after), "actor": actor, "timelineItem": snapshotItem}
	s.mu.Unlock()
	s.broadcast(sceneEvent)
	s.broadcast(snapshotEvent)
	return cloneScene(updated), cloneSceneSnapshot(after), nil
}

// ResolveCase completes the verification step after the approved physical
// transition. The HTTP route is support-authenticated and deliberately absent
// from WebMCP; page tools may inspect and recommend, but cannot invoke it.
func (s *Session) ResolveCase(actor string) (CaseContext, TimelineItem, error) {
	now := time.Now().UTC()
	s.mu.Lock()
	if s.caseContext.Status == "resolved" {
		s.mu.Unlock()
		return CaseContext{}, TimelineItem{}, ErrCaseResolved
	}
	if s.caseContext.Status != "verifying" || s.caseContext.CurrentStepID != "verify-wan-connection" ||
		!sceneHasRelationship(s.scene, "modem-1", "wan-port") {
		s.mu.Unlock()
		return CaseContext{}, TimelineItem{}, ErrCaseNotReady
	}

	s.caseContext.Status = "resolved"
	s.caseContext.CurrentStepID = ""
	s.caseContext.UpdatedAt = now
	for i := range s.caseContext.Steps {
		if s.caseContext.Steps[i].ID == "verify-wan-connection" {
			s.caseContext.Steps[i].Status = "complete"
		}
	}
	event := s.newEventLocked("case.resolved", nil)
	item := TimelineItem{
		ID: event.ID, Type: event.Type,
		Message: "Support representative resolved the WAN connection case",
		Actor:   actor, CreatedAt: now,
	}
	s.appendTimelineLocked(item)
	event.Payload = map[string]any{
		"caseContext":  cloneCaseContext(s.caseContext),
		"timelineItem": item,
	}
	context := cloneCaseContext(s.caseContext)
	s.mu.Unlock()
	s.broadcast(event)
	return context, item, nil
}

func (s *Session) ClearAnnotations(actor string) int {
	s.mu.Lock()
	count := len(s.annotations)
	s.annotations = make(map[string]Annotation)
	s.annotationReceipts = make(map[string]AnnotationReceipt)
	s.sceneTracking = nil
	event := s.newEventLocked("annotations.cleared", map[string]any{"count": count, "actor": actor})
	s.appendTimelineLocked(TimelineItem{
		ID: event.ID, Type: event.Type, Message: fmt.Sprintf("Cleared %d annotation(s)", count),
		Actor: actor, CreatedAt: time.Now().UTC(),
	})
	s.mu.Unlock()
	s.broadcast(event)
	return count
}

// AcknowledgeAnnotations records browser-render delivery for the current
// scene. It is atomic across the requested IDs, idempotent, support-only, and
// deliberately leaves the case timeline and physical scene untouched.
func (s *Session) AcknowledgeAnnotations(annotationIDs []string, sceneVersion uint64) ([]AnnotationReceipt, bool, error) {
	if len(annotationIDs) == 0 || len(annotationIDs) > maxActiveAnnotations {
		return nil, false, ErrAnnotationNotFound
	}
	s.mu.Lock()
	if sceneVersion == 0 || sceneVersion != s.scene.Version {
		s.mu.Unlock()
		return nil, false, ErrSceneVersionStale
	}
	unique := make([]string, 0, len(annotationIDs))
	seen := make(map[string]struct{}, len(annotationIDs))
	for _, annotationID := range annotationIDs {
		if _, duplicate := seen[annotationID]; duplicate {
			continue
		}
		if _, ok := s.annotations[annotationID]; !ok {
			s.mu.Unlock()
			return nil, false, ErrAnnotationNotFound
		}
		seen[annotationID] = struct{}{}
		unique = append(unique, annotationID)
	}
	now := time.Now().UTC()
	receipts := make([]AnnotationReceipt, 0, len(unique))
	newReceipts := make([]AnnotationReceipt, 0, len(unique))
	for _, annotationID := range unique {
		if existing, ok := s.annotationReceipts[annotationID]; ok && existing.SceneVersion == sceneVersion {
			receipts = append(receipts, existing)
			continue
		}
		annotation := s.annotations[annotationID]
		receipt := AnnotationReceipt{
			AnnotationID:   annotationID,
			ObjectID:       annotation.ObjectID,
			SceneVersion:   sceneVersion,
			Source:         "operator-rendered-overlay",
			AcknowledgedAt: now,
		}
		s.annotationReceipts[annotationID] = receipt
		receipts = append(receipts, receipt)
		newReceipts = append(newReceipts, receipt)
	}
	if len(newReceipts) == 0 {
		s.mu.Unlock()
		return receipts, false, nil
	}
	event := s.newEventLocked("annotation.acknowledged", map[string]any{"receipts": newReceipts})
	s.mu.Unlock()
	s.broadcast(event)
	return receipts, true, nil
}

func (s *Session) RecordObservation(text, actor string) TimelineItem {
	s.mu.Lock()
	itemID, _ := secureToken(9)
	now := time.Now().UTC()
	item := TimelineItem{
		ID: itemID, Type: "observation.created", Message: text,
		Actor: actor, CreatedAt: now,
	}
	s.caseContext.UpdatedAt = now
	s.appendTimelineLocked(item)
	event := s.newEventLocked(item.Type, item)
	s.mu.Unlock()
	s.broadcast(event)
	return item
}

// UpdateRoomContext replaces the current support-only visual room summary.
// The scene version binding prevents Codex from publishing landmarks derived
// from a frame that predates a calibration or semantic scene change.
func (s *Session) UpdateRoomContext(summary string, observations []RoomObservation, baseSceneVersion uint64, actor string) (RoomContext, TimelineItem, error) {
	summary = strings.TrimSpace(summary)
	if summary == "" || len(summary) > 500 || len(observations) > maxRoomObservations {
		return RoomContext{}, TimelineItem{}, ErrInvalidRoomContext
	}
	cleaned := make([]RoomObservation, 0, len(observations))
	for _, observation := range observations {
		observation.Label = strings.TrimSpace(observation.Label)
		observation.Detail = strings.TrimSpace(observation.Detail)
		if observation.Label == "" || len(observation.Label) > 80 || observation.Detail == "" || len(observation.Detail) > 240 {
			return RoomContext{}, TimelineItem{}, ErrInvalidRoomContext
		}
		cleaned = append(cleaned, observation)
	}

	s.mu.Lock()
	if baseSceneVersion == 0 || baseSceneVersion != s.scene.Version {
		s.mu.Unlock()
		return RoomContext{}, TimelineItem{}, ErrSceneVersionStale
	}
	now := time.Now().UTC()
	context := RoomContext{
		Summary: summary, Observations: cleaned, BaseSceneVersion: baseSceneVersion,
		UpdatedBy: actor, UpdatedAt: now,
	}
	s.roomContext = &context
	s.caseContext.UpdatedAt = now
	event := s.newEventLocked("room.context_updated", nil)
	item := TimelineItem{
		ID: event.ID, Type: event.Type,
		Message: fmt.Sprintf("Updated room context with %d landmark(s)", len(cleaned)),
		Actor:   actor, CreatedAt: now,
	}
	s.appendTimelineLocked(item)
	event.Payload = map[string]any{"roomContext": cloneRoomContext(&context), "timelineItem": item}
	s.mu.Unlock()
	s.broadcast(event)
	return context, item, nil
}

// SelectOperatorIssue publishes the operator's explicit request. Preset
// identity remains a phone-only input detail: support and Codex receive the
// same plain user-authored context shape for starters and free-form requests.
func (s *Session) SelectOperatorIssue(mode, presetID, summary, actor string) (OperatorIssue, TimelineItem, error) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	presetID = strings.ToLower(strings.TrimSpace(presetID))
	summary = strings.Join(strings.Fields(summary), " ")
	switch mode {
	case OperatorIssueModePreset:
		if presetID != OperatorIssuePresetTV {
			return OperatorIssue{}, TimelineItem{}, ErrInvalidOperatorIssue
		}
		summary = "I lost my controller. How do I control my TV?"
	case OperatorIssueModeFreeform:
		if presetID != "" || summary == "" || len(summary) > maxOperatorIssueText {
			return OperatorIssue{}, TimelineItem{}, ErrInvalidOperatorIssue
		}
	default:
		return OperatorIssue{}, TimelineItem{}, ErrInvalidOperatorIssue
	}

	s.mu.Lock()
	if s.operatorIssue != nil {
		s.mu.Unlock()
		return OperatorIssue{}, TimelineItem{}, ErrOperatorIssueSelected
	}
	now := time.Now().UTC()
	issue := OperatorIssue{Summary: summary, SelectedAt: now}
	s.operatorIssue = &issue
	event := s.newEventLocked("operator.issue_selected", nil)
	message := ConversationMessage{
		ID: event.ID, Text: summary, Sender: RoleOperator, Actor: actor, SentAt: now,
	}
	s.messages = append(s.messages, message)
	if len(s.messages) > maxConversationItems {
		s.messages = append([]ConversationMessage(nil), s.messages[len(s.messages)-maxConversationItems:]...)
	}
	item := TimelineItem{
		ID: event.ID, Type: event.Type, Message: "Operator requested help: " + summary,
		Actor: actor, CreatedAt: now,
	}
	s.appendTimelineLocked(item)
	event.Payload = map[string]any{
		"issue": cloneOperatorIssue(&issue), "message": message, "timelineItem": item,
	}
	s.mu.Unlock()
	s.broadcast(event)
	return issue, item, nil
}

// SendConversationMessage appends one backend-authoritative message visible
// to both roles and restored on reconnect. Camera media remains peer-to-peer;
// only bounded text is retained with the session.
func (s *Session) SendConversationMessage(text string, sender Role, actor string) (ConversationMessage, TimelineItem, error) {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > maxConversationText || strings.ContainsRune(text, '\x00') ||
		(sender != RoleOperator && sender != RoleSupport) {
		return ConversationMessage{}, TimelineItem{}, ErrInvalidConversation
	}

	s.mu.Lock()
	now := time.Now().UTC()
	event := s.newEventLocked("conversation.message_sent", nil)
	message := ConversationMessage{
		ID: event.ID, Text: text, Sender: sender, Actor: actor, SentAt: now,
	}
	s.messages = append(s.messages, message)
	if len(s.messages) > maxConversationItems {
		s.messages = append([]ConversationMessage(nil), s.messages[len(s.messages)-maxConversationItems:]...)
	}
	item := TimelineItem{
		ID: event.ID, Type: event.Type, Message: string(sender) + " sent a message",
		Actor: actor, CreatedAt: now,
	}
	s.appendTimelineLocked(item)
	event.Payload = map[string]any{"message": message, "timelineItem": item}
	s.mu.Unlock()
	s.broadcast(event)
	return message, item, nil
}

// AskOperator streams one bounded choice question to the phone. A pending
// question must be answered before another replaces it so the operator never
// has competing prompts.
func (s *Session) AskOperator(prompt string, optionLabels []string, actor string) (OperatorQuestion, TimelineItem, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" || len(prompt) > 240 || len(optionLabels) < 2 || len(optionLabels) > maxOperatorOptions {
		return OperatorQuestion{}, TimelineItem{}, ErrInvalidQuestion
	}
	options := make([]OperatorQuestionOption, 0, len(optionLabels))
	seen := make(map[string]struct{}, len(optionLabels))
	for index, label := range optionLabels {
		label = strings.TrimSpace(label)
		key := strings.ToLower(label)
		if label == "" || len(label) > 80 {
			return OperatorQuestion{}, TimelineItem{}, ErrInvalidQuestionOption
		}
		if _, duplicate := seen[key]; duplicate {
			return OperatorQuestion{}, TimelineItem{}, ErrInvalidQuestionOption
		}
		seen[key] = struct{}{}
		options = append(options, OperatorQuestionOption{ID: fmt.Sprintf("option-%d", index+1), Label: label})
	}

	s.mu.Lock()
	if s.activeQuestion != nil && s.activeQuestion.Status == "pending" {
		s.mu.Unlock()
		return OperatorQuestion{}, TimelineItem{}, ErrQuestionPending
	}
	id, err := secureToken(9)
	if err != nil {
		s.mu.Unlock()
		return OperatorQuestion{}, TimelineItem{}, err
	}
	now := time.Now().UTC()
	question := OperatorQuestion{
		ID: id, Prompt: prompt, Options: options, Status: "pending",
		AskedBy: actor, AskedAt: now,
	}
	s.activeQuestion = &question
	event := s.newEventLocked("operator.question_asked", nil)
	item := TimelineItem{
		ID: event.ID, Type: event.Type, Message: "Asked operator: " + prompt,
		Actor: actor, CreatedAt: now,
	}
	s.appendTimelineLocked(item)
	event.Payload = map[string]any{"question": cloneOperatorQuestion(&question), "timelineItem": item}
	s.mu.Unlock()
	s.broadcast(event)
	return question, item, nil
}

// SendOperatorInstruction replaces the current hands-busy banner without
// altering spatial guidance. Every role receives the same server-authored
// value, and reconnecting clients restore it from their role snapshot.
func (s *Session) SendOperatorInstruction(title, detail, actor string) (OperatorInstruction, TimelineItem, error) {
	title = strings.TrimSpace(title)
	detail = strings.TrimSpace(detail)
	if title == "" || len(title) > maxInstructionTitle || detail == "" || len(detail) > maxInstructionDetail ||
		strings.ContainsAny(title, "\r\n\x00") || strings.ContainsAny(detail, "\r\n\x00") {
		return OperatorInstruction{}, TimelineItem{}, ErrInvalidInstruction
	}

	s.mu.Lock()
	id, err := secureToken(9)
	if err != nil {
		s.mu.Unlock()
		return OperatorInstruction{}, TimelineItem{}, err
	}
	now := time.Now().UTC()
	instruction := OperatorInstruction{
		ID: id, Title: title, Detail: detail, SentBy: actor, SentAt: now,
	}
	s.operatorInstruction = &instruction
	event := s.newEventLocked("operator.instruction_updated", nil)
	item := TimelineItem{
		ID: event.ID, Type: event.Type, Message: "Sent operator banner: " + title,
		Actor: actor, CreatedAt: now,
	}
	s.appendTimelineLocked(item)
	event.Payload = map[string]any{
		"instruction":  cloneOperatorInstruction(&instruction),
		"timelineItem": item,
	}
	s.mu.Unlock()
	s.broadcast(event)
	return instruction, item, nil
}

// ClearOperatorInstruction removes the current hands-busy banner from every
// participant through the same backend-authoritative event used to publish it.
// The operation is idempotent so a stale support console cannot resurrect or
// duplicate banner state while reconnecting.
func (s *Session) ClearOperatorInstruction(actor string) (TimelineItem, bool) {
	s.mu.Lock()
	if s.operatorInstruction == nil {
		s.mu.Unlock()
		return TimelineItem{}, false
	}
	now := time.Now().UTC()
	s.operatorInstruction = nil
	event := s.newEventLocked("operator.instruction_updated", nil)
	item := TimelineItem{
		ID: event.ID, Type: event.Type, Message: "Removed operator phone banner",
		Actor: actor, CreatedAt: now,
	}
	s.appendTimelineLocked(item)
	event.Payload = map[string]any{
		"instruction":  nil,
		"timelineItem": item,
	}
	s.mu.Unlock()
	s.broadcast(event)
	return item, true
}

func (s *Session) AnswerOperatorQuestion(questionID, optionID, actor string) (OperatorQuestion, TimelineItem, error) {
	s.mu.Lock()
	if s.activeQuestion == nil || s.activeQuestion.ID != questionID {
		s.mu.Unlock()
		return OperatorQuestion{}, TimelineItem{}, ErrQuestionNotFound
	}
	if s.activeQuestion.Status != "pending" {
		s.mu.Unlock()
		return OperatorQuestion{}, TimelineItem{}, ErrQuestionAnswered
	}
	answer := ""
	for _, option := range s.activeQuestion.Options {
		if option.ID == optionID {
			answer = option.Label
			break
		}
	}
	if answer == "" {
		s.mu.Unlock()
		return OperatorQuestion{}, TimelineItem{}, ErrInvalidQuestionOption
	}
	now := time.Now().UTC()
	s.activeQuestion.Status = "answered"
	s.activeQuestion.AnswerID = optionID
	s.activeQuestion.Answer = answer
	s.activeQuestion.AnsweredAt = &now
	event := s.newEventLocked("operator.question_answered", nil)
	item := TimelineItem{
		ID: event.ID, Type: event.Type, Message: "Operator answered: " + answer,
		Actor: actor, CreatedAt: now,
	}
	s.appendTimelineLocked(item)
	question := cloneOperatorQuestion(s.activeQuestion)
	event.Payload = map[string]any{"question": question, "timelineItem": item}
	s.mu.Unlock()
	s.broadcast(event)
	return *question, item, nil
}

func (s *Session) newEventLocked(eventType string, payload any) Event {
	s.sequence++
	id, _ := secureToken(9)
	return Event{
		ID:        id,
		Type:      eventType,
		SessionID: s.ID,
		Sequence:  s.sequence,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:   payload,
	}
}

func (s *Session) appendTimelineLocked(item TimelineItem) {
	s.timeline = append(s.timeline, item)
	if len(s.timeline) > maxTimelineItems {
		s.timeline = append([]TimelineItem(nil), s.timeline[len(s.timeline)-maxTimelineItems:]...)
	}
}

func (s *Session) storeSnapshotLocked(snapshot SceneSnapshot) {
	if s.snapshots == nil {
		s.snapshots = make(map[string]SceneSnapshot)
	}
	s.snapshots[snapshot.ID] = snapshot
	s.snapshotOrder = append(s.snapshotOrder, snapshot.ID)
	if len(s.snapshotOrder) <= maxSceneSnapshots {
		return
	}
	oldestID := s.snapshotOrder[0]
	s.snapshotOrder = append([]string(nil), s.snapshotOrder[1:]...)
	delete(s.snapshots, oldestID)
}

func (s *Session) broadcast(event Event) {
	for role, hub := range s.hubs {
		roleEvent, ok := eventForRole(role, event)
		if !ok {
			continue
		}
		b, err := json.Marshal(roleEvent)
		if err != nil {
			continue
		}
		hub.BroadcastWait(b)
	}
}

// eventForRole is an explicit transport allowlist. Support receives the full
// accountable event stream; operator receives only the realtime fields needed
// for WebRTC signaling, participant state, scene rendering, guidance, and the
// one-time approval it can consume.
func eventForRole(role Role, event Event) (Event, bool) {
	if role == RoleSupport {
		return event, true
	}
	if role != RoleOperator {
		return Event{}, false
	}
	if strings.HasPrefix(event.Type, "webrtc.") || event.Type == "participant.joined" || event.Type == "participant.left" || event.Type == "annotations.cleared" {
		return event, true
	}
	payload, _ := event.Payload.(map[string]any)
	filtered := event
	switch event.Type {
	case "annotation.created":
		filtered.Payload = map[string]any{"annotation": payload["annotation"]}
	case "annotation.removed":
		filtered.Payload = map[string]any{"id": payload["id"], "annotation": payload["annotation"]}
	case "action.approved":
		filtered.Payload = map[string]any{"approval": payload["approval"]}
	case "scene.updated":
		filtered.Payload = map[string]any{"scene": payload["scene"]}
	case "scene.tracking_updated":
		filtered.Payload = map[string]any{"tracking": payload["tracking"]}
	case "operator.issue_selected":
		filtered.Payload = map[string]any{"issue": payload["issue"], "message": payload["message"]}
	case "operator.question_asked", "operator.question_answered":
		filtered.Payload = map[string]any{"question": payload["question"]}
	case "operator.instruction_updated":
		filtered.Payload = map[string]any{"instruction": payload["instruction"]}
	case "conversation.message_sent":
		filtered.Payload = map[string]any{"message": payload["message"]}
	default:
		return Event{}, false
	}
	return filtered, true
}

func (s *Session) Stop() {
	for _, hub := range s.hubs {
		hub.Stop()
	}
}

type SessionStore struct {
	mu             sync.RWMutex
	sessions       map[string]*Session
	ttl            time.Duration
	demoMode       bool
	max            int
	expiryObserver func(string, time.Time)
}

func (s *SessionStore) SetExpiryObserver(observer func(string, time.Time)) {
	s.mu.Lock()
	s.expiryObserver = observer
	s.mu.Unlock()
}

func NewSessionStore(ttl time.Duration) *SessionStore {
	return NewSessionStoreWithDemoMode(ttl, true)
}

func NewSessionStoreWithDemoMode(ttl time.Duration, demoMode bool) *SessionStore {
	return newSessionStoreWithLimit(ttl, demoMode, defaultMaxSessions)
}

func newSessionStoreWithLimit(ttl time.Duration, demoMode bool, maxSessions int) *SessionStore {
	if maxSessions <= 0 {
		maxSessions = defaultMaxSessions
	}
	return &SessionStore{sessions: make(map[string]*Session), ttl: ttl, demoMode: demoMode, max: maxSessions}
}

func (s *SessionStore) Create() (*Session, error) {
	return s.CreateWithDemoMode(s.demoMode)
}

// CreateWithDemoMode selects the deterministic submission fixture or a blank
// live scene per session without changing the deployment-wide default.
func (s *SessionStore) CreateWithDemoMode(demoMode bool) (*Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sessions) >= s.max {
		return nil, ErrSessionLimit
	}
	session, err := newSession(s.ttl)
	if err != nil {
		return nil, err
	}
	if !demoMode {
		now := time.Now().UTC()
		session.mu.Lock()
		session.scene = Scene{
			ID:        "unobserved-scene",
			Label:     "Awaiting scene observations",
			Version:   1,
			Timestamp: now,
			Objects:   []SceneObject{},
			Calibration: SceneCalibration{
				Source:          "unobserved",
				CoordinateSpace: "normalized-video",
				UpdatedAt:       now,
			},
		}
		session.caseContext = newLiveCaseContext(session.ID, now)
		session.mu.Unlock()
	}
	s.sessions[session.ID] = session
	return session, nil
}

func (s *SessionStore) Get(id string) (*Session, error) {
	s.mu.RLock()
	session, ok := s.sessions[id]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrSessionNotFound
	}
	if time.Now().UTC().After(session.ExpiresAt) {
		return nil, ErrSessionExpired
	}
	return session, nil
}

func (s *SessionStore) RunJanitor(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.StopAll()
			return
		case now := <-ticker.C:
			s.removeExpired(now.UTC())
		}
	}
}

func (s *SessionStore) removeExpired(now time.Time) {
	var expired []*Session
	s.mu.Lock()
	for id, session := range s.sessions {
		if now.After(session.ExpiresAt) {
			delete(s.sessions, id)
			expired = append(expired, session)
		}
	}
	observer := s.expiryObserver
	s.mu.Unlock()
	for _, session := range expired {
		session.Stop()
		if observer != nil {
			observer(session.ID, session.ExpiresAt)
		}
	}
}

func (s *SessionStore) StopAll() {
	s.mu.Lock()
	sessions := make([]*Session, 0, len(s.sessions))
	for _, session := range s.sessions {
		sessions = append(sessions, session)
	}
	s.sessions = make(map[string]*Session)
	s.mu.Unlock()
	for _, session := range sessions {
		session.Stop()
	}
}
