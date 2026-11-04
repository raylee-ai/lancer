import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Build the shared packages first, just as the canonical check command does.
// Compile an in-memory caller with the driver's real configuration and sources.
test("SDK driver implements canonical SessionDriver and cannot omit tree operations", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = path.join(root, "packages/pi-sdk-driver");
  const configPath = path.join(directory, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  assert.deepEqual(parsed.errors, []);
  const file = path.join(directory, "src/contract-proof.ts");
  const text = `
import type { SessionDriver } from "@lancer/session-driver";
import type { PiSdkDriver } from "./pi-sdk-driver.js";
declare const driver: PiSdkDriver;
const accepted: SessionDriver = driver;
declare const incomplete: Omit<PiSdkDriver, "getSessionTree" | "navigateSessionTree">;
const rejected: SessionDriver = incomplete;
`;
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  // TypeScript canonicalizes requested names to forward slashes on Windows, so
  // compare normalized paths when injecting the in-memory proof source.
  const samePath = (left, right) =>
    left.split(path.sep).join("/") === right.split(path.sep).join("/");
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    samePath(name, file)
      ? ts.createSourceFile(name, text, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([...parsed.fileNames, file], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const rendered = diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
  assert.equal(diagnostics.length, 1, rendered.join("\n"));
  assert.equal(
    diagnostics[0].file?.fileName.split(path.sep).join("/"),
    file.split(path.sep).join("/"),
  );
  assert.match(rendered[0], /missing.*getSessionTree, navigateSessionTree/);
  const source = program.getSourceFile(file);
  const binding = source.statements[0].importClause.namedBindings.elements[0].name;
  const checker = program.getTypeChecker();
  const declaration = checker.getAliasedSymbol(checker.getSymbolAtLocation(binding))
    .declarations[0];
  assert.equal(
    declaration.getSourceFile().fileName.split(path.sep).join("/"),
    path.join(root, "packages/session-driver/dist/types.d.ts").split(path.sep).join("/"),
  );
});

test("desktop runtime resolves its catalog backend without TypeScript aliases", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const require = createRequire(path.join(root, "apps/desktop/package.json"));
  for (const [specifier, relative] of [
    ["@lancer/catalogs/node", "packages/catalogs/dist/node/index.js"],
    ["@lancer/catalogs/node/atomic-write", "packages/catalogs/dist/node/atomic-write.js"],
  ]) {
    let resolved;
    assert.doesNotThrow(() => {
      resolved = require.resolve(specifier);
    }, `${specifier} must resolve from desktop; run pnpm install --frozen-lockfile after workspace dependency changes and build shared packages.`);
    assert.equal(resolved, path.join(root, relative));
  }
});
