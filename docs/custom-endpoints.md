# Custom endpoints and provider templates

In **Settings → Providers**, add a custom endpoint manually or start from an optional
provider template. Templates fill public connection defaults; supply your own API
key and model IDs. Selecting a template makes no network request and does not
verify account access, model availability, or subscription eligibility.

Templates distinguish regions and plans because their URLs, keys, and billing can
differ. Use the service's official documentation and your account console to
confirm the connection details. A native template, such as OpenRouter, opens the
existing built-in provider flow and reuses its model catalog instead of creating
a duplicate custom provider.

## Protocol and base URL

Choose the protocol your service supports. The base URL is an API base, not a full
inference URL.

| API protocol         | Base URL rule                                                                           | Model discovery                                                                  |
| -------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `openai-completions` | Include the service's API prefix, often `/v1`. Do not append `/chat/completions`.       | `GET {baseUrl}/models` with Bearer authentication when a key is supplied.        |
| `openai-responses`   | Include the service's API prefix, often `/v1`. Do not append `/responses`.              | `GET {baseUrl}/models` with Bearer authentication when a key is supplied.        |
| `anthropic-messages` | Use the Anthropic API root. The SDK appends `/v1/messages`; do not include that suffix. | `GET {root}/v1/models` with `anthropic-version` and, when supplied, `x-api-key`. |

For example, Ollama normally uses `http://localhost:11434/v1`. An Anthropic-compatible
gateway might use `https://gateway.example.com/anthropic`; the resulting inference
path is `/anthropic/v1/messages`. Preserve any service-specific prefix documented
by the provider. Supplying an OpenAI-style `/v1` suffix for Anthropic inference can
produce an incorrect path, even if model discovery succeeds.

**Detect models** is optional. If the service does not expose a model list, including
when discovery returns 404, enter an exact model ID under **Add model ID manually**,
add it, and save the endpoint. Discovery only lists IDs; it does not prove that a
model supports tool calling or that inference will succeed. Choose a model suitable
for coding-agent tool use.

## Saving and editing

Custom endpoints are stored in `~/.pi/agent/models.json`, including API keys in
plaintext. For a local server without authentication, leave the key blank; the
storage format receives an `unused` placeholder. For an authenticated local server,
enter its configured key.

Editing an existing endpoint retains advanced provider fields, such as custom
headers, and advanced fields for each retained model, matched by its exact model ID.
These include model-specific API overrides, input capabilities, reasoning settings,
token limits, and compatibility options. Changing the provider-level protocol does
not erase model-specific protocol overrides. An unsupported existing provider
protocol remains unchanged while **Keep existing protocol (advanced configuration)**
is selected.

The selected model list is authoritative when saving: unchecking a model removes
that model's configuration from the endpoint. Saving a different model ID creates
a new model entry rather than carrying advanced fields across names. **Remove**
deletes the managed endpoint configuration. Other providers and unrelated
`models.json` fields are retained.

## Adding a template

1. Add a static entry to
   [`provider-presets.ts`](../apps/desktop/contracts/provider-presets.ts). Use a unique
   preset ID, English and Simplified Chinese text, search aliases, and the correct
   region and plan. Use `kind: "native"` to reuse an existing built-in provider;
   otherwise supply the custom provider ID, protocol, and documented base URL.
2. Include an official `docsUrl` supporting the protocol and URL. Explain any
   region, plan, or model-ID constraints in the description or model hint. Do not
   include credentials or assume that a model is available to every account.
3. Update
   [`provider-presets.spec.ts`](../apps/desktop/tests/unit/provider-presets.spec.ts)
   for catalog and search expectations. Cover behavior changes in the existing
   store, IPC, and Core Electron tests as appropriate.

Run `pnpm check` for the repository baseline. For the endpoint UI, build and run the
focused Core specs with the shared launcher:

```sh
pnpm --filter @lancer/desktop run test:e2e:runner -- apps/desktop/tests/core/custom-endpoints.spec.ts apps/desktop/tests/core/custom-endpoint-protocols.spec.ts
```

These Core tests use isolated profiles, synthetic keys, and local HTTP fixtures.
They verify configuration and request contracts, not authentication or inference
against real providers.
