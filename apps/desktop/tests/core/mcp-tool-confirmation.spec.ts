import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  openNewThread,
  getDesktopState,
  openSettingsSection,
  writeProjectExtension,
  type DesktopHarness,
} from "../helpers/electron-app";

const narrowApprovalWidth = 560;
const narrowApprovalHeight = 420;

// Only the model is scripted. Pi loads the actual stdio MCP/codemode factories,
// emits nested tool_call hooks, and runs tools only after renderer confirmation.
const provider = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  pi.registerProvider("approval-test", {
    baseUrl: "http://127.0.0.1:9/never-contact", apiKey: "LOCAL_FIXTURE", api: "approval-test",
    models: [{ id: "scripted", name: "Approval fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const index = context.messages.findLastIndex((m) => m.role === "user");
      const prompt = JSON.stringify(context.messages[index]);
      const finished = context.messages.slice(index + 1).some((m) => m.role === "toolResult");
      const direct = prompt.includes("direct");
      const large = prompt.includes("large");
      const text = "APPROVAL_TURN_COMPLETE";
      const message = {
        role: "assistant",
        content: finished ? [{ type: "text", text }] : [{ type: "toolCall", id: "approval-" + index,
          name: direct ? "mcp__fixture__write_note" : "codemode",
          arguments: direct
            ? { text: large ? "中文工具参数" + String.fromCharCode(10) + "UNBROKEN".repeat(60) + String.fromCharCode(10) + "长参数".repeat(3000) : "direct" }
            : { code: 'const result = await tools.mcp__fixture__write_note({text: "nested"}); text(result);' },
        }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: finished ? "stop" : "toolUse", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (finished) stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
}
`;

async function useNarrowApprovalWindow(app: DesktopHarness, page: Page): Promise<void> {
  await app.electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error("missing desktop window");
      }
      // Product minimum is 560×600. Shrink further so the long approval cannot
      // fit unless the dialog scrolls internally.
      window.setMinimumSize(480, 320);
      window.setContentSize(size.width, size.height);
    },
    { height: narrowApprovalHeight, width: narrowApprovalWidth },
  );
  await expect
    .poll(() =>
      page.evaluate(
        ([width, height]) =>
          Math.abs(window.innerWidth - width) <= 4 && Math.abs(window.innerHeight - height) <= 4,
        [narrowApprovalWidth, narrowApprovalHeight] as const,
      ),
    )
    .toBe(true);
}

async function controlBox(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: Math.round(rect.bottom),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      top: Math.round(rect.top),
    };
  });
}

async function receivesPointer(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return target !== null && element.contains(target);
  });
}

async function expectLongApprovalFits(dialog: Locator): Promise<void> {
  const body = dialog.locator(".extension-dialog__body");
  const confirm = dialog.getByTestId("extension-dialog-confirm");
  const cancel = dialog.getByTestId("extension-dialog-cancel");
  const layout = await dialog.evaluate((element) => {
    const bodyElement = element.querySelector<HTMLElement>(".extension-dialog__body");
    const rect = element.getBoundingClientRect();
    const style = bodyElement ? getComputedStyle(bodyElement) : undefined;
    return {
      bodyClientHeight: bodyElement?.clientHeight ?? 0,
      bodyClientWidth: bodyElement?.clientWidth ?? 0,
      bodyScrollHeight: bodyElement?.scrollHeight ?? 0,
      bodyScrollWidth: bodyElement?.scrollWidth ?? 0,
      bodyText: bodyElement?.innerText ?? "",
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      whiteSpace: style?.whiteSpace ?? "",
    };
  });
  expect(Math.abs(layout.viewportWidth - narrowApprovalWidth)).toBeLessThanOrEqual(4);
  expect(Math.abs(layout.viewportHeight - narrowApprovalHeight)).toBeLessThanOrEqual(4);
  expect(layout.top).toBeGreaterThanOrEqual(23);
  expect(layout.left).toBeGreaterThanOrEqual(23);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth - 23);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight - 23);
  expect(layout.whiteSpace).toBe("pre-wrap");
  expect(layout.bodyScrollHeight).toBeGreaterThan(layout.bodyClientHeight + 24);
  expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.bodyClientWidth + 1);
  expect(layout.bodyText).toContain("中文工具参数\\nUNBROKEN");
  expect(layout.bodyText).toMatch(/mcp__fixture__write_note\n\n\{\n\s+"text":/);
  expect(layout.bodyText).toContain("Approve this call only; approval is never remembered.");

  const confirmBefore = await controlBox(confirm);
  const cancelBefore = await controlBox(cancel);
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(20);
  expect(await controlBox(confirm)).toEqual(confirmBefore);
  expect(await controlBox(cancel)).toEqual(cancelBefore);
  await expect(confirm).toBeInViewport({ ratio: 1 });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await expect(confirm).toHaveAccessibleName("Confirm");
  await expect(cancel).toHaveAccessibleName("Cancel");
  await expect(confirm).toBeEnabled();
  await expect(cancel).toBeEnabled();
  expect(await receivesPointer(confirm)).toBe(true);
  expect(await receivesPointer(cancel)).toBe(true);
  expect(
    await body.evaluate(
      (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
    ),
  ).toBe(true);
}

test("MCP read-only claims and codemode cannot bypass per-call confirmation", async () => {
  const profile = await makeUserDataDir();
  const agentDir = join(profile, "agent");
  const workspace = await makeWorkspace("mcp-approval");
  const marker = join(workspace, "writes.ndjson");
  await writeFile(marker, "");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(join(profile, "ui-state.json"), JSON.stringify({ language: "en" }));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "approval-test",
      defaultModel: "scripted",
      enabledModels: ["approval-test/scripted"],
      defaultTools: ["codemode", "read"],
      compaction: { enabled: false },
    }),
  );
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [
            resolve("apps/desktop/tests/fixtures/mcp-approval-server.mjs"),
            marker,
            "--claim-readonly",
          ],
          exposure: "direct",
        },
      },
    }),
  );
  await writeProjectExtension(workspace, "approval-provider.ts", provider);
  const app = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const page = await app.firstWindow();
    const idle = () =>
      expect
        .poll(async () => {
          const state = await getDesktopState(page);
          return state.workspaces
            .flatMap((w) => w.sessions)
            .find((s) => s.id === state.selectedSessionId)?.status;
        })
        .toBe("idle");
    await openNewThread(page);
    await page.getByLabel("New thread prompt").fill("direct call with a false read-only claim");
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    const dialog = page.getByTestId("extension-dialog");
    await expect(dialog).toContainText("mcp__fixture__write_note");
    await expect(dialog).toContainText("Confirm this tool call");
    expect(await readFile(marker, "utf8")).toBe("");
    await dialog.getByTestId("extension-dialog-cancel").click();
    await expect(page.locator(".process-assistant").last()).toContainText("APPROVAL_TURN_COMPLETE");
    await idle();
    expect(await readFile(marker, "utf8")).toBe("");

    await useNarrowApprovalWindow(app, page);
    await page.getByTestId("composer").fill("direct large call with Chinese parameters");
    await page.getByTestId("send").click();
    await expect(dialog).toContainText("中文工具参数");
    await expectLongApprovalFits(dialog);
    await page.screenshot({ path: test.info().outputPath("long-approval-scrolled.png") });
    await dialog.getByTestId("extension-dialog-cancel").click();
    await expect(page.locator(".process-assistant").last()).toContainText("APPROVAL_TURN_COMPLETE");
    await idle();
    expect(await readFile(marker, "utf8")).toBe("");

    for (const approveNested of [true, false]) {
      await page.getByTestId("composer").fill("nested call " + String(approveNested));
      await page.getByTestId("send").click();
      await expect(dialog).toContainText("codemode");
      await dialog.getByTestId("extension-dialog-confirm").click();
      // Outer approval must not pre-approve the nested tool, even with readOnlyHint.
      await expect(dialog).toContainText("mcp__fixture__write_note");
      await expect(dialog).not.toContainText('"code"');
      await dialog
        .getByTestId(approveNested ? "extension-dialog-confirm" : "extension-dialog-cancel")
        .click();
      await expect(page.locator(".process-assistant").last()).toContainText(
        "APPROVAL_TURN_COMPLETE",
      );
      await idle();
      expect((await readFile(marker, "utf8")).trim().split("\n")).toEqual([
        JSON.stringify({ text: "nested" }),
      ]);
    }

    await page.getByTestId("composer").fill("direct large confirm with Chinese parameters");
    await page.getByTestId("send").click();
    await expect(dialog).toContainText("中文工具参数");
    await expectLongApprovalFits(dialog);
    await dialog.getByTestId("extension-dialog-confirm").click();
    await expect(page.locator(".process-assistant").last()).toContainText("APPROVAL_TURN_COMPLETE");
    await idle();
    const lines = (await readFile(marker, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(JSON.stringify({ text: "nested" }));
    const approved = JSON.parse(lines[1] ?? "") as { text?: string };
    expect(approved.text?.slice(0, "中文工具参数\nUNBROKEN".length)).toBe("中文工具参数\nUNBROKEN");
    expect(approved.text?.endsWith("长参数")).toBe(true);
    expect((approved.text ?? "").length).toBeGreaterThan(5_000);
    await page.screenshot({ path: test.info().outputPath("mcp-confirmed-and-cancelled.png") });
  } finally {
    await app.close();
  }
});

test("MCP integrations can be disabled in Settings and stay disabled after restart", async () => {
  const profile = await makeUserDataDir();
  const agentDir = join(profile, "agent");
  const workspace = await makeWorkspace("mcp-switches");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      scrubProviderEnv: true,
      testMode: "background",
    });
  for (const initial of [true, false]) {
    const app = await launch();
    try {
      const page = await app.firstWindow();
      if (!(await page.getByTestId("extensions-list").isVisible()))
        await openSettingsSection(page, "Extensions");
      for (const [label, name] of [
        ["MCP", "lancer-mcp"],
        ["Codemode", "lancer-codemode"],
        ["Tool search", "lancer-tool-search"],
      ]) {
        const toggle = page
          .getByTestId("extensions-list")
          .getByRole("switch", { name: "Enable " + label, exact: true });
        if (initial) {
          await expect(toggle).toBeChecked();
          await toggle.click();
        }
        await expect(toggle).not.toBeChecked();
        await expect
          .poll(async () => {
            const state = await getDesktopState(page);
            return Object.values(state.runtimeByWorkspace)
              .flatMap((r) => r.extensions)
              .find((e) => e.path === "<inline:" + name + ">")?.enabled;
          })
          .toBe(false);
      }
      await expect(page.getByRole("switch", { name: /lancer-tool-permissions/ })).toHaveCount(0);
    } finally {
      await app.close();
    }
  }
});
