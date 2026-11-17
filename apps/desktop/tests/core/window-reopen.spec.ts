import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  spawnDesktopProcess,
  type DesktopHarness,
} from "../helpers/electron-app";

async function workspaceWindowIds(harness: DesktopHarness): Promise<readonly number[]> {
  return harness.electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((window) => window.webContents.getURL().includes("index.html"))
      .map((window) => window.id),
  );
}

test("a real second process reopens a workspace when only the orb remains", async () => {
  const profile = await makeUserDataDir();
  const workspace = await makeWorkspace("window-reopen");
  const agentDir = join(profile, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const harness = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    testMode: "foreground",
    envOverrides: { PI_APP_TEST_ORB: "1" },
  });
  let duplicate: ChildProcess | undefined;

  try {
    await harness.firstWindow();
    await expect
      .poll(() => harness.electronApp.windows().some((page) => page.url().includes("pi-orb.html")))
      .toBe(true);
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes("index.html"))
        ?.close();
    });
    await expect.poll(() => workspaceWindowIds(harness)).toEqual([]);
    await expect.poll(() => harness.electronApp.windows().length).toBe(1);

    duplicate = await spawnDesktopProcess(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      testMode: "foreground",
      envOverrides: { PI_APP_TEST_ORB: "1" },
    });
    await expect.poll(() => duplicate?.exitCode).toBe(0);
    await expect.poll(() => workspaceWindowIds(harness)).toHaveLength(1);
    const reopened = harness.electronApp
      .windows()
      .find((page) => page.url().includes("index.html"));
    if (!reopened) throw new Error("Expected a reopened workspace renderer");
    await reopened.waitForLoadState("domcontentloaded");
    await reopened.waitForFunction(() => Boolean(globalThis.window.piApp));
    await expect(reopened.getByTestId("new-thread-composer")).toBeVisible();
    await reopened.screenshot({ path: test.info().outputPath("reopened-workspace.png") });

    const windowIds = await workspaceWindowIds(harness);
    await harness.electronApp.evaluate(({ app, BrowserWindow }, ids) => {
      BrowserWindow.fromId(ids[0])?.minimize();
      app.emit("second-instance");
      app.emit("second-instance");
    }, windowIds);
    await expect.poll(() => workspaceWindowIds(harness)).toEqual(windowIds);
    await expect
      .poll(() =>
        harness.electronApp.evaluate(({ BrowserWindow }, ids) => {
          const window = BrowserWindow.fromId(ids[0]);
          return { visible: window?.isVisible(), minimized: window?.isMinimized() };
        }, windowIds),
      )
      .toEqual({ visible: true, minimized: false });
    await expect.poll(() => harness.electronApp.windows().length).toBe(2);

    // Exercise the shared creation path used by macOS Dock activation as an
    // injected event; this is not native macOS Dock input proof.
    await harness.electronApp.evaluate(({ BrowserWindow }, ids) => {
      BrowserWindow.fromId(ids[0])?.close();
    }, windowIds);
    await expect.poll(() => workspaceWindowIds(harness)).toEqual([]);
    await harness.electronApp.evaluate(({ app }) => app.emit("activate"));
    await expect.poll(() => workspaceWindowIds(harness)).toHaveLength(1);
    const activated = harness.electronApp
      .windows()
      .find((page) => page.url().includes("index.html"));
    if (!activated) throw new Error("Expected a workspace after activation");
    await activated.waitForFunction(() => Boolean(globalThis.window.piApp));
    await expect(activated.getByTestId("new-thread-composer")).toBeVisible();
  } finally {
    if (duplicate && duplicate.exitCode === null) duplicate.kill();
    await harness.close();
  }
});
