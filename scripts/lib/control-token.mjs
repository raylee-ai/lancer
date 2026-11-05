import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Windows mode bits do not express the security boundary. Use a private protected
// DACL and verify owner/allow ACEs on every reuse. Paths travel via env, never code.
export async function windowsBoundary(path, initialize = false) {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding
$p = $env:LANCER_CONTROL_TARGET
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$item = if ([IO.Directory]::Exists($p)) { New-Object IO.DirectoryInfo($p) } else { New-Object IO.FileInfo($p) }
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Control path is a reparse point' }
if ($env:LANCER_CONTROL_INITIALIZE -eq '1') {
  if (($item -is [IO.DirectoryInfo])) { $acl = New-Object Security.AccessControl.DirectorySecurity; $inherit = 'ContainerInherit,ObjectInherit' }
  else { $acl = New-Object Security.AccessControl.FileSecurity; $inherit = 'None' }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
  $item.SetAccessControl($acl)
}
$acl = $item.GetAccessControl()
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$acl.AreAccessRulesProtected) { throw 'Control ACL must be protected and owned by current user' }
$allowsCurrent = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -ne 'Allow') { continue }
  if ($rule.IdentityReference.Value -eq $sid.Value) { $allowsCurrent = $true }
  elseif ($rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'Control ACL grants access to another principal' }
}
if (!$allowsCurrent) { throw 'Control ACL does not grant current user access' }
`;
  await exec(
    join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      timeout: 10_000,
      env: {
        ...process.env,
        LANCER_CONTROL_TARGET: path,
        LANCER_CONTROL_INITIALIZE: initialize ? "1" : "0",
      },
    },
  );
}

async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128)
    throw new Error("Invalid control.token file; original retained");
  return info;
}

export async function readControlToken(path) {
  if (process.platform === "win32") {
    await windowsBoundary(dirname(path));
    await windowsBoundary(path);
  }
  const before = await regular(path);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    if (
      info.ino !== before.ino ||
      info.dev !== before.dev ||
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 128
    )
      throw new Error("control.token changed during open");
    if (
      process.platform !== "win32" &&
      ((info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()))
    )
      throw new Error("control.token must be owned by this user with mode 0600");
    const token = (await file.readFile("utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error("Invalid control.token; original file retained");
    return token;
  } finally {
    await file.close();
  }
}

export async function ensureControlToken(path) {
  if (process.platform === "win32") {
    let created = false;
    try {
      await mkdir(dirname(path));
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await windowsBoundary(dirname(path), created);
  }
  let file;
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return readControlToken(path);
  }
  try {
    if (process.platform === "win32") await windowsBoundary(path, true);
    await file.writeFile(`${randomBytes(32).toString("hex")}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  return readControlToken(path);
}
