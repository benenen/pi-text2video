// Image provider dispatch and saving generated files to disk.
import * as fs from "node:fs";
import { slugify, timestamp, uniquePath } from "./files.ts";
import { generateWithMiniMax } from "./image/provider/minimax.ts";
import { generateWithOpenAI } from "./image/provider/openai.ts";
import { generateWithCodexApi } from "./image/provider/codex-api.ts";
import { generateWithCodexCli } from "./image/provider/codex-cli.ts";
import type { GeneratedImage, SavedImage, GenerateOptions } from "./image/types.ts";

export { formatBytes } from "./files.ts";
export { imageDimensions } from "./image/media.ts";
export type { GeneratedImage, SavedImage, GenerateOptions } from "./image/types.ts";

/** All providers return images in memory; saving is independent of the backend. */
export async function generateImages(options: GenerateOptions): Promise<GeneratedImage[]> {
  if (options.config.provider === "minimax") return generateWithMiniMax(options);
  if (options.config.provider !== "codex") return generateWithOpenAI(options);
  return options.config.codexMode === "api" ? generateWithCodexApi(options) : generateWithCodexCli(options);
}

export function saveImages(images: GeneratedImage[], options: { outputDir: string; prompt: string; filename?: string }): SavedImage[] {
  fs.mkdirSync(options.outputDir, { recursive: true });
  const stamp = timestamp();
  const slug = slugify(options.filename?.trim() || options.prompt);
  return images.map((image, index) => {
    const suffix = images.length > 1 ? `-${index + 1}` : "";
    const file = uniquePath(options.outputDir, `${stamp}-${slug}${suffix}`, image.ext);
    fs.writeFileSync(file, image.data);
    return {
      path: file,
      mimeType: image.mimeType,
      bytes: image.data.byteLength,
      width: image.width,
      height: image.height,
      revisedPrompt: image.revisedPrompt,
    };
  });
}
