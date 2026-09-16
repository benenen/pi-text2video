import type { Text2ImageConfig } from "../config.ts";

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  ext: string;
  /** Actual pixels, read from the file header. Absent for formats we cannot parse. */
  width?: number;
  height?: number;
  /** Some services (DALL·E 3 for one) return the prompt they actually used. */
  revisedPrompt?: string;
}

export interface SavedImage {
  path: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  revisedPrompt?: string;
}

export interface GenerateOptions {
  config: Text2ImageConfig;
  prompt: string;
  n?: number;
  size?: string;
  model?: string;
  signal?: AbortSignal;
}
