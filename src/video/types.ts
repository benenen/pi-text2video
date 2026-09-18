import type { Text2VideoConfig } from "../config.ts";

export interface GeneratedVideo {
  data: Buffer;
  mimeType: string;
  ext: string;
}

export interface SavedVideo {
  path: string;
  mimeType: string;
  bytes: number;
}

export interface GenerateVideoOptions {
  config: Text2VideoConfig;
  prompt: string;
  /** MiniMax frame images: local path, public URL or base64 image data URL. */
  firstFrame?: string;
  lastFrame?: string;
  /** MiniMax reference mode; mutually exclusive with firstFrame/lastFrame. */
  referenceImages?: string[];
  referenceVideos?: string[];
  referenceAudios?: string[];
  /** MiniMax ratio; reference mode also accepts adaptive. */
  ratio?: string;
  /** Base directory for relative image paths. Defaults to process.cwd(). */
  cwd?: string;
  size?: string;
  seconds?: string;
  model?: string;
  signal?: AbortSignal;
  /** Polling is slow and boring: each state change is worth showing to the user. */
  onProgress?: (message: string) => void;
}
