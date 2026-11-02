import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  normalizeWindowBounds,
  parseWindowBoundsState,
  WindowBoundsPersistence,
  windowBoundsFilePath,
} from "../../electron/windows/window-bounds";

const defaults = { width: 1480, height: 980, minWidth: 560, minHeight: 600 };
const display = { x: 0, y: 0, width: 1920, height: 1080 };

test("restores saved bounds that are still reachable", () => {
  const saved = { x: 80, y: 80, width: 1000, height: 700 };
  expect(normalizeWindowBounds(saved, [display], defaults)).toEqual(saved);
});

test("a saved position on a removed display falls back to a centered window", () => {
  const saved = { x: 3200, y: -200, width: 1000, height: 700 };
  expect(normalizeWindowBounds(saved, [display], defaults)).toEqual({
    x: 220,
    y: 50,
    width: 1480,
    height: 980,
  });
});

test("a deliberately half-off-screen window keeps its position", () => {
  const saved = { x: -400, y: 200, width: 1000, height: 700 };
  expect(normalizeWindowBounds(saved, [display], defaults)).toEqual(saved);
});

test("saved bounds below the minimum size grow back to it", () => {
  expect(
    normalizeWindowBounds({ x: 10, y: 10, width: 200, height: 100 }, [display], defaults),
  ).toEqual({ x: 10, y: 10, width: 560, height: 600 });
});

test("malformed saved bounds are ignored", () => {
  for (const saved of [
    null,
    undefined,
    "x",
    [],
    {},
    { x: 1, y: 2 },
    { x: "1", y: 2, width: 3, height: 4 },
  ]) {
    expect(normalizeWindowBounds(saved, [display], defaults)).toEqual({
      x: 220,
      y: 50,
      width: 1480,
      height: 980,
    });
  }
});

test("persisted state is validated before it is trusted", () => {
  expect(parseWindowBoundsState({ bounds: { x: 1, y: 2, width: 800, height: 600 } })).toEqual({
    bounds: { x: 1, y: 2, width: 800, height: 600 },
    maximized: false,
  });
  expect(
    parseWindowBoundsState({
      bounds: { x: 1, y: 2, width: 800, height: 600 },
      maximized: true,
    })?.maximized,
  ).toBe(true);
  expect(parseWindowBoundsState({ bounds: { width: 0, height: 0 } })).toBeUndefined();
  expect(parseWindowBoundsState("not an object")).toBeUndefined();
});

test("bounds survive a write and read round trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lancer-window-bounds-"));
  try {
    const persistence = new WindowBoundsPersistence(windowBoundsFilePath(dir), 0);
    expect(persistence.read()).toBeUndefined();

    persistence.schedule({ bounds: { x: 80, y: 80, width: 1000, height: 700 }, maximized: true });
    await expect
      .poll(async () => (await persistence.peek())?.maximized, { timeout: 5_000 })
      .toBe(true);
    expect(persistence.read()).toEqual({
      bounds: { x: 80, y: 80, width: 1000, height: 700 },
      maximized: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
