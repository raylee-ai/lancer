#!/usr/bin/env node
import { request } from "node:http";
import { pipeline } from "node:stream/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { controlPaths, defaultControlDirectory } from "./lib/control-paths.mjs";
import { readControlToken } from "./lib/control-token.mjs";

const usage = `Usage:
  lancer-ctl sessions [--json]
  lancer-ctl lanes [--group id] [--json]
  lancer-ctl logs <id|title> [--since seq] [--json]
  lancer-ctl stream [id|title] [--since seq]
  lancer-ctl stop <id|title>
  lancer-ctl set-model <id|title> <provider/model-id>
  lancer-ctl set-thinking <id|title> off|minimal|low|medium|high|xhigh|max
  lancer-ctl set-result <id|title> <path>
  lancer-ctl set-stage <id|title> [--stage text|null] [--progress number|null]
  lancer-ctl send <id|title> [--mode send|queue|steer] "message"
  lancer-ctl send <id|title> [--mode ...] --file path
  lancer-ctl tail <id|title> [-n 20] [--json]
  lancer-ctl wait <id|title> [--timeout seconds]
  lancer-ctl new --draft --cwd path --zone video --name "待办 · 下载视频"
  lancer-ctl new --cwd path [--zone video|research|lancer|xhs] [--model provider/id] [--name title] "message"
new also accepts --group id --orchestrator id --role lead|lane.
All commands accept --user-data-dir path (or LANCER_USER_DATA_DIR).
Requires a running Lancer with Settings > General > Allow local control API enabled.`;

function parse(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--draft") {
      options.draft = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const key = {
      "--user-data-dir": "directory",
      "--mode": "mode",
      "--file": "file",
      "-n": "n",
      "--timeout": "timeout",
      "--cwd": "cwd",
      "--model": "model",
      "--name": "name",
      "--zone": "zone",
      "--group": "group",
      "--orchestrator": "orchestrator",
      "--role": "role",
      "--since": "since",
      "--stage": "stage",
      "--progress": "progress",
    }[arg];
    if (!key || args[i + 1] === undefined || args[i + 1].startsWith("--"))
      throw new Error(`Invalid option: ${arg}`);
    if (options[key] !== undefined) throw new Error(`Duplicate option: ${arg}`);
    options[key] = args[++i];
  }
  return { options, positional };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  const allowed = {
    sessions: ["json"],
    send: ["mode", "file"],
    tail: ["n", "json"],
    wait: ["timeout"],
    new: ["cwd", "zone", "model", "name", "file", "draft", "group", "orchestrator", "role"],
    lanes: ["group", "json"],
    logs: ["since", "json"],
    stream: ["since"],
    stop: [],
    "set-thinking": [],
    "set-model": [],
    "set-result": [],
    "set-stage": ["stage", "progress"],
  }[command];
  if (!allowed) throw new Error(`Unknown command: ${command}\n${usage}`);
  const { options, positional } = parse(args);
  for (const key of Object.keys(options))
    if (key !== "directory" && !allowed.includes(key))
      throw new Error(`Option ${key} is not valid for ${command}`);
  const directory = resolve(
    options.directory || process.env.LANCER_USER_DATA_DIR || defaultControlDirectory(),
  );
  const { socketPath, tokenPath } = controlPaths(directory);
  let token;
  try {
    token = await readControlToken(tokenPath);
  } catch {
    throw new Error(
      `Lancer is not running with local control enabled at ${directory}. Start Lancer, enable the API, or select --user-data-dir.`,
    );
  }

  async function call(input, timeout = 30_000) {
    return new Promise((resolveResult, reject) => {
      const body = JSON.stringify(input);
      const req = request(
        {
          socketPath,
          path: "/v1",
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (response) => {
          if (
            command === "stream" &&
            response.statusCode === 200 &&
            response.headers["content-type"]?.split(";")[0].trim() === "application/x-ndjson"
          ) {
            clearTimeout(timer);
            pipeline(response, process.stdout, { end: false }).then(resolveResult, reject);
            return;
          }
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 32 * 1024 * 1024)
              response.destroy(new Error("Control response exceeds 32 MiB; reduce tail -n"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (!payload.ok)
                throw new Error(
                  `${payload.error?.code || "API_ERROR"}: ${payload.error?.message || "Request failed"}`,
                );
              if (command === "stream") throw new Error("Expected an NDJSON stream response");
              resolveResult(payload.result);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      const timer = setTimeout(
        () =>
          req.destroy(
            Object.assign(
              new Error(
                "Control request timed out; outcome may be unknown. Inspect tail before retrying; messages are never automatically replayed.",
              ),
              { code: "CONTROL_TIMEOUT" },
            ),
          ),
        timeout,
      );
      req.once("close", () => clearTimeout(timer));
      req.on("error", (error) => {
        reject(
          ["ENOENT", "ECONNREFUSED"].includes(error.code)
            ? new Error(
                `Lancer is not running or local control is disabled (${socketPath}). No session files were written.`,
              )
            : error,
        );
      });
      req.end(body);
    });
  }

  let input = { operation: command };
  if (command === "sessions" || command === "lanes") {
    if (positional.length) throw new Error(`${command} takes no positional arguments`);
    if (command === "lanes") input.group = options.group;
  } else if (command === "stream") {
    if (positional.length > 1) throw new Error("stream accepts at most one session");
    input.session = positional[0];
  } else if (command === "set-model") {
    if (positional.length !== 2 || !/^[^/\s]+\/[^\s]+$/.test(positional[1]))
      throw new Error("set-model requires a session and exact provider/model-id");
    input.session = positional[0];
    input.model = positional[1];
  } else if (command === "set-thinking") {
    if (positional.length !== 2)
      throw new Error("set-thinking requires a session and thinking level");
    const thinkingLevel = positional[1];
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel))
      throw new Error("thinking level must be off, minimal, low, medium, high, xhigh or max");
    input.session = positional[0];
    input.thinkingLevel = thinkingLevel;
  } else if (command === "set-result") {
    if (positional.length !== 2) throw new Error("set-result requires a session and path");
    input.session = positional[0];
    input.path = positional[1];
  } else if (command === "new" && options.draft) {
    if (positional.length || options.file) throw new Error("--draft cannot include a message");
    if (!options.cwd || !options.name) throw new Error("--draft requires --cwd and --name");
    input = {
      ...input,
      draft: true,
      cwd: resolve(options.cwd),
      name: options.name,
      zone: options.zone,
      model: options.model,
    };
  } else if (command === "send" || command === "new") {
    const count = command === "send" ? 1 : 0;
    if (positional.length !== count + (options.file ? 0 : 1))
      throw new Error("Provide exactly one message string OR --file path (and a session for send)");
    const message = options.file
      ? await readFile(resolve(options.file), "utf8")
      : positional[count];
    if (!message.trim()) throw new Error("Message must not be empty");
    if (command === "send") {
      const mode = options.mode || "send";
      if (!["send", "queue", "steer"].includes(mode))
        throw new Error("mode must be send, queue or steer");
      input = { ...input, session: positional[0], message, mode };
    } else {
      if (!options.cwd) throw new Error("new requires --cwd");
      input = {
        ...input,
        cwd: resolve(options.cwd),
        model: options.model,
        name: options.name,
        zone: options.zone,
        message,
      };
    }
  } else {
    if (positional.length !== 1) throw new Error(`${command} requires exactly one session`);
    input.session = positional[0];
    if (command === "tail") {
      input.n = Number(options.n ?? 20);
      if (!Number.isInteger(input.n) || input.n < 1 || input.n > 1000)
        throw new Error("-n must be 1..1000");
    }
  }
  if (command === "new") {
    if (options.role !== undefined && !["lead", "lane"].includes(options.role))
      throw new Error("--role must be lead or lane");
    Object.assign(input, {
      group: options.group,
      orchestrator: options.orchestrator,
      role: options.role,
    });
  }
  if (options.since !== undefined) {
    if (!/^\d+$/.test(options.since) || !Number.isSafeInteger(Number(options.since)))
      throw new Error("--since must be a non-negative safe integer");
    input.since = Number(options.since);
  }
  if (command === "set-stage") {
    if (options.stage === undefined && options.progress === undefined)
      throw new Error("set-stage requires --stage or --progress");
    if (options.stage !== undefined) input.stage = options.stage === "null" ? null : options.stage;
    if (options.progress !== undefined) {
      const progress = options.progress === "null" ? null : Number(options.progress);
      if (
        progress !== null &&
        (!options.progress.trim() || !Number.isFinite(progress) || progress < 0 || progress > 1)
      )
        throw new Error("--progress must be 0..1 or null");
      input.progress = progress;
    }
  }
  let result;
  if (command === "wait") {
    const seconds = Number(options.timeout ?? 300);
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new Error("--timeout must be a positive number of seconds");
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      try {
        result = await call(input, Math.max(1, Math.min(30_000, deadline - Date.now())));
      } catch (error) {
        if (error.code === "CONTROL_TIMEOUT" && Date.now() >= deadline) break;
        throw error;
      }
      if (result.done) break;
      await sleep(Math.max(0, Math.min(250, deadline - Date.now())));
    }
    if (!result?.done) {
      console.log(JSON.stringify({ ...result, done: false, timedOut: true }, null, 2));
      process.exitCode = 2;
      return;
    }
    if (result.outcome === "failed") process.exitCode = 1;
  } else result = await call(input);

  if (command === "stream") return;
  if (command === "lanes" && !options.json) {
    for (const lane of result.lanes)
      console.log(
        [
          lane.id,
          lane.title,
          lane.model,
          lane.status,
          lane.stage,
          lane.progress,
          lane.startedAt,
          lane.elapsed,
          lane.resultPath,
          lane.lastLine,
        ]
          .map((value) => value ?? "")
          .join("\t"),
      );
  } else if (command === "logs" && !options.json) {
    for (const event of result.events) console.log(`[${event.seq}] ${event.kind}\t${event.text}`);
  } else if (command === "sessions" && !options.json) {
    for (const session of result.sessions)
      console.log(
        `${session.workspaceId}:${session.id}\t${session.status}\t${session.title}\t${session.zone}\t${session.workspace}\t${session.cwd}\t${session.model || "(default/unknown)"}`,
      );
  } else if (command === "tail" && !options.json) {
    console.log(
      `${result.session.title} — ${result.session.status}${result.error ? ` (${result.error})` : ""}`,
    );
    for (const message of result.messages)
      console.log(`[${message.role || message.kind}] ${message.text ?? message.label ?? ""}`);
    console.log(`\nLast assistant reply:\n${result.lastAssistant ?? "(none)"}`);
  } else console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`lancer-ctl: ${error.message}`);
  process.exitCode = 1;
});
