import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  getDesktopState,
  getRealAuthConfig,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  writeProjectExtension,
} from "../helpers/electron-app";

/**
 * A tool the model is told to call keeps the real run open for a fixed window,
 * so queueing follow-ups and pressing Stop are not racing a fast answer. It is
 * abort-aware, which is what Stop exercises.
 */
const HOLD_RUN_EXTENSION = `
import { Type } from "@sinclair/typebox";
export default function(pi) {
  pi.registerTool({
    name: "hold_run",
    label: "Hold run",
    description: "Blocks the current turn for the requested number of seconds. Call it exactly once when asked to hold the run.",
    parameters: Type.Object({ seconds: Type.Number() }),
    async execute(_id, params, signal) {
      const ms = Math.min(120, Math.max(1, Number(params.seconds) || 1)) * 1000;
      const started = Date.now();
      while (Date.now() - started < ms) {
        if (signal?.aborted) throw new Error("Hold aborted");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { content: [{ type: "text", text: "held" }], details: { exitCode: 0 } };
    },
  });
}
`;

function realProvider(): { provider: string; model: string } {
  const auth = getRealAuthConfig();
  if (!auth.enabled) throw new Error(auth.skipReason);
  const provider = process.env.PI_GUI_PROVIDER;
  const model = process.env.PI_GUI_MODEL;
  if (!provider || !model) throw new Error("Specify the real provider and model");
  return { provider, model };
}

async function launchWithHold(name: string): Promise<{
  app: Awaited<ReturnType<typeof launchDesktop>>;
  page: Page;
}> {
  const auth = getRealAuthConfig();
  if (!auth.sourceDir) throw new Error(auth.skipReason ?? "Missing real auth source");
  const { provider, model } = realProvider();
  const profile = await makeUserDataDir();
  const workspace = await makeWorkspace(name);
  await writeProjectExtension(workspace, "hold-run.ts", HOLD_RUN_EXTENSION);
  const app = await launchDesktop(profile, {
    initialWorkspaces: [workspace],
    realAuthSourceDir: auth.sourceDir,
    enabledModels: [`${provider}/${model}`],
    scrubProviderEnv: true,
    testMode: "background",
  });
  return { app, page: await app.firstWindow() };
}

async function selectedSessionStatus(page: Page): Promise<string | undefined> {
  const state = await getDesktopState(page);
  return state.workspaces
    .flatMap((workspace) => workspace.sessions)
    .find((session) => session.id === state.selectedSessionId)?.status;
}

async function userMessages(page: Page): Promise<string[]> {
  const transcript = await getSelectedTranscript(page);
  return (transcript?.transcript ?? [])
    .filter((item) => item.kind === "message" && item.role === "user")
    .map((item) => ("text" in item ? item.text : ""));
}

test("Stop discards queued follow-ups before the reply is published", async () => {
  test.setTimeout(240_000);
  const { provider, model } = realProvider();
  const { app, page } = await launchWithHold("stop-clears-queue");

  try {
    await page.evaluate(() => {
      const counter = { pushes: 0 };
      (window as unknown as { __stopQueueProbe: typeof counter }).__stopQueueProbe = counter;
      window.piApp!.onStateChanged(() => {
        counter.pushes += 1;
      });
    });

    await openNewThread(page);
    await page
      .getByLabel("New thread prompt")
      .fill(
        "先调用 hold_run 工具一次，参数 seconds=45；工具返回后再输出 STOPQUEUE_DONE。不要调用其他工具，不要在工具返回前输出任何内容。",
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect.poll(() => selectedSessionStatus(page), { timeout: 120_000 }).toBe("running");
    // Once the hold tool runs the turn cannot finish before it returns, so the two
    // follow-ups below are queued rather than sent as a new turn.
    await expect(page.getByText(/hold_run|Hold run/).first()).toBeVisible({ timeout: 120_000 });

    const composer = page.getByTestId("composer");
    for (const text of ["queued-one", "queued-two"]) {
      await composer.fill(text);
      await composer.press("Enter");
    }
    await expect(page.getByTestId("queued-composer-message")).toHaveCount(2, { timeout: 20_000 });
    const beforeStop = await getDesktopState(page);
    expect(beforeStop.queuedComposerMessages.map((message) => message.text)).toEqual([
      "queued-one",
      "queued-two",
    ]);

    await page.evaluate(() => {
      (window as unknown as { __stopQueueProbe: { pushes: number } }).__stopQueueProbe.pushes = 0;
    });
    const stopClickedAt = Date.now();
    await page.getByRole("button", { name: "Stop run", exact: true }).click();

    // Sample the DOM and the published state until Stop settles. The reply that
    // answers the click used to be built from the pre-cancel published field, so
    // the queue never cleared; a stale queued snapshot then kept re-adding it.
    const timeline: Array<{
      ms: number;
      dom: number;
      state: number;
      status: string | undefined;
    }> = [];
    let clearedAtMs: number | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const dom = await page.getByTestId("queued-composer-message").count();
      const state = await getDesktopState(page);
      timeline.push({
        ms: Date.now() - stopClickedAt,
        dom,
        state: state.queuedComposerMessages.length,
        status: state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((session) => session.id === state.selectedSessionId)?.status,
      });
      if (dom === 0 && state.queuedComposerMessages.length === 0) {
        clearedAtMs = Date.now() - stopClickedAt;
        break;
      }
      await page.waitForTimeout(250);
    }
    const pushes = await page.evaluate(
      () => (window as unknown as { __stopQueueProbe: { pushes: number } }).__stopQueueProbe.pushes,
    );
    // Evidence first: a failing run still writes what the UI showed after Stop.
    await writeFile(
      test.info().outputPath("stop-queue.json"),
      JSON.stringify(
        {
          provider,
          model,
          queueBeforeStop: beforeStop.queuedComposerMessages.map((message) => message.text),
          clearedAtMs,
          timeline,
          statePushesAfterStop: pushes,
        },
        null,
        2,
      ),
    );
    expect(
      clearedAtMs,
      "queued messages must disappear from the composer after Stop",
    ).toBeDefined();

    expect((await userMessages(page)).some((text) => text.includes("queued-one"))).toBe(false);

    // Nothing may resurrect the queue once the cancelled run settles.
    await page.waitForTimeout(5_000);
    await expect(page.getByTestId("queued-composer-message")).toHaveCount(0);
    expect((await getDesktopState(page)).queuedComposerMessages).toEqual([]);
  } finally {
    await app.close();
  }
});

test("a queued follow-up still runs when the held turn ends normally", async () => {
  test.setTimeout(240_000);
  realProvider();
  const { app, page } = await launchWithHold("stop-queue-delivers");

  try {
    await openNewThread(page);
    await page
      .getByLabel("New thread prompt")
      .fill(
        "先调用 hold_run 工具一次，参数 seconds=8；工具返回后输出 HOLD_DONE。不要调用其他工具，不要在工具返回前输出任何内容。",
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(page.getByText(/hold_run|Hold run/).first()).toBeVisible({ timeout: 120_000 });

    const composer = page.getByTestId("composer");
    await composer.fill("queued-followup");
    await composer.press("Enter");
    await expect(page.getByTestId("queued-composer-message")).toHaveCount(1, { timeout: 20_000 });

    // The turn settles and the queued message starts as the next turn: it must
    // reach the transcript, not be dropped by the queue bookkeeping.
    await expect
      .poll(
        async () => (await userMessages(page)).some((text) => text.includes("queued-followup")),
        {
          timeout: 120_000,
        },
      )
      .toBe(true);
    await expect(page.getByTestId("queued-composer-message")).toHaveCount(0, { timeout: 30_000 });
    expect((await getDesktopState(page)).queuedComposerMessages).toEqual([]);
  } finally {
    await app.close();
  }
});
