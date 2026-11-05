import { request } from "node:http";
import { controlPaths } from "./control-paths.mjs";
import { readControlToken } from "./control-token.mjs";

export async function controlClient(directory) {
  const { socketPath, tokenPath } = controlPaths(directory);
  const token = await readControlToken(tokenPath);
  return (input, timeout = 30_000) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(input);
      const req = request(
        {
          socketPath,
          path: "/v1",
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) res.destroy(new Error("CONTROL_RESPONSE_TOO_LARGE"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (res.statusCode !== 200 || payload.ok !== true)
                throw new Error(
                  `${payload.error?.code || "CONTROL_ERROR"}: ${payload.error?.message || res.statusCode}`,
                );
              resolve(payload.result);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      const timer = setTimeout(
        () =>
          req.destroy(
            new Error("CONTROL_TIMEOUT: request outcome unknown; never replay automatically"),
          ),
        timeout,
      );
      req.once("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end(body);
    });
}
