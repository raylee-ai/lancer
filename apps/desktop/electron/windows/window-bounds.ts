import { readFileSync } from "node:fs";
import path from "node:path";
import { readJsonWithBackup, writeFileAtomicQueued } from "../persistence/atomic-file-write";

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowBoundsDefaults {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

/** The slice of `Display.workArea` the bounds are checked against. */
export interface DisplayWorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowBoundsState {
  readonly bounds: WindowBounds;
  readonly maximized: boolean;
}

/** Enough of the window must stay grabbable; a title strip is all a user needs. */
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 80;
const SAVE_DEBOUNCE_MS = 400;

export function normalizeWindowBounds(
  saved: unknown,
  displays: readonly DisplayWorkArea[],
  defaults: WindowBoundsDefaults,
): WindowBounds {
  const fallback = centeredBounds(displays, defaults);
  const candidate = numericBounds(saved);
  if (!candidate) {
    return fallback;
  }

  const width = Math.max(defaults.minWidth, Math.round(candidate.width));
  const height = Math.max(defaults.minHeight, Math.round(candidate.height));
  const bounds = {
    x: Math.round(candidate.x),
    y: Math.round(candidate.y),
    width,
    height,
  };

  // A window left on a display that is gone must come back where it can be
  // grabbed, but a partially off-screen position is a legitimate user choice.
  const reachable = displays.some((area) => {
    const overlapX = Math.min(bounds.x + width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= MIN_VISIBLE_WIDTH && overlapY >= MIN_VISIBLE_HEIGHT;
  });
  return reachable ? bounds : fallback;
}

export function isWindowBoundsState(value: unknown): value is WindowBoundsState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as { bounds?: unknown; maximized?: unknown };
  return numericBounds(record.bounds) !== undefined;
}

export function parseWindowBoundsState(value: unknown): WindowBoundsState | undefined {
  if (!isWindowBoundsState(value)) {
    return undefined;
  }
  return {
    bounds: numericBounds(value.bounds)!,
    maximized: (value as { maximized?: unknown }).maximized === true,
  };
}

/**
 * Reads the saved bounds synchronously: `createWindow()` needs them as
 * constructor options. The `.bak` sibling is tried when the primary file is
 * unreadable; a missing file is the normal first launch.
 */
export function readWindowBoundsState(filePath: string): WindowBoundsState | undefined {
  for (const candidate of [filePath, `${filePath}.bak`]) {
    try {
      return parseWindowBoundsState(JSON.parse(readFileSync(candidate, "utf8")));
    } catch {
      // Try the backup, then fall back to the default bounds.
    }
  }
  return undefined;
}

async function readWindowBoundsStateAsync(
  filePath: string,
): Promise<WindowBoundsState | undefined> {
  const { value } = await readJsonWithBackup(filePath);
  return parseWindowBoundsState(value);
}

/**
 * Debounced writer for the main window's normal bounds. Reads are synchronous
 * (startup), writes go through the atomic JSON helper so a crash mid-write
 * cannot leave a truncated file that the next launch would read as invalid.
 */
export class WindowBoundsPersistence {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: WindowBoundsState | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly debounceMs: number = SAVE_DEBOUNCE_MS,
  ) {}

  read(): WindowBoundsState | undefined {
    return readWindowBoundsState(this.filePath);
  }

  /** Record the latest bounds; the trailing save wins. */
  schedule(state: WindowBoundsState): void {
    this.pending = state;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush().catch((error: unknown) => {
        console.warn("[window-bounds] could not save window bounds", error);
      });
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const state = this.pending;
    this.pending = undefined;
    if (!state) {
      return;
    }
    this.writeChain = this.writeChain
      .then(() =>
        writeFileAtomicQueued(this.filePath, JSON.stringify(state), (existing) =>
          isWindowBoundsState(existing) ? existing : undefined,
        ),
      )
      .catch((error: unknown) => {
        console.warn("[window-bounds] could not save window bounds", error);
      });
    await this.writeChain;
  }

  /** Read back what a caller just queued; used by tests and diagnostics. */
  async peek(): Promise<WindowBoundsState | undefined> {
    await this.writeChain;
    return readWindowBoundsStateAsync(this.filePath);
  }
}

export function windowBoundsFilePath(userDataDir: string): string {
  return path.join(userDataDir, "window-bounds.json");
}

function numericBounds(value: unknown): WindowBounds | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const numbers = ["x", "y", "width", "height"].map((key) => record[key]);
  if (!numbers.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return undefined;
  }
  const [x, y, width, height] = numbers as number[];
  if (width! <= 0 || height! <= 0) {
    return undefined;
  }
  return { x: x!, y: y!, width: width!, height: height! };
}

function centeredBounds(
  displays: readonly DisplayWorkArea[],
  defaults: WindowBoundsDefaults,
): WindowBounds {
  const width = defaults.width;
  const height = defaults.height;
  const area = displays[0];
  if (!area) {
    return { x: 0, y: 0, width, height };
  }
  return {
    x: Math.round(area.x + Math.max(0, (area.width - width) / 2)),
    y: Math.round(area.y + Math.max(0, (area.height - height) / 2)),
    width,
    height,
  };
}
