export const DEFAULT_GITHUB_DOWNLOAD_ATTEMPTS = 3;
export const DEFAULT_GITHUB_DOWNLOAD_RETRY_DELAY_MS = 15_000;

const TRANSIENT_GITHUB_DOWNLOAD =
  /cannot resolve https:\/\/github\.com\/\S+: status code 50[234]\b/;

// @electron/get reports "Response code 504 (Gateway Time-out) for https://github.com/...".
// electron-builder 26 reports the same gateway timeout on one line with failedTask=build
// and does not repeat the GitHub URL.
const TRANSIENT_RESPONSE_CODE =
  /Response code 50[234]\b[\s\S]{0,160}https:\/\/github\.com\/|Response code 50[234] \(Gateway Time-out\)[\s\S]{0,160}failedTask=build/;

export function isTransientGithubDownloadFailure(output) {
  return (
    typeof output === "string" &&
    (TRANSIENT_GITHUB_DOWNLOAD.test(output) || TRANSIENT_RESPONSE_CODE.test(output))
  );
}

export function githubDownloadRetryDelayMs(
  failedAttempt,
  baseDelayMs = DEFAULT_GITHUB_DOWNLOAD_RETRY_DELAY_MS,
) {
  return baseDelayMs * 2 ** (failedAttempt - 1);
}

export async function withGithubDownloadRetry(run, options = {}) {
  const attempts = options.attempts ?? DEFAULT_GITHUB_DOWNLOAD_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_GITHUB_DOWNLOAD_RETRY_DELAY_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((message) => console.error(message));

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }

  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await run(attempt);
    if (last?.ok) {
      return last;
    }
    const output = typeof last?.output === "string" ? last.output : "";
    const canRetry = attempt < attempts && isTransientGithubDownloadFailure(output);
    if (!canRetry) {
      return last;
    }
    const delayMs = githubDownloadRetryDelayMs(attempt, baseDelayMs);
    log(
      `GitHub returned a transient download 5xx; retrying electron-builder in ${delayMs}ms (attempt ${attempt + 1}/${attempts})`,
    );
    await sleep(delayMs);
  }
  return last;
}
