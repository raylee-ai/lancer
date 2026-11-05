import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfiguration } from "app-builder-lib/out/util/config/config.js";
import { DebugLogger } from "builder-util";
import { parseDocument } from "yaml";
import { assertWorkflowActionPolicy, isAction } from "../../../scripts/workflow-action-policy.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..", "..", "..");
const linuxPackageCommand = "node scripts/run-electron-builder.mjs --linux --publish never";
const linuxDependencies = [
  "libgtk-3-0 | libgtk-3-0t64",
  "libnotify4",
  "libnss3",
  "libxss1",
  "libxtst6",
  "xdg-utils",
  "libatspi2.0-0 | libatspi2.0-0t64",
  "libuuid1",
  "libsecret-1-0",
  "libgbm1",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function parseYaml(relativePath) {
  const filePath = path.join(repoDir, relativePath);
  const document = parseDocument(await readFile(filePath, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `${relativePath} is invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return document.toJS();
}

function stepNamed(job, name) {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert(step, `Missing workflow step "${name}"`);
  return step;
}

function runText(step) {
  return typeof step.run === "string" ? step.run : "";
}

function validateCiWorkflow(workflow) {
  const versionCheck = stepNamed(workflow.jobs?.typecheck, "Verify release version consistency");
  assert(
    runText(versionCheck).includes("pnpm verify:release-version"),
    "CI must reject drift between product package versions",
  );

  const linuxJob = workflow.jobs?.["desktop-package-linux"];
  assert(linuxJob?.["runs-on"] === "ubuntu-latest", "Linux package CI must run on Ubuntu");
  assert(
    runText(stepNamed(linuxJob, "Verify Linux package configuration")).includes(
      "verify:release-config",
    ),
    "Linux package CI must validate release configuration before packaging",
  );
  assert(
    runText(stepNamed(linuxJob, "Package Linux AppImage and deb")).includes("run package:linux"),
    "Linux package CI must build the configured AppImage and deb targets",
  );

  const windowsJob = workflow.jobs?.["desktop-package-windows"];
  assert(windowsJob?.["runs-on"] === "windows-latest", "Windows package CI must run on Windows");
  assert(
    runText(stepNamed(windowsJob, "Package Windows directory")).includes("run package:win:dir"),
    "Windows package CI must use the retrying Windows packager",
  );
}

function validateBuilderConfig(config, desktopPackage, afterRemoveSource) {
  assert(config.appId === "com.lancer.desktop", "Lancer must keep its own bundle id");
  assert(config.productName === "Lancer", "Lancer must keep its product name");
  assert(
    config.mac?.identity === null,
    "Lancer macOS builds require a pinned identity supplied by the packaging runner",
  );
  assert(config.mac?.notarize === false, "Lancer macOS builds must not try to notarize");
  assert(config.dmg?.sign === false, "Local DMGs are not signed for public distribution");
  assert(
    config.publish === null || config.publish === undefined,
    "Lancer must never publish to or read update metadata from upstream releases",
  );
  assert(
    JSON.stringify(config.mac?.target) ===
      JSON.stringify([
        { target: "dmg", arch: "arm64" },
        { target: "zip", arch: "arm64" },
      ]),
    "macOS packaging must produce arm64 dmg and zip targets",
  );
  assert(
    config.win?.signAndEditExecutable === true,
    "Windows packaging must preserve executable icon and version metadata",
  );

  const targets = new Set((config.win?.target ?? []).map(({ target }) => target));
  assert(targets.has("nsis"), "Windows packaging must include NSIS");
  assert(targets.has("portable"), "Windows packaging must include portable");

  const setupName = "${productName}-${version}-${arch}-setup.${ext}";
  const portableName = "${productName}-${version}-${arch}-portable.${ext}";
  assert(config.nsis?.artifactName === setupName, `NSIS artifactName must be ${setupName}`);
  assert(
    config.portable?.artifactName === portableName,
    `portable artifactName must be ${portableName}`,
  );
  assert(
    config.nsis.artifactName !== config.portable.artifactName,
    "NSIS and portable artifacts must not share a filename",
  );

  assert(
    !String(desktopPackage.homepage ?? "").includes("minghinmatthewlam/pi-gui"),
    "Desktop package metadata must not point Lancer users at upstream pi-gui",
  );
  assert(
    desktopPackage.scripts?.["package:linux"]?.includes(linuxPackageCommand),
    "pnpm Linux packaging must build AppImage and deb for x64",
  );
  assert(
    desktopPackage.scripts?.["package:linux:dir"]?.includes(
      "node scripts/run-electron-builder.mjs --linux --dir --publish never",
    ),
    "pnpm Linux directory packaging must retry GitHub binary downloads",
  );
  assert(
    desktopPackage.scripts?.["package:win"]?.includes("package-windows.mjs") &&
      desktopPackage.scripts?.["package:win:dir"]?.includes("package-windows.mjs"),
    "pnpm Windows packaging must keep the canonical Windows packager",
  );

  assert(config.linux?.executableName === "lancer", "Linux executable name must be lancer");
  assert(
    /<[^>]+@[^>]+>/.test(config.linux?.maintainer ?? ""),
    "Linux package maintainer must include an email address",
  );
  assert(config.linux?.synopsis, "Linux package synopsis must remain explicit");
  assert(
    JSON.stringify(config.linux?.target) ===
      JSON.stringify([
        { target: "AppImage", arch: ["x64"] },
        { target: "deb", arch: ["x64"] },
      ]),
    "Linux packaging must produce x64 AppImage and deb targets",
  );

  assert(
    config.deb?.artifactName === "${productName}_${version}_${arch}.${ext}",
    "Debian artifact naming must remain deterministic",
  );
  assert(
    config.deb?.packageName === "lancer",
    "Debian package name must be lancer (installs beside pi-gui)",
  );
  assert(config.deb?.packageCategory === "devel", "Debian Section must remain devel");
  assert(config.deb?.priority === "optional", "Debian Priority must remain optional");
  assert(
    config.deb?.afterRemove === "resources/linux/after-remove.sh",
    "Debian packaging must use the corrected removal hook",
  );
  assert(
    JSON.stringify(config.deb?.depends) === JSON.stringify(linuxDependencies),
    "Debian dependencies must match the validated runtime dependency set",
  );
  assert(
    afterRemoveSource.includes(
      "update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'",
    ) &&
      !afterRemoveSource.includes(
        "update-alternatives --remove '${executable}' '/usr/bin/${executable}'",
      ),
    "Debian removal must unregister the alternatives target, not the link",
  );
}

function validateGithubDownloadRetry(retrySource, packageWindowsSource, runElectronBuilderSource) {
  assert(
    retrySource.includes("cannot resolve https:") &&
      retrySource.includes("github") &&
      retrySource.includes("50[234]"),
    "GitHub download retry must match electron-builder 502/503/504 errors",
  );
  assert(
    runElectronBuilderSource.includes("withGithubDownloadRetry") &&
      runElectronBuilderSource.includes("ELECTRON_BUILDER_CACHE"),
    "electron-builder runner must retry GitHub downloads and keep a local binary cache",
  );
  assert(
    runElectronBuilderSource.includes("prepareAppImageTools") &&
      runElectronBuilderSource.includes("APPIMAGE_TOOLS_PATH"),
    "Linux AppImage builds must use the patched tool wrapper so mksquashfs survives newer glibc",
  );
  assert(
    packageWindowsSource.includes('from "./run-electron-builder.mjs"') &&
      packageWindowsSource.includes("runElectronBuilder"),
    "Windows packaging must use the retrying electron-builder runner",
  );
}

const [
  builderConfig,
  ciWorkflow,
  desktopPackageSource,
  afterRemoveSource,
  retrySource,
  packageWindowsSource,
  runElectronBuilderSource,
] = await Promise.all([
  parseYaml("apps/desktop/electron-builder.yml"),
  parseYaml(".github/workflows/ci.yml"),
  readFile(path.join(scriptDir, "..", "package.json"), "utf8"),
  readFile(path.join(scriptDir, "..", "resources", "linux", "after-remove.sh"), "utf8"),
  readFile(path.join(scriptDir, "github-download-retry.mjs"), "utf8"),
  readFile(path.join(scriptDir, "package-windows.mjs"), "utf8"),
  readFile(path.join(scriptDir, "run-electron-builder.mjs"), "utf8"),
]);

assert(
  runElectronBuilderSource.includes("-c.forceCodeSigning=true") &&
    runElectronBuilderSource.includes("LANCER_MAC_SIGNING_IDENTITY"),
  "macOS runner must require persistent signing",
);
await assertWorkflowActionPolicy(repoDir);
await validateConfiguration(builderConfig, new DebugLogger(false));
validateBuilderConfig(builderConfig, JSON.parse(desktopPackageSource), afterRemoveSource);
validateCiWorkflow(ciWorkflow);
validateGithubDownloadRetry(retrySource, packageWindowsSource, runElectronBuilderSource);
console.log("Lancer package and CI configuration are valid.");
