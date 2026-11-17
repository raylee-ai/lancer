import { expect, test } from "@playwright/test";
import { reopenWorkspaceWindow } from "../../electron/windows/window-reopen";

function fixtureWindow(minimized = false) {
  const events: string[] = [];
  return {
    events,
    isMinimized: () => minimized,
    restore: () => {
      minimized = false;
      events.push("restore");
    },
    show: () => {
      events.push("show");
    },
    focus: () => {
      events.push("focus");
    },
  };
}

test("early second instances wait for complete startup and reuse its initial workspace", async () => {
  let releaseReady: (() => void) | undefined;
  const applicationReady = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  const window = fixtureWindow(true);
  let current: ReturnType<typeof fixtureWindow> | undefined;
  let selections = 0;
  let creations = 0;
  const reopen = () =>
    reopenWorkspaceWindow(
      applicationReady,
      () => {
        selections++;
        return current;
      },
      () => {
        creations++;
        return window;
      },
    );
  const pending = [reopen(), reopen(), reopen()];
  await Promise.resolve();
  expect(selections).toBe(0);
  expect(creations).toBe(0);
  expect(window.events).toEqual([]);
  // Startup creates the initial workspace only after its async store setup.
  current = window;
  releaseReady?.();
  await Promise.all(pending);
  expect(creations).toBe(0);
  expect(window.events).toEqual(["restore", "show", "focus", "show", "focus", "show", "focus"]);
});

test("a burst after all workspaces close creates one workspace and restores it", async () => {
  let current: ReturnType<typeof fixtureWindow> | undefined;
  let creations = 0;
  const reopen = () =>
    reopenWorkspaceWindow(
      Promise.resolve(),
      () => current,
      () => {
        creations++;
        return (current = fixtureWindow());
      },
    );
  await Promise.all([reopen(), reopen(), reopen()]);
  expect(creations).toBe(1);
  expect(current?.events).toEqual(["show", "focus", "show", "focus", "show", "focus"]);
});

test("failed startup rejects reopening without touching uninitialized window state", async () => {
  const failure = new Error("startup failed");
  let touched = false;
  await expect(
    reopenWorkspaceWindow(
      Promise.reject(failure),
      () => {
        touched = true;
        return undefined;
      },
      () => {
        touched = true;
        return fixtureWindow();
      },
    ),
  ).rejects.toThrow(failure);
  expect(touched).toBe(false);
});
