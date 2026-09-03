import path from "node:path";
import {Config} from "@remotion/cli/config";

Config.setPublicDir(path.resolve(process.cwd(), "../artifacts/video/output"));
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

