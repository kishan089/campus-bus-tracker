import type { Config } from "../config";
import type { ErrorReporter } from "../http/errors";

export interface Reporter extends ErrorReporter { flush(ms?: number): Promise<void> }

/**
 * Sends unexpected server errors to Sentry when SENTRY_DSN is set (free tier, so it costs nothing).
 * Without a DSN there is no reporter at all and nothing is sent anywhere.
 * Request bodies, headers and cookies are never attached, and query strings are dropped from URLs.
 */
export async function createErrorReporter(config: Config): Promise<Reporter | undefined> {
  if (!config.sentryDsn) return undefined;
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: config.sentryDsn, environment: config.env, release: config.release, tracesSampleRate: 0,
    beforeSend(event) { // belt and braces: nothing from the request except where and what failed
      if (event.request) {
        delete event.request.cookies; delete event.request.headers; delete event.request.data; delete event.request.query_string;
        if (event.request.url) event.request.url = event.request.url.split("?")[0];
      }
      return event;
    },
  });
  return {
    capture(err, ctx) {
      Sentry.withScope((scope) => {
        if (ctx.requestId) scope.setTag("request_id", ctx.requestId);
        scope.setContext("request", { method: ctx.method, url: ctx.url?.split("?")[0] });
        Sentry.captureException(err);
      });
    },
    flush: async (ms = 2000) => { await Sentry.flush(ms); },
  };
}
