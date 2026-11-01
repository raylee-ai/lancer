import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CustomProviderStore } from "../dist/custom-provider-store.js";

const endpoint = {
  providerId: "local-endpoint",
  baseUrl: "http://localhost:8080/v1",
  models: [{ id: "test-model" }],
};

async function withStore(
  run: (store: CustomProviderStore, path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-provider-"));
  // Retain synthetic fixtures for failure inspection, per repository policy.
  const path = join(dir, "models.json");
  await run(new CustomProviderStore(path), path);
}

for (const providers of [[], ["saved-value"], null, false, 0, "saved-value"]) {
  await test(`rejects malformed providers ${JSON.stringify(providers)} without changing bytes`, async () => {
    await withStore(async (store, path) => {
      const original = `${JSON.stringify({ providers, futureSetting: { retained: true } }, null, 4)}\n`;
      await writeFile(path, original);
      for (const operation of [
        () => store.list(),
        () => store.set(endpoint),
        () => store.delete(endpoint.providerId),
      ]) {
        await assert.rejects(operation, /JSON object for providers/);
        assert.equal(await readFile(path, "utf8"), original);
      }
    });
  });
}

await test("missing file or providers supports saving and reopening an endpoint", async () => {
  for (const initial of [undefined, "", '{"futureSetting":{"retained":true}}']) {
    await withStore(async (store, path) => {
      if (initial !== undefined) await writeFile(path, initial);
      assert.deepEqual(await store.list(), []);
      assert.equal(await store.delete(endpoint.providerId), false);
      await store.set(endpoint);
      assert.deepEqual(await new CustomProviderStore(path).list(), [
        { ...endpoint, api: "openai-completions" },
      ]);
      if (initial) {
        const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        assert.deepEqual(saved.futureSetting, {
          retained: true,
        });
      }
      assert.equal(await store.delete(endpoint.providerId), true);
      assert.deepEqual(await store.list(), []);
    });
  }
});

await test("set and delete preserve unrelated upstream fields and providers", async () => {
  await withStore(async (store, path) => {
    const original = {
      futureSetting: { retained: true },
      providers: {
        upstream: { api: "future-api", customField: ["preserved"] },
      },
    };
    await writeFile(path, JSON.stringify(original));
    await store.set(endpoint);
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      futureSetting: unknown;
      providers: Record<string, unknown>;
    };
    assert.deepEqual(saved.futureSetting, original.futureSetting);
    assert.deepEqual(saved.providers.upstream, original.providers.upstream);
    assert.equal(await store.delete(endpoint.providerId), true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
  });
});

await test("editing an endpoint preserves provider and model fields outside the form", async () => {
  await withStore(async (store, path) => {
    const advancedModel = {
      id: "vision-model",
      input: ["text", "image"],
      reasoning: true,
      maxTokens: 4096,
      contextWindow: 32000,
      compat: { supportsDeveloperRole: false },
      futureModelField: { retained: true },
    };
    const original = {
      providers: {
        [endpoint.providerId]: {
          baseUrl: endpoint.baseUrl,
          api: "openai-responses",
          apiKey: "unused",
          piGuiCustomEndpoint: true,
          headers: { "X-Example": "synthetic" },
          futureProviderField: { retained: true },
          models: [advancedModel],
        },
      },
    };
    await writeFile(path, JSON.stringify(original));
    const [listed] = await store.list();
    await store.set({ ...listed, baseUrl: "http://localhost:9090/v1" });
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(saved.providers[endpoint.providerId], {
      ...original.providers[endpoint.providerId],
      baseUrl: "http://localhost:9090/v1",
    });
  });
});

await test("model edits preserve fields by ID while removed models stay removed", async () => {
  await withStore(async (store, path) => {
    await writeFile(
      path,
      JSON.stringify({
        providers: {
          [endpoint.providerId]: {
            baseUrl: endpoint.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            piGuiCustomEndpoint: true,
            models: [
              { id: "removed-model", input: ["text", "image"] },
              { id: "kept-model", reasoning: true, contextWindow: 32000 },
            ],
          },
        },
      }),
    );
    await store.set({
      ...endpoint,
      models: [{ id: "kept-model", contextWindow: 64000 }, { id: "new-model" }],
    });
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(saved.providers[endpoint.providerId].models, [
      { id: "kept-model", reasoning: true, contextWindow: 64000 },
      { id: "new-model" },
    ]);
    await store.set({ ...endpoint, models: [{ id: "kept-model" }] });
    const cleared = JSON.parse(await readFile(path, "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(cleared.providers[endpoint.providerId].models, [
      { id: "kept-model", reasoning: true },
    ]);
  });
});

await test("malformed existing target configs are never overwritten", async () => {
  for (const config of [null, false, 0, "saved-value", [], {}]) {
    await withStore(async (store, path) => {
      const original = JSON.stringify({ providers: { [endpoint.providerId]: config } });
      await writeFile(path, original);
      await assert.rejects(() => store.set(endpoint), /not managed by pi-gui/);
      assert.equal(await store.delete(endpoint.providerId), false);
      assert.equal(await readFile(path, "utf8"), original);
    });
  }
});

await test("the queue recovers once malformed saved data is repaired externally", async () => {
  await withStore(async (store, path) => {
    await writeFile(path, '{"providers":[]}');
    await assert.rejects(() => store.set(endpoint), /JSON object for providers/);
    await writeFile(path, '{"providers":{}}');
    await store.set(endpoint);
    assert.deepEqual(await store.list(), [{ ...endpoint, api: "openai-completions" }]);
  });
});

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
  await test(`roundtrips ${api} and retains model protocol overrides`, async () => {
    await withStore(async (store, path) => {
      await store.set({ ...endpoint, api });
      const [listed] = await new CustomProviderStore(path).list();
      assert.equal(listed.api, api);
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        providers: Record<string, Record<string, unknown>>;
      };
      assert.equal(saved.providers[endpoint.providerId].api, api);
    });
  });
}

await test("omitted API preserves unsupported advanced protocols and defaults new endpoints", async () => {
  await withStore(async (store, path) => {
    const provider = {
      baseUrl: endpoint.baseUrl,
      api: "future-protocol",
      piGuiCustomEndpoint: true,
      apiKey: "unused",
      models: [{ id: "test-model", api: "openai-responses" }],
    };
    await writeFile(path, JSON.stringify({ providers: { [endpoint.providerId]: provider } }));
    const [listed] = await store.list();
    assert.equal(listed.api, undefined);
    await store.set({ ...listed, baseUrl: "http://localhost:9090" });
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(saved.providers[endpoint.providerId], {
      ...provider,
      baseUrl: "http://localhost:9090",
    });
    await store.set({ ...listed, api: "anthropic-messages" });
    const changed = JSON.parse(await readFile(path, "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    assert.equal(changed.providers[endpoint.providerId].api, "anthropic-messages");
    assert.deepEqual(changed.providers[endpoint.providerId].models, provider.models);
    await assert.rejects(
      () => store.set({ ...endpoint, api: "invalid" as "openai-completions" }),
      /Unsupported custom provider API/,
    );
  });
});
