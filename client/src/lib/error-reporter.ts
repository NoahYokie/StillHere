const ERROR_REPORT_ENDPOINT = "/api/errors/report";

interface ErrorReportPayload {
  type: string;
  message: string;
  stack?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

let initialized = false;

async function sendErrorReport(payload: ErrorReportPayload) {
  try {
    await fetch(ERROR_REPORT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
  } catch {
  }
}

export function initErrorReporter() {
  if (initialized) return;
  initialized = true;

  window.addEventListener("error", (event) => {
    sendErrorReport({
      type: "uncaught_error",
      message: event.message || "Unknown error",
      stack: event.error?.stack,
      url: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : window.location.href,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    sendErrorReport({
      type: "unhandled_rejection",
      message: reason?.message || String(reason) || "Unhandled promise rejection",
      stack: reason?.stack,
      url: window.location.href,
    });
  });
}

export function reportError(error: Error, context?: Record<string, unknown>) {
  sendErrorReport({
    type: "caught_error",
    message: error.message,
    stack: error.stack,
    url: window.location.href,
    metadata: context,
  });
}

export function reportComponentError(error: Error, componentStack: string) {
  sendErrorReport({
    type: "component_crash",
    message: error.message,
    stack: error.stack,
    url: window.location.href,
    metadata: { componentStack },
  });
}
