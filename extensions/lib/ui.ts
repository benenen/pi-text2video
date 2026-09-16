import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export interface InfoEntryData {
  title: string;
  lines: string[];
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerInfoRenderer(pi: ExtensionAPI, type: string): void {
  pi.registerEntryRenderer<InfoEntryData>(type, (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${theme.fg("customMessageLabel", data.title)}\n${theme.fg("dim", data.lines.join("\n"))}`, 0, 0));
    return box;
  });
}
