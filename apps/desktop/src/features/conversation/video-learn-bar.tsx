import { useEffect, useState } from "react";
import type { VideoLearnSnapshot } from "../../../contracts/video-learn";
import { videoLearnErrorMessage } from "../../../contracts/video-learn";
import { t } from "../../../contracts/i18n";

export function VideoLearnBar({
  workspaceId,
  sessionId,
  zoneId,
  snapshot,
  onSnapshot,
}: {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly zoneId: string;
  readonly snapshot: VideoLearnSnapshot | null;
  readonly onSnapshot: (snapshot: VideoLearnSnapshot | null) => void;
}) {
  const [url, setUrl] = useState("");
  const [cookiesPath, setCookiesPath] = useState("");
  const [running, setRunning] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (zoneId !== "video") return;
    const api = window.piApp;
    if (!api) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      api
        .videoLearnStatus({ workspaceId })
        .then((next) => {
          if (!cancelled) onSnapshot(next);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) timer = setTimeout(refresh, 1000);
        })
        .catch(() => undefined);
    };
    refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [onSnapshot, workspaceId, zoneId]);

  if (zoneId !== "video") return null;

  const submit = () => {
    const api = window.piApp;
    if (!api) return;
    const trimmed = url.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setLocalError(null);
    void api
      .videoLearnRun({
        workspaceId,
        sessionId,
        url: trimmed,
        ...(cookiesPath.trim() ? { cookiesPath: cookiesPath.trim() } : {}),
      })
      .then((next) => {
        onSnapshot(next);
        if (next.errorCode) setLocalError(next.errorCode);
      })
      .catch((error: unknown) => {
        setLocalError(error instanceof Error ? error.message : "FAILED");
      })
      .finally(() => setRunning(false))
      .catch(() => undefined);
  };

  return (
    <section className="video-learn-bar" data-testid="video-learn-bar">
      <div className="video-learn-bar__relay">
        <b>{t("lancer.videoLearn.pipeline")}</b>
        <span className="video-learn-bar__hint">{t("lancer.videoLearn.handoff")}</span>
      </div>
      <div className="video-learn-bar__form">
        <input
          data-testid="video-learn-url"
          aria-label={t("lancer.videoLearn.urlLabel")}
          placeholder={t("lancer.videoLearn.urlPlaceholder")}
          value={url}
          disabled={running}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <input
          data-testid="video-learn-cookies"
          aria-label={t("lancer.videoLearn.cookiesLabel")}
          placeholder={t("lancer.videoLearn.cookiesPlaceholder")}
          value={cookiesPath}
          disabled={running}
          onChange={(event) => setCookiesPath(event.target.value)}
        />
        <button
          type="button"
          data-testid="video-learn-submit"
          disabled={running || !url.trim()}
          onClick={submit}
        >
          {running ? t("lancer.videoLearn.running") : t("lancer.videoLearn.submit")}
        </button>
      </div>
      {snapshot ? (
        <div className="video-learn-bar__stages" data-testid="video-learn-status">
          <span className={`video-learn-bar__gui video-learn-bar__gui--${snapshot.guiStatus}`}>
            {snapshot.guiStatus}
            {snapshot.videoId ? ` · ${snapshot.videoId}` : ""}
          </span>
          {snapshot.stages.map((stage) => (
            <span
              key={stage.id}
              className={`video-learn-bar__stage${stage.ok ? " video-learn-bar__stage--ok" : ""}`}
              data-testid="video-learn-stage"
              data-status={stage.statusCode}
            >
              {stage.guiLabel}
              <code>{stage.statusCode}</code>
            </span>
          ))}
          {snapshot.handoff ? (
            <code className="video-learn-bar__handoff" data-testid="video-learn-handoff">
              {`sha256=${snapshot.handoff.sha256} manifest=${snapshot.handoff.manifest} source=${snapshot.handoff.source}`}
            </code>
          ) : null}
        </div>
      ) : null}
      {localError || snapshot?.errorCode ? (
        <p className="video-learn-bar__error">
          {videoLearnErrorMessage(localError ?? snapshot?.errorCode)}
        </p>
      ) : null}
      {snapshot?.sessionError ? (
        <p className="video-learn-bar__error">{snapshot.sessionError}</p>
      ) : null}
    </section>
  );
}
