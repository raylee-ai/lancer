import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  selectSession,
  selectSidePanel,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("integrated terminals follow the session directory and keep existing shells", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeGitWorkspace("terminal-session-cwd");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const workspaceId = (await getDesktopState(window)).selectedWorkspaceId!;
    await window.evaluate(
      async ({ id }) => {
        const app = globalThis.window.piApp;
        if (!app) throw new Error("piApp IPC bridge is unavailable");
        await app.createSession({
          workspaceId: id,
          title: "Worktree terminal",
          useWorktree: true,
        });
      },
      { id: workspaceId },
    );
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((session) => session.id === state.selectedSessionId)?.worktree?.path;
      })
      .toBeTruthy();
    const worktreePath = await realpath(
      (await getDesktopState(window)).workspaces
        .flatMap((workspace) => workspace.sessions)
        .find((session) => session.title === "Worktree terminal")!.worktree!.path,
    );

    await selectSidePanel(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await window.keyboard.type("printf 'WORKTREE_TERMINAL_OK\\n'; pwd");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("WORKTREE_TERMINAL_OK", {
      timeout: 15_000,
    });
    await expect(terminal.locator(".xterm-rows")).toContainText("lancer-worktrees", {
      timeout: 15_000,
    });
    await expect(window.getByTestId("terminal-cwd")).toHaveAttribute("data-cwd", worktreePath);
    await expect(terminal).toHaveAttribute("data-execution-cwd", worktreePath);
    await expect(window.getByTestId("terminal-cwd-mismatch")).toHaveCount(0);

    await createNamedThread(window, "Workspace terminal");
    await selectSidePanel(window, "Terminal");
    const workspaceTerminal = window.getByTestId("integrated-terminal");
    await expect(workspaceTerminal).toBeVisible();
    await workspaceTerminal.locator(".xterm").click();
    await window.keyboard.type("printf 'WORKSPACE_TERMINAL_OK\\n'; pwd");
    await window.keyboard.press("Enter");
    await expect(workspaceTerminal.locator(".xterm-rows")).toContainText("WORKSPACE_TERMINAL_OK", {
      timeout: 15_000,
    });
    await expect(workspaceTerminal.locator(".xterm-rows")).toContainText(basename(workspacePath), {
      timeout: 15_000,
    });
    await expect(workspaceTerminal.locator(".xterm-rows")).not.toContainText(
      "WORKTREE_TERMINAL_OK",
    );
    const workspaceRealPath = await realpath(workspacePath);
    await expect(window.getByTestId("terminal-cwd")).toHaveAttribute("data-cwd", workspaceRealPath);

    await selectSession(window, "Worktree terminal");
    await expect(window.getByTestId("integrated-terminal").locator(".xterm-rows")).toContainText(
      "WORKTREE_TERMINAL_OK",
      { timeout: 15_000 },
    );

    const target = await window.evaluate(() => {
      return globalThis.window.piApp!.getState().then((state) => ({
        workspaceId: state.selectedWorkspaceId!,
        sessionId: state.selectedSessionId!,
      }));
    });
    await window.evaluate(async (sessionTarget) => {
      const app = globalThis.window.piApp;
      if (!app) throw new Error("piApp IPC bridge is unavailable");
      const state = await app.discardSessionWorktree(sessionTarget);
      if (state.lastError) throw new Error(state.lastError);
    }, target);

    await expect(window.getByTestId("terminal-cwd-mismatch")).toBeVisible();
    await expect(window.getByTestId("integrated-terminal")).toHaveAttribute(
      "data-execution-cwd",
      workspaceRealPath,
    );
    await expect(window.getByTestId("terminal-cwd")).toHaveAttribute("data-cwd", worktreePath);
    await expect(window.getByTestId("integrated-terminal").locator(".xterm-rows")).toContainText(
      "WORKTREE_TERMINAL_OK",
    );

    await window.getByLabel("New terminal").click();
    await expect(window.getByTestId("terminal-tab")).toHaveCount(2);
    await expect(window.getByTestId("terminal-cwd")).toHaveAttribute("data-cwd", workspaceRealPath);
    await expect(window.getByTestId("terminal-cwd-mismatch")).toHaveCount(0);
    await window.getByTestId("terminal-tab").first().click();
    await expect(window.getByTestId("terminal-cwd")).toHaveAttribute("data-cwd", worktreePath);
    await expect(window.getByTestId("terminal-cwd-mismatch")).toBeVisible();
    await expect(window.getByTestId("integrated-terminal").locator(".xterm-rows")).toContainText(
      "WORKTREE_TERMINAL_OK",
    );
  } finally {
    await harness.close();
  }
});
