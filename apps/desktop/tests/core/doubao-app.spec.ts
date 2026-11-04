import { createServer } from "node:http";
import { makeVideoLearnFixture } from "../helpers/video-learn-fixture";
import { expect, test } from "@playwright/test";
import { chmod, readFile, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
} from "../helpers/electron-app";

test("Doubao App binds without a Pi model and keeps a fixed conversation across mode changes", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("doubao-ui");
  const agentDir = join(userDataDir, "agent");
  const helperPath = join(userDataDir, "doubao-fixture.mjs");
  const statePath = join(userDataDir, "doubao-fixture.json");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    statePath,
    JSON.stringify({
      messages: [
        {
          role: "assistant",
          text: "MULTILINE_VIDEO_A_OK\n/Users/test/downloads/video.mp4\nSHA256: abc123",
        },
      ],
      conversationId: "12345",
    }),
  );
  let releaseAnalysis!: () => void;
  let releaseHandoff!: () => void;
  const analysisReady = new Promise<void>((resolve) => {
    releaseAnalysis = resolve;
  });
  const handoffReady = new Promise<void>((resolve) => {
    releaseHandoff = resolve;
  });
  let releaseMotion!: () => void;
  const motionReady = new Promise<void>((resolve) => {
    releaseMotion = resolve;
  });
  let modelCalls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      let requestBody = "";
      request.setEncoding("utf8");
      for await (const chunk of request as AsyncIterable<string>) requestBody += chunk;
      const active = JSON.parse(
        await readFile(join(workspacePath, "_gates/active.json"), "utf8"),
      ) as { video_id: string };
      const manifest = JSON.parse(
        await readFile(join(workspacePath, "learning", active.video_id, "frames.json"), "utf8"),
      ) as { frames: { frame_index: number; pts_ms: number; sha256: string }[] };
      const ref = manifest.frames[0]!;
      modelCalls++;
      if (modelCalls === 3) expect(requestBody).toContain("向阳生长");
      const analysis = modelCalls === 1;
      await (modelCalls === 3 ? motionReady : analysis ? analysisReady : handoffReady);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: `fixture-${modelCalls}`,
          model: analysis ? "claude-haiku-5-5" : "gpt-6.1-sol",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify(
                  modelCalls === 3
                    ? {
                        title: "几何测试动画",
                        background: "#eee8d5",
                        shapes: [
                          {
                            kind: "circle",
                            color: "#e12332",
                            width: 180,
                            height: 180,
                            keys: [
                              { t: 0, x: 150, y: 270, scale: 0.5, rotation: 0, opacity: 1 },
                              { t: 5, x: 650, y: 270, scale: 1, rotation: 0, opacity: 1 },
                            ],
                          },
                        ],
                      }
                    : modelCalls === 4
                      ? "圆形从左向右移动。"
                      : analysis
                        ? { conclusions: [{ ...ref, observation: "测试观察" }] }
                        : { lessons: [{ ...ref, lesson: "测试学习结论，非真实模型" }] },
                ),
              },
            },
          ],
        }),
      );
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "example-gateway": {
          apiKey: "LOCAL_FIXTURE_ONLY",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [
            { id: "claude-haiku-5-5", input: ["text", "image"] },
            { id: "gpt-6.1-sol", input: ["text"] },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(userDataDir, "video-learn-tools.json"),
    JSON.stringify({
      ffmpegPath: process.env.FFMPEG,
      ffprobePath: process.env.FFPROBE,
      providerId: "example-gateway",
      modelId: "claude-haiku-5-5",
      handoffModelId: "gpt-6.1-sol",
    }),
  );
  // Only native UI transport is replaced; renderer, IPC and binding persistence are real.
  await writeFile(
    helperPath,
    `#!${process.execPath}
import fs from 'node:fs';
const path = ${JSON.stringify(statePath)};
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
if (input.action === 'select') state.conversationId = input.conversationId;
if (input.action === 'send') state.messages.push({role:'user',text:input.text},{role:'assistant',text:'豆包实际回复 fixture'});
fs.writeFileSync(path, JSON.stringify(state));
console.log(JSON.stringify({ok:true,permission:true,title:'固定测试会话',busy:false,hasVideo:true,durationMs:4000,...state,sent:input.action === 'send'}));
`,
  );
  await chmod(helperPath, 0o755);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PI_APP_DOUBAO_HELPER_PATH: helperPath },
  });
  try {
    const window = await harness.firstWindow();
    await openNewThread(window);
    await window.locator(".new-thread__hint .model-selector__badge").first().click();
    await window.getByTestId("choose-doubao-app").click();
    // One conversation owns one tree; workflow stages do not create extra chats.
    await expect(window.locator(".strip4 .lr")).toHaveCount(1);
    await expect(
      window.getByTestId("lancer-zone-sidebar").getByTestId("process-session-row"),
    ).toHaveCount(1);
    const transcript = window.getByTestId("doubao-app-transcript");
    await expect(transcript.getByText("固定测试会话", { exact: true })).toBeHidden();
    await expect(transcript.getByText("MULTILINE_VIDEO_A_OK", { exact: false })).toBeHidden();
    await transcript.getByText("会话连接", { exact: true }).click();
    await transcript.getByText("执行记录", { exact: false }).click();
    await expect(transcript.getByText("MULTILINE_VIDEO_A_OK", { exact: false })).toBeVisible();
    await transcript.getByText("执行记录", { exact: false }).click();
    await transcript.getByText("会话连接", { exact: true }).click();
    const composer = window.getByTestId("doubao-app-composer");
    await composer.fill("中文输入");
    await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    const nativeState = JSON.parse(await readFile(statePath, "utf8")) as { messages: unknown[] };
    expect(nativeState.messages).toHaveLength(1);
    await window.getByTestId("doubao-app-send").click();
    await expect(transcript).toContainText("豆包实际回复 fixture");
    await window.getByRole("button", { name: "豆包 App · 切回模型" }).click();
    await expect(composer).toHaveCount(0);
    await window.locator(".composer .model-selector__badge").first().click();
    await window.getByTestId("choose-doubao-app").click();
    await expect(transcript.getByText("固定测试会话", { exact: true })).toBeHidden();
    await expect(transcript).toContainText("豆包实际回复 fixture");
    await transcript.getByText("会话连接", { exact: true }).click();
    await window.getByRole("button", { name: "刷新回复", exact: true }).click();
    await transcript.getByText("会话连接", { exact: true }).click();
    await expect(transcript).not.toContainText("豆包正在执行");
    await window.reload();
    await expect(transcript.getByText("固定测试会话", { exact: true })).toBeHidden();
    await expect(transcript).toContainText("豆包实际回复 fixture");
    await window.screenshot({ path: test.info().outputPath("doubao-bound.png") });
    const saved = JSON.parse(await readFile(join(userDataDir, "doubao-app.json"), "utf8")) as {
      bindings: Record<string, { binding: { downloadDirectory: string } }>;
    };
    const directory = Object.values(saved.bindings)[0]!.binding.downloadDirectory;
    const fixture = makeVideoLearnFixture(directory, process.env.FFMPEG ?? "ffmpeg", 3);
    const old = new Date(Date.now() - 5000);
    await utimes(fixture, old, old);
    // Import the completed fixture through the real refresh action; do not race
    // the background polling cadence against the analysis assertion deadline.
    await transcript.getByText("会话连接", { exact: true }).click();
    const refresh = window.getByRole("button", { name: "刷新回复", exact: true });
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await transcript.getByText("会话连接", { exact: true }).click();
    const learning = transcript.getByRole("region", { name: "视频学习进度", includeHidden: true });
    await expect(learning.locator('[data-stage="analysis"] > summary')).toContainText(
      "正在分析画面",
    );
    await expect(learning).toContainText("正在分析画面");
    await expect(window.locator('.lhc[data-current="true"]')).toContainText("运行中");
    await expect(window.locator('.lhc[data-current="true"] .p')).toBeHidden();
    await expect(learning).not.toContainText("学片与模型交接完成");
    // Real FFmpeg work is visible before the model response completes.
    const media = learning.locator('[data-stage="media"]');
    const extract = media.locator(".video-process-step").filter({ hasText: "运行 ffmpeg 抽帧" });
    await extract.locator("summary").click();
    await expect(extract.locator(".process-tool-step__command")).toContainText("-vf");
    await expect(extract.locator(".process-tool-step__output")).toContainText("pts_time:");
    await expect(media.locator(".video-process-thumbnail img").first()).toBeVisible();
    await media.locator(".video-process-thumbnail").first().click();
    await expect(window.getByTestId("image-viewer")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("image-viewer")).toHaveCount(0);
    const group = media.locator(".video-process-steps > summary");
    await group.click();
    await expect(extract).toBeHidden();
    await group.click();
    await expect(extract.locator(".process-tool-step__command")).toBeVisible();
    await window.screenshot({ path: test.info().outputPath("analysis-running.png") });
    releaseAnalysis();
    await expect(learning).toContainText("正在整理学习结论");
    await expect(window.locator('.lhc[data-current="true"]')).toContainText("运行中");
    await expect(window.locator('.lhc[data-current="true"] .p')).toBeHidden();
    await expect(learning).toContainText("gpt-6.1-sol");
    releaseHandoff();
    await expect(learning).toContainText("学片与模型交接完成");
    await expect(learning).toContainText("测试学习结论，非真实模型");
    const handoff = learning.locator(".process-handoff-card");
    await expect(handoff).toContainText("claude-haiku-5-5 → gpt-6.1-sol");
    await expect(handoff).toContainText("spec.json");
    await expect(handoff).not.toContainText("example-gateway");
    await expect(handoff).not.toContainText("无损");
    expect(modelCalls).toBe(2);
    await expect(window.locator('.lhc[data-current="true"]')).toContainText("完成");
    await expect(window.locator(".strip4 .lr").first()).not.toContainText("未开始");
    await extract.locator("summary").click();
    await handoff.scrollIntoViewIfNeeded();
    await window.screenshot({ path: test.info().outputPath("handoff-complete.png") });
    await window.reload();
    await expect(learning).toContainText("学片与模型交接完成");
    await transcript.locator(".doubao-app-animation > summary").click();
    const animation = window.getByRole("region", { name: "代码动画工作区" });
    await expect(animation.getByRole("img").first()).toBeVisible();
    const snapshotButton = animation.locator(".animation-filmstrip button").first();
    expect((await snapshotButton.boundingBox())!.height).toBeGreaterThan(100);
    await expect(snapshotButton).toContainText("s");
    await animation.getByLabel("片段起点秒", { exact: true }).fill("0");
    await animation
      .getByLabel("新想法", { exact: true })
      .fill("几何图形拼成一朵花，最后出现向阳生长");
    await animation.getByRole("button", { name: "生成 5 秒动画" }).click();
    await expect(window.locator('.lhc[data-current="true"]')).toContainText("运行中");
    await expect(window.locator('.lhc[data-current="true"] .p')).toBeHidden();
    releaseMotion();
    await expect(animation).toContainText("5 秒代码动画已就绪", { timeout: 30000 });
    const before = await animation
      .locator("canvas")
      .evaluate((c: HTMLCanvasElement) => c.toDataURL());
    await animation.getByRole("button", { name: "播放", exact: true }).click();
    await expect
      .poll(() => animation.locator("canvas").evaluate((c: HTMLCanvasElement) => c.toDataURL()))
      .not.toBe(before);
    await animation.getByRole("button", { name: "导出 MP4" }).click();
    await expect(animation).toContainText("MP4 已导出", { timeout: 60000 });
    await window.screenshot({ path: test.info().outputPath("animation-export.png") });
    await window.reload();
    await expect(transcript.locator(".doubao-app-animation > summary")).toContainText("MP4 已导出");
    await transcript.locator(".doubao-app-animation > summary").click();
    await expect(animation).toContainText("已导出到当前项目");
    await expect(animation.getByLabel("新想法", { exact: true })).toHaveValue(
      "几何图形拼成一朵花，最后出现向阳生长",
    );
    // Both the received source and the exported result remain accessible after restart.
    await expect(transcript.getByRole("region", { name: "收到的视频" })).toContainText(
      "two-scenes-with-audio.mp4",
    );
    await expect(learning).toBeVisible();
    await expect(learning.locator(".process-handoff-card")).toContainText("claude-haiku-5-5");
    await expect(transcript.getByText("执行记录", { exact: false })).toBeHidden();
    await expect(transcript.getByText("查看代码", { exact: true })).toBeHidden();
    await expect(animation.getByRole("button", { name: "导出 MP4" })).toBeVisible();
  } finally {
    releaseMotion();
    releaseAnalysis();
    releaseHandoff();
    await harness.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
