import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { query } from "#src/main/builders/query";
import { mutation } from "#src/main/builders/mutation";
import { subscription } from "#src/main/builders/subscription";
import { createServer } from "#src/main/server";
import { scope, createWindowRegistry } from "#src/main/scope";
import { withMiddleware } from "#src/main/middleware";
import {
  createMockElectron,
  type MockElectron,
} from "#test/helpers/electron-mock";
import {
  RpcError,
  RpcErrorCode,
  IPC_CHANNELS,
  type InvokePayload,
  type SubscribePayload,
} from "#src/shared/types";

function invokeFrom(mock: MockElectron, payload: InvokePayload) {
  return mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, payload);
}

describe("scope middleware", () => {
  let mock: MockElectron;

  beforeEach(() => {
    mock = createMockElectron();
  });

  describe("WindowRegistry", () => {
    it("register and has", () => {
      const reg = createWindowRegistry();
      reg.register("main", 1);
      expect(reg.has("main", 1)).toBe(true);
      expect(reg.has("main", 2)).toBe(false);
      expect(reg.has("settings", 1)).toBe(false);
    });

    it("unregister removes the mapping", () => {
      const reg = createWindowRegistry();
      reg.register("main", 1);
      reg.unregister("main", 1);
      expect(reg.has("main", 1)).toBe(false);
    });

    it("multiple IDs per role", () => {
      const reg = createWindowRegistry();
      reg.register("editor", 1);
      reg.register("editor", 2);
      expect(reg.has("editor", 1)).toBe(true);
      expect(reg.has("editor", 2)).toBe(true);
      reg.unregister("editor", 1);
      expect(reg.has("editor", 1)).toBe(false);
      expect(reg.has("editor", 2)).toBe(true);
    });

    it("unregister on unknown role is a no-op", () => {
      const reg = createWindowRegistry();
      expect(() => reg.unregister("nope", 1)).not.toThrow();
    });
  });

  describe("role-based scoping", () => {
    it("allows requests from a registered role", async () => {
      const reg = createWindowRegistry();
      reg.register("main", mock.webContents.id);

      const scoped = withMiddleware(
        [scope({ roles: ["main"], registry: reg })],
        { ping: query().handler(() => "pong") },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });
      const result = await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
      expect(result).toBe("pong");
      server.cleanup();
    });

    it("blocks requests from an unregistered role", async () => {
      const reg = createWindowRegistry();
      // Don't register mock.webContents.id for "admin"

      const scoped = withMiddleware(
        [scope({ roles: ["admin"], registry: reg })],
        { ping: query().handler(() => "pong") },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });

      try {
        await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.UNAUTHORIZED);
        expect((err as RpcError).message).toContain("ping");
      }

      server.cleanup();
    });

    it("allows if sender matches any of the listed roles", async () => {
      const reg = createWindowRegistry();
      reg.register("editor", mock.webContents.id);

      const scoped = withMiddleware(
        [scope({ roles: ["admin", "editor"], registry: reg })],
        { ping: query().handler(() => "pong") },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });
      const result = await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
      expect(result).toBe("pong");
      server.cleanup();
    });

    it("checks at request time — late registration works", async () => {
      const reg = createWindowRegistry();

      const scoped = withMiddleware(
        [scope({ roles: ["main"], registry: reg })],
        { ping: query().handler(() => "pong") },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });

      // Before registration — blocked
      try {
        await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as RpcError).code).toBe(RpcErrorCode.UNAUTHORIZED);
      }

      // Register after route definition
      reg.register("main", mock.webContents.id);

      // Now allowed
      const result = await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
      expect(result).toBe("pong");

      server.cleanup();
    });

    it("unregistration blocks previously allowed windows", async () => {
      const reg = createWindowRegistry();
      reg.register("main", mock.webContents.id);

      const scoped = withMiddleware(
        [scope({ roles: ["main"], registry: reg })],
        { ping: query().handler(() => "pong") },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });

      // Allowed
      const result = await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
      expect(result).toBe("pong");

      // Unregister
      reg.unregister("main", mock.webContents.id);

      // Now blocked
      try {
        await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as RpcError).code).toBe(RpcErrorCode.UNAUTHORIZED);
      }

      server.cleanup();
    });
  });

  describe("predicate-based scoping", () => {
    it("allows requests when predicate returns true", async () => {
      const allowedIds = new Set([mock.webContents.id]);

      const scoped = withMiddleware(
        [scope({ allow: (id) => allowedIds.has(id) })],
        { ping: query().handler(() => "pong") },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });
      const result = await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
      expect(result).toBe("pong");
      server.cleanup();
    });

    it("blocks requests when predicate returns false", async () => {
      const scoped = withMiddleware(
        [scope({ allow: () => false })],
        { ping: query().handler(() => "pong") },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });

      try {
        await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.UNAUTHORIZED);
      }

      server.cleanup();
    });
  });

  describe("custom error message", () => {
    it("uses custom message when provided", async () => {
      const scoped = withMiddleware(
        [scope({ allow: () => false }, { message: "Admin window only" })],
        { deleteAll: mutation().handler(() => "deleted") },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });

      try {
        await invokeFrom(mock, { type: "mutation", path: "deleteAll", input: undefined });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).message).toBe("Admin window only");
      }

      server.cleanup();
    });
  });

  describe("composition with other middleware", () => {
    it("scope runs as part of global -> group -> per-proc chain", async () => {
      const order: string[] = [];
      const reg = createWindowRegistry();
      reg.register("main", mock.webContents.id);

      const globalMw = async (_ctx: unknown, next: () => Promise<unknown>) => {
        order.push("global");
        return next();
      };

      const procMw = async (_ctx: unknown, next: () => Promise<unknown>) => {
        order.push("per-proc");
        return next();
      };

      const scoped = withMiddleware(
        [scope({ roles: ["main"], registry: reg })],
        {
          ping: query().use(procMw).handler(() => {
            order.push("handler");
            return "pong";
          }),
        },
      );

      const server = createServer(scoped, {
        ipcMain: mock.ipcMain,
        middleware: [globalMw],
      });

      await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
      expect(order).toEqual(["global", "per-proc", "handler"]);
      server.cleanup();
    });

    it("scope blocks before per-procedure middleware runs", async () => {
      const order: string[] = [];
      const reg = createWindowRegistry();
      // Don't register — should block

      const procMw = async (_ctx: unknown, next: () => Promise<unknown>) => {
        order.push("per-proc");
        return next();
      };

      const scoped = withMiddleware(
        [scope({ roles: ["admin"], registry: reg })],
        {
          ping: query().use(procMw).handler(() => {
            order.push("handler");
            return "pong";
          }),
        },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });

      try {
        await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as RpcError).code).toBe(RpcErrorCode.UNAUTHORIZED);
      }

      expect(order).toEqual([]);
      server.cleanup();
    });
  });

  describe("scoped routes vs public routes", () => {
    it("only scoped procedures are restricted", async () => {
      const reg = createWindowRegistry();

      const adminRoutes = withMiddleware(
        [scope({ roles: ["admin"], registry: reg })],
        { adminAction: mutation().handler(() => "admin") },
      );

      const router = {
        ...adminRoutes,
        publicAction: query().handler(() => "public"),
      };

      const server = createServer(router, { ipcMain: mock.ipcMain });

      const publicResult = await invokeFrom(mock, { type: "query", path: "publicAction", input: undefined });
      expect(publicResult).toBe("public");

      try {
        await invokeFrom(mock, { type: "mutation", path: "adminAction", input: undefined });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as RpcError).code).toBe(RpcErrorCode.UNAUTHORIZED);
      }

      server.cleanup();
    });
  });

  describe("multi-window scoping", () => {
    it("different windows scoped to different roles", async () => {
      const { webContents: wc2, ipcRenderer: ir2 } = mock.createWebContents();
      const reg = createWindowRegistry();
      reg.register("main", mock.webContents.id);
      reg.register("settings", wc2.id);

      const mainRoutes = withMiddleware(
        [scope({ roles: ["main"], registry: reg })],
        { mainOnly: query().handler(() => "main-data") },
      );

      const settingsRoutes = withMiddleware(
        [scope({ roles: ["settings"], registry: reg })],
        { settingsOnly: query().handler(() => "settings-data") },
      );

      const router = { ...mainRoutes, ...settingsRoutes };
      const server = createServer(router, { ipcMain: mock.ipcMain });

      // Main window can access mainOnly
      const r1 = await invokeFrom(mock, { type: "query", path: "mainOnly", input: undefined });
      expect(r1).toBe("main-data");

      // Main window cannot access settingsOnly
      try {
        await invokeFrom(mock, { type: "query", path: "settingsOnly", input: undefined });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as RpcError).code).toBe(RpcErrorCode.UNAUTHORIZED);
      }

      // Settings window can access settingsOnly
      const r2 = await ir2.invoke(IPC_CHANNELS.INVOKE, { type: "query", path: "settingsOnly", input: undefined });
      expect(r2).toBe("settings-data");

      // Settings window cannot access mainOnly
      try {
        await ir2.invoke(IPC_CHANNELS.INVOKE, { type: "query", path: "mainOnly", input: undefined });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as RpcError).code).toBe(RpcErrorCode.UNAUTHORIZED);
      }

      server.cleanup();
    });
  });

  describe("subscriptions", () => {
    it("scope blocks subscription setup for unauthorized windows", async () => {
      const errors: unknown[] = [];
      const reg = createWindowRegistry();

      const scoped = withMiddleware(
        [scope({ roles: ["admin"], registry: reg })],
        {
          onTick: subscription()
            .output(z.object({ count: z.number() }))
            .handler((_, ctx) => {
              ctx.emit({ count: 0 });
              return () => {};
            }),
        },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });

      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: unknown) => {
        const message = msg as { type: string; error?: unknown };
        if (message.type === "error") {
          errors.push(message.error);
        }
      });

      mock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-scoped",
        path: "onTick",
        input: undefined,
      } satisfies SubscribePayload);

      await new Promise((r) => setTimeout(r, 20));

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toMatchObject({ code: RpcErrorCode.UNAUTHORIZED });

      server.cleanup();
    });

    it("scope allows subscription setup for authorized windows", async () => {
      const data: unknown[] = [];
      const reg = createWindowRegistry();
      reg.register("main", mock.webContents.id);

      const scoped = withMiddleware(
        [scope({ roles: ["main"], registry: reg })],
        {
          onTick: subscription()
            .output(z.object({ count: z.number() }))
            .handler((_, ctx) => {
              ctx.emit({ count: 42 });
              return () => {};
            }),
        },
      );

      const server = createServer(scoped, { ipcMain: mock.ipcMain });

      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: unknown) => {
        const message = msg as { type: string; data?: unknown };
        if (message.type === "data") {
          data.push(message.data);
        }
      });

      mock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-allowed",
        path: "onTick",
        input: undefined,
      } satisfies SubscribePayload);

      await new Promise((r) => setTimeout(r, 20));

      expect(data).toContainEqual({ count: 42 });

      server.cleanup();
    });
  });

  describe("per-procedure scope (via .use())", () => {
    it("scope can be applied per-procedure with .use()", async () => {
      const reg = createWindowRegistry();

      const router = {
        restricted: query()
          .use(scope({ roles: ["admin"], registry: reg }))
          .handler(() => "restricted"),
        open: query().handler(() => "open"),
      };

      const server = createServer(router, { ipcMain: mock.ipcMain });

      const openResult = await invokeFrom(mock, { type: "query", path: "open", input: undefined });
      expect(openResult).toBe("open");

      try {
        await invokeFrom(mock, { type: "query", path: "restricted", input: undefined });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as RpcError).code).toBe(RpcErrorCode.UNAUTHORIZED);
      }

      server.cleanup();
    });
  });
});
