package main

import (
	"fmt"
	"strings"

	apphtml "github.com/DonaldMurillo/gofastr/core-ui/html"
	"github.com/DonaldMurillo/gofastr/core/render"
	"github.com/DonaldMurillo/gofastr/framework/experimental/webmcp"
	frameworkui "github.com/DonaldMurillo/gofastr/framework/ui"
)

type landingScreen struct{}

func (*landingScreen) ScreenTitle() string { return "Remote support" }

func (*landingScreen) ScreenDescription() string {
	return "Start a shared WebRTC support session for an operator, an expert, and Codex."
}

func (*landingScreen) Render() render.HTML {
	return entryShell("landing-app", "landing", apphtml.Div(apphtml.DivConfig{Class: "landing-content"},
		apphtml.Div(apphtml.DivConfig{Class: "entry-main"},
			apphtml.Section(apphtml.SectionConfig{Label: "Field Assist overview", Class: "entry-intro"},
				apphtml.Div(apphtml.DivConfig{Class: "eyebrow entry-kicker"}, render.Text("GOFASTR × WEBMCP")),
				apphtml.Heading(apphtml.HeadingConfig{Level: 1}, render.Text("Point at the problem. Work it together.")),
				apphtml.Paragraph(apphtml.TextConfig{Class: "lede"}, render.Text("Open a secure workspace where an operator streams the device, a support rep stays accountable, and Codex can inspect and guide the live scene.")),
				apphtml.Div(apphtml.DivConfig{Class: "entry-proof", ExtraAttrs: apphtml.Attrs{"aria-label": "Session capabilities"}},
					proofItem("01", "Direct camera", "Browser-to-browser WebRTC"),
					proofItem("02", "Spatial guidance", "Anchored to the live scene"),
					proofItem("03", "Codex tools", "Exposed through WebMCP"),
				),
			),
			sessionStartCard("Start a field session", "Create the support console first. The operator joins from a one-time QR code after it opens."),
		),
		hackathonDemoGuide(),
	))
}

func hackathonDemoGuide() render.HTML {
	return apphtml.Section(apphtml.SectionConfig{Label: "Hackathon demonstration instructions", Class: "demo-guide", ID: "demo-guide"},
		apphtml.Div(apphtml.DivConfig{Class: "demo-guide-intro"},
			apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("HACKATHON DEMO · 2–3 MINUTES")),
			apphtml.Div(apphtml.DivConfig{Class: "demo-browser-requirement"},
				apphtml.Span(apphtml.TextConfig{Class: "demo-browser-label"}, render.Text("OPEN THIS SITE IN")),
				apphtml.Strong(apphtml.TextConfig{}, render.Text("Codex’s built-in browser or another WebMCP-enabled browser")),
			),
			apphtml.Heading(apphtml.HeadingConfig{Level: 2}, render.Text("Watch guidance cross from Codex into the live camera.")),
			apphtml.Paragraph(apphtml.TextConfig{Class: "demo-guide-summary"}, render.Text("Use a computer for the support console and a phone for the rear camera. The phone needs no account, and camera media stays peer to peer.")),
			apphtml.Div(apphtml.DivConfig{Class: "demo-guide-actions"},
				apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/new", Class: "demo-guide-primary", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Text("Start the live demo")}),
				apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/tools", Class: "demo-guide-secondary", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Text("View WebMCP tools")}),
			),
		),
		apphtml.OrderedList(apphtml.ListConfig{Class: "demo-guide-steps"},
			demoGuideStep("01", "Create the console", "Open a secure support session on the computer. A one-time operator QR appears inside the camera area."),
			demoGuideStep("02", "Pair the phone", "Scan the QR, choose the TV starter or enter any real problem, then allow rear-camera access."),
			demoGuideStep("03", "Let Codex guide", "Ask Codex to inspect the scene, then watch its banner and anchored arrow reach the phone."),
		),
	)
}

func demoGuideStep(number, title, detail string) render.HTML {
	return apphtml.ListItem(apphtml.ListItemConfig{Class: "demo-guide-step"},
		apphtml.Span(apphtml.TextConfig{Class: "demo-step-number", ExtraAttrs: apphtml.Attrs{"aria-hidden": "true"}}, render.Text(number)),
		apphtml.Div(apphtml.DivConfig{},
			apphtml.Strong(apphtml.TextConfig{}, render.Text(title)),
			apphtml.Paragraph(apphtml.TextConfig{}, render.Text(detail)),
		),
	)
}

type newSessionScreen struct{}

func (*newSessionScreen) ScreenTitle() string { return "New session" }

func (*newSessionScreen) ScreenDescription() string {
	return "Create a secure Field Assist workspace for an operator, a support representative, and Codex."
}

func (*newSessionScreen) Render() render.HTML {
	return entryShell("new-session-app", "new-session", apphtml.Div(apphtml.DivConfig{Class: "entry-main recovery-main"},
		apphtml.Section(apphtml.SectionConfig{Label: "New field session", Class: "entry-intro recovery-copy"},
			apphtml.Div(apphtml.DivConfig{Class: "error-code"}, render.Text("NEW SESSION")),
			apphtml.Heading(apphtml.HeadingConfig{Level: 1}, render.Text("Open a live workspace.")),
			apphtml.Paragraph(apphtml.TextConfig{Class: "lede"}, render.Text("The support console opens here first. Pair the operator from its one-time QR code, then bring Codex into the live scene through WebMCP.")),
		),
		sessionStartCard("Create a new session", "Open a blank live workspace. The operator supplies the request after pairing."),
	))
}

const unavailableSessionPath = "/__field-assist/session-unavailable"

type notFoundScreen struct{}

func (*notFoundScreen) Render() render.HTML {
	return renderNotFound(false)
}

func (*notFoundScreen) RenderNotFound(path string) render.HTML {
	return renderNotFound(path == unavailableSessionPath)
}

func renderNotFound(sessionUnavailable bool) render.HTML {
	if sessionUnavailable {
		return entryShell("session-unavailable-app", "session-unavailable", apphtml.Main(apphtml.MainConfig{Class: "entry-main recovery-main"},
			apphtml.Section(apphtml.SectionConfig{Label: "Session unavailable", Class: "entry-intro recovery-copy"},
				apphtml.Div(apphtml.DivConfig{Class: "error-code"}, render.Text("SESSION ENDED")),
				apphtml.Heading(apphtml.HeadingConfig{Level: 1}, render.Text("That field session has packed up.")),
				apphtml.Paragraph(apphtml.TextConfig{Class: "lede"}, render.Text("The private link may have expired, been closed, or belongs to another browser. Start a fresh session and you will get a new operator QR code.")),
			),
			sessionStartCard("Create a new session", "A fresh console opens immediately. No account is required on the operator phone."),
		))
	}

	return entryShell("not-found-app", "not-found", apphtml.Main(apphtml.MainConfig{Class: "entry-main recovery-main"},
		apphtml.Section(apphtml.SectionConfig{Label: "Page not found", Class: "entry-intro recovery-copy"},
			apphtml.Div(apphtml.DivConfig{Class: "error-code"}, render.Text("404")),
			apphtml.Heading(apphtml.HeadingConfig{Level: 1}, render.Text("Nothing is connected here.")),
			apphtml.Paragraph(apphtml.TextConfig{Class: "lede"}, render.Text("This address does not match a Field Assist screen. Return home or start a new live session from here.")),
			apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/", Class: "secondary-action home-action", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Text("Return home")}),
		),
		sessionStartCard("Start instead", "Create a secure support console and pair an operator when you are ready."),
	))
}

func entryShell(id, page string, content render.HTML) render.HTML {
	return apphtml.Div(apphtml.DivConfig{Class: "field-app entry-shell", ID: id, ExtraAttrs: apphtml.Attrs{"data-fui-field-assist": page}},
		appHeader("Live spatial support", nil),
		content,
		apphtml.Footer(apphtml.FooterConfig{Class: "app-footer"},
			apphtml.Paragraph(apphtml.TextConfig{}, render.Text("Private by default · peer-to-peer media · no recording")),
			apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/stack", Class: "footer-link", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Text("Check the stack")}),
		),
	)
}

func sessionStartCard(title, description string) render.HTML {
	return apphtml.Section(apphtml.SectionConfig{Label: "Create a new session", Class: "session-launch-card", ID: "new-session"},
		apphtml.Div(apphtml.DivConfig{Class: "launch-card-heading"},
			apphtml.Span(apphtml.TextConfig{Class: "launch-index", ExtraAttrs: apphtml.Attrs{"aria-hidden": "true"}}, render.Text("+")),
			apphtml.Div(apphtml.DivConfig{},
				apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("NEW WORKSPACE")),
				apphtml.Heading(apphtml.HeadingConfig{Level: 2}, render.Text(title)),
			),
		),
		apphtml.Paragraph(apphtml.TextConfig{Class: "launch-description"}, render.Text(description)),
		apphtml.Form(apphtml.FormConfig{Method: "POST", Action: "/sessions/new", ID: "create-session-form"},
			frameworkui.Button(frameworkui.ButtonConfig{Label: "Create secure session", Type: "submit", Variant: frameworkui.ButtonPrimary, Size: frameworkui.ButtonSizeLarge, Class: "primary-action launch-action", ID: "create-session"}),
		),
		apphtml.Paragraph(apphtml.TextConfig{Class: "form-status", ID: "create-status", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("The support console opens in this browser.")),
	)
}

func proofItem(number, title, detail string) render.HTML {
	return apphtml.Div(apphtml.DivConfig{Class: "proof-item"},
		apphtml.Span(apphtml.TextConfig{Class: "step-number"}, render.Text(number)),
		apphtml.Strong(apphtml.TextConfig{}, render.Text(title)),
		apphtml.Span(apphtml.TextConfig{}, render.Text(detail)),
	)
}

type stackScreen struct{}

func (*stackScreen) ScreenTitle() string { return "Technology stack" }

func (*stackScreen) ScreenDescription() string {
	return "The released framework, browser capabilities, realtime transports, and deployment services behind Field Assist."
}

func (*stackScreen) Render() render.HTML {
	return entryShell("stack-app", "stack", apphtml.Div(apphtml.DivConfig{Class: "stack-main"},
		apphtml.Section(apphtml.SectionConfig{Label: "Technology stack overview", Class: "stack-intro"},
			apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("THE ACTUAL STACK")),
			apphtml.Heading(apphtml.HeadingConfig{Level: 1}, render.Text("What makes the live loop work.")),
			apphtml.Paragraph(apphtml.TextConfig{Class: "lede"}, render.Text("Field Assist is one Go application plus browser-native media and vision. Codex operates only through the WebMCP tools exposed by the authenticated support page.")),
			apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/new", Class: "primary-action stack-action", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Text("Start a session")}),
		),
		apphtml.Div(apphtml.DivConfig{Class: "stack-list", ExtraAttrs: apphtml.Attrs{"aria-label": "Field Assist technology inventory"}},
			stackRow("01", "Go 1.27 + GoFastr v0.75.0", "Released Go module for the HTTP application, server-rendered UI host, typed handlers, security middleware, rate limiting, JSON logs, and trusted plugin assets."),
			stackRow("02", "GoFastr WebMCP", "Browser bridge for the twenty-five authenticated scene, conversation, room-context, phone-banner, guidance, operator-question, snapshot, case, and diagnostic tools that Codex discovers on the support page. The public tool catalog is generated from these same declarations without exposing invocation schemas."),
			stackRow("03", "Codex", "The only agent driving the application. It inspects and guides through page-scoped WebMCP; there is no separate model API embedded in Field Assist."),
			stackRow("04", "WebRTC + MediaDevices + DataChannel", "Peer-to-peer rear-camera video from the operator phone plus a latest-only scalar orientation bridge. Camera frames do not pass through the Go server."),
			stackRow("05", "WebSockets + ICE", "GoFastr carries authenticated signaling, session state, annotations, and receipts. Public STUN is the default, with environment-configured TURN support."),
			stackRow("06", "OpenCV 5 + HTML Canvas", "The support computer owns enhanced tracking and publishes bounded geometry. OpenCV ORB, RANSAC homography, and PnP run against its peer-video copy; Canvas provides the fast fallback."),
			stackRow("07", "ONNX Runtime Web + Depth Anything V2 Small", "The support computer runs the pinned 1.29 browser runtime and compact monocular-depth models at low cadence to validate planes and seed relative camera pose. It does not claim metric depth or LiDAR."),
			stackRow("08", "DeviceOrientation + Canvas", "The phone keeps a lightweight Canvas tracker and sends bounded orientation samples over the WebRTC data channel. The support console uses one responsive CSS Grid and container-query layout."),
			stackRow("09", "Donald Murillo Barcode", "Server-side QR generation through barcode.donaldmurillo.com, backed by a visible one-time copy-link fallback."),
			stackRow("10", "VPS hosting", "A containerized Go service on private VPS infrastructure, with an HTTPS public origin, WebSocket proxying, health probes, and repeatable release verification."),
			stackRow("11", "Playwright", "End-to-end coverage for WebRTC, WebMCP, responsive layout, camera recovery, tracking, and the deployed Codex-to-phone loop."),
		),
	))
}

func stackRow(number, title, detail string) render.HTML {
	return apphtml.Article(apphtml.ArticleConfig{Class: "stack-row"},
		apphtml.Span(apphtml.TextConfig{Class: "stack-number", ExtraAttrs: apphtml.Attrs{"aria-hidden": "true"}}, render.Text(number)),
		apphtml.Heading(apphtml.HeadingConfig{Level: 2}, render.Text(title)),
		apphtml.Paragraph(apphtml.TextConfig{}, render.Text(detail)),
	)
}

type toolsScreen struct {
	tools []webmcp.Tool
}

func (*toolsScreen) ScreenTitle() string { return "WebMCP tool catalog" }

func (*toolsScreen) ScreenDescription() string {
	return "The complete page-scoped WebMCP capability catalog for Field Assist."
}

func (s *toolsScreen) Render() render.HTML {
	rows := make([]render.HTML, 0, len(s.tools))
	for index, tool := range s.tools {
		rows = append(rows, toolCatalogRow(index+1, tool))
	}

	return entryShell("tools-app", "tools", apphtml.Main(apphtml.MainConfig{Class: "tools-main"},
		apphtml.Section(apphtml.SectionConfig{Label: "WebMCP tool catalog introduction", Class: "tools-intro"},
			apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("WEBMCP CAPABILITY MAP")),
			apphtml.Heading(apphtml.HeadingConfig{Level: 1}, render.Text("Everything Codex can do here.")),
			apphtml.Paragraph(apphtml.TextConfig{Class: "lede"}, render.Text("This catalog is generated from the same declarations registered on the support page. Schemas and invocation stay inside an authenticated support session.")),
			apphtml.Div(apphtml.DivConfig{Class: "tools-count", ExtraAttrs: apphtml.Attrs{"aria-label": fmt.Sprintf("%d available WebMCP tools", len(s.tools))}},
				apphtml.Strong(apphtml.TextConfig{}, render.Text(fmt.Sprintf("%02d", len(s.tools)))),
				apphtml.Span(apphtml.TextConfig{}, render.Text("available tools")),
			),
			apphtml.Div(apphtml.DivConfig{Class: "tools-intro-actions"},
				apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/new", Class: "primary-action tools-action", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Text("Start a session")}),
				apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/stack", Class: "stack-link", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Text("Check the stack")}),
			),
		),
		apphtml.Section(apphtml.SectionConfig{Label: "Available WebMCP tools", Class: "tool-catalog"},
			apphtml.Div(apphtml.DivConfig{Class: "tool-catalog-heading"},
				apphtml.Div(apphtml.DivConfig{},
					apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("REGISTERED SURFACE")),
					apphtml.Heading(apphtml.HeadingConfig{Level: 2}, render.Text("Session-scoped capabilities")),
				),
				apphtml.Paragraph(apphtml.TextConfig{}, render.Text("Read-only, user-content, and debug-only behavior is labeled directly on each declaration.")),
			),
			apphtml.Div(apphtml.DivConfig{Class: "tool-list", Role: "list"}, rows...),
		),
	))
}

func toolCatalogRow(number int, tool webmcp.Tool) render.HTML {
	title := tool.Title
	if title == "" {
		title = tool.Name
	}
	method := tool.Method
	if method == "" {
		method = "POST"
	}
	meta := []render.HTML{
		apphtml.Span(apphtml.TextConfig{Class: "tool-method"}, render.Text(method)),
	}
	if tool.ReadOnlyHint {
		meta = append(meta, apphtml.Span(apphtml.TextConfig{Class: "tool-trait"}, render.Text("Read only")))
	}
	if tool.UntrustedContentHint {
		meta = append(meta, apphtml.Span(apphtml.TextConfig{Class: "tool-trait"}, render.Text("User content")))
	}
	debugOnly := strings.HasPrefix(tool.Name, "debug_")
	if debugOnly {
		meta = append(meta, apphtml.Span(apphtml.TextConfig{Class: "tool-trait tool-trait-debug"}, render.Text("Debug only")))
	}
	attrs := apphtml.Attrs{
		"data-tool-name": tool.Name,
		"role":           "listitem",
	}
	if debugOnly {
		attrs["data-debug-only"] = "true"
	}

	return apphtml.Article(apphtml.ArticleConfig{Class: "tool-row", ExtraAttrs: attrs},
		apphtml.Span(apphtml.TextConfig{Class: "tool-number", ExtraAttrs: apphtml.Attrs{"aria-hidden": "true"}}, render.Text(fmt.Sprintf("%02d", number))),
		apphtml.Div(apphtml.DivConfig{Class: "tool-identity"},
			apphtml.Heading(apphtml.HeadingConfig{Level: 3}, render.Text(title)),
			render.Tag("code", map[string]string{}, render.Text(tool.Name)),
			apphtml.Div(apphtml.DivConfig{Class: "tool-meta"}, meta...),
		),
		apphtml.Paragraph(apphtml.TextConfig{Class: "tool-description"}, render.Text(tool.Description)),
	)
}

type supportScreen struct {
	webmcpScriptURL string
	tools           []webmcp.Tool
}

func (*supportScreen) ScreenTitle() string         { return "Support console" }
func (*supportScreen) SetParams(map[string]string) {}

func (*supportScreen) ScreenDescription() string {
	return "Live support console with WebRTC video, scene state, WebMCP actions, and a case timeline."
}

func (s *supportScreen) Render() render.HTML {
	caseStatus := frameworkui.StatusBadge(frameworkui.StatusBadgeConfig{
		Label:   "Awaiting operator",
		Variant: frameworkui.StatusInfo,
		ID:      "case-status",
		Class:   "status-pill",
		ExtraAttrs: apphtml.Attrs{
			"data-state": "pending",
			"role":       "status",
			"aria-live":  "polite",
		},
	})
	caseActions := apphtml.Div(apphtml.DivConfig{Class: "case-actions"},
		frameworkui.Button(frameworkui.ButtonConfig{
			Label:   "Approve cable move",
			ID:      "approve-cable-move",
			Class:   "primary-action case-control",
			Variant: frameworkui.ButtonPrimary,
			Type:    "button",
			ExtraAttrs: apphtml.Attrs{
				"data-field-action": "approve-cable-move",
				"hidden":            "",
			},
		}),
		frameworkui.Button(frameworkui.ButtonConfig{
			Label:   "Calibrate WAN region",
			ID:      "calibrate-wan",
			Class:   "secondary-action case-control",
			Variant: frameworkui.ButtonSecondary,
			Type:    "button",
			ExtraAttrs: apphtml.Attrs{
				"data-field-action": "calibrate-wan",
				"hidden":            "",
			},
		}),
		frameworkui.Button(frameworkui.ButtonConfig{
			Label:   "Resolve verified case",
			ID:      "resolve-case",
			Class:   "primary-action case-control",
			Variant: frameworkui.ButtonPrimary,
			Type:    "button",
			ExtraAttrs: apphtml.Attrs{
				"data-field-action": "resolve-case",
				"hidden":            "",
			},
		}),
	)
	caseSummary := apphtml.Section(apphtml.SectionConfig{Label: "Current support step", Class: "session-panel", ID: "case-summary"},
		apphtml.Div(apphtml.DivConfig{Class: "session-panel-heading"},
			apphtml.Div(apphtml.DivConfig{},
				apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("NEXT ACTION")),
				apphtml.Span(apphtml.TextConfig{Class: "session-step", ID: "case-current-step", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("Pair operator")),
			),
			caseStatus,
		),
		apphtml.Heading(apphtml.HeadingConfig{Level: 2, ExtraAttrs: apphtml.Attrs{"id": "next-step-title"}}, render.Text("Pair the operator")),
		apphtml.Paragraph(apphtml.TextConfig{Class: "next-step-rationale", ID: "next-step-rationale"}, render.Text("Scan the code in the live workspace, then wait for the operator camera.")),
		caseActions,
	)

	return apphtml.Div(apphtml.DivConfig{Class: "field-app support-console", ID: "support-app", ExtraAttrs: apphtml.Attrs{"data-role": "support", "data-fui-field-assist": "support"}},
		appHeader("Support console", s.tools),
		apphtml.Div(apphtml.DivConfig{Class: "console-grid"},
			apphtml.Section(apphtml.SectionConfig{Label: "Live operator camera", Class: "live-column"},
				apphtml.Div(apphtml.DivConfig{Class: "section-heading"},
					apphtml.Div(apphtml.DivConfig{},
						apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("LIVE FIELD VIEW")),
						apphtml.Heading(apphtml.HeadingConfig{Level: 1}, render.Text("Operator camera")),
					),
					apphtml.Div(apphtml.DivConfig{Class: "live-heading-actions"},
						connectionStatusButton(),
					),
				),
				apphtml.Div(apphtml.DivConfig{Class: "video-stage", ID: "support-stage"},
					apphtml.Video(apphtml.VideoConfig{ID: "remote-video", Class: "field-video", ExtraAttrs: apphtml.Attrs{
						"autoplay": "", "playsinline": "", "aria-label": "Live operator camera",
					}}),
					cameraStatusHUD(),
					apphtml.Div(apphtml.DivConfig{ID: "support-overlay", Class: "overlay-layer", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}),
					apphtml.Div(apphtml.DivConfig{ID: "video-empty", Class: "video-empty", ExtraAttrs: apphtml.Attrs{"data-state": "pairing"}},
						apphtml.Div(apphtml.DivConfig{Class: "stage-pairing", ID: "stage-pairing"},
							apphtml.Div(apphtml.DivConfig{Class: "qr-card"},
								apphtml.Image(apphtml.ImageConfig{
									Src: "/api/session/operator-qr", Alt: "QR code for the one-time operator join link", Class: "operator-qr", ID: "operator-qr",
									ExtraAttrs: apphtml.Attrs{"width": "320", "height": "320"},
								}),
								apphtml.Div(apphtml.DivConfig{Class: "qr-fallback", ID: "qr-fallback", ExtraAttrs: apphtml.Attrs{"hidden": ""}},
									apphtml.Span(apphtml.TextConfig{}, render.Text("QR")),
									apphtml.Strong(apphtml.TextConfig{}, render.Text("Use secure link")),
								),
								apphtml.Span(apphtml.TextConfig{Class: "qr-caption"}, render.Text("Scan with phone camera")),
							),
							apphtml.Div(apphtml.DivConfig{Class: "stage-pairing-details"},
								apphtml.Div(apphtml.DivConfig{Class: "stage-pairing-copy"},
									apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("PAIR THE OPERATOR")),
									apphtml.Heading(apphtml.HeadingConfig{Level: 2}, render.Text("Scan to open the camera")),
									apphtml.Paragraph(apphtml.TextConfig{Class: "stage-pairing-note"}, render.Text("Open the one-time link on the operator phone, then allow camera access.")),
								),
								apphtml.Div(apphtml.DivConfig{Class: "pairing-actions"},
									apphtml.Div(apphtml.DivConfig{Class: "join-link-row"},
										apphtml.Link(apphtml.LinkConfig{Href: "/", Text: "Preparing join link…", ID: "operator-link"}),
										frameworkui.CopyButton(frameworkui.CopyButtonConfig{
											Target:      "#operator-link",
											Label:       "Copy link",
											CopiedLabel: "Copied",
											AriaLabel:   "Copy operator join link",
											ID:          "copy-operator-link",
											Class:       "stage-copy-action",
											ExtraAttrs:  apphtml.Attrs{"data-field-copy-control": "operator-link", "hidden": ""},
										}),
									),
									apphtml.Paragraph(apphtml.TextConfig{Class: "qr-status", ID: "qr-status", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("Generating secure code…")),
								),
							),
						),
						apphtml.Div(apphtml.DivConfig{Class: "stage-joined", ID: "stage-joined", ExtraAttrs: apphtml.Attrs{"hidden": ""}},
							apphtml.Span(apphtml.TextConfig{Class: "stage-joined-mark", ExtraAttrs: apphtml.Attrs{"aria-hidden": "true"}}, render.Text("01")),
							apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("PHONE PAIRED")),
							apphtml.Heading(apphtml.HeadingConfig{Level: 2}, render.Text("Waiting for the rear camera")),
							apphtml.Paragraph(apphtml.TextConfig{}, render.Text("Ask the operator to allow camera access or tap Start rear camera.")),
						),
					),
				),
				apphtml.Div(apphtml.DivConfig{Class: "phone-banner-bar"},
					apphtml.Div(apphtml.DivConfig{Class: "phone-banner-summary"},
						apphtml.Span(apphtml.TextConfig{Class: "phone-banner-label"}, render.Text("PHONE BANNER")),
						apphtml.Strong(apphtml.TextConfig{ID: "support-banner-preview"}, render.Text("No active instruction")),
					),
					apphtml.Div(apphtml.DivConfig{Class: "phone-banner-actions"},
						render.Tag("button", map[string]string{
							"type":          "button",
							"id":            "support-banner-dialog-trigger",
							"class":         "phone-banner-trigger",
							"aria-haspopup": "dialog",
							"aria-controls": "support-banner-dialog",
						}, render.Text("Compose")),
						render.Tag("button", map[string]string{
							"type":       "button",
							"id":         "support-banner-clear",
							"class":      "phone-banner-clear",
							"hidden":     "",
							"aria-label": "Remove phone banner",
						}, render.Text("Remove")),
					),
				),
			),
			apphtml.Aside(apphtml.AsideConfig{Label: "Session controls and case activity", Class: "case-column"},
				apphtml.Section(apphtml.SectionConfig{Label: "Codex WebMCP model requirement", Class: "session-model-requirement", ExtraAttrs: apphtml.Attrs{"role": "note"}},
					apphtml.Div(apphtml.DivConfig{Class: "session-model-heading"},
						apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("CODEX WEBMCP")),
						apphtml.Span(apphtml.TextConfig{Class: "session-model-badge"}, render.Text("TERRA / SOL")),
					),
					apphtml.Strong(apphtml.TextConfig{}, render.Text("Choose GPT-5.6 Terra or Sol in Codex.")),
					apphtml.Paragraph(apphtml.TextConfig{}, render.Text("Luna currently cannot use this page’s WebMCP tools.")),
				),
				caseSummary,
				apphtml.Section(apphtml.SectionConfig{Label: "Session conversation", Class: "support-conversation", ID: "support-conversation"},
					apphtml.Div(apphtml.DivConfig{Class: "conversation-heading"},
						apphtml.Div(apphtml.DivConfig{},
							apphtml.Span(apphtml.TextConfig{Class: "metric-label"}, render.Text("CONVERSATION")),
							apphtml.Strong(apphtml.TextConfig{}, render.Text("Operator + support + Codex")),
						),
						apphtml.Span(apphtml.TextConfig{Class: "conversation-count", ID: "support-message-count"}, render.Text("0 messages")),
					),
					apphtml.OrderedList(apphtml.ListConfig{Class: "conversation-list", ID: "support-message-list", ExtraAttrs: apphtml.Attrs{"aria-live": "polite", "aria-label": "Session messages"}}),
					apphtml.Form(apphtml.FormConfig{Method: "POST", ID: "support-chat-form", Class: "conversation-form"},
						apphtml.Label(apphtml.LabelConfig{For: "support-chat-input", Text: "Reply to operator", Class: "sr-only"}),
						apphtml.Input(apphtml.InputConfig{Type: "text", Name: "text", ID: "support-chat-input", Placeholder: "Write a concise reply…", ExtraAttrs: apphtml.Attrs{"maxlength": "500", "autocomplete": "off"}}),
						frameworkui.Button(frameworkui.ButtonConfig{Label: "Send", Type: "submit", Variant: frameworkui.ButtonSecondary, Size: frameworkui.ButtonSizeSmall, Class: "conversation-send"}),
					),
					apphtml.Paragraph(apphtml.TextConfig{Class: "conversation-status muted", ID: "support-chat-status", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("")),
				),
				apphtml.Section(apphtml.SectionConfig{Label: "Scene tools", Class: "scene-panel", ExtraAttrs: apphtml.Attrs{"hidden": "", "data-media": "waiting"}},
					apphtml.Div(apphtml.DivConfig{Class: "section-heading compact"},
						apphtml.Div(apphtml.DivConfig{},
							apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("SCENE MODEL")),
							apphtml.Heading(apphtml.HeadingConfig{Level: 2, ExtraAttrs: apphtml.Attrs{"id": "scene-title"}}, render.Text("Awaiting scene")),
						),
					),
					apphtml.Paragraph(apphtml.TextConfig{Class: "scene-tools-gate muted", ID: "scene-tools-gate", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("Scene controls will appear when the operator camera is live.")),
					apphtml.Div(apphtml.DivConfig{Class: "scene-workbench", ID: "scene-workbench", ExtraAttrs: apphtml.Attrs{"hidden": ""}},
						apphtml.Section(apphtml.SectionConfig{Label: "Operator request", Class: "operator-issue-summary", ID: "operator-issue-summary", ExtraAttrs: apphtml.Attrs{"hidden": "", "aria-live": "polite"}},
							apphtml.Span(apphtml.TextConfig{Class: "metric-label"}, render.Text("OPERATOR REQUEST")),
							apphtml.Strong(apphtml.TextConfig{ID: "operator-issue-title"}, render.Text("Waiting for a selection")),
							apphtml.Paragraph(apphtml.TextConfig{Class: "muted", ID: "operator-issue-detail"}, render.Text("")),
						),
						apphtml.Div(apphtml.DivConfig{Class: "scene-summary", ID: "scene-summary", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}},
							apphtml.Div(apphtml.DivConfig{Class: "scene-summary-heading"},
								apphtml.Div(apphtml.DivConfig{},
									apphtml.Span(apphtml.TextConfig{Class: "metric-label"}, render.Text("Physical state")),
									apphtml.Strong(apphtml.TextConfig{ID: "scene-state"}, render.Text("Awaiting observation")),
									apphtml.Span(apphtml.TextConfig{Class: "scene-state-detail", ID: "scene-state-detail"}, render.Text("Add a target from the live camera to begin")),
								),
								apphtml.Span(apphtml.TextConfig{Class: "scene-version", ID: "scene-version"}, render.Text("Scene v1")),
							),
							apphtml.Paragraph(apphtml.TextConfig{Class: "scene-updated", ID: "scene-updated"}, render.Text("Waiting for scene telemetry.")),
						),
						apphtml.Section(apphtml.SectionConfig{Label: "Codex room context", Class: "room-context", ID: "room-context"},
							apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("CODEX ROOM CONTEXT")),
							apphtml.Strong(apphtml.TextConfig{ID: "room-context-summary"}, render.Text("No room context yet")),
							apphtml.Paragraph(apphtml.TextConfig{Class: "muted", ID: "room-context-empty"}, render.Text("Ask Codex to describe visible room landmarks.")),
							apphtml.UnorderedList(apphtml.ListConfig{Class: "room-context-observations", ID: "room-context-observations"}),
							apphtml.Paragraph(apphtml.TextConfig{Class: "room-context-meta muted", ID: "room-context-meta"}, render.Text("")),
						),
						apphtml.Div(apphtml.DivConfig{Class: "support-instruction", ID: "support-instruction", ExtraAttrs: apphtml.Attrs{"hidden": "", "aria-live": "polite"}},
							apphtml.Span(apphtml.TextConfig{Class: "metric-label", ID: "support-instruction-label"}, render.Text("CODEX PHONE BANNER")),
							apphtml.Strong(apphtml.TextConfig{ID: "support-instruction-title"}, render.Text("")),
							apphtml.Span(apphtml.TextConfig{ID: "support-instruction-detail"}, render.Text("")),
						),
						apphtml.Div(apphtml.DivConfig{Class: "support-question", ID: "support-question", ExtraAttrs: apphtml.Attrs{"hidden": "", "aria-live": "polite"}},
							apphtml.Span(apphtml.TextConfig{Class: "metric-label", ID: "support-question-label"}, render.Text("OPERATOR RESPONSE")),
							apphtml.Strong(apphtml.TextConfig{ID: "support-question-prompt"}, render.Text("")),
							apphtml.Span(apphtml.TextConfig{ID: "support-question-status"}, render.Text("")),
						),
						apphtml.Div(apphtml.DivConfig{Class: "scene-object-list", ID: "scene-object-list", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}),
						apphtml.Div(apphtml.DivConfig{Class: "object-row demo-object-row", ID: "demo-object-row", ExtraAttrs: apphtml.Attrs{"data-object-id": "wan-port"}},
							apphtml.Div(apphtml.DivConfig{},
								apphtml.Strong(apphtml.TextConfig{}, render.Text("WAN port")),
								apphtml.Paragraph(apphtml.TextConfig{Class: "muted"}, render.Text("Blue uplink port · calibrated region")),
							),
							frameworkui.Button(frameworkui.ButtonConfig{Label: "Highlight", ID: "highlight-wan", Variant: frameworkui.ButtonPrimary, Size: frameworkui.ButtonSizeSmall, Class: "primary-action compact-action"}),
						),
						apphtml.Div(apphtml.DivConfig{Class: "target-builder"},
							apphtml.Label(apphtml.LabelConfig{For: "target-label", Text: "Observed control or target"}),
							apphtml.Div(apphtml.DivConfig{Class: "target-builder-row"},
								apphtml.Input(apphtml.InputConfig{Type: "text", Name: "targetLabel", ID: "target-label", Placeholder: "Power button", ExtraAttrs: apphtml.Attrs{"maxlength": "120"}}),
								frameworkui.Button(frameworkui.ButtonConfig{Label: "Add target", ID: "add-scene-target", Variant: frameworkui.ButtonSecondary, Class: "secondary-action", Type: "button"}),
							),
							apphtml.Paragraph(apphtml.TextConfig{Class: "muted target-builder-help"}, render.Text("Name the control, then drag around it in the live video. The camera frame stays in the browser.")),
						),
						apphtml.Div(apphtml.DivConfig{Class: "scene-actions"},
							frameworkui.Button(frameworkui.ButtonConfig{Label: "Request close-up", ID: "request-closeup", Variant: frameworkui.ButtonSecondary, Class: "secondary-action scene-action", ExtraAttrs: apphtml.Attrs{"data-object-id": "wan-port"}}),
							frameworkui.Button(frameworkui.ButtonConfig{Label: "Capture snapshot", ID: "capture-snapshot", Variant: frameworkui.ButtonSecondary, Class: "secondary-action scene-action"}),
						),
						apphtml.Paragraph(apphtml.TextConfig{Class: "scene-action-status muted", ID: "scene-action-status", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("Manual scene controls are ready.")),
						apphtml.Div(apphtml.DivConfig{Class: "snapshot-status-row"},
							apphtml.Span(apphtml.TextConfig{Class: "metric-label"}, render.Text("Latest snapshot")),
							apphtml.Strong(apphtml.TextConfig{ID: "snapshot-status"}, render.Text("None captured")),
						),
						apphtml.OrderedList(apphtml.ListConfig{Class: "snapshot-history", ID: "snapshot-history", ExtraAttrs: apphtml.Attrs{"aria-label": "Captured snapshots"}}),
						frameworkui.Button(frameworkui.ButtonConfig{Label: "Clear guidance", ID: "clear-annotations", Variant: frameworkui.ButtonGhost, Class: "text-action"}),
					),
				),
				apphtml.Section(apphtml.SectionConfig{Label: "Case timeline", Class: "timeline-panel"},
					render.Tag("details", map[string]string{"id": "case-timeline-details", "class": "timeline-details"}, render.Join(
						render.Tag("summary", map[string]string{"class": "timeline-summary"}, render.Join(
							apphtml.Div(apphtml.DivConfig{},
								apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("CASE TIMELINE")),
								apphtml.Heading(apphtml.HeadingConfig{Level: 2}, render.Text("What happened")),
							),
							apphtml.Span(apphtml.TextConfig{Class: "timeline-count", ID: "timeline-count", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("0 events")),
						)),
						render.Tag("ol", map[string]string{"id": "timeline", "class": "timeline"},
							render.Tag("li", map[string]string{"class": "timeline-empty"}, render.Text("Activity will appear as the session unfolds.")),
						),
					)),
				),
			),
		),
		connectionStatusPopover(),
		supportBannerDialog(),
		s.webMCPBridgeScript(),
	)
}

func (s *supportScreen) webMCPBridgeScript() render.HTML {
	if s.webmcpScriptURL == "" {
		return ""
	}
	return apphtml.Script(s.webmcpScriptURL)
}

func connectionStatusButton() render.HTML {
	return render.Tag("button", map[string]string{
		"type":          "button",
		"id":            "peer-status",
		"class":         "status-pill connection-status-trigger",
		"data-state":    "pending",
		"popovertarget": "connection-status-popover",
		"aria-label":    "Connection status",
	}, render.Text("Waiting for operator"))
}

func connectionStatusPopover() render.HTML {
	return apphtml.Div(apphtml.DivConfig{Class: "connection-status-popover", ID: "connection-status-popover", ExtraAttrs: apphtml.Attrs{
		"popover":    "auto",
		"role":       "status",
		"aria-label": "Live connection status",
	}},
		apphtml.Div(apphtml.DivConfig{Class: "connection-popover-heading"},
			apphtml.Span(apphtml.TextConfig{Class: "eyebrow"}, render.Text("CONNECTION STATUS")),
			apphtml.Span(apphtml.TextConfig{Class: "connection-live-mark"}, render.Text("LIVE")),
		),
		apphtml.Div(apphtml.DivConfig{Class: "connection-popover-metrics"},
			metric("signal-status", "Signaling", "Connecting"),
			metric("ice-status", "ICE", "New"),
			metric("media-status", "Media", "Waiting"),
		),
	)
}

func supportBannerDialog() render.HTML {
	return render.Tag("dialog", map[string]string{
		"id":              "support-banner-dialog",
		"class":           "app-dialog support-banner-dialog",
		"aria-labelledby": "support-banner-dialog-title",
	}, apphtml.Section(apphtml.SectionConfig{Label: "Phone banner composer", Class: "support-banner-composer", ID: "support-banner-composer"},
		apphtml.Div(apphtml.DivConfig{Class: "banner-composer-heading"},
			apphtml.Div(apphtml.DivConfig{},
				apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("PHONE BANNER")),
				apphtml.Heading(apphtml.HeadingConfig{Level: 2, ExtraAttrs: apphtml.Attrs{"id": "support-banner-dialog-title"}}, render.Text("Put an instruction on the live view")),
			),
			render.Tag("button", map[string]string{"type": "button", "id": "support-banner-dialog-close", "class": "dialog-close", "aria-label": "Close phone banner"}, render.Text("Close")),
		),
		apphtml.Paragraph(apphtml.TextConfig{Class: "banner-composer-copy"}, render.Text("Send the one instruction the operator must notice while holding the phone. Both fields are required.")),
		apphtml.Form(apphtml.FormConfig{Method: "POST", ID: "support-banner-form", Class: "support-banner-form"},
			apphtml.Div(apphtml.DivConfig{Class: "banner-field"},
				apphtml.Label(apphtml.LabelConfig{For: "support-banner-title", Text: "Short command · required"}),
				apphtml.Input(apphtml.InputConfig{Type: "text", Name: "title", ID: "support-banner-title", Placeholder: "HOLD STEADY", ExtraAttrs: apphtml.Attrs{"maxlength": "80", "autocomplete": "off", "required": "", "aria-required": "true"}}),
			),
			apphtml.Div(apphtml.DivConfig{Class: "banner-field"},
				apphtml.Label(apphtml.LabelConfig{For: "support-banner-detail", Text: "What to do · required"}),
				apphtml.Input(apphtml.InputConfig{Type: "text", Name: "detail", ID: "support-banner-detail", Placeholder: "Keep the control centered in the frame.", ExtraAttrs: apphtml.Attrs{"maxlength": "180", "autocomplete": "off", "required": "", "aria-required": "true"}}),
			),
			apphtml.Div(apphtml.DivConfig{Class: "banner-submit-row"},
				apphtml.Paragraph(apphtml.TextConfig{Class: "banner-status", ID: "support-banner-status", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("Replaces the current yellow banner.")),
				frameworkui.Button(frameworkui.ButtonConfig{Label: "Send yellow banner", Type: "submit", Variant: frameworkui.ButtonPrimary, Class: "banner-send", ID: "support-banner-send"}),
			),
		),
	))
}

type operatorScreen struct{}

func (*operatorScreen) ScreenTitle() string         { return "Operator camera" }
func (*operatorScreen) SetParams(map[string]string) {}

func (*operatorScreen) ScreenDescription() string {
	return "Phone camera interface for receiving visual guidance from the support session."
}

func (*operatorScreen) Render() render.HTML {
	return apphtml.Div(apphtml.DivConfig{Class: "field-app operator-console", ID: "operator-app", ExtraAttrs: apphtml.Attrs{"data-role": "operator", "data-fui-field-assist": "operator"}},
		apphtml.Header(apphtml.HeaderConfig{Class: "operator-header", Banner: true},
			apphtml.Div(apphtml.DivConfig{Class: "brand-lockup"},
				apphtml.Span(apphtml.TextConfig{Class: "brand-mark", ExtraAttrs: apphtml.Attrs{"aria-hidden": "true"}}, render.Text("GF")),
				apphtml.Div(apphtml.DivConfig{},
					apphtml.Strong(apphtml.TextConfig{}, render.Text("Field Assist")),
					apphtml.Span(apphtml.TextConfig{Class: "operator-caption"}, render.Text("Operator view")),
				),
			),
			statusPill("operator-status", "Joining"),
		),
		apphtml.Div(apphtml.DivConfig{Class: "operator-main"},
			apphtml.Section(apphtml.SectionConfig{Label: "Camera and visual guidance", Class: "operator-stage", ID: "operator-stage"},
				apphtml.Video(apphtml.VideoConfig{ID: "local-video", Class: "field-video", ExtraAttrs: apphtml.Attrs{
					"autoplay": "", "playsinline": "", "muted": "", "aria-label": "Rear camera preview",
				}}),
				apphtml.Div(apphtml.DivConfig{ID: "operator-overlay", Class: "overlay-layer", ExtraAttrs: apphtml.Attrs{"aria-live": "assertive"}}),
				render.Tag("details", map[string]string{"class": "operator-status-hud", "id": "operator-status-hud", "hidden": ""}, render.Join(
					render.Tag("summary", map[string]string{"class": "operator-status-trigger", "id": "operator-status-trigger", "aria-controls": "operator-status-panel", "aria-expanded": "false"}, render.Text("Display status")),
					apphtml.Div(apphtml.DivConfig{Class: "operator-status-panel", ID: "operator-status-panel", ExtraAttrs: apphtml.Attrs{"aria-label": "Current operator status"}},
						apphtml.Paragraph(apphtml.TextConfig{Class: "operator-status-panel-title"}, render.Text("SESSION STATUS")),
						apphtml.Div(apphtml.DivConfig{Class: "operator-status-instruction"},
							apphtml.Span(apphtml.TextConfig{Class: "operator-status-row-label"}, render.Text("Current guidance")),
							apphtml.Paragraph(apphtml.TextConfig{ID: "operator-instruction", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("No active instruction.")),
						),
						operatorStatusRow("Connection", "operator-connection-status", "Joining"),
						operatorStatusRow("Visual check", "operator-scene-activity-status", "Visual check idle"),
						operatorStatusRow("Tracking", "operator-tracking-status", "Tracking idle"),
						operatorStatusRow("Spatial perception", "operator-perception-status", "Spatial perception idle"),
						operatorStatusRow("Banner delivery", "operator-banner-status", "No active banner"),
						apphtml.Paragraph(apphtml.TextConfig{Class: "privacy-note"}, render.Text("Peer-to-peer · no recording")),
					),
				)),
				apphtml.Section(apphtml.SectionConfig{Label: "Choose how to begin", Class: "operator-issue-chooser", ID: "operator-issue-chooser", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}},
					apphtml.Div(apphtml.DivConfig{Class: "operator-issue-copy"},
						apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("START THE CONVERSATION")),
						apphtml.Heading(apphtml.HeadingConfig{Level: 1}, render.Text("What do you need help with?")),
						apphtml.Paragraph(apphtml.TextConfig{}, render.Text("Choose the starter below or describe anything else. Field Assist receives only what you send.")),
					),
					frameworkui.Button(frameworkui.ButtonConfig{
						Label: "I lost my controller — help me control my TV", ID: "operator-tv-demo", Variant: frameworkui.ButtonPrimary, Size: frameworkui.ButtonSizeLarge, Class: "operator-demo-choice",
						ExtraAttrs: apphtml.Attrs{"data-preset-id": "lost-tv-controller"},
					}),
					apphtml.Div(apphtml.DivConfig{Class: "operator-issue-divider"}, render.Text("OR DESCRIBE SOMETHING ELSE")),
					apphtml.Form(apphtml.FormConfig{Method: "POST", ID: "operator-freeform-issue-form"},
						apphtml.Label(apphtml.LabelConfig{For: "operator-freeform-issue", Text: "What is happening?"}),
						apphtml.Input(apphtml.InputConfig{Type: "text", Name: "summary", ID: "operator-freeform-issue", Placeholder: "My device will not turn on…", ExtraAttrs: apphtml.Attrs{"maxlength": "280", "autocomplete": "off"}}),
						frameworkui.Button(frameworkui.ButtonConfig{Label: "Start free-form help", ID: "operator-freeform-submit", Type: "submit", Variant: frameworkui.ButtonSecondary, Size: frameworkui.ButtonSizeLarge, Class: "operator-freeform-submit"}),
					),
					apphtml.Paragraph(apphtml.TextConfig{Class: "operator-issue-status", ID: "operator-issue-status", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("")),
				),
				apphtml.Div(apphtml.DivConfig{ID: "camera-permission", Class: "camera-permission"},
					apphtml.Heading(apphtml.HeadingConfig{Level: 1}, render.Text("Share your camera when ready")),
					apphtml.Paragraph(apphtml.TextConfig{}, render.Text("The live video goes directly to the support representative. It is not recorded.")),
					frameworkui.Button(frameworkui.ButtonConfig{Label: "Start rear camera", ID: "start-camera", Variant: frameworkui.ButtonPrimary, Size: frameworkui.ButtonSizeLarge, Class: "primary-action"}),
				),
				frameworkui.Button(frameworkui.ButtonConfig{Label: "Chat", ID: "operator-chat-toggle", Type: "button", Variant: frameworkui.ButtonSecondary, Class: "operator-chat-toggle", ExtraAttrs: apphtml.Attrs{"aria-expanded": "false", "aria-controls": "operator-chat-panel"}}),
			),
			apphtml.Aside(apphtml.AsideConfig{Label: "Session conversation", Class: "operator-chat-panel", ID: "operator-chat-panel", ExtraAttrs: apphtml.Attrs{"hidden": ""}},
				apphtml.Div(apphtml.DivConfig{Class: "operator-chat-heading"},
					apphtml.Div(apphtml.DivConfig{},
						apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("LIVE TEXT")),
						apphtml.Heading(apphtml.HeadingConfig{Level: 2}, render.Text("Conversation")),
					),
					render.Tag("button", map[string]string{"type": "button", "id": "operator-chat-close", "class": "operator-chat-close", "aria-label": "Close conversation"}, render.Text("Close")),
				),
				apphtml.OrderedList(apphtml.ListConfig{Class: "conversation-list operator-conversation-list", ID: "operator-message-list", ExtraAttrs: apphtml.Attrs{"aria-live": "polite", "aria-label": "Session messages"}}),
				apphtml.Form(apphtml.FormConfig{Method: "POST", ID: "operator-chat-form", Class: "conversation-form operator-conversation-form"},
					apphtml.Label(apphtml.LabelConfig{For: "operator-chat-input", Text: "Message support", Class: "sr-only"}),
					apphtml.Input(apphtml.InputConfig{Type: "text", Name: "text", ID: "operator-chat-input", Placeholder: "Tell support what you see…", ExtraAttrs: apphtml.Attrs{"maxlength": "500", "autocomplete": "off", "enterkeyhint": "send"}}),
					frameworkui.Button(frameworkui.ButtonConfig{Label: "Send", Type: "submit", Variant: frameworkui.ButtonPrimary, Class: "conversation-send"}),
				),
				apphtml.Paragraph(apphtml.TextConfig{Class: "conversation-status", ID: "operator-chat-status", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("")),
			),
			apphtml.Div(apphtml.DivConfig{Class: "operator-footer"},
				apphtml.Section(apphtml.SectionConfig{Label: "Question from support", Class: "operator-question", ID: "operator-question", ExtraAttrs: apphtml.Attrs{"hidden": "", "aria-live": "assertive"}},
					apphtml.Paragraph(apphtml.TextConfig{Class: "operator-question-source", ID: "operator-question-source"}, render.Text("CODEX IS ASKING")),
					apphtml.Heading(apphtml.HeadingConfig{Level: 2, ExtraAttrs: apphtml.Attrs{"id": "operator-question-prompt"}}, render.Text("")),
					apphtml.Div(apphtml.DivConfig{Class: "operator-question-options", ID: "operator-question-options"}),
					apphtml.Paragraph(apphtml.TextConfig{Class: "operator-question-status", ID: "operator-question-status"}, render.Text("")),
				),
				apphtml.Div(apphtml.DivConfig{Class: "operator-actions", ID: "operator-actions"},
					frameworkui.Button(frameworkui.ButtonConfig{Label: "Done — cable moved", ID: "confirm-cable-moved", Variant: frameworkui.ButtonPrimary, Size: frameworkui.ButtonSizeLarge, Class: "primary-action operator-action", ExtraAttrs: apphtml.Attrs{"hidden": ""}}),
					apphtml.Paragraph(apphtml.TextConfig{Class: "operator-action-status", ID: "confirm-status", ExtraAttrs: apphtml.Attrs{"aria-live": "polite"}}, render.Text("")),
				),
			),
		),
	)
}

func appHeader(subtitle string, tools []webmcp.Tool) render.HTML {
	toolsAction := render.HTML(apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/tools", Class: "header-action tools-link", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Text("View tools")}))
	toolsDialogHTML := render.HTML("")
	if len(tools) > 0 {
		toolsAction = render.Tag("button", map[string]string{
			"type":          "button",
			"id":            "tools-dialog-trigger",
			"class":         "header-action tools-link",
			"aria-haspopup": "dialog",
			"aria-controls": "tools-dialog",
		}, render.Text("View tools"))
		toolsDialogHTML = toolDialog(tools)
	}

	return apphtml.Header(apphtml.HeaderConfig{Class: "app-header", Banner: true},
		apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/", Class: "brand-lockup", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Join(
			apphtml.Span(apphtml.TextConfig{Class: "brand-mark", ExtraAttrs: apphtml.Attrs{"aria-hidden": "true"}}, render.Text("GF")),
			apphtml.Div(apphtml.DivConfig{},
				apphtml.Strong(apphtml.TextConfig{}, render.Text("Field Assist")),
				apphtml.Span(apphtml.TextConfig{Class: "brand-subtitle"}, render.Text(subtitle)),
			),
		)}),
		apphtml.Div(apphtml.DivConfig{Class: "app-header-actions"},
			apphtml.Span(apphtml.TextConfig{Class: "app-ready"}, render.Text("Ready")),
			apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/new", Class: "header-action", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Text("New session")}),
			toolsAction,
			apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/stack", Class: "stack-link", ExtraAttrs: apphtml.Attrs{"target": "_top"}, Content: render.Text("Check the stack")}),
		),
		toolsDialogHTML,
	)
}

func toolDialog(tools []webmcp.Tool) render.HTML {
	rows := make([]render.HTML, 0, len(tools))
	for index, tool := range tools {
		rows = append(rows, toolCatalogRow(index+1, tool))
	}

	return render.Tag("dialog", map[string]string{
		"id":              "tools-dialog",
		"class":           "app-dialog tools-dialog",
		"aria-labelledby": "tools-dialog-title",
	}, apphtml.Div(apphtml.DivConfig{Class: "tools-dialog-shell"},
		apphtml.Div(apphtml.DivConfig{Class: "dialog-heading"},
			apphtml.Div(apphtml.DivConfig{},
				apphtml.Paragraph(apphtml.TextConfig{Class: "eyebrow"}, render.Text("AVAILABLE WEBMCP TOOLS")),
				apphtml.Heading(apphtml.HeadingConfig{Level: 2, ExtraAttrs: apphtml.Attrs{"id": "tools-dialog-title"}}, render.Text(fmt.Sprintf("%d session capabilities", len(tools)))),
			),
			render.Tag("button", map[string]string{"type": "button", "id": "tools-dialog-close", "class": "dialog-close", "aria-label": "Close tool catalog"}, render.Text("Close")),
		),
		apphtml.Paragraph(apphtml.TextConfig{Class: "dialog-intro"}, render.Text("Codex can use these only while this authenticated support page is open.")),
		apphtml.Div(apphtml.DivConfig{Class: "tool-list tools-dialog-list", Role: "list"}, rows...),
		apphtml.LinkHTML(apphtml.LinkHTMLConfig{Href: "/tools", Class: "dialog-catalog-link", ExtraAttrs: apphtml.Attrs{"target": "_blank", "rel": "noopener"}, Content: render.Text("Open the full public catalog ↗")}),
	))
}

func statusPill(id, text string) render.HTML {
	return frameworkui.StatusPill(frameworkui.StatusPillConfig{
		Label: text,
		ID:    id,
		Class: "status-pill",
		Dot:   false,
		ExtraAttrs: apphtml.Attrs{
			"data-state": "pending",
			"role":       "status",
			"aria-live":  "polite",
		},
	})
}

func operatorStatusRow(label, id, text string) render.HTML {
	return apphtml.Div(apphtml.DivConfig{Class: "operator-status-row"},
		apphtml.Span(apphtml.TextConfig{Class: "operator-status-row-label"}, render.Text(label)),
		statusPill(id, text),
	)
}

func cameraStatusHUD() render.HTML {
	return apphtml.Div(apphtml.DivConfig{Class: "camera-status-hud", ID: "camera-status-hud", ExtraAttrs: apphtml.Attrs{
		"aria-label": "Live scene system status",
	}},
		apphtml.Div(apphtml.DivConfig{Class: "camera-status-items", ID: "camera-status-items"},
			cameraStatusIcon("support-guidance-delivery-status", "guidance", "Guidance idle"),
			cameraStatusIcon("support-scene-activity-status", "vision", "Visual check idle"),
			cameraStatusIcon("support-tracking-status", "tracking", "Tracking idle"),
			cameraStatusIcon("support-perception-status", "spatial", "Spatial perception idle"),
			cameraStatusIcon("webmcp-status", "webmcp", "WebMCP probing"),
		),
		render.Tag("button", map[string]string{
			"type":          "button",
			"id":            "camera-status-toggle",
			"class":         "camera-status-toggle",
			"aria-label":    "Show scene system status",
			"aria-controls": "camera-status-items",
			"aria-expanded": "false",
		}, render.Join(
			apphtml.Span(apphtml.TextConfig{Class: "camera-status-kebab", ExtraAttrs: apphtml.Attrs{"aria-hidden": "true"}}, render.Text("•••")),
		)),
	)
}

func cameraStatusIcon(id, kind, label string) render.HTML {
	return render.Tag("button", map[string]string{
		"type":                "button",
		"class":               "camera-status-control",
		"data-status-control": kind,
		"data-status-label":   label,
		"data-state":          "pending",
		"aria-label":          label,
	}, render.Join(
		cameraStatusGlyph(kind),
		apphtml.Span(apphtml.TextConfig{Class: "camera-status-label", ID: id, ExtraAttrs: apphtml.Attrs{
			"data-state": "pending",
			"role":       "status",
			"aria-live":  "polite",
		}}, render.Text(label)),
	))
}

func cameraStatusGlyph(kind string) render.HTML {
	attrs := map[string]string{
		"viewBox":     "0 0 24 24",
		"aria-hidden": "true",
		"focusable":   "false",
	}
	stroke := map[string]string{
		"fill":            "none",
		"stroke":          "currentColor",
		"stroke-width":    "1.8",
		"stroke-linecap":  "round",
		"stroke-linejoin": "round",
	}
	var shapes []render.HTML
	switch kind {
	case "guidance":
		shapes = []render.HTML{render.Tag("path", mergeAttrs(stroke, map[string]string{"d": "M4 12h14m-5-5 5 5-5 5"}))}
	case "vision":
		shapes = []render.HTML{
			render.Tag("path", mergeAttrs(stroke, map[string]string{"d": "M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z"})),
			render.Tag("circle", mergeAttrs(stroke, map[string]string{"cx": "12", "cy": "12", "r": "2.3"})),
		}
	case "tracking":
		shapes = []render.HTML{
			render.Tag("circle", mergeAttrs(stroke, map[string]string{"cx": "12", "cy": "12", "r": "5"})),
			render.Tag("path", mergeAttrs(stroke, map[string]string{"d": "M12 2v3m0 14v3M2 12h3m14 0h3"})),
		}
	case "spatial":
		shapes = []render.HTML{
			render.Tag("path", mergeAttrs(stroke, map[string]string{"d": "m12 3 7 4v10l-7 4-7-4V7l7-4Z"})),
			render.Tag("path", mergeAttrs(stroke, map[string]string{"d": "m5 7 7 4 7-4M12 11v10"})),
		}
	default:
		shapes = []render.HTML{render.Tag("path", mergeAttrs(stroke, map[string]string{"d": "M8 5H5v14h3m8-14h3v14h-3M9 12h6"}))}
	}
	return render.Tag("svg", attrs, shapes...)
}

func mergeAttrs(base, extra map[string]string) map[string]string {
	merged := make(map[string]string, len(base)+len(extra))
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range extra {
		merged[key] = value
	}
	return merged
}

func perceptionStatusPill(id, text string) render.HTML {
	return frameworkui.StatusPill(frameworkui.StatusPillConfig{
		Label: text,
		ID:    id,
		Class: "status-pill perception-status-pill",
		Dot:   false,
		ExtraAttrs: apphtml.Attrs{
			"data-state":  "idle",
			"data-source": "calibrated-region",
			"data-reason": "",
			"role":        "status",
			"aria-live":   "polite",
		},
	})
}

func metric(id, label, value string) render.HTML {
	return apphtml.Div(apphtml.DivConfig{Class: "connection-metric"},
		apphtml.Span(apphtml.TextConfig{Class: "metric-label"}, render.Text(label)),
		apphtml.Strong(apphtml.TextConfig{ID: id}, render.Text(value)),
	)
}
