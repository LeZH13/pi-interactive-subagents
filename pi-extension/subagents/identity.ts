import type { Theme } from "@earendil-works/pi-coding-agent";

/** Shared identity for plain status text and themed transcript/widget headers. */
export function formatSubagentIdentity(
  name: string,
  agent?: string,
  theme?: Pick<Theme, "fg" | "bold">,
): string {
  const badge = agent && name.toLowerCase() !== agent.toLowerCase() ? ` [${agent}]` : "";
  if (!theme) return name + badge;
  return theme.fg("toolTitle", theme.bold(name)) + (badge ? theme.fg("dim", badge) : "");
}
