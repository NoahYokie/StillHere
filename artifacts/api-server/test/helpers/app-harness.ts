import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IStorage } from "../../server/storage";

type StorageOverrides = Partial<{
  [K in keyof IStorage]: IStorage[K];
}>;

export type HarnessRequest = {
  userId?: string;
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
};

export type AppHarness = {
  request(path: string, options?: HarnessRequest): Promise<Response>;
  close(): Promise<void>;
};

function installStorageOverrides(
  storage: IStorage,
  overrides: StorageOverrides,
): () => void {
  const target = storage as unknown as Record<PropertyKey, unknown>;
  const originals = new Map<
    PropertyKey,
    { existed: boolean; descriptor?: PropertyDescriptor }
  >();

  for (const key of Reflect.ownKeys(overrides)) {
    originals.set(key, {
      existed: Object.prototype.hasOwnProperty.call(target, key),
      descriptor: Object.getOwnPropertyDescriptor(target, key),
    });
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value: (overrides as Record<PropertyKey, unknown>)[key],
    });
  }

  return () => {
    for (const [key, original] of originals) {
      if (original.existed && original.descriptor) {
        Object.defineProperty(target, key, original.descriptor);
      } else {
        delete target[key];
      }
    }
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function createAppHarness(
  storageOverrides: StorageOverrides,
): Promise<AppHarness> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get("x-test-user-id");
    if (userId) (req as any).userId = userId;
    next();
  });

  const server = createServer(app);
  const originalSetInterval = globalThis.setInterval;
  const registrationIntervals: NodeJS.Timeout[] = [];
  let restoreStorage = () => {};
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = originalSetInterval(...args);
    handle.unref();
    registrationIntervals.push(handle);
    return handle;
  }) as typeof setInterval;

  try {
    const [{ registerRoutes }, { storage }] = await Promise.all([
      import("../../server/routes"),
      import("../../server/storage"),
    ]);
    restoreStorage = installStorageOverrides(storage, storageOverrides);
    await registerRoutes(server, app);
    await listen(server);
  } catch (error) {
    restoreStorage();
    for (const interval of registrationIntervals) clearInterval(interval);
    if (server.listening) await closeServer(server);
    throw error;
  } finally {
    globalThis.setInterval = originalSetInterval;
  }

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let closed = false;

  return {
    request(path, options = {}) {
      const headers = new Headers(options.headers);
      if (options.userId) headers.set("x-test-user-id", options.userId);
      if (options.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const interval of registrationIntervals) clearInterval(interval);
      restoreStorage();
      await closeServer(server);
    },
  };
}
