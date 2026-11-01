import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "../dist/custom-provider-store.js";
import { CUSTOM_PROVIDER_APIS } from "../dist/custom-provider-types.js";

async function loadRuntime(modelsPath: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

for (const api of CUSTOM_PROVIDER_APIS) {
  await test(`saved ${api} endpoint resolves with its protocol in pi runtime`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-custom-provider-runtime-"));
    const modelsPath = join(dir, "models.json");
    const store = new CustomProviderStore(modelsPath);
    const endpoint = {
      providerId: "runtime-fixture",
      baseUrl: "http://127.0.0.1:9/gateway",
      api,
      models: [{ id: "fixture-model", contextWindow: 64000 }],
    };
    await store.set(endpoint);

    const runtime = await loadRuntime(modelsPath);
    assert.equal(runtime.getError(), undefined);
    const model = runtime.getModel(endpoint.providerId, endpoint.models[0].id);
    assert.ok(model, "pi must load the endpoint saved by the desktop store");
    assert.equal(model.api, api);
    assert.equal(model.baseUrl, endpoint.baseUrl);
    assert.equal(model.contextWindow, 64000);
  });
}

await test("editing a provider protocol preserves a model-level runtime protocol override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-provider-runtime-"));
  const modelsPath = join(dir, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        "runtime-fixture": {
          baseUrl: "http://127.0.0.1:9/old",
          api: "openai-completions",
          apiKey: "unused",
          piGuiCustomEndpoint: true,
          models: [{ id: "inherited-model" }, { id: "override-model", api: "openai-responses" }],
        },
      },
    }),
  );
  const store = new CustomProviderStore(modelsPath);
  const [existing] = await store.list();
  await store.set({
    ...existing,
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:9/new",
  });

  const runtime = await loadRuntime(modelsPath);
  assert.equal(runtime.getError(), undefined);
  assert.equal(runtime.getModel("runtime-fixture", "inherited-model")?.api, "anthropic-messages");
  assert.equal(runtime.getModel("runtime-fixture", "override-model")?.api, "openai-responses");
  assert.equal(
    runtime.getModel("runtime-fixture", "override-model")?.baseUrl,
    "http://127.0.0.1:9/new",
  );
});
