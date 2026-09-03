import type {CSSProperties, ReactNode} from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";

const FPS = 30;
const INTRO_SECONDS = 10;
const SOURCE_SECONDS = 143.033;
const PLAYBACK_RATE = 1.25;
const DEMO_SECONDS = SOURCE_SECONDS / PLAYBACK_RATE;
const USE_CASE_SECONDS = 21;
const STACK_SECONDS = 13;
const CLOSE_SECONDS = 6;

const INTRO_FRAMES = INTRO_SECONDS * FPS;
const DEMO_FRAMES = Math.ceil(DEMO_SECONDS * FPS);
const USE_CASE_FRAMES = USE_CASE_SECONDS * FPS;
const STACK_FRAMES = STACK_SECONDS * FPS;
const CLOSE_FRAMES = CLOSE_SECONDS * FPS;

export const VIDEO_DURATION_FRAMES =
  INTRO_FRAMES + DEMO_FRAMES + USE_CASE_FRAMES + STACK_FRAMES + CLOSE_FRAMES;

const palette = {
  paper: "#f3f0e8",
  raised: "#fbfaf5",
  ink: "#17201f",
  soft: "#54605e",
  graphite: "#111817",
  graphiteRaised: "#1c2523",
  signal: "#006d63",
  guide: "#f1a900",
  guideInk: "#1d1705",
};

const fonts = {
  display: '"Avenir Next Condensed", "Avenir Next", sans-serif',
  body: '"Avenir Next", sans-serif',
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

const easeOut = (value: number) =>
  Easing.bezier(0.16, 1, 0.3, 1)(clamp(value));

const enter = (frame: number, start: number, duration = 18) =>
  easeOut((frame - start) / duration);

const exit = (frame: number, start: number, duration = 12) =>
  1 - easeOut((frame - start) / duration);

const fadeWindow = (
  frame: number,
  start: number,
  end: number,
  enterDuration = 15,
  exitDuration = 10,
) => Math.min(enter(frame, start, enterDuration), exit(frame, end - exitDuration, exitDuration));

const Eyebrow = ({children, light = false}: {children: ReactNode; light?: boolean}) => (
  <div
    style={{
      color: light ? palette.guide : palette.signal,
      fontFamily: fonts.body,
      fontSize: 23,
      fontWeight: 800,
      letterSpacing: "0.2em",
      textTransform: "uppercase",
    }}
  >
    {children}
  </div>
);

const Wordmark = ({light = false}: {light?: boolean}) => (
  <div style={{display: "flex", alignItems: "center", gap: 18}}>
    <div
      style={{
        width: 58,
        height: 58,
        border: `2px solid ${light ? palette.paper : palette.ink}`,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        color: light ? palette.paper : palette.ink,
        fontFamily: fonts.body,
        fontSize: 18,
        fontWeight: 900,
        letterSpacing: "-0.04em",
      }}
    >
      FA
    </div>
    <div
      style={{
        color: light ? palette.paper : palette.ink,
        fontFamily: fonts.body,
        fontSize: 25,
        fontWeight: 700,
      }}
    >
      Field Assist
    </div>
  </div>
);

const AmberTrace = ({progress, dark = false}: {progress: number; dark?: boolean}) => {
  const lineWidth = 760 * clamp(progress);
  const dotX = 214 + lineWidth;

  return (
    <div style={{position: "absolute", inset: 0, pointerEvents: "none"}}>
      <div
        style={{
          position: "absolute",
          left: 214,
          top: 772,
          width: lineWidth,
          height: 4,
          background: palette.guide,
          transformOrigin: "left center",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: dotX - 9,
          top: 764,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: palette.guide,
          boxShadow: dark ? "0 0 0 7px rgba(241, 169, 0, 0.14)" : "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: dotX - 1,
          top: 772,
          width: 500 * clamp((progress - 0.72) / 0.28),
          height: 4,
          background: palette.guide,
          transform: "rotate(-23deg)",
          transformOrigin: "left center",
        }}
      />
    </div>
  );
};

const Intro = () => {
  const frame = useCurrentFrame();
  const problem = fadeWindow(frame, 0, 92, 18, 12);
  const reveal = enter(frame, 78, 24);
  const trace = easeOut((frame - 150) / 82);
  const architecture = enter(frame, 178, 24);

  return (
    <AbsoluteFill style={{background: palette.paper, color: palette.ink, overflow: "hidden"}}>
      <div style={{position: "absolute", left: 92, top: 72}}>
        <Wordmark />
      </div>

      <div
        style={{
          position: "absolute",
          left: 170,
          top: 270,
          opacity: problem,
          transform: `translateY(${interpolate(problem, [0, 1], [26, 0])}px)`,
        }}
      >
        <Eyebrow>Remote support has a translation problem</Eyebrow>
        <div
          style={{
            width: 1380,
            marginTop: 22,
            fontFamily: fonts.display,
            fontSize: 104,
            fontWeight: 800,
            letterSpacing: "-0.055em",
            lineHeight: 0.96,
          }}
        >
          “Which button?” should not be the hardest part.
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 170,
          top: 242,
          opacity: reveal,
          transform: `translateY(${interpolate(reveal, [0, 1], [34, 0])}px)`,
        }}
      >
        <Eyebrow>Live spatial guidance</Eyebrow>
        <div
          style={{
            marginTop: 12,
            fontFamily: fonts.display,
            fontSize: 164,
            fontWeight: 850,
            letterSpacing: "-0.07em",
            lineHeight: 0.88,
          }}
        >
          See it.
          <br />
          Confirm it.
          <br />
          Point to it.
        </div>
      </div>

      <AmberTrace progress={trace} />

      <div
        style={{
          position: "absolute",
          left: 1010,
          top: 705,
          display: "flex",
          alignItems: "center",
          gap: 18,
          opacity: architecture,
          transform: `translateX(${interpolate(architecture, [0, 1], [36, 0])}px)`,
          fontFamily: fonts.body,
          fontSize: 26,
          fontWeight: 700,
        }}
      >
        <span>Phone camera</span>
        <span style={{color: palette.guide}}>→</span>
        <span>Codex + WebMCP</span>
        <span style={{color: palette.guide}}>→</span>
        <span>Anchored instruction</span>
      </div>
    </AbsoluteFill>
  );
};

const chapterStarts = [0, 16, 28.8, 41.6, 68, 86.4].map((seconds) =>
  Math.round(seconds * FPS),
);

const chapters = [
  ["01", "CONNECT", "One session. Two screens. No app install."],
  ["02", "IDENTIFY", "Codex turns the live scene into a testable hypothesis."],
  ["03", "CONFIRM", "The operator stays in control of physical-world actions."],
  ["04", "TRACK", "Visual geometry follows the target as the camera moves."],
  ["05", "GUIDE", "A verified control becomes a precise instruction."],
  ["06", "ANCHOR", "The pointer corrects against the scene—not the screen."],
] as const;

const ChapterCard = ({index, start}: {index: number; start: number}) => {
  const frame = useCurrentFrame();
  const local = frame - start;
  const alpha = fadeWindow(local, 0, 84, 10, 12);
  const wipe = enter(local, 0, 18);
  const [number, title, detail] = chapters[index];

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
        opacity: alpha,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1920,
          height: 154,
          background: palette.guide,
          color: palette.guideInk,
          transform: `translateY(${interpolate(wipe, [0, 1], [-154, 0])}px)`,
          display: "flex",
          alignItems: "center",
          gap: 28,
          padding: "0 68px",
          fontFamily: fonts.body,
        }}
      >
        <div style={{fontSize: 27, fontWeight: 800, letterSpacing: "0.14em"}}>{number}</div>
        <div style={{width: 2, height: 58, background: palette.guideInk, opacity: 0.45}} />
        <div style={{fontFamily: fonts.display, fontSize: 68, fontWeight: 850, letterSpacing: "-0.05em"}}>
          {title}
        </div>
        <div style={{fontSize: 25, fontWeight: 600, marginLeft: 12}}>{detail}</div>
      </div>
    </div>
  );
};

const Demo = () => {
  const frame = useCurrentFrame();
  const reveal = enter(frame, 0, 12);

  return (
    <AbsoluteFill style={{background: palette.graphite}}>
      <OffthreadVideo
        src={staticFile("gofastr-demo-selects-sync-v2.mp4")}
        playbackRate={PLAYBACK_RATE}
        muted
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          opacity: reveal,
          transform: `scale(${interpolate(reveal, [0, 1], [1.025, 1])})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 28,
          bottom: 24,
          padding: "10px 14px",
          background: "rgba(17, 24, 23, 0.88)",
          color: palette.paper,
          fontFamily: fonts.body,
          fontSize: 18,
          fontWeight: 800,
          letterSpacing: "0.12em",
        }}
      >
        PHONE
      </div>
      <div
        style={{
          position: "absolute",
          left: 528,
          bottom: 24,
          padding: "10px 14px",
          background: "rgba(17, 24, 23, 0.88)",
          color: palette.paper,
          fontFamily: fonts.body,
          fontSize: 18,
          fontWeight: 800,
          letterSpacing: "0.12em",
        }}
      >
        CODEX + SUPPORT CONSOLE
      </div>
      {chapterStarts.map((start, index) => (
        <ChapterCard key={chapters[index][1]} index={index} start={start} />
      ))}
    </AbsoluteFill>
  );
};

const useCaseGroups = [
  {
    verb: "FIX",
    statement: "Put remote expertise beside the equipment.",
    items: ["Equipment repair", "Device setup", "Field service"],
  },
  {
    verb: "INCLUDE",
    statement: "Turn visual instructions into accessible action.",
    items: ["Accessibility", "Independent living", "Remote care"],
  },
  {
    verb: "OPERATE",
    statement: "Guide high-stakes work without occupying both hands.",
    items: ["Warehouse picking", "Inspection", "Safety training"],
  },
] as const;

const UseCases = () => {
  const frame = useCurrentFrame();
  const segment = Math.min(2, Math.floor(frame / (7 * FPS)));
  const local = frame - segment * 7 * FPS;
  const data = useCaseGroups[segment];
  const inValue = enter(local, 0, 20);
  const outValue = exit(local, 7 * FPS - 15, 15);
  const alpha = Math.min(inValue, outValue);
  const trace = easeOut((local - 36) / 90);

  return (
    <AbsoluteFill style={{background: palette.paper, color: palette.ink, overflow: "hidden"}}>
      <div style={{position: "absolute", left: 88, top: 66}}>
        <Wordmark />
      </div>
      <div
        style={{
          position: "absolute",
          left: 160,
          top: 225,
          opacity: alpha,
          transform: `translateY(${interpolate(inValue, [0, 1], [34, 0])}px)`,
        }}
      >
        <Eyebrow>One interaction model. Many physical workflows.</Eyebrow>
        <div
          style={{
            marginTop: 16,
            fontFamily: fonts.display,
            fontSize: 170,
            fontWeight: 850,
            letterSpacing: "-0.065em",
            lineHeight: 0.9,
          }}
        >
          {data.verb}
        </div>
        <div
          style={{
            width: 820,
            marginTop: 20,
            color: palette.soft,
            fontFamily: fonts.body,
            fontSize: 36,
            fontWeight: 600,
            lineHeight: 1.22,
          }}
        >
          {data.statement}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          right: 130,
          top: 245,
          width: 650,
          display: "grid",
          gap: 0,
          opacity: alpha,
        }}
      >
        {data.items.map((item, index) => {
          const itemValue = enter(local, 20 + index * 10, 18);
          return (
            <div
              key={item}
              style={{
                padding: "30px 8px",
                borderBottom: `2px solid ${palette.ink}`,
                fontFamily: fonts.display,
                fontSize: 53,
                fontWeight: 760,
                letterSpacing: "-0.035em",
                opacity: itemValue,
                transform: `translateX(${interpolate(itemValue, [0, 1], [38, 0])}px)`,
              }}
            >
              {item}
            </div>
          );
        })}
      </div>
      <AmberTrace progress={trace} />
    </AbsoluteFill>
  );
};

const Stack = () => {
  const frame = useCurrentFrame();
  const intro = enter(frame, 0, 22);
  const stack = [
    "Codex",
    "WebMCP",
    "GoFastr",
    "WebRTC",
    "OpenCV",
    "Depth Anything V2",
    "ONNX Runtime Web",
    "DeviceOrientation",
    "VPS hosting",
  ];

  return (
    <AbsoluteFill style={{background: palette.graphite, color: palette.paper}}>
      <div style={{position: "absolute", left: 90, top: 68}}>
        <Wordmark light />
      </div>
      <div style={{position: "absolute", left: 155, top: 245, opacity: intro}}>
        <Eyebrow light>Check the stack</Eyebrow>
        <div
          style={{
            width: 710,
            marginTop: 20,
            fontFamily: fonts.display,
            fontSize: 105,
            fontWeight: 830,
            letterSpacing: "-0.055em",
            lineHeight: 0.98,
          }}
        >
          Browser-native where it matters.
        </div>
        <div
          style={{
            width: 690,
            marginTop: 32,
            color: "#b8c2bf",
            fontFamily: fonts.body,
            fontSize: 29,
            lineHeight: 1.34,
          }}
        >
          Camera bytes remain peer-to-peer. Semantic state and reversible guidance move through the application.
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 990,
          top: 215,
          width: 730,
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
        }}
      >
        {stack.map((item, index) => {
          const value = enter(frame, 22 + index * 7, 18);
          return (
            <div
              key={item}
              style={{
                padding: "16px 20px",
                border: `1px solid ${index < 2 ? palette.guide : "#4e5a57"}`,
                color: index < 2 ? palette.guide : palette.paper,
                fontFamily: fonts.body,
                fontSize: 25,
                fontWeight: 700,
                opacity: value,
                transform: `translateY(${interpolate(value, [0, 1], [18, 0])}px)`,
              }}
            >
              {item}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const Close = () => {
  const frame = useCurrentFrame();
  const reveal = enter(frame, 0, 24);
  const trace = easeOut((frame - 18) / 70);

  return (
    <AbsoluteFill style={{background: palette.guide, color: palette.guideInk, overflow: "hidden"}}>
      <div
        style={{
          position: "absolute",
          left: 168,
          top: 238,
          opacity: reveal,
          transform: `translateY(${interpolate(reveal, [0, 1], [28, 0])}px)`,
        }}
      >
        <Eyebrow>Field Assist</Eyebrow>
        <div
          style={{
            width: 1450,
            marginTop: 20,
            fontFamily: fonts.display,
            fontSize: 128,
            fontWeight: 850,
            letterSpacing: "-0.06em",
            lineHeight: 0.95,
          }}
        >
          Remote expertise,
          <br />
          anchored to the real world.
        </div>
        <div
          style={{
            marginTop: 58,
            fontFamily: fonts.body,
            fontSize: 30,
            fontWeight: 700,
          }}
        >
          webmcp.donaldmurillo.com
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 160,
          bottom: 80,
          width: 1600 * trace,
          height: 5,
          background: palette.guideInk,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 160 + 1600 * trace - 9,
          bottom: 72,
          width: 21,
          height: 21,
          borderRadius: "50%",
          background: palette.guideInk,
        }}
      />
    </AbsoluteFill>
  );
};

const sectionStyle: CSSProperties = {position: "absolute", inset: 0};

export const FieldAssistDemo = () => (
  <AbsoluteFill style={{background: palette.graphite}}>
    <Sequence durationInFrames={INTRO_FRAMES} style={sectionStyle}>
      <Intro />
    </Sequence>
    <Sequence from={INTRO_FRAMES} durationInFrames={DEMO_FRAMES} style={sectionStyle}>
      <Demo />
    </Sequence>
    <Sequence
      from={INTRO_FRAMES + DEMO_FRAMES}
      durationInFrames={USE_CASE_FRAMES}
      style={sectionStyle}
    >
      <UseCases />
    </Sequence>
    <Sequence
      from={INTRO_FRAMES + DEMO_FRAMES + USE_CASE_FRAMES}
      durationInFrames={STACK_FRAMES}
      style={sectionStyle}
    >
      <Stack />
    </Sequence>
    <Sequence
      from={INTRO_FRAMES + DEMO_FRAMES + USE_CASE_FRAMES + STACK_FRAMES}
      durationInFrames={CLOSE_FRAMES}
      style={sectionStyle}
    >
      <Close />
    </Sequence>
  </AbsoluteFill>
);
