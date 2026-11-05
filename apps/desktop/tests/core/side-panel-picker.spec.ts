import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";

test("one icon and keyboard shortcuts toggle the selected workspace tool", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("workbench-shortcuts");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    // Pin bash with no profile so macOS does not print the zsh deprecation
    // banner, and both platforms share one prompt marker.
    envOverrides: {
      PI_APP_TERMINAL_PROMPT: "LANCER_READY$ ",
    },
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Shortcut thread");
    // The global toggle remains in the titlebar; workspace tools also have a local close action.
    const toggle = window.getByTestId("topbar").getByRole("button", { name: "Toggle side panel" });
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("");
    await toggle.click();
    const chooser = window.getByTestId("workbench-chooser");
    if (!(await chooser.isVisible())) await window.getByTestId("workbench-add-tab").click();
    const modifierLabel = process.platform === "darwin" ? "⌘" : "Ctrl+";
    const tile = (name: string) => chooser.getByRole("button", { name, exact: true });
    await expect(tile("Review").locator("kbd")).toHaveText(`${modifierLabel}R`);
    await expect(tile("Terminal").locator("kbd")).toHaveText(`${modifierLabel}J`);
    await expect(tile("Files").locator("kbd")).toHaveCount(0);
    await selectSidePanel(window, "Files");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await window.getByTestId("composer").click();
    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(window.getByTestId("file-workbench")).toBeVisible();

    await selectSidePanel(window, "Review");
    await expect(window.locator(".diff-panel")).toBeVisible();
    await expect(window.getByTestId("file-workbench")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("R"));
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(window.locator(".diff-panel")).toBeVisible();

    await window.keyboard.press(desktopShortcut("B"));
    await expect(window.locator(".shell-sidebar")).toBeHidden();
    await expect(window.locator(".diff-panel")).toBeVisible();
    await window.keyboard.press(desktopShortcut("B"));
    await expect(window.locator(".shell-sidebar")).toBeVisible();

    await window.keyboard.press(desktopShortcut("J"));
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await expect(window.locator(".diff-panel")).toHaveCount(0);
    await terminal.locator(".xterm").click();
    // Ctrl+R before the shell's prompt is ready is echoed as "^R" and never
    // starts readline reverse-search.
    await expect(terminal.locator(".xterm-rows")).toContainText("LANCER_READY$");
    const modifier = process.platform === "darwin" ? "meta" : "control";
    const pressInWindow = (keyCode: string, modifiers: readonly string[]) =>
      harness.electronApp.evaluate(
        ({ BrowserWindow }, payload) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          if (!contents) throw new Error("Missing window");
          // keyDown alone leaves the modifier stuck, so the next chord is not the one sent.
          contents.sendInputEvent({
            type: "keyDown",
            keyCode: payload.keyCode,
            modifiers: payload.modifiers,
          });
          contents.sendInputEvent({
            type: "keyUp",
            keyCode: payload.keyCode,
            modifiers: payload.modifiers,
          });
        },
        { keyCode, modifiers: [...modifiers] },
      );
    const pressSidePanelShortcut = () => pressInWindow("b", [modifier, "alt"]);
    await pressSidePanelShortcut();
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await pressSidePanelShortcut();
    await expect(terminal).toBeVisible();
    await expect(
      window.getByRole("tablist", { name: "Workspace tools" }).getByRole("tab"),
    ).toHaveCount(3);

    // Cmd+R reaches Review from the terminal on macOS; Ctrl+R stays with the shell elsewhere.
    await terminal.locator(".xterm").click();
    await pressInWindow("r", [modifier]);
    if (process.platform === "darwin") {
      await expect(window.locator(".diff-panel")).toBeVisible();
    } else {
      await expect(terminal.locator(".xterm-rows")).toContainText(/i-search/);
      await expect(window.locator(".diff-panel")).toHaveCount(0);
    }
  } finally {
    await harness.close();
  }
});
