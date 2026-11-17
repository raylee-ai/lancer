import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "../dist/custom-provider-store.js";

for (const [suffix, prefix] of [
  ["", ""],
  ["/", ""],
  ["/v1", ""],
  ["/v1/", ""],
  ["/gateway/anthropic", "/gateway/anthropic"],
  ["/gateway/anthropic/v1//", "/gateway/anthropic"],
  ["/v1/proxy/", "/v1/proxy"],
  ["/gateway/v10/", "/gateway/v10"],
  ["/gateway%3Fprefix%23name/v1/", "/gateway%3Fprefix%23name"],
]) {
  await test(`Anthropic ${suffix || "root"} saves an SDK-compatible root and requests messages once`, async () => {
    const requests: { method: string | undefined; path: string | undefined; key: unknown }[] = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method,
        path: request.url,
        key: request.headers["x-api-key"],
      });
      request.resume();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        {
          type: "message_start",
          message: {
            id: "fixture",
            type: "message",
            role: "assistant",
            model: "fixture",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "local fixture" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ])
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      const dir = await mkdtemp(join(tmpdir(), "pi-anthropic-url-"));
      const path = join(dir, "models.json");
      const store = new CustomProviderStore(path);
      await store.set({
        providerId: "anthropic-fixture",
        api: "anthropic-messages",
        baseUrl: ` ${origin}${suffix} `,
        models: [{ id: "fixture" }],
      });
      assert.equal((await store.list())[0]?.baseUrl, `${origin}${prefix}`);
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: path,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      assert.equal(runtime.getError(), undefined);
      const model = runtime.getModel("anthropic-fixture", "fixture");
      assert.ok(model);
      const result = await completeSimple(
        model,
        { messages: [{ role: "user", content: "local fixture", timestamp: 0 }] },
        { apiKey: "synthetic-url-fixture", maxTokens: 16 },
      );
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.deepEqual(result.content, [{ type: "text", text: "local fixture" }]);
      assert.deepEqual(requests, [
        { method: "POST", path: `${prefix}/v1/messages?beta=true`, key: "synthetic-url-fixture" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

await test("Anthropic queries and fragments cannot overwrite saved configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-anthropic-invalid-url-"));
  const path = join(dir, "models.json");
  const store = new CustomProviderStore(path);
  const entry = {
    providerId: "fixture",
    api: "anthropic-messages" as const,
    baseUrl: "http://localhost:9/gateway",
    models: [{ id: "fixture" }],
  };
  await store.set(entry);
  const original = await readFile(path, "utf8");
  for (const suffix of [
    "?",
    "#",
    "/v1/?",
    "?route=fixture",
    "#fragment",
    "/v1/?route=fixture#fragment",
  ]) {
    await assert.rejects(
      store.set({ ...entry, api: undefined, baseUrl: `${entry.baseUrl}${suffix}` }),
      /query string or fragment/,
    );
    assert.equal(await readFile(path, "utf8"), original);
  }
});

for (const api of ["openai-completions", "openai-responses"] as const) {
  await test(`${api} keeps its API prefix when saved`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-openai-url-"));
    const store = new CustomProviderStore(join(dir, "models.json"));
    for (const suffix of ["", "/", "/v1", "/v1/", "/gateway/v1/", "/gateway?route=fixture"]) {
      const baseUrl = `http://localhost:9${suffix}`;
      await store.set({ providerId: "fixture", api, baseUrl, models: [{ id: "fixture" }] });
      assert.equal((await store.list())[0]?.baseUrl, baseUrl);
    }
  });
}
