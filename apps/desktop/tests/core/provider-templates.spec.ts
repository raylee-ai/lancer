import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

test("provider templates search aliases, allow overrides, persist and reuse native providers", async () => {
  const profile = await makeUserDataDir();
  const agentDir = join(profile, "agent");
  const workspace = await makeWorkspace("provider-templates");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const harness = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const page = await harness.firstWindow();
    await page.keyboard.press(desktopShortcut(","));
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await page.getByRole("button", { name: "Choose template", exact: true }).click();
    const picker = page.getByTestId("provider-preset-dialog");
    await picker.getByRole("searchbox", { name: "Search templates" }).fill("no-such-template");
    await expect(picker).toContainText("No matching templates");
    await picker.getByRole("searchbox", { name: "Search templates" }).fill("豆包");
    await expect(
      picker.getByRole("button", { name: "Volcengine Ark · Agent Plan", exact: true }),
    ).toBeVisible();
    await picker.getByRole("button", { name: "Volcengine Ark · Agent Plan", exact: true }).click();
    await expect(picker).toHaveCount(0);
    const form = page.getByTestId("custom-endpoint-dialog");
    await expect(form.getByLabel("Provider ID")).toHaveValue("volcengine-agent-plan");
    await expect(form.getByLabel("API protocol")).toHaveValue("anthropic-messages");
    await expect(form.getByLabel("Base URL")).toHaveValue(
      "https://ark.cn-beijing.volces.com/api/plan",
    );
    await expect(form.getByLabel("API key")).toHaveValue("");
    // Override the public preset with a local fixture; choosing a template never calls its server.
    await form.getByLabel("Base URL").fill("http://127.0.0.1:39997/plan");
    await form.getByLabel("Add model ID manually").fill("account-specific-model");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await form.getByRole("button", { name: "Add endpoint", exact: true }).click();
    await expect(form).toHaveCount(0);
    const saved = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(saved.providers["volcengine-agent-plan"]).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "http://127.0.0.1:39997/plan",
      models: [{ id: "account-specific-model" }],
    });

    // Native templates open the existing account flow instead of creating another provider.
    await page.getByRole("button", { name: "Choose template", exact: true }).click();
    await picker.getByRole("searchbox", { name: "Search templates" }).fill("openrouter");
    await picker.getByRole("button", { name: "OpenRouter", exact: true }).click();
    await expect(page.getByTestId("provider-api-key-dialog")).toContainText("OpenRouter");
    await expect(form).toHaveCount(0);
    await page
      .getByTestId("provider-api-key-dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    const after = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as unknown;
    expect(after).toEqual(saved);

    // Manual creation remains available and starts with a clean form.
    await page.getByRole("button", { name: "Add endpoint", exact: true }).click();
    await expect(form.getByLabel("Provider ID")).toHaveValue("");
    await expect(form.getByLabel("API protocol")).toHaveValue("openai-completions");
    await expect(form.getByLabel("Base URL")).toHaveValue("");
  } finally {
    await harness.close();
  }
});
