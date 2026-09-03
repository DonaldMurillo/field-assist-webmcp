import {Composition} from "remotion";
import {FieldAssistDemo, VIDEO_DURATION_FRAMES} from "./FieldAssistDemo";

export const VideoRoot = () => (
  <Composition
    id="FieldAssistDemo"
    component={FieldAssistDemo}
    durationInFrames={VIDEO_DURATION_FRAMES}
    fps={30}
    width={1920}
    height={1080}
  />
);

