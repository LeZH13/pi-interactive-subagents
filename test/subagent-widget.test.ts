import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCellDimensions, rgbColor, setCellDimensions, visibleWidth } from "@earendil-works/pi-tui";
import {
  AnimatedWidget, borderPhase, borderHeadPhase, borderColorAt, createBorderPalette,
  renderWidgetFrame, WIDGET_FRAME_MS, WIDGET_CYCLE_MS,
} from "../pi-extension/subagents/widget.ts";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { DEFAULT_SUBAGENTS_CONFIG, WIDGET_CYCLE_SECONDS, WIDGET_TRAIL_FRACTIONS } from "../pi-extension/subagents/config.ts";
import { createStatusState } from "../pi-extension/subagents/status.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const theme = {
  colors: { borderMuted: rgbColor(70, 80, 100) },
  getColorMode: () => "truecolor" as const,
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getThinkingBorderColor: () => (text: string) => text,
};

/** Deterministic ticks, including callbacks already queued when disposal occurs. */
function fakeTimers() {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const active = new Map<object, () => void>();
  const queued: Array<() => void> = [];
  const delays: number[] = [];
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    const handle = { unref() {} };
    active.set(handle, callback);
    queued.push(callback);
    delays.push(delay);
    return handle;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: object) => { active.delete(handle); }) as typeof clearInterval;
  return {
    active, queued, delays,
    tick: () => [...active.values()].forEach((callback) => callback()),
    restore() { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; },
  };
}

function extensionHarness() {
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const modelMessages: unknown[] = [];
  const notifications: string[] = [];
  const mounts: unknown[] = [];
  let component: AnimatedWidget | undefined;
  let renders = 0;
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget(_key: string, factory: any) {
        mounts.push(factory);
        component?.dispose();
        component = factory?.({ requestRender: () => { renders++; } }, theme);
      },
    },
  };
  subagentsExtension({
    on(event: string, callback: (...args: any[]) => any) {
      handlers.set(event, [...handlers.get(event) ?? [], callback]);
    },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool() {}, registerShortcut() {}, registerMessageRenderer() {},
    sendUserMessage: (message: unknown) => modelMessages.push(message),
    sendMessage: (message: unknown) => modelMessages.push(message),
  } as any);
  return {
    ctx, mounts, commands, notifications, modelMessages,
    get component() { return component; }, get renders() { return renders; },
    async emit(event: string, context = ctx) { for (const callback of handlers.get(event) ?? []) await callback({}, context); },
  };
}

function liveWidgetAgent() {
  const startTime = Date.now() - 23_000;
  return {
    id: "widget-test", name: "real-agent", agent: "worker", startTime,
    statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
  };
}

describe("animated widget frame", () => {
  it("walks clockwise around every corner exactly once in screen-distance coordinates", () => {
    const coordinates = [
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2],
      [4, 3], [3, 3], [2, 3], [1, 3], [0, 3], [0, 2], [0, 1],
    ];
    const phases = coordinates.map(([x, y]) => borderPhase(x, y, 5, 4, { widthPx: 9, heightPx: 18 }));
    assert.deepEqual(phases, [...phases].sort((a, b) => a - b));
    assert.equal(new Set(phases).size, coordinates.length);
    assert.deepEqual([phases[0], phases[4], phases[7], phases[11]], [0, 0.8, 2, 2.8]);
  });

  it("uses equal pixel speed, not equal edge durations, for wide/tall frames and different cell proportions", () => {
    for (const cells of [{ widthPx: 9, heightPx: 18 }, { widthPx: 20, heightPx: 43 }, { widthPx: 10, heightPx: 25 }, { widthPx: 10, heightPx: 10 }]) {
      for (const [width, height] of [[100, 6], [6, 100], [51, 51], [2, 2], [2, 100]]) {
        const horizontal = (width - 1) * cells.widthPx;
        const vertical = (height - 1) * cells.heightPx;
        const perimeter = 2 * (horizontal + vertical);
        const corners = [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]];
        for (let edge = 0; edge < 4; edge++) {
          const [x, y] = corners[edge];
          const start = borderPhase(x, y, width, height, cells);
          const pixelLength = edge % 2 === 0 ? horizontal : vertical;
          const end = start + pixelLength / perimeter * 4;
          const [nextX, nextY] = corners[(edge + 1) % 4];
          const midpoint = borderPhase((x + nextX) / 2, (y + nextY) / 2, width, height, cells);
          assert.ok(Math.abs(midpoint - (start + end) / 2) < 1e-12);
          const duration = pixelLength / perimeter * WIDGET_CYCLE_MS;
          assert.ok(Math.abs(borderHeadPhase((start + end) / 2 / 4 * WIDGET_CYCLE_MS) - midpoint) < 1e-12);
          assert.ok(Math.abs(pixelLength / duration - perimeter / WIDGET_CYCLE_MS) < 1e-12,
            "all four edges have the same screen-distance speed");
        }
      }
      assert.equal(WIDGET_CYCLE_MS, 6_000, "complete the clockwise loop in six seconds");
      assert.equal(borderHeadPhase(WIDGET_CYCLE_MS), 0);
      assert.equal(borderHeadPhase(-WIDGET_FRAME_MS), borderHeadPhase(WIDGET_CYCLE_MS - WIDGET_FRAME_MS));
      assert.equal(borderPhase(0, 1, 1, 4, cells), 1, "single-column frames have no zero-length edge division");
    }
    const cells = { widthPx: 9, heightPx: 18 };
    const rightStart = borderPhase(69, 0, 70, 9, cells);
    const rightEnd = borderPhase(69, 8, 70, 9, cells);
    assert.ok((rightEnd - rightStart) / 4 * WIDGET_CYCLE_MS < 800,
      "a typical short side must not linger for two seconds");
  });

  it("changes every short-edge frame smoothly, including corner entry/exit, on the actual renderer", () => {
    const palette = createBorderPalette(theme as any);
    const cells = { widthPx: 9, heightPx: 18 };
    for (const height of [3, 4, 6, 9]) {
      const rows = Array.from({ length: height - 2 }, () => ({ left: "", right: "" }));
      for (const edge of [1, 3]) {
        const sideColors = (time: number) => renderWidgetFrame("Subagents", "1 running", rows, 100, time, theme as any, palette, cells)
          .flatMap((line) => {
            const matches = [...line.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m[╭╮│╯╰]/g)];
            return (edge === 1 ? matches.at(-1)! : matches[0])[1].split(";").map(Number);
          });
        const startPhase = edge === 1 ? borderPhase(99, 0, 100, height, cells) : borderPhase(0, height - 1, 100, height, cells);
        const endPhase = edge === 1 ? 2 : 4;
        const start = startPhase / 4 * WIDGET_CYCLE_MS;
        const end = endPhase / 4 * WIDGET_CYCLE_MS;
        let previous = sideColors(start - WIDGET_FRAME_MS);
        for (let time = start; time <= end + WIDGET_FRAME_MS; time += WIDGET_FRAME_MS) {
          const current = sideColors(time);
          assert.notDeepEqual(current, previous, `height ${height}, edge ${edge}: no repeated frame at ${time} ms`);
          const maxDelta = Math.max(...current.map((channel, i) => Math.abs(channel - previous[i])));
          assert.ok(maxDelta <= 25, `no hard cell switch (under 10% of a channel per frame): RGB step ${maxDelta} at ${time} ms`);
          previous = current;
        }
      }
    }
  });

  it("uses Pi's current cell dimensions on each render, including changes after a font/terminal resize", () => {
    const saved = getCellDimensions();
    const palette = createBorderPalette(theme as any);
    const rows = [{ left: "", right: "" }];
    try {
      const firstCells = { widthPx: 9, heightPx: 18 };
      setCellDimensions(firstCells);
      const first = renderWidgetFrame("Subagents", "1 running", rows, 70, 3500, theme as any, palette);
      assert.deepEqual(first, renderWidgetFrame("Subagents", "1 running", rows, 70, 3500, theme as any, palette, firstCells));
      const nextCells = { widthPx: 10, heightPx: 25 };
      setCellDimensions(nextCells);
      const next = renderWidgetFrame("Subagents", "1 running", rows, 70, 3500, theme as any, palette);
      assert.deepEqual(next, renderWidgetFrame("Subagents", "1 running", rows, 70, 3500, theme as any, palette, nextCells));
      assert.notDeepEqual(next, first);
      assert.deepEqual(next.map(strip), first.map(strip));
    } finally { setCellDimensions(saved); }
  });

  it("has a localized rainbow trail, moves with time, and wraps seamlessly", () => {
    const palette = createBorderPalette(theme as any);
    const colors = (time: number) => Array.from({ length: 200 }, (_, i) => borderColorAt(i / 50, borderHeadPhase(time), palette));
    const start = colors(0);
    assert.ok(start.filter((color) => color === palette.base).length > 50);
    assert.ok(new Set(start).size > 10);
    for (let time = WIDGET_FRAME_MS; time <= WIDGET_CYCLE_MS; time += WIDGET_FRAME_MS) {
      assert.notDeepEqual(colors(time - WIDGET_FRAME_MS), colors(time), `color motion advances at ${time} ms`);
    }
    assert.deepEqual(start, colors(WIDGET_CYCLE_MS));
    assert.deepEqual(colors(-WIDGET_FRAME_MS), colors(WIDGET_CYCLE_MS - WIDGET_FRAME_MS));
  });

  it("uses each saved trail fraction, defaults to two thirds, and fades fully to the border", () => {
    assert.equal(createBorderPalette(theme as any).trailLength, 8 / 3);
    for (const fraction of WIDGET_TRAIL_FRACTIONS) {
      const actual = createBorderPalette(theme as any, fraction);
      const length = fraction * 4;
      const palette = { base: "base", trailLength: length, glow: Array.from({ length: 512 }, (_, i) => `glow-${i}`) };
      assert.equal(actual.trailLength, length);
      assert.equal(actual.glow.at(-1), actual.base);
      for (const head of [0, 0.3, 2.8, 3.99]) {
        const behind = (distance: number) => (head - distance + 4) % 4;
        assert.notEqual(borderColorAt(behind(length - 0.01), head, palette), palette.base);
        assert.equal(borderColorAt(behind(length - 1e-9), head, palette), palette.glow.at(-1));
        assert.equal(borderColorAt(behind(length + 0.001), head, palette), palette.base);
      }
    }
  });

  it("uses each saved loop duration and renders a static border when animation is off", () => {
    const palette = createBorderPalette(theme as any);
    const rows = [{ left: " worker ", right: " active " }];
    for (const seconds of WIDGET_CYCLE_SECONDS) {
      assert.equal(borderHeadPhase(seconds * 250, seconds), 1);
      assert.equal(borderHeadPhase(seconds * 1_000, seconds), 0);
      const appearance = { ...DEFAULT_SUBAGENTS_CONFIG.status, cycleSeconds: seconds };
      const render = (time: number) => renderWidgetFrame("Subagents", "1 running", rows, 80, time, theme as any, palette, undefined, appearance);
      assert.deepEqual(render(0), render(seconds * 1_000));
      assert.notDeepEqual(render(0), render(seconds * 250));
      appearance.animated = false;
      assert.deepEqual(render(0), render(seconds * 250));
      assert.equal(new Set(render(0).join("").match(/\x1b\[38;2;[0-9;]+m/g)).size, 1, "all frame glyphs use the base border color");
    }
  });

  it("uses capability-aware 256-color output", () => {
    const palette = createBorderPalette({ ...theme, getColorMode: () => "256color" } as any);
    for (const color of [palette.base, ...palette.glow]) {
      assert.match(color, /^\x1b\[38;5;\d+m$/);
    }
  });

  it("uses normal text color for the title and keeps the count muted across frames and widths", () => {
    const palette = createBorderPalette(theme as any);
    for (const title of ["Subagents"]) {
      for (const width of [3, 8, 32, 80]) {
        for (const time of [0, WIDGET_FRAME_MS, WIDGET_CYCLE_MS / 2]) {
          const styled: Array<{ color: string; char: string }> = [];
          const labelTheme = {
            fg: (color: string, char: string) => { styled.push({ color, char }); return char; },
          };
          renderWidgetFrame(title, "1 running", [], width, time, labelTheme as any, palette);
          const visibleTitle = title.slice(0, Math.max(0, width - 4));
          assert.equal(styled.filter(({ color }) => color === "text").map(({ char }) => char).join(""), visibleTitle);
          const infoStart = styled.findIndex(({ char }) => char === "1");
          if (infoStart >= 0) {
            assert.ok(styled.slice(infoStart).every(({ color }) => color === "muted"));
          }
        }
      }
    }
  });

  it("keeps labels and body colors steady, supports Unicode and tiny widths", () => {
    const palette = createBorderPalette(theme as any);
    const rows = [{ left: " 界面 é 👩‍💻 \x1b[32mworker\x1b[0m ", right: " active · bash 7s " }];
    for (const width of [0, 1, 2, 3, 8, 16, 32, 80, 160]) {
      const render = (now: number) => renderWidgetFrame("Subagents", "1 running", rows, width, now, theme as any, palette);
      const first = render(0);
      assert.deepEqual(first.map(visibleWidth), [width, width, width]);
      assert.deepEqual(first.map(strip), render(WIDGET_FRAME_MS).map(strip));
      if (width >= 80) {
        const interior = (line: string) => line.replace(/^\x1b\[[0-9;]*m│\x1b\[0m/, "").replace(/\x1b\[[0-9;]*m│\x1b\[0m$/, "");
        assert.equal(interior(first[1]), interior(render(WIDGET_FRAME_MS)[1]));
        assert.match(first[1], /\x1b\[32mworker/);
      }
    }
  });

  it("refreshes without remounting, rebuilds theme colors, and releases its timer idempotently", () => {
    const timers = fakeTimers();
    let renders = 0;
    let ticks = 0;
    let lastPalette: unknown;
    const mutableTheme = { ...theme, colors: { ...theme.colors } };
    const widget = new AnimatedWidget({ requestRender() { renders++; } }, mutableTheme as any,
      (_width, _now, palette) => { lastPalette = palette; return [palette.base]; }, () => { ticks++; });
    try {
      assert.equal(WIDGET_FRAME_MS, 25, "target 40 frames per second");
      assert.deepEqual(timers.delays, [WIDGET_FRAME_MS]);
      assert.equal(timers.active.size, 1);
      timers.tick();
      assert.equal(renders, 1);
      assert.equal(ticks, 1);
      const initial = widget.render(80);
      const initialPalette = lastPalette;
      widget.render(80);
      assert.equal(lastPalette, initialPalette, "palette is cached between frames");
      mutableTheme.colors.borderMuted = rgbColor(200, 210, 220);
      widget.invalidate();
      assert.notDeepEqual(widget.render(80), initial);
      widget.setAppearance({ ...DEFAULT_SUBAGENTS_CONFIG.status, animated: false });
      assert.equal(timers.active.size, 1, "static mode still updates live progress");
      assert.equal(timers.delays.at(-1), 1_000);
      timers.tick();
      assert.equal(ticks, 2);
      widget.setAppearance({ ...DEFAULT_SUBAGENTS_CONFIG.status, trailFraction: 1 / 4, cycleSeconds: 10 });
      assert.equal(timers.delays.at(-1), WIDGET_FRAME_MS);
      assert.equal(timers.active.size, 1);
      widget.render(80);
      assert.notEqual(lastPalette, initialPalette);
      const samePalette = lastPalette;
      const timerCount = timers.delays.length;
      widget.setAppearance({ ...DEFAULT_SUBAGENTS_CONFIG.status, trailFraction: 1 / 4, cycleSeconds: 10 });
      widget.render(80);
      assert.equal(lastPalette, samePalette);
      assert.equal(timers.delays.length, timerCount, "unchanged settings do not restart the timer");
      const previousRenders = renders;
      widget.dispose();
      widget.dispose();
      timers.queued.forEach((callback) => callback());
      widget.setAppearance(DEFAULT_SUBAGENTS_CONFIG.status);
      assert.equal(timers.active.size, 0);
      assert.equal(renders, previousRenders, "queued callbacks cannot render after disposal");
      assert.deepEqual(widget.render(80), []);
    } finally { widget.dispose(); timers.restore(); }
  });
});

describe("widget lifecycle", () => {
  it("does not register a debug preview command or mount simulated agents", async () => {
    const timers = fakeTimers();
    const harness = extensionHarness();
    try {
      await harness.emit("session_start");
      assert.equal(harness.commands.has("subagent-widget-preview"), false);
      assert.equal(harness.mounts.filter(Boolean).length, 0);
      assert.equal(timers.active.size, 0);
      assert.deepEqual(harness.modelMessages, []);
    } finally { await harness.emit("session_shutdown"); timers.restore(); }
  });

  it("applies appearance live without remounting, honors visibility, and cleans up on session switch/shutdown/reload", async () => {
    const timers = fakeTimers();
    const config = __test__.getSubagentsConfigState();
    const saved = config.get();
    config.replace(structuredClone(DEFAULT_SUBAGENTS_CONFIG));
    const harness = extensionHarness();
    try {
      await harness.emit("session_start");
      const live = liveWidgetAgent();
      __test__.runningSubagents.set(live.id, live as any);
      __test__.updateWidget();
      const first = harness.component!;
      assert.match(strip(first.render(100).join("\n")), /real-agent/);
      for (let i = 0; i < 10; i++) { __test__.updateWidget(); timers.tick(); }
      assert.equal(harness.component, first);
      assert.equal(timers.active.size, 1);
      const before = first.render(100);
      config.replace({ ...config.get(), status: { ...config.get().status, animated: false, trailFraction: 1 / 4, cycleSeconds: 10 } });
      __test__.updateWidget();
      assert.equal(harness.component, first);
      assert.equal(timers.delays.at(-1), 1_000);
      const after = first.render(100);
      assert.notDeepEqual(after, before);
      assert.deepEqual(after.map(strip), before.map(strip));
      timers.tick();
      assert.equal(harness.component, first);
      config.replace({ ...config.get(), status: { ...config.get().status, animated: true } });
      __test__.updateWidget();
      assert.equal(timers.delays.at(-1), WIDGET_FRAME_MS);
      assert.equal(harness.component, first);
      __test__.runningSubagents.delete(live.id);
      timers.tick();
      assert.equal(first.disposed, true, "the final agent disappearing releases the widget timer");
      assert.equal(harness.mounts.at(-1), undefined);
      assert.equal(timers.active.size, 0);
      __test__.runningSubagents.set(live.id, live as any);
      __test__.updateWidget();
      const remounted = harness.component!;
      config.replace({ ...config.get(), status: { ...config.get().status, enabled: false } });
      __test__.updateWidget();
      assert.equal(remounted.disposed, true);
      assert.equal(timers.active.size, 0);
      config.replace({ ...config.get(), status: { ...config.get().status, enabled: true } });
      __test__.updateWidget();
      assert.equal(timers.active.size, 1);
      const second = harness.component!;
      (globalThis as any)[Symbol.for("pi-subagents/widget-dispose")](); // reload cleanup
      assert.equal(second.disposed, true);
      assert.equal(timers.active.size, 0);
      __test__.updateWidget();
      assert.notEqual(harness.component, second);
      await harness.emit("session_start");
      assert.equal(timers.active.size, 0);
      assert.equal(harness.mounts.at(-1), undefined);
      __test__.updateWidget();
      __test__.runningSubagents.delete(live.id);
      await harness.emit("session_shutdown");
      timers.queued.forEach((callback) => callback());
      assert.equal(timers.active.size, 0);
      assert.equal(harness.component, undefined);
    } finally {
      __test__.runningSubagents.delete("widget-test");
      await harness.emit("session_shutdown");
      config.replace(saved);
      timers.restore();
    }
  });

  it("does not mount or schedule timers outside TUI mode", async () => {
    const timers = fakeTimers();
    const harness = extensionHarness();
    const live = liveWidgetAgent();
    try {
      __test__.runningSubagents.set(live.id, live as any);
      for (const context of [{ ...harness.ctx, mode: "rpc" }, { ...harness.ctx, mode: "json", hasUI: false }]) {
        await harness.emit("session_start", context);
        __test__.updateWidget();
        assert.equal(harness.mounts.filter(Boolean).length, 0);
        assert.equal(timers.active.size, 0);
      }
    } finally {
      __test__.runningSubagents.delete(live.id);
      await harness.emit("session_shutdown");
      timers.restore();
    }
  });
});
