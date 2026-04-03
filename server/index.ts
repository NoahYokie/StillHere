import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { authMiddleware } from "./auth";
import { setupSocketServer } from "./socket";

const app = express();
const httpServer = createServer(app);

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
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
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

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
  skip: (req) => {
    const fullPath = req.originalUrl || req.path;
    return fullPath === "/api/health";
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
      const cronSecret = process.env.SESSION_SECRET;
      if (!cronSecret) {
        log("WARNING: SESSION_SECRET not set, cron scheduler disabled", "cron");
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
    },
  );
})();
