import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

test("editing an endpoint URL preserves advanced provider and model configuration", async () => {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("custom-endpoint-preservation");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: [],
  });

  const providerId = "advanced-fixture";
  const modelsPath = join(agentDir, "models.json");
  const provider = {
    baseUrl: "http://127.0.0.1:39997",
    api: "google-generative-ai",
    apiKey: "unused",
    piGuiCustomEndpoint: true,
    headers: { "X-Fixture-Route": "preserve-me" },
    compat: { supportsDeveloperRole: false },
    futureProviderField: { retained: true },
    models: [
      {
        id: "vision-model",
        api: "openai-responses",
        contextWindow: 64000,
        input: ["text", "image"],
        reasoning: true,
        maxTokens: 8192,
        headers: { "X-Fixture-Model": "preserve-me" },
        futureModelField: { retained: true },
      },
    ],
  };
  const fixture = {
    futureRootField: { retained: true },
    providers: { [providerId]: provider },
  };
  await writeFile(modelsPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: { LANCER_LOCALE: "en", PI_APP_REAL_AUTH: "0" },
  });
  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Providers");

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    const entryRow = customEndpoints.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: /^advanced-fixture$/ }),
    });
    await entryRow.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = window.getByTestId("custom-endpoint-dialog");
    await expect(dialog.getByLabel("Provider ID")).toHaveValue(providerId);
    const protocol = dialog.getByLabel("API protocol", { exact: true });
    await expect(protocol).toHaveValue("");
    await expect(protocol.locator("option:checked")).toHaveText(
      "Keep existing protocol (advanced configuration)",
    );
    await expect(dialog.getByRole("button", { name: "Detect models", exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("Enable vision-model", { exact: true })).toBeChecked();
    const updatedBaseUrl = "http://127.0.0.1:39998";
    await dialog.getByLabel("Base URL").fill(updatedBaseUrl);
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(entryRow).toContainText(updatedBaseUrl);

    await expect
      .poll(async () => JSON.parse(await readFile(modelsPath, "utf8")) as unknown)
      .toEqual({
        ...fixture,
        providers: { [providerId]: { ...provider, baseUrl: updatedBaseUrl } },
      });

    await entryRow.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(dialog.getByLabel("Base URL")).toHaveValue(updatedBaseUrl);
    await expect(protocol).toHaveValue("");
    await expect(dialog.getByLabel("Enable vision-model", { exact: true })).toBeChecked();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    await harness.close();
  }
});
