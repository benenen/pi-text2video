// Video generation entry point and saving generated clips to disk.
import * as fs from "node:fs";
import { slugify, timestamp, uniquePath } from "./files.ts";
import { generateWithMiniMax } from "./video/provider/minimax.ts";
import { generateWithOpenAI } from "./video/provider/openai.ts";
import type { GeneratedVideo, SavedVideo, GenerateVideoOptions } from "./video/types.ts";

export async function generateVideos(options: GenerateVideoOptions): Promise<GeneratedVideo[]> {
  return options.config.provider === "minimax" ? generateWithMiniMax(options) : generateWithOpenAI(options);
}
export { videoMimeType } from "./video/media.ts";
export type { GeneratedVideo, SavedVideo, GenerateVideoOptions } from "./video/types.ts";

export function saveVideos(videos: GeneratedVideo[], options: { outputDir: string; prompt: string; filename?: string }): SavedVideo[] {
  fs.mkdirSync(options.outputDir, { recursive: true });
  const stamp = timestamp();
  const slug = slugify(options.filename?.trim() || options.prompt);
  return videos.map((video, index) => {
    const suffix = videos.length > 1 ? `-${index + 1}` : "";
    const file = uniquePath(options.outputDir, `${stamp}-${slug}${suffix}`, video.ext);
    fs.writeFileSync(file, video.data);
    return { path: file, mimeType: video.mimeType, bytes: video.data.byteLength };
  });
}
