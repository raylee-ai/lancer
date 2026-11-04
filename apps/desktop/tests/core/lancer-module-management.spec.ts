import { test, expect } from "@playwright/test";
import { join } from "node:path";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  getDesktopState,
} from "../helpers/electron-app";

test("manage module templates, retain conversations on deletion and restore after restart", async () => {
  test.setTimeout(90_000);
  const profile = await makeUserDataDir(),
    agentDir = join(profile, "agent"),
    workspace = await makeWorkspace("module-management");
  await seedAgentDir(agentDir);
  let harness = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    let page = await harness.firstWindow();
    await page.getByRole("button", { name: "新增模块", exact: true }).click();
    let manager = page.getByRole("dialog", { name: "管理模块", exact: true });
    await manager.getByLabel("模块名称", { exact: true }).fill("设计研究");
    await manager.getByLabel("模块说明", { exact: true }).fill("研究产品体验");
    await manager.getByRole("button", { name: "配置阶段、模型与 Skill" }).click();
    const workflow = page.getByRole("dialog", { name: "配置模块流程" });
    await page.keyboard.press("Escape");
    await expect(workflow).toHaveCount(0);
    await expect(manager.getByLabel("模块名称", { exact: true })).toHaveValue("设计研究");
    await manager.getByRole("button", { name: "配置阶段、模型与 Skill" }).click();
    await workflow.getByLabel("阶段 1 名称", { exact: true }).fill("竞品分析");
    await workflow.getByLabel("阶段 1 模型", { exact: true }).selectOption("openai/gpt-5");
    await workflow.getByRole("button", { name: "保存流程", exact: true }).click();
    await expect(manager).toContainText("竞品分析");
    await manager.getByRole("button", { name: "保存模块", exact: true }).click();
    await expect(manager).toHaveCount(0);
    await page.getByRole("button", { name: "设计研究", exact: true }).click();
    await page.getByTestId("new-thread-composer").fill("模块历史保留验证");
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(page.getByTestId("module-workflow")).toContainText("竞品分析");
    const state = await getDesktopState(page);
    const sessionId = state.selectedSessionId;
    expect(state.assistants?.workflows?.[`${workspace}:${sessionId}`]?.steps[0].title).toBe(
      "竞品分析",
    );
    await page.getByRole("button", { name: "设计研究", exact: true }).click({ button: "right" });
    manager = page.getByRole("dialog", { name: "管理模块", exact: true });
    await manager.getByLabel("模块名称", { exact: true }).fill("体验研究");
    await manager.getByRole("button", { name: "保存模块", exact: true }).click();
    await expect(page.getByRole("button", { name: "体验研究", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "体验研究", exact: true }).focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("dialog", { name: "管理模块", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "删除模块", exact: true }).click();
    await page.getByRole("button", { name: "确认删除模块", exact: true }).click();
    await expect(page.getByRole("button", { name: "体验研究", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("module-workflow")).toHaveCount(0);
    await page.getByRole("button", { name: "Standard chat", exact: true }).click();
    expect(
      (await getDesktopState(page)).workspaces
        .flatMap((w) => w.sessions)
        .some((s) => s.id === sessionId),
    ).toBe(true);
    await harness.close();
    harness = await launchDesktop(profile, { agentDir, testMode: "background" });
    page = await harness.firstWindow();
    await page.getByRole("button", { name: "管理模块", exact: true }).click();
    manager = page.getByRole("dialog", { name: "管理模块", exact: true });
    await manager
      .getByLabel("选择模块", { exact: true })
      .selectOption({ label: "体验研究（已删除）" });
    await expect(manager.getByLabel("模块说明", { exact: true })).toHaveValue("研究产品体验");
    await expect(manager).toContainText("竞品分析");
    await manager.getByRole("button", { name: "恢复模块", exact: true }).click();
    await expect(page.getByRole("button", { name: "体验研究", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("restored-module.png") });
  } finally {
    await harness.close();
  }
});
