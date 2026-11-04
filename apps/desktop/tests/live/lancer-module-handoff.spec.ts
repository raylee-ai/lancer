import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
} from "../helpers/electron-app";

test("real models hand off a module conversation without losing its context", async () => {
  test.setTimeout(180_000);
  const auth = getRealAuthConfig();
  test.skip(!auth.enabled, auth.skipReason);
  const provider = process.env.PI_GUI_PROVIDER,
    first = process.env.PI_GUI_MODEL,
    next = process.env.PI_GUI_HANDOFF_MODEL;
  if (!provider || !first || !next) throw new Error("Configure two real handoff models");
  const profile = await makeUserDataDir(),
    workspace = await makeWorkspace("real-module-handoff");
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light" }),
  );
  const skillDir = join(workspace, ".agents", "skills", "handoff-proof");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: handoff-proof\ndescription: Verify configured stage execution.\n---\nInclude the token SKILL-829 in the final answer. Do not use tools.\n",
  );
  const harness = await launchDesktop(profile, {
    initialWorkspaces: [workspace],
    realAuthSourceDir: auth.sourceDir,
    enabledModels: [`${provider}/${first}`, `${provider}/${next}`],
    scrubProviderEnv: true,
    envOverrides: { PI_APP_TEST_MODE: undefined },
  });
  try {
    await harness.focusWindow();
    const page = await harness.firstWindow();
    const doctor = await harness.electronApp.evaluate(({ app, BrowserWindow }) => ({
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      testMode: process.env.PI_APP_TEST_MODE ?? null,
      testHooks: "__PI_APP_TEST_HOOKS" in globalThis,
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
    }));
    expect(doctor.appPath).toBe(process.cwd() + "/apps/desktop");
    expect(doctor.userData).toBe(profile);
    expect(doctor.testMode).toBeNull();
    expect(doctor.testHooks).toBe(false);
    expect(doctor.visible).toBe(true);
    await page.getByRole("button", { name: "Paper lookup", exact: true }).click();
    await openNewThread(page);
    await page
      .getByLabel("New thread prompt")
      .fill("Remember the unique handoff code QUARTZ-472. Reply only READY. Do not use tools.");
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(page.locator(".process-assistant").last()).toContainText("READY", {
      timeout: 90_000,
    });
    const idle = async () => {
      await expect
        .poll(
          async () =>
            (await getDesktopState(page)).workspaces
              .flatMap((w) => w.sessions)
              .some((s) => s.status === "running"),
          { timeout: 90_000 },
        )
        .toBe(false);
    };
    await idle();
    const sessionId = (await getDesktopState(page)).selectedSessionId;
    await page.getByLabel("设置模型交接流程").click();
    await page.getByLabel("阶段 2 模型", { exact: true }).selectOption(`${provider}/${next}`);
    await page
      .getByLabel("阶段 2 目标", { exact: true })
      .fill("Recall the unique handoff code from the previous stage. Do not use tools.");
    await page
      .getByLabel("阶段 2 交付物", { exact: true })
      .fill("Reply on one line containing the code and the skill token, then DELIVERED-24.");
    await page.locator(".workflow-editor__stage").nth(1).locator("summary").click();
    await page
      .getByRole("group", { name: "阶段 2 技能", exact: true })
      .getByLabel("handoff-proof", { exact: true })
      .check();
    await page.getByRole("button", { name: "保存流程", exact: true }).click();
    await page.getByLabel("交接阶段 2：阅读分析", { exact: true }).click();
    await expect(page.getByLabel("交接阶段 2：阅读分析", { exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "载入任务", exact: true }).click();
    await expect(page.getByTestId("composer")).toHaveValue(/^\/skill:handoff-proof /);
    await page.getByTestId("send").click();
    await expect(page.locator(".process-assistant").last()).toHaveText(/QUARTZ-472/, {
      timeout: 90_000,
    });
    await idle();
    await expect(page.locator(".process-assistant").last()).toContainText("SKILL-829");
    await expect(page.locator(".process-assistant").last()).toContainText("DELIVERED-24");
    const state = await getDesktopState(page);
    expect(state.selectedSessionId).toBe(sessionId);
    expect(
      state.assistants?.workflows?.[`${state.selectedWorkspaceId}:${sessionId}`]?.activeStep,
    ).toBe(1);
    await page.screenshot({ path: test.info().outputPath("real-model-handoff.png") });
    await writeFile(
      test.info().outputPath("proof.json"),
      JSON.stringify({ provider, first, next, doctor, sessionId, contextRetained: true }, null, 2),
    );
  } finally {
    await harness.close();
  }
});
