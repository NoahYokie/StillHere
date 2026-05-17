import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import "./outbound-policy";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { authMiddleware } from "./auth";
import { setupSocketServer } from "./socket";
import { pool } from "./db";

const app = express();
const httpServer = createServer(app);
const nativeAllowedOrigins = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "https://localhost",
  "http://localhost",
]);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://maps.googleapis.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "https://maps.gstatic.com", "https://maps.googleapis.com"],
        connectSrc: ["'self'", "https:", "wss:", "ws:"],
        workerSrc: ["'self'", "blob:"],
        manifestSrc: ["'self'"],
        mediaSrc: ["'self'", "blob:"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: process.env.NODE_ENV === "production" ? {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    } : false,
  })
);

app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(self), accelerometer=(self), gyroscope=(self)");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.removeHeader("X-Powered-By");
  next();
});

app.set("trust proxy", 1);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && nativeAllowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Stripe webhook MUST be registered before express.json() so the raw Buffer
// body reaches stripe-replit-sync for signature verification. It also needs
// to bypass the rate limiter and the JSON Content-Type guard below.
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["stripe-signature"];
      if (!signature) return res.status(400).json({ error: "Missing stripe-signature" });
      const sig = Array.isArray(signature) ? signature[0] : signature;
      if (!Buffer.isBuffer(req.body)) {
        console.error("[stripe] webhook body is not a Buffer");
        return res.status(500).json({ error: "Webhook processing error" });
      }
      const { getStripeSync } = await import("./stripeClient");
      const sync = await getStripeSync();
      await sync.processWebhook(req.body as Buffer, sig);
      // Reflect any subscription change into our app's `users.premiumUntil`.
      try {
        const { reconcileEntitlementFromWebhook } = await import("./billing");
        await reconcileEntitlementFromWebhook(req.body as Buffer);
      } catch (err) {
        console.error("[stripe] entitlement reconcile failed", err);
      }
      res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("[stripe] webhook error:", err?.message || err);
      res.status(400).json({ error: "Webhook processing error" });
    }
  },
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
  skip: (req) => {
    const fullPath = req.originalUrl || req.path;
    return (
      fullPath === "/api/health" ||
      fullPath === "/api/stripe/webhook" ||
      fullPath === "/api/revenuecat/webhook"
    );
  },
});

app.use("/api/", apiLimiter);

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(cookieParser());
app.use(authMiddleware);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!req.path.startsWith("/api/")) return next();
  if (req.path === "/api/cron/tick") return next();
  if (req.path === "/api/auth/logout") return next();
  if (req.path === "/api/sms/incoming") return next();
  if (req.path === "/api/sms/status") return next();
  if (req.path === "/api/revenuecat/webhook") return next();
  if (req.path.startsWith("/api/wellness-call/")) return next();
  if (req.path.startsWith("/api/checkin/quick") || req.path.startsWith("/api/status/simple")) return next();

  const ct = req.headers["content-type"] || "";
  if (!ct.includes("application/json")) {
    return res.status(415).json({ error: "Content-Type must be application/json" });
  }
  next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

function sanitizePath(p: string): string {
  return p
    .replace(/\/emergency\/[a-zA-Z0-9_-]+/g, "/emergency/[REDACTED]")
    .replace(/\/api\/auth\/passkey\/[a-zA-Z0-9_-]+/g, "/api/auth/passkey/[REDACTED]");
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${sanitizePath(path)} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

(async () => {
  setupSocketServer(httpServer);
  await registerRoutes(httpServer, app);

  // Family consent backfill (Round 3 plan): idempotent. On every boot, mark
  // pre-consent rows as `active_legacy` with a 21-day re-confirm deadline,
  // convert old `invited` to `pending`, and downgrade any expired
  // `active_legacy` to `pending`. Runs in the background so a slow query
  // never blocks startup; failures are logged but do not crash the server.
  (async () => {
    try {
      const { storage } = await import("./storage");
      const result = await storage.backfillFamilyConsent();
      if (result.legacyMarked || result.pendingMarked || result.expiredDowngraded) {
        log(
          `family consent backfill: legacy=${result.legacyMarked} pending=${result.pendingMarked} expired=${result.expiredDowngraded}`,
          "family",
        );
      }
    } catch (err: any) {
      log(`family consent backfill skipped: ${err?.message || err}`, "family");
    }
  })();

  // Bring up the stripe.* schema (idempotent) and create/refresh the managed
  // webhook endpoint so Stripe events flow into stripe-replit-sync. Runs in
  // the background so a Stripe outage cannot block app startup.
  (async () => {
    try {
      const { runMigrations } = await import("stripe-replit-sync");
      await runMigrations({ connectionString: process.env.DATABASE_URL!, max: 1 } as any);
      const { getStripeSync } = await import("./stripeClient");
      const sync = await getStripeSync();
      const appBaseUrl =
        process.env.BASE_URL ||
        process.env.BRAND_BASE_URL ||
        (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null) ||
        (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0].trim()}` : null);
      if (appBaseUrl && typeof sync.findOrCreateManagedWebhook === "function") {
        await sync.findOrCreateManagedWebhook(`${appBaseUrl.replace(/\/$/, "")}/api/stripe/webhook`);
        log("stripe webhook ensured", "stripe");
      }
      if (typeof sync.syncBackfill === "function") {
        await sync.syncBackfill();
        log("stripe backfill complete", "stripe");
      }
    } catch (err: any) {
      log(`stripe init skipped: ${err?.message || err}`, "stripe");
    }
  })();

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    const safeMessage = status < 500 ? (err.message || "Bad Request") : "Internal Server Error";
    return res.status(status).json({ error: safeMessage });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

      const CRON_INTERVAL_MS = 2 * 60 * 1000;
      const internalCronEnabled = process.env.INTERNAL_CRON_ENABLED !== "false";
      const cronSecret = process.env.SESSION_SECRET;
      if (!cronSecret) {
        log("WARNING: SESSION_SECRET not set, cron scheduler disabled", "cron");
        return;
      }
      if (!internalCronEnabled) {
        log("built-in cron scheduler disabled by INTERNAL_CRON_ENABLED=false", "cron");
        return;
      }
      setInterval(async () => {
        try {
          const response = await fetch(`http://localhost:${port}/api/cron/tick`, {
            headers: { "x-cron-secret": cronSecret },
          });
          if (response.ok) {
            const data = await response.json() as any;
            if (data.reminders > 0 || data.alerts > 0 || data.escalations > 0) {
              log(`cron: ${data.reminders} reminders, ${data.alerts} alerts, ${data.escalations} escalations`, "cron");
            }
          }
        } catch (error) {
          log(`cron tick failed: ${error}`, "cron");
        }
      }, CRON_INTERVAL_MS);
      log("built-in cron scheduler started (every 2 minutes)", "cron");

      const SAFETY_STATE_INTERVAL_MS = 30 * 1000;
      const QUIET_THRESHOLD_SECONDS = 180;
      setInterval(async () => {
        try {
          const response = await fetch(`http://localhost:${port}/api/safety-state/tick`, {
            headers: { "x-cron-secret": cronSecret },
          });
          if (response.ok) {
            const data = await response.json() as any;
            if (data.transitioned > 0) {
              log(`safety-state: ${data.transitioned} users moved to quiet`, "cron");
            }
          }
        } catch (error) {
          log(`safety-state tick failed: ${error}`, "cron");
        }
      }, SAFETY_STATE_INTERVAL_MS);
      log(`safety-state worker started (every ${SAFETY_STATE_INTERVAL_MS / 1000}s, quiet threshold ${QUIET_THRESHOLD_SECONDS}s)`, "cron");
    },
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, closing server`, "shutdown");
    httpServer.close(async () => {
      try {
        await pool.end();
        log("database pool closed", "shutdown");
      } catch (error: any) {
        log(`database pool close failed: ${error?.message || error}`, "shutdown");
      } finally {
        process.exit(0);
      }
    });
    setTimeout(() => {
      log("shutdown timeout reached", "shutdown");
      process.exit(1);
    }, 25_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
})();
