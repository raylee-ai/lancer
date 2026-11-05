import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), "lctl-"));
  await writeFile(join(directory, "control.token"), "test-token\n");
  const requests = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1");
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, "Bearer test-token");
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    if (handler) handler(input, res);
    else res.end(JSON.stringify({ ok: true, result: input }));
  });
  await new Promise((resolve) => server.listen(join(directory, "control.sock"), resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  function run(args, onData) {
    const child = spawn(process.execPath, [
      resolve("scripts/lancer-ctl.mjs"),
      ...args,
      "--user-data-dir",
      directory,
    ]);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onData?.(stdout);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    return new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }
  return { run, requests };
}

test("new operations and old commands preserve wire payloads", async (t) => {
  const { run } = await fixture(t);
  const cases = [
    [["lanes", "--group", "g", "--json"], { operation: "lanes", group: "g" }],
    [["logs", "s", "--since", "12", "--json"], { operation: "logs", session: "s", since: 12 }],
    [["stop", "s"], { operation: "stop", session: "s" }],
    ...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((thinkingLevel) => [
      ["set-thinking", "Task title", thinkingLevel],
      { operation: "set-thinking", session: "Task title", thinkingLevel },
    ]),
    [
      ["set-result", "s", "out/result.json"],
      { operation: "set-result", session: "s", path: "out/result.json" },
    ],
    [
      ["set-stage", "s", "--stage", "testing", "--progress", "0.5"],
      { operation: "set-stage", session: "s", stage: "testing", progress: 0.5 },
    ],
    [
      ["set-stage", "s", "--stage", "null", "--progress", "null"],
      { operation: "set-stage", session: "s", stage: null, progress: null },
    ],
    [["set-stage", "s", "--progress", "0"], { operation: "set-stage", session: "s", progress: 0 }],
    [
      [
        "new",
        "--draft",
        "--cwd",
        ".",
        "--name",
        "task",
        "--group",
        "g",
        "--orchestrator",
        "o",
        "--role",
        "lane",
      ],
      {
        operation: "new",
        draft: true,
        cwd: process.cwd(),
        name: "task",
        group: "g",
        orchestrator: "o",
        role: "lane",
      },
    ],
    [
      ["new", "--cwd", ".", "--group", "g", "hello"],
      { operation: "new", cwd: process.cwd(), group: "g", message: "hello" },
    ],
    [
      ["new", "--cwd", ".", "--worktree", "hello"],
      { operation: "new", cwd: process.cwd(), worktree: true, message: "hello" },
    ],
    [
      ["send", "s", "--mode", "queue", "hello"],
      { operation: "send", session: "s", message: "hello", mode: "queue" },
    ],
    [["tail", "s", "--json"], { operation: "tail", session: "s", n: 20 }],
    [["sessions", "--json"], { operation: "sessions" }],
  ];
  for (const [args, expected] of cases) {
    const result = await run(args);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});

test("invalid arguments never dispatch", async (t) => {
  const { run, requests } = await fixture(t);
  for (const args of [
    ["logs", "s", "--since", "1.5"],
    ["logs", "s", "--since", "-1"],
    ["logs", "s", "--since", "9007199254740992"],
    ["logs"],
    ["stream", "a", "b"],
    ["stop"],
    ["set-thinking"],
    ["set-thinking", "s"],
    ["set-thinking", "s", "invalid"],
    ["set-thinking", "s", "HIGH"],
    ["set-thinking", "s", "high", "extra"],
    ["set-thinking", "s", "high", "--mode", "send"],
    ["set-result", "s"],
    ["set-stage", "s"],
    ["set-stage", "s", "--progress", "NaN"],
    ["set-stage", "s", "--progress", "1.1"],
    ["new", "--cwd", ".", "--role", "other", "hello"],
    ["lanes", "--since", "0"],
  ])
    assert.equal((await run(args)).code, 1, args.join(" "));
  assert.equal(requests.length, 0);
});

test("help documents set-thinking and supported levels", async (t) => {
  const { run, requests } = await fixture(t);
  const result = await run(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /set-thinking <id\|title> off\|minimal\|low\|medium\|high\|xhigh\|max/,
  );
  assert.equal(requests.length, 0);
});

test("stream delivers bytes before EOF and preserves split UTF-8/NDJSON", async (t) => {
  let release;
  const first = '{"seq":1,"text":"你好"}\n';
  const second = '{"seq":2,"kind":"status"}\n';
  const { run, requests } = await fixture(t, (_input, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    const bytes = Buffer.from(first);
    res.write(bytes.subarray(0, 20));
    res.write(bytes.subarray(20));
    release = () => res.end(second);
  });
  const result = await run(["stream", "s", "--since", "0"], (output) => {
    if (output.includes(first)) release();
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, first + second);
  assert.deepEqual(requests, [{ operation: "stream", session: "s", since: 0 }]);
});

test("stream surfaces authenticated API errors without retry", async (t) => {
  const { run, requests } = await fixture(t, (_input, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "denied" } }));
  });
  const result = await run(["stream"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /UNAUTHORIZED: denied/);
  assert.equal(result.stdout, "");
  assert.deepEqual(requests, [{ operation: "stream" }]);
});
