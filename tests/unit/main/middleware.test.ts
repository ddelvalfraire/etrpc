/**
 * Tests for the middleware system.
 *
 * Middleware runs before/after handler execution for queries and mutations.
 * It is composable (multiple middleware in a chain), supports async, and
 * can extend the context object in a type-safe way.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { query } from "#src/main/builders/query";
import { mutation } from "#src/main/builders/mutation";
import { subscription } from "#src/main/builders/subscription";
import { createServer } from "#src/main/server";
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
  type SubscriptionDataMessage,
} from "#src/shared/types";
import type { Middleware, MiddlewareContext } from "#src/main/middleware";
import { withMiddleware } from "#src/main/middleware";

// =============================================================================
// Helpers
// =============================================================================

function invokeFrom(mock: MockElectron, payload: InvokePayload) {
  return mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, payload);
}

// =============================================================================
// Tests
// =============================================================================

describe("middleware system", () => {
  let mock: MockElectron;

  beforeEach(() => {
    mock = createMockElectron();
  });

  // ===========================================================================
  // Basic middleware execution
  // ===========================================================================

  describe("basic execution", () => {
    it("middleware runs before the handler", async () => {
      const order: string[] = [];

      const logMiddleware: Middleware = async (ctx, next) => {
        order.push("middleware:before");
        const result = await next();
        order.push("middleware:after");
        return result;
      };

      const router = {
        ping: query().handler(() => {
          order.push("handler");
          return "pong";
        }),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [logMiddleware],
      });

      const result = await invokeFrom(mock, {
        type: "query",
        path: "ping",
        input: undefined,
      });

      expect(result).toBe("pong");
      expect(order).toEqual(["middleware:before", "handler", "middleware:after"]);

      server.cleanup();
    });

    it("middleware runs for mutations too", async () => {
      const calls: string[] = [];

      const logMiddleware: Middleware = async (ctx, next) => {
        calls.push(`${ctx.type}:${ctx.path}`);
        return next();
      };

      const router = {
        doSomething: mutation()
          .input(z.number())
          .handler((n) => n * 2),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [logMiddleware],
      });

      const result = await invokeFrom(mock, {
        type: "mutation",
        path: "doSomething",
        input: 5,
      });

      expect(result).toBe(10);
      expect(calls).toEqual(["mutation:doSomething"]);

      server.cleanup();
    });

    it("middleware receives correct context properties", async () => {
      let capturedCtx: MiddlewareContext | undefined;

      const inspectMiddleware: Middleware = async (ctx, next) => {
        capturedCtx = ctx;
        return next();
      };

      const router = {
        greet: query()
          .input(z.object({ name: z.string() }))
          .handler(({ name }) => `Hello, ${name}!`),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [inspectMiddleware],
      });

      await invokeFrom(mock, {
        type: "query",
        path: "greet",
        input: { name: "World" },
      });

      expect(capturedCtx).toBeDefined();
      expect(capturedCtx!.type).toBe("query");
      expect(capturedCtx!.path).toBe("greet");
      expect(capturedCtx!.input).toEqual({ name: "World" });
      expect(capturedCtx!.sender).toEqual({ id: mock.webContents.id });

      server.cleanup();
    });
  });

  // ===========================================================================
  // Composable middleware chain
  // ===========================================================================

  describe("composable chain", () => {
    it("multiple middleware run in order (first to last)", async () => {
      const order: string[] = [];

      const first: Middleware = async (ctx, next) => {
        order.push("first:before");
        const result = await next();
        order.push("first:after");
        return result;
      };

      const second: Middleware = async (ctx, next) => {
        order.push("second:before");
        const result = await next();
        order.push("second:after");
        return result;
      };

      const third: Middleware = async (ctx, next) => {
        order.push("third:before");
        const result = await next();
        order.push("third:after");
        return result;
      };

      const router = {
        ping: query().handler(() => {
          order.push("handler");
          return "pong";
        }),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [first, second, third],
      });

      await invokeFrom(mock, {
        type: "query",
        path: "ping",
        input: undefined,
      });

      expect(order).toEqual([
        "first:before",
        "second:before",
        "third:before",
        "handler",
        "third:after",
        "second:after",
        "first:after",
      ]);

      server.cleanup();
    });

    it("middleware can modify the return value", async () => {
      const wrapMiddleware: Middleware = async (_ctx, next) => {
        const result = await next();
        return { wrapped: true, original: result };
      };

      const router = {
        ping: query().handler(() => "pong"),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [wrapMiddleware],
      });

      const result = await invokeFrom(mock, {
        type: "query",
        path: "ping",
        input: undefined,
      });

      expect(result).toEqual({ wrapped: true, original: "pong" });

      server.cleanup();
    });
  });

  // ===========================================================================
  // Async middleware
  // ===========================================================================

  describe("async middleware", () => {
    it("supports async middleware that awaits before calling next", async () => {
      const timingMiddleware: Middleware = async (ctx, next) => {
        // Simulate async work (e.g., checking auth token)
        await new Promise((r) => setTimeout(r, 5));
        return next();
      };

      const router = {
        ping: query().handler(() => "pong"),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [timingMiddleware],
      });

      const result = await invokeFrom(mock, {
        type: "query",
        path: "ping",
        input: undefined,
      });

      expect(result).toBe("pong");

      server.cleanup();
    });

    it("supports async middleware that does work after next()", async () => {
      const durations: number[] = [];

      const timingMiddleware: Middleware = async (_ctx, next) => {
        const start = Date.now();
        const result = await next();
        durations.push(Date.now() - start);
        return result;
      };

      const router = {
        slow: query().handler(async () => {
          await new Promise((r) => setTimeout(r, 20));
          return "done";
        }),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [timingMiddleware],
      });

      await invokeFrom(mock, {
        type: "query",
        path: "slow",
        input: undefined,
      });

      expect(durations.length).toBe(1);
      expect(durations[0]!).toBeGreaterThanOrEqual(15);

      server.cleanup();
    });
  });

  // ===========================================================================
  // Error handling in middleware
  // ===========================================================================

  describe("error handling", () => {
    it("middleware can throw to short-circuit (handler never runs)", async () => {
      const handlerCalled = vi.fn();

      const authMiddleware: Middleware = async (_ctx, _next) => {
        throw new RpcError(RpcErrorCode.HANDLER_ERROR, "Unauthorized");
      };

      const router = {
        secret: query().handler(() => {
          handlerCalled();
          return "classified";
        }),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [authMiddleware],
      });

      try {
        await invokeFrom(mock, {
          type: "query",
          path: "secret",
          input: undefined,
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).message).toBe("Unauthorized");
      }

      expect(handlerCalled).not.toHaveBeenCalled();

      server.cleanup();
    });

    it("middleware can catch and transform handler errors", async () => {
      const errorTransformMiddleware: Middleware = async (_ctx, next) => {
        try {
          return await next();
        } catch (err) {
          if (err instanceof Error) {
            throw new RpcError(
              RpcErrorCode.INTERNAL,
              `Wrapped: ${err.message}`,
            );
          }
          throw err;
        }
      };

      const router = {
        failing: query().handler(() => {
          throw new Error("original error");
        }),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [errorTransformMiddleware],
      });

      try {
        await invokeFrom(mock, {
          type: "query",
          path: "failing",
          input: undefined,
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.INTERNAL);
        expect((err as RpcError).message).toBe("Wrapped: original error");
      }

      server.cleanup();
    });

    it("if middleware throws a non-RpcError, it becomes HANDLER_ERROR", async () => {
      const badMiddleware: Middleware = async (_ctx, _next) => {
        throw new Error("middleware broke");
      };

      const router = {
        ping: query().handler(() => "pong"),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [badMiddleware],
      });

      try {
        await invokeFrom(mock, {
          type: "query",
          path: "ping",
          input: undefined,
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.HANDLER_ERROR);
        expect((err as RpcError).message).toBe("middleware broke");
      }

      server.cleanup();
    });
  });

  // ===========================================================================
  // Common use cases
  // ===========================================================================

  describe("common use cases", () => {
    it("logging middleware: logs procedure calls", async () => {
      const logs: string[] = [];

      const loggerMiddleware: Middleware = async (ctx, next) => {
        logs.push(`[${ctx.type}] ${ctx.path} called`);
        const result = await next();
        logs.push(`[${ctx.type}] ${ctx.path} completed`);
        return result;
      };

      const router = {
        ping: query().handler(() => "pong"),
        save: mutation()
          .input(z.string())
          .handler((s) => s.toUpperCase()),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [loggerMiddleware],
      });

      await invokeFrom(mock, {
        type: "query",
        path: "ping",
        input: undefined,
      });

      await invokeFrom(mock, {
        type: "mutation",
        path: "save",
        input: "hello",
      });

      expect(logs).toEqual([
        "[query] ping called",
        "[query] ping completed",
        "[mutation] save called",
        "[mutation] save completed",
      ]);

      server.cleanup();
    });

    it("rate limiting middleware: blocks rapid calls", async () => {
      const callTimestamps = new Map<string, number>();

      const rateLimitMiddleware: Middleware = async (ctx, next) => {
        const key = `${ctx.sender.id}:${ctx.path}`;
        const lastCall = callTimestamps.get(key);
        const now = Date.now();

        if (lastCall !== undefined && now - lastCall < 50) {
          throw new RpcError(RpcErrorCode.HANDLER_ERROR, "Rate limited");
        }

        callTimestamps.set(key, now);
        return next();
      };

      const router = {
        ping: query().handler(() => "pong"),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [rateLimitMiddleware],
      });

      // First call succeeds
      const result = await invokeFrom(mock, {
        type: "query",
        path: "ping",
        input: undefined,
      });
      expect(result).toBe("pong");

      // Immediate second call is rate limited
      try {
        await invokeFrom(mock, {
          type: "query",
          path: "ping",
          input: undefined,
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).message).toBe("Rate limited");
      }

      // Wait and try again -- should succeed
      await new Promise((r) => setTimeout(r, 60));
      const result2 = await invokeFrom(mock, {
        type: "query",
        path: "ping",
        input: undefined,
      });
      expect(result2).toBe("pong");

      server.cleanup();
    });
  });

  // ===========================================================================
  // Middleware does not apply to subscriptions
  // (Subscriptions have a different handler pattern -- they are fire-and-forget
  // with emit/emitError. Middleware is for request-response only.)
  // ===========================================================================

  describe("subscriptions (middleware applies to subscribe call)", () => {
    it("middleware runs when a subscription is started", async () => {
      const calls: string[] = [];

      const logMiddleware: Middleware = async (ctx, next) => {
        calls.push(`${ctx.type}:${ctx.path}`);
        return next();
      };

      const router = {
        onTick: subscription()
          .output(z.object({ count: z.number() }))
          .handler((_, ctx) => {
            ctx.emit({ count: 0 });
            return () => {};
          }),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [logMiddleware],
      });

      mock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-1",
        path: "onTick",
        input: undefined,
      } satisfies SubscribePayload);

      await new Promise((r) => setTimeout(r, 10));

      expect(calls).toContain("subscription:onTick");

      server.cleanup();
    });

    it("middleware can block a subscription from starting", async () => {
      const errors: unknown[] = [];

      const blockMiddleware: Middleware = async (_ctx, _next) => {
        throw new RpcError(RpcErrorCode.HANDLER_ERROR, "Subscription blocked");
      };

      const router = {
        onTick: subscription()
          .output(z.object({ count: z.number() }))
          .handler((_, ctx) => {
            ctx.emit({ count: 0 });
            return () => {};
          }),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [blockMiddleware],
      });

      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: unknown) => {
        const message = msg as { type: string; error?: unknown };
        if (message.type === "error") {
          errors.push(message.error);
        }
      });

      mock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-blocked",
        path: "onTick",
        input: undefined,
      } satisfies SubscribePayload);

      await new Promise((r) => setTimeout(r, 10));

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toMatchObject({
        code: RpcErrorCode.HANDLER_ERROR,
        message: "Subscription blocked",
      });

      server.cleanup();
    });
  });

  // ===========================================================================
  // Per-procedure middleware (.use())
  // ===========================================================================

  describe("per-procedure middleware (.use())", () => {
    it("per-procedure middleware runs after global middleware", async () => {
      const order: string[] = [];

      const globalMw: Middleware = async (_ctx, next) => {
        order.push("global");
        return next();
      };

      const perProcMw: Middleware = async (_ctx, next) => {
        order.push("per-proc");
        return next();
      };

      const router = {
        ping: query().use(perProcMw).handler(() => {
          order.push("handler");
          return "pong";
        }),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [globalMw],
      });

      await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
      expect(order).toEqual(["global", "per-proc", "handler"]);
      server.cleanup();
    });

    it("per-procedure middleware only applies to its procedure", async () => {
      const calls: string[] = [];

      const perProcMw: Middleware = async (ctx, next) => {
        calls.push(`perproc:${ctx.path}`);
        return next();
      };

      const router = {
        withMw: query().use(perProcMw).handler(() => "a"),
        withoutMw: query().handler(() => "b"),
      };

      const server = createServer(router, { ipcMain: mock.ipcMain });

      await invokeFrom(mock, { type: "query", path: "withMw", input: undefined });
      await invokeFrom(mock, { type: "query", path: "withoutMw", input: undefined });

      expect(calls).toEqual(["perproc:withMw"]);
      server.cleanup();
    });

    it("per-procedure middleware works on mutations", async () => {
      const calls: string[] = [];

      const mw: Middleware = async (ctx, next) => {
        calls.push(`mw:${ctx.path}`);
        return next();
      };

      const router = {
        doIt: mutation().use(mw).input(z.number()).handler((n) => n * 2),
      };

      const server = createServer(router, { ipcMain: mock.ipcMain });
      const result = await invokeFrom(mock, { type: "mutation", path: "doIt", input: 5 });

      expect(result).toBe(10);
      expect(calls).toEqual(["mw:doIt"]);
      server.cleanup();
    });

    it("per-procedure middleware can short-circuit", async () => {
      const handlerCalled = vi.fn();

      const blockMw: Middleware = async (_ctx, _next) => {
        throw new RpcError(RpcErrorCode.HANDLER_ERROR, "blocked by per-proc mw");
      };

      const router = {
        secret: query().use(blockMw).handler(() => {
          handlerCalled();
          return "nope";
        }),
      };

      const server = createServer(router, { ipcMain: mock.ipcMain });

      try {
        await invokeFrom(mock, { type: "query", path: "secret", input: undefined });
        expect.fail("should throw");
      } catch (err) {
        expect((err as RpcError).message).toBe("blocked by per-proc mw");
      }

      expect(handlerCalled).not.toHaveBeenCalled();
      server.cleanup();
    });

    it("multiple per-procedure middleware run in .use() order", async () => {
      const order: string[] = [];

      const first: Middleware = async (_ctx, next) => { order.push("first"); return next(); };
      const second: Middleware = async (_ctx, next) => { order.push("second"); return next(); };
      const third: Middleware = async (_ctx, next) => { order.push("third"); return next(); };

      const router = {
        ping: query().use(first).use(second).use(third).handler(() => {
          order.push("handler");
          return "pong";
        }),
      };

      const server = createServer(router, { ipcMain: mock.ipcMain });
      await invokeFrom(mock, { type: "query", path: "ping", input: undefined });

      expect(order).toEqual(["first", "second", "third", "handler"]);
      server.cleanup();
    });
  });

  // ===========================================================================
  // withMiddleware (group middleware, Chi-style)
  // ===========================================================================

  describe("withMiddleware (group middleware)", () => {
    it("applies middleware to all procedures in the group", async () => {
      const calls: string[] = [];

      const groupMw: Middleware = async (ctx, next) => {
        calls.push(`group:${ctx.path}`);
        return next();
      };

      const grouped = withMiddleware([groupMw], {
        a: query().handler(() => "a"),
        b: query().handler(() => "b"),
      });

      const router = { ...grouped };
      const server = createServer(router, { ipcMain: mock.ipcMain });

      await invokeFrom(mock, { type: "query", path: "a", input: undefined });
      await invokeFrom(mock, { type: "query", path: "b", input: undefined });

      expect(calls).toEqual(["group:a", "group:b"]);
      server.cleanup();
    });

    it("group middleware does not apply to procedures outside the group", async () => {
      const calls: string[] = [];

      const groupMw: Middleware = async (ctx, next) => {
        calls.push(`group:${ctx.path}`);
        return next();
      };

      const protectedRoutes = withMiddleware([groupMw], {
        secret: query().handler(() => "secret"),
      });

      const router = {
        ...protectedRoutes,
        public: query().handler(() => "public"),
      };

      const server = createServer(router, { ipcMain: mock.ipcMain });

      await invokeFrom(mock, { type: "query", path: "public", input: undefined });
      await invokeFrom(mock, { type: "query", path: "secret", input: undefined });

      expect(calls).toEqual(["group:secret"]);
      server.cleanup();
    });

    it("execution order: global -> group -> per-procedure -> handler", async () => {
      const order: string[] = [];

      const globalMw: Middleware = async (_ctx, next) => { order.push("global"); return next(); };
      const groupMw: Middleware = async (_ctx, next) => { order.push("group"); return next(); };
      const procMw: Middleware = async (_ctx, next) => { order.push("per-proc"); return next(); };

      const grouped = withMiddleware([groupMw], {
        ping: query().use(procMw).handler(() => {
          order.push("handler");
          return "pong";
        }),
      });

      const server = createServer(grouped, {
        ipcMain: mock.ipcMain,
        middleware: [globalMw],
      });

      await invokeFrom(mock, { type: "query", path: "ping", input: undefined });
      expect(order).toEqual(["global", "group", "per-proc", "handler"]);
      server.cleanup();
    });

    it("withMiddleware preserves existing per-procedure middleware", async () => {
      const order: string[] = [];

      const groupMw: Middleware = async (_ctx, next) => { order.push("group"); return next(); };
      const procMw: Middleware = async (_ctx, next) => { order.push("per-proc"); return next(); };

      const grouped = withMiddleware([groupMw], {
        ping: query().use(procMw).handler(() => {
          order.push("handler");
          return "pong";
        }),
      });

      const server = createServer(grouped, { ipcMain: mock.ipcMain });
      await invokeFrom(mock, { type: "query", path: "ping", input: undefined });

      // Group middleware runs first, then per-procedure
      expect(order).toEqual(["group", "per-proc", "handler"]);
      server.cleanup();
    });

    it("withMiddleware works with mutations and subscriptions", async () => {
      const calls: string[] = [];

      const groupMw: Middleware = async (ctx, next) => {
        calls.push(`group:${ctx.type}:${ctx.path}`);
        return next();
      };

      const grouped = withMiddleware([groupMw], {
        inc: mutation().input(z.number()).handler((n) => n + 1),
        onTick: subscription()
          .output(z.object({ n: z.number() }))
          .handler((_, ctx) => { ctx.emit({ n: 0 }); return () => {}; }),
      });

      const server = createServer(grouped, { ipcMain: mock.ipcMain });

      await invokeFrom(mock, { type: "mutation", path: "inc", input: 5 });

      mock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-group",
        path: "onTick",
        input: undefined,
      } satisfies SubscribePayload);
      await new Promise((r) => setTimeout(r, 10));

      expect(calls).toContain("group:mutation:inc");
      expect(calls).toContain("group:subscription:onTick");
      server.cleanup();
    });

    it("multiple group middleware run in order", async () => {
      const order: string[] = [];

      const first: Middleware = async (_ctx, next) => { order.push("g1"); return next(); };
      const second: Middleware = async (_ctx, next) => { order.push("g2"); return next(); };

      const grouped = withMiddleware([first, second], {
        ping: query().handler(() => { order.push("handler"); return "pong"; }),
      });

      const server = createServer(grouped, { ipcMain: mock.ipcMain });
      await invokeFrom(mock, { type: "query", path: "ping", input: undefined });

      expect(order).toEqual(["g1", "g2", "handler"]);
      server.cleanup();
    });

    it("nested withMiddleware composes correctly", async () => {
      const order: string[] = [];

      const outerMw: Middleware = async (_ctx, next) => { order.push("outer"); return next(); };
      const innerMw: Middleware = async (_ctx, next) => { order.push("inner"); return next(); };

      const inner = withMiddleware([innerMw], {
        ping: query().handler(() => { order.push("handler"); return "pong"; }),
      });
      const outer = withMiddleware([outerMw], inner);

      const server = createServer(outer, { ipcMain: mock.ipcMain });
      await invokeFrom(mock, { type: "query", path: "ping", input: undefined });

      expect(order).toEqual(["outer", "inner", "handler"]);
      server.cleanup();
    });
  });

  // ===========================================================================
  // No middleware (backward compatibility)
  // ===========================================================================

  describe("backward compatibility", () => {
    it("server works without middleware option", async () => {
      const router = {
        ping: query().handler(() => "pong"),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
      });

      const result = await invokeFrom(mock, {
        type: "query",
        path: "ping",
        input: undefined,
      });

      expect(result).toBe("pong");

      server.cleanup();
    });

    it("empty middleware array works the same as no middleware", async () => {
      const router = {
        ping: query().handler(() => "pong"),
      };

      const server = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [],
      });

      const result = await invokeFrom(mock, {
        type: "query",
        path: "ping",
        input: undefined,
      });

      expect(result).toBe("pong");

      server.cleanup();
    });
  });
});
