import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

test("installs the custom application menu on every platform", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [await makeWorkspace("app-menu-workspace")],
    testMode: "background",
  });

  try {
    await harness.firstWindow();
    const menu = await harness.electronApp.evaluate(({ Menu }) => {
      const applicationMenu = Menu.getApplicationMenu();
      const file = applicationMenu?.items.find((item) => item.label === "File");
      return {
        topLevel: applicationMenu?.items.map((item) => item.label) ?? [],
        fileItems: file?.submenu?.items.map((item) => item.label) ?? [],
        newThreadAccelerator:
          file?.submenu?.items.find((item) => item.label === "New Thread")?.accelerator ?? null,
      };
    });

    // Windows and Linux used to keep Electron's default menu; macOS adds the app
    // menu in front of this same list.
    expect(menu.topLevel).toContain("File");
    expect(menu.topLevel).toContain("Edit");
    expect(menu.topLevel).toContain("View");
    expect(menu.topLevel).toContain("Window");
    expect(menu.fileItems).toContain("New Thread");
    expect(menu.fileItems).toContain("New Window");
    expect(menu.fileItems).toContain("Open Folder…");
    expect(menu.newThreadAccelerator).toBe("CommandOrControl+N");
  } finally {
    await harness.close();
  }
});
