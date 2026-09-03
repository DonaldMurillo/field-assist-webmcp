export const scenarios = [
  {
    id: "lost-tv-controller",
    title: "Lost TV controller",
    operatorIssue: "I lost my controller. How do I control my TV?",
    objects: [
      {
        key: "television",
        label: "Television",
        kind: "television",
        bounds: { x: 0.14, y: 0.12, width: 0.72, height: 0.62 },
      },
      {
        key: "power-control",
        label: "TV power button",
        kind: "device-control",
        bounds: { x: 0.73, y: 0.68, width: 0.08, height: 0.08 },
      },
    ],
    expectedTargetKey: "power-control",
    requiredAny: ["draw_arrow"],
    requiredDeliveryAny: ["send_operator_instruction", "send_operator_message"],
    forbidden: ["show_region", "highlight_object", "register_scene_object"],
    task:
      "Help the connected operator use the physical controls already observed in the scene. Give hands-busy guidance on the phone and point with an arrow only, without a box.",
  },
  {
    id: "free-form-port",
    title: "Free-form unfamiliar object",
    operatorIssue: "Which port should I use for the blue network cable?",
    objects: [
      {
        key: "router",
        label: "Network router",
        kind: "network-device",
        bounds: { x: 0.12, y: 0.2, width: 0.76, height: 0.56 },
      },
      {
        key: "wan-port",
        label: "Blue WAN port",
        kind: "network-port",
        bounds: { x: 0.66, y: 0.5, width: 0.1, height: 0.12 },
      },
    ],
    expectedTargetKey: "wan-port",
    requiredAny: ["draw_arrow"],
    requiredDeliveryAny: ["send_operator_instruction", "send_operator_message"],
    forbidden: ["register_scene_object"],
    task:
      "Answer the operator's free-form request using only the observed scene. Point to the correct known target and communicate the next action on the phone.",
  },
  {
    id: "unverified-device-control",
    title: "Unverified physical control",
    operatorIssue: "I lost my controller. Turn on this PlayStation for me.",
    objects: [
      {
        key: "playstation",
        label: "PlayStation 4 console",
        kind: "appliance",
        bounds: { x: 0.24, y: 0.22, width: 0.5, height: 0.5 },
      },
    ],
    requiredAny: ["request_closeup", "request_operator_view", "request_different_angle", "send_operator_instruction", "ask_operator"],
    requiredDeliveryAny: ["send_operator_instruction", "request_closeup", "request_operator_view", "request_different_angle", "request_move", "ask_operator"],
    forbidden: ["draw_arrow", "highlight_object", "show_region", "register_scene_object", "recalibrate_object"],
    task:
      "Use device knowledge to form a likely power-control hypothesis, but do not point at the broad console object. Put provisional guidance on the phone and request the specific close view needed to verify the physical control.",
  },
];

export const repeatsPerScenario = 2;
