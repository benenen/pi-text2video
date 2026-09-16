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
  size?: string;
  seconds?: string;
  model?: string;
  signal?: AbortSignal;
  /** Polling is slow and boring: each state change is worth showing to the user. */
  onProgress?: (message: string) => void;
}
