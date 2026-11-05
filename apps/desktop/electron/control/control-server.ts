import { chmod, lstat, unlink } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { controlPaths } from "../../../../scripts/lib/control-paths.mjs";
import { ensureControlToken } from "../../../../scripts/lib/control-token.mjs";
import { ControlError } from "./control-service";
import { ControlStream } from "./control-stream";
import { once } from "node:events";

const MAX_BODY = 1024 * 1024;

async function clearStaleSocket(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error(`Refusing to replace a non-owned socket: ${path}`);
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(path);
    probe.setTimeout(1000);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("Local control socket is already in use"));
    });
    probe.once("timeout", () => {
      probe.destroy();
      reject(new Error("Local control socket probe timed out"));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
  // This is only a stale IPC endpoint, never a session or user artifact.
  const current = await lstat(path);
  if (current.ino !== stat.ino || current.dev !== stat.dev)
    throw new Error("Control socket changed during probe");
  await unlink(path);
}

/** HTTP/1.1 over local IPC only (Unix socket or Windows named pipe). No TCP listener, discovery service or telemetry. */
export class ControlServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private lifecycle: Promise<void> = Promise.resolve();
  readonly socketPath: string;
  readonly tokenPath: string;

  constructor(
    directory: string,
    private readonly handle: (input: unknown) => Promise<unknown>,
  ) {
    const paths = controlPaths(directory);
    this.socketPath = paths.socketPath;
    this.tokenPath = paths.tokenPath;
  }

  setEnabled(enabled: boolean): Promise<void> {
    const next = this.lifecycle.then(() => (enabled ? this.start() : this.stop()));
    this.lifecycle = next.catch(() => {});
    return next;
  }

  private async start(): Promise<void> {
    if (this.server) return;
    const token = await ensureControlToken(this.tokenPath);
    if (process.platform !== "win32") await clearStaleSocket(this.socketPath);
    const server = createServer((request, response) => {
      response.on("error", () => {});
      const respond = (status: number, body: unknown) => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Connection: "close",
        });
        response.end(JSON.stringify(body));
      };
      const authorization = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
        respond(401, {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Invalid local control token" },
        });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1") {
        respond(404, { ok: false, error: { code: "NOT_FOUND", message: "Use POST /v1" } });
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        if (size > MAX_BODY) return;
        size += chunk.length;
        if (size > MAX_BODY) {
          chunks.length = 0;
          respond(413, {
            ok: false,
            error: { code: "TOO_LARGE", message: "Request exceeds 1 MiB" },
          });
        } else chunks.push(chunk);
      });
      request.on("error", () => {});
      request.on("end", () => {
        if (size > MAX_BODY) return;
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          respond(400, { ok: false, error: { code: "INVALID_JSON", message: "Expected JSON" } });
          return;
        }
        void this.handle(input)
          .then(
            async (result) => {
              if (!(result instanceof ControlStream)) {
                respond(200, { ok: true, result });
                return;
              }
              response.on("close", () => result.close());
              request.socket.setTimeout(0);
              response.writeHead(200, {
                "Content-Type": "application/x-ndjson",
                "Cache-Control": "no-store",
              });
              response.flushHeaders();
              try {
                for await (const event of result) {
                  if (response.destroyed) break;
                  if (!response.write(`${JSON.stringify(event)}\n`))
                    await Promise.race([once(response, "drain"), once(response, "close")]);
                }
              } finally {
                result.close();
                response.end();
              }
            },
            (error: unknown) =>
              respond(error instanceof ControlError ? 400 : 500, {
                ok: false,
                error: {
                  code: error instanceof ControlError ? error.code : "INTERNAL_ERROR",
                  message: error instanceof Error ? error.message : String(error),
                },
              }),
          )
          .catch(() => response.destroy());
      });
    });
    server.maxConnections = 32;
    server.requestTimeout = 30_000;
    server.headersTimeout = 5000;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.setTimeout(30_000, () => socket.destroy());
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    try {
      if (process.platform !== "win32") await chmod(this.socketPath, 0o600);
    } catch (error) {
      await this.stop();
      throw error;
    }
    server.on("error", (error) => console.error("[local-control] server error", error));
  }

  private async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
