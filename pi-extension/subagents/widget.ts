import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  foregroundAnsi, getCellDimensions, mixColors, rgbColor, truncateToWidth, visibleWidth,
  type CellDimensions, type Component, type TUI,
} from "@earendil-works/pi-tui";

import { DEFAULT_SUBAGENTS_CONFIG, type SubagentsConfig } from "./config.ts";

export type WidgetAppearance = Pick<SubagentsConfig["status"], "animated" | "cycleSeconds" | "trailFraction">;
export const WIDGET_FRAME_MS = 25;
export const WIDGET_CYCLE_MS = DEFAULT_SUBAGENTS_CONFIG.status.cycleSeconds * 1_000;
const STATUS_REFRESH_MS = 1_000;
const RESET = "\x1b[0m";
const GLOW_COLOR_STEPS = 512;
// Distances are normalized to the screen-space perimeter. Both ends fade to
// the base color so crossing a cell/corner never switches a bright glyph on.
const GLOW_LEAD = 0.18;
const RAINBOW = [
  rgbColor(106, 169, 255), // blue
  rgbColor(85, 217, 219),  // cyan
  rgbColor(141, 211, 168), // mint
  rgbColor(230, 192, 120), // gold
  rgbColor(237, 141, 157), // coral
  rgbColor(187, 154, 247), // violet
];

export type BorderTheme = Pick<Theme, "colors" | "getColorMode">;
export interface BorderPalette { base: string; glow: string[]; trailLength: number }
export interface WidgetRow { left: string; right: string }
type PaintBorder = (glyph: string, column: number) => string;
const plainBorder: PaintBorder = (glyph) => glyph;

function smoothstep(value: number): number { return value * value * (3 - 2 * value); }

/** Precompute color math/terminal capability conversion, not on every animation frame. */
export function createBorderPalette(
  theme: BorderTheme, trailFraction = DEFAULT_SUBAGENTS_CONFIG.status.trailFraction,
): BorderPalette {
  const trailLength = trailFraction * 4;
  const base = theme.colors.borderMuted;
  const mode = theme.getColorMode();
  return {
    base: foregroundAnsi(base, mode),
    trailLength,
    glow: Array.from({ length: GLOW_COLOR_STEPS }, (_, i) => {
      const distance = i / (GLOW_COLOR_STEPS - 1) * (GLOW_LEAD + trailLength) - GLOW_LEAD;
      const age = Math.max(0, Math.min(1, distance / trailLength));
      const stop = age * (RAINBOW.length - 1);
      const color = mixColors(RAINBOW[Math.floor(stop)], RAINBOW[Math.min(RAINBOW.length - 1, Math.floor(stop) + 1)], stop % 1, "srgb");
      const strength = distance < 0 ? smoothstep(1 + distance / GLOW_LEAD) : 1 - smoothstep(age);
      return foregroundAnsi(mixColors(base, color, strength, "srgb"), mode);
    }),
  };
}

/** Clockwise screen-distance coordinates, normalized to one four-unit cycle.
 * A row is usually about twice as tall as a column is wide. Weighting actual
 * cell dimensions keeps pixel speed consistent, rather than parking on each
 * short edge for the same two seconds as a long edge.
 */
export function borderPhase(x: number, y: number, width: number, height: number, cells: CellDimensions): number {
  if (width === 1) return y / height * 4;
  const horizontal = (width - 1) * cells.widthPx;
  const vertical = (height - 1) * cells.heightPx;
  const perimeter = 2 * (horizontal + vertical);
  let distance: number;
  if (y === 0) distance = x * cells.widthPx;
  else if (x === width - 1) distance = horizontal + y * cells.heightPx;
  else if (y === height - 1) distance = horizontal + vertical + (width - 1 - x) * cells.widthPx;
  else distance = 2 * horizontal + vertical + (height - 1 - y) * cells.heightPx;
  return distance / perimeter * 4;
}

/** Constant screen-distance speed for both the head and its fading color field. */
export function borderHeadPhase(now: number, cycleSeconds = DEFAULT_SUBAGENTS_CONFIG.status.cycleSeconds): number {
  const cycleMs = cycleSeconds * 1_000;
  return ((now % cycleMs + cycleMs) % cycleMs) / cycleMs * 4;
}

export function borderColorAt(position: number, head: number, palette: BorderPalette): string {
  let age = (head - position + 4) % 4;
  if (age >= 4 - GLOW_LEAD) age -= 4;
  if (age < -GLOW_LEAD || age > palette.trailLength) return palette.base;
  const fraction = (age + GLOW_LEAD) / (GLOW_LEAD + palette.trailLength);
  return palette.glow[Math.min(palette.glow.length - 1, Math.round(fraction * (palette.glow.length - 1)))];
}

/** Preserve the right-hand status; all padding/truncation uses terminal columns. */
export function borderLine(left: string, right: string, width: number, paint = plainBorder): string {
  if (width <= 0) return "";
  if (width === 1) return paint("│", 0);
  const contentWidth = width - 2;
  const rightVis = visibleWidth(right);
  let content: string;
  if (rightVis >= contentWidth) {
    const clipped = truncateToWidth(right, contentWidth);
    content = clipped + " ".repeat(contentWidth - visibleWidth(clipped));
  } else {
    const clipped = truncateToWidth(left, contentWidth - rightVis);
    content = clipped + " ".repeat(contentWidth - visibleWidth(clipped) - rightVis) + right;
  }
  return paint("│", 0) + content + paint("│", width - 1);
}

/** Only frame glyphs move through the gradient; header labels and body colors stay steady. */
export function renderWidgetFrame(
  title: string, info: string, rows: WidgetRow[], width: number, now: number,
  theme: Pick<Theme, "fg">, palette: BorderPalette,
  cells: CellDimensions = getCellDimensions(),
  appearance: WidgetAppearance = DEFAULT_SUBAGENTS_CONFIG.status,
): string[] {
  const height = rows.length + 2;
  if (width <= 0) return Array.from({ length: height }, () => "");
  const head = borderHeadPhase(now, appearance.cycleSeconds);
  const paint = (y: number): PaintBorder => (glyph, x) =>
    (appearance.animated ? borderColorAt(borderPhase(x, y, width, height, cells), head, palette) : palette.base) + glyph + RESET;
  if (width === 1) return [paint(0)("╭", 0), ...rows.map((_, i) => paint(i + 1)("│", 0)), paint(height - 1)("╰", 0)];

  const inner = width - 2;
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(titlePart) - visibleWidth(infoPart)));
  // These internal labels are single-column text; keep truncation ANSI-free
  // before applying per-character title and frame colors.
  const header = `${titlePart}${fill}${infoPart}`.slice(0, inner);
  const headerText = header + "─".repeat(inner - visibleWidth(header));
  // Titles/info are our own single-column labels, never agent-supplied content.
  let column = 1;
  const top = paint(0)("╭", 0) + Array.from(headerText, (char) => {
    const x = column++;
    if (char === "─") return paint(0)(char, x);
    return theme.fg(x >= 3 && x < titlePart.length ? "text" : "muted", char);
  }).join("") + paint(0)("╮", width - 1);
  const bottomPaint = paint(height - 1);
  const bottom = Array.from({ length: width }, (_, x) => bottomPaint(x === 0 ? "╰" : x === width - 1 ? "╯" : "─", x)).join("");
  return [top, ...rows.map((row, i) => borderLine(row.left, row.right, width, paint(i + 1))), bottom];
}

/** One persistent widget and one disposable timer, never repeated setWidget() calls. */
export class AnimatedWidget implements Component {
  private timer: ReturnType<typeof setInterval> | undefined;
  private palette: BorderPalette;
  private tui: Pick<TUI, "requestRender">;
  private theme: BorderTheme;
  private draw: (width: number, now: number, palette: BorderPalette, appearance: WidgetAppearance) => string[];
  private onTick: () => void;
  private appearance: WidgetAppearance;
  disposed = false;

  constructor(
    tui: Pick<TUI, "requestRender">,
    theme: BorderTheme,
    draw: (width: number, now: number, palette: BorderPalette, appearance: WidgetAppearance) => string[],
    onTick: () => void,
    appearance: WidgetAppearance = DEFAULT_SUBAGENTS_CONFIG.status,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.draw = draw;
    this.onTick = onTick;
    this.appearance = { ...appearance };
    this.palette = createBorderPalette(theme, appearance.trailFraction);
    this.startTimer();
  }

  /** Static borders still refresh elapsed time and live telemetry once a second. */
  private startTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    this.timer = setInterval(() => {
      if (this.disposed) return;
      this.onTick();
      this.refresh();
    }, this.appearance.animated ? WIDGET_FRAME_MS : STATUS_REFRESH_MS);
    this.timer.unref();
  }

  setAppearance(appearance: WidgetAppearance): void {
    if (this.disposed) return;
    const previous = this.appearance;
    if (previous.animated === appearance.animated && previous.cycleSeconds === appearance.cycleSeconds &&
        previous.trailFraction === appearance.trailFraction) return;
    this.appearance = { ...appearance };
    if (previous.trailFraction !== appearance.trailFraction) this.invalidate();
    if (previous.animated !== appearance.animated) this.startTimer();
    this.refresh();
  }

  refresh(): void { if (!this.disposed) this.tui.requestRender(); }
  render(width: number): string[] { return this.disposed ? [] : this.draw(width, Date.now(), this.palette, this.appearance); }
  invalidate(): void { this.palette = createBorderPalette(this.theme, this.appearance.trailFraction); }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
