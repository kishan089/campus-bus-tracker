import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";

const QUIET = (method: string | undefined, url: string | undefined) =>
  url === "/health" || url === "/ping" || (method === "POST" && url === "/location"); // constant background traffic: debug level only

/**
 * One structured line per request, with a request id that the client gets back (x-request-id and in error bodies).
 * Headers are never logged, so tokens and cookies cannot leak into the logs; `redact` is a second safety net.
 */
export function httpLogger(log: Logger) {
  return pinoHttp({
    logger: log,
    genReqId: (req, res) => {
      const incoming = req.headers["x-request-id"];
      const id = typeof incoming === "string" && /^[\w.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
    customLogLevel: (req, res, err) =>
      err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : QUIET(req.method, req.url) ? "debug" : "info",
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split("?")[0], ip: req.remoteAddress }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    redact: { paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'], censor: "[redacted]" },
    customProps: (req) => ({ userId: (req as any).userId }),
  });
}
