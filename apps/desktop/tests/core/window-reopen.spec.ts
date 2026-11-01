import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  type DesktopHarness,
} from "../helpers/electron-app";

async function workspaceWindowIds(harness: DesktopHarness): Promise<readonly number[]> {
  return harness.electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((window) => window.webContents.getURL().includes("index.html"))
      .map((window) => window.id),
  );
}

test("second instance reopens a workspace when only the orb remains", async () => {
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

    await harness.electronApp.evaluate(({ app }) => app.emit("second-instance"));
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
  } finally {
    await harness.close();
  }
});
