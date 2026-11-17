import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

const PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
type Protocol = (typeof PROTOCOLS)[number];

interface ModelListRequest {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly apiKey: string | string[] | undefined;
  readonly anthropicVersion: string | string[] | undefined;
}

async function startModelListServer(statusCode: 200 | 404) {
  const requests: ModelListRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"],
      anthropicVersion: request.headers["anthropic-version"],
    });
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        statusCode === 200
          ? { data: [{ id: "protocol-model" }] }
          : { error: "Model discovery is unavailable" },
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function verifyProtocolFlow(
  protocol: Protocol,
  statusCode: 200 | 404 = 200,
  anthropicSuffix = "",
  expectedPrefix = "",
) {
  const modelServer = await startModelListServer(statusCode);
  let harness: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    const userDataDir = await makeUserDataDir();
    const agentDir = join(userDataDir, "agent");
    const workspacePath = await makeWorkspace("custom-endpoint-protocols");
    await seedAgentDir(agentDir, { enabledModels: [] });
    harness = await launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Providers");
    await window.getByRole("button", { name: "Add endpoint", exact: true }).click();

    const dialog = window.getByTestId("custom-endpoint-dialog");
    const providerId = `fixture-${protocol}`;
    const baseUrl =
      protocol === "anthropic-messages"
        ? `${modelServer.origin}${anthropicSuffix}`
        : `${modelServer.origin}/v1`;
    const savedBaseUrl =
      protocol === "anthropic-messages" ? `${modelServer.origin}${expectedPrefix}` : baseUrl;
    const apiKey = "synthetic-protocol-fixture-key";
    await dialog.getByLabel("Provider ID").fill(providerId);
    await dialog.getByLabel("API protocol").selectOption(protocol);
    if (protocol === "anthropic-messages" && statusCode === 200 && anthropicSuffix === "") {
      for (const suffix of ["?route=fixture", "#fragment"]) {
        await dialog.getByLabel("Base URL").fill(`${baseUrl}${suffix}`);
        await dialog.getByRole("button", { name: "Detect models", exact: true }).click();
        await expect(dialog).toContainText("must not contain a query string or fragment");
        expect(modelServer.requests).toEqual([]);
      }
    }
    await dialog.getByLabel("Base URL").fill(baseUrl);
    await dialog.getByLabel("API key").fill(apiKey);
    await dialog.getByRole("button", { name: "Detect models", exact: true }).click();

    const modelId = statusCode === 200 ? "protocol-model" : "manual-protocol-model";
    if (statusCode === 200) {
      await dialog.getByLabel(`Enable ${modelId}`, { exact: true }).check();
    } else {
      await expect(dialog).toContainText("404");
      await dialog.getByLabel("Add model ID manually").fill(modelId);
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await expect(dialog.getByLabel(`Enable ${modelId}`, { exact: true })).toBeChecked();
    }

    expect(modelServer.requests).toEqual([
      {
        method: "GET",
        path: `${expectedPrefix}/v1/models`,
        authorization: protocol === "anthropic-messages" ? undefined : `Bearer ${apiKey}`,
        apiKey: protocol === "anthropic-messages" ? apiKey : undefined,
        anthropicVersion: protocol === "anthropic-messages" ? "2023-06-01" : undefined,
      },
    ]);

    await dialog.getByRole("button", { name: "Add endpoint", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(saved.providers[providerId]).toMatchObject({
      api: protocol,
      baseUrl: savedBaseUrl,
      apiKey,
      models: [{ id: modelId }],
    });

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    const entryRow = customEndpoints.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: new RegExp(`^${providerId}$`) }),
    });
    await entryRow.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(dialog.getByLabel("API protocol")).toHaveValue(protocol);
    await expect(dialog.getByLabel("Base URL")).toHaveValue(savedBaseUrl);
    await expect(dialog.getByLabel(`Enable ${modelId}`, { exact: true })).toBeChecked();
  } finally {
    try {
      await harness?.close();
    } finally {
      await modelServer.close();
    }
  }
}

for (const protocol of PROTOCOLS) {
  test(`custom endpoint ${protocol} detects models and preserves its protocol when edited`, async () => {
    await verifyProtocolFlow(protocol);
  });
}

for (const [suffix, prefix] of [
  ["/", ""],
  ["/v1", ""],
  ["/v1/", ""],
  ["/gateway/anthropic/v1/", "/gateway/anthropic"],
]) {
  test(`Anthropic ${suffix} uses the same root for discovery and saved inference`, async () => {
    await verifyProtocolFlow("anthropic-messages", 200, suffix, prefix);
  });
}

test("custom endpoint with unavailable discovery still saves a manual Anthropic model", async () => {
  await verifyProtocolFlow("anthropic-messages", 404);
});
