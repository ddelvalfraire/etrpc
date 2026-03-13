/**
 * Unit tests for composeMiddleware utility.
 *
 * Tests the middleware composition independent from the IPC server.
 */

import { describe, it, expect, vi } from "vitest";
import {
  composeMiddleware,
  defineMiddleware,
  type Middleware,
  type MiddlewareContext,
} from "#src/main/middleware";

function createCtx(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    type: "query",
    path: "test",
    input: undefined,
    sender: { id: 1 },
    ...overrides,
  };
}

describe("composeMiddleware", () => {
  it("calls the handler directly when middleware array is empty", async () => {
    const handler = vi.fn().mockResolvedValue("result");
    const result = await composeMiddleware([], handler, createCtx());
    expect(result).toBe("result");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("single middleware wraps the handler", async () => {
    const order: string[] = [];

    const mw: Middleware = async (_ctx, next) => {
      order.push("before");
      const result = await next();
      order.push("after");
      return result;
    };

    const handler = async () => {
      order.push("handler");
      return "ok";
    };

    const result = await composeMiddleware([mw], handler, createCtx());
    expect(result).toBe("ok");
    expect(order).toEqual(["before", "handler", "after"]);
  });

  it("passes the context to each middleware", async () => {
    const receivedCtxs: MiddlewareContext[] = [];

    const mw: Middleware = async (ctx, next) => {
      receivedCtxs.push(ctx);
      return next();
    };

    const ctx = createCtx({ path: "myProcedure", type: "mutation" });
    await composeMiddleware([mw], async () => "ok", ctx);

    expect(receivedCtxs).toHaveLength(1);
    expect(receivedCtxs[0]!.path).toBe("myProcedure");
    expect(receivedCtxs[0]!.type).toBe("mutation");
  });

  it("detects next() called multiple times in the same middleware", async () => {
    const mw: Middleware = async (_ctx, next) => {
      await next();
      return next(); // second call should fail
    };

    await expect(
      composeMiddleware([mw], async () => "ok", createCtx()),
    ).rejects.toThrow("next() called multiple times");
  });

  it("middleware can swallow errors from handler", async () => {
    const mw: Middleware = async (_ctx, next) => {
      try {
        return await next();
      } catch {
        return "recovered";
      }
    };

    const handler = async () => {
      throw new Error("boom");
    };

    const result = await composeMiddleware([mw], handler, createCtx());
    expect(result).toBe("recovered");
  });

  it("middleware error propagates to caller when not caught", async () => {
    const mw: Middleware = async (_ctx, _next) => {
      throw new Error("middleware error");
    };

    await expect(
      composeMiddleware([mw], async () => "ok", createCtx()),
    ).rejects.toThrow("middleware error");
  });

  it("handler is never called when middleware does not call next()", async () => {
    const handler = vi.fn().mockResolvedValue("should not run");

    const mw: Middleware = async (_ctx, _next) => {
      return "short-circuited";
    };

    const result = await composeMiddleware([mw], handler, createCtx());
    expect(result).toBe("short-circuited");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("defineMiddleware", () => {
  it("returns the same function it receives", () => {
    const fn: Middleware = async (_ctx, next) => next();
    const result = defineMiddleware(fn);
    expect(result).toBe(fn);
  });

  it("defined middleware works with composeMiddleware", async () => {
    const order: string[] = [];

    const mw = defineMiddleware(async (ctx, next) => {
      order.push(`${ctx.type}:${ctx.path}`);
      return next();
    });

    const result = await composeMiddleware(
      [mw],
      async () => "done",
      createCtx({ type: "mutation", path: "save" }),
    );

    expect(result).toBe("done");
    expect(order).toEqual(["mutation:save"]);
  });

  it("defined middleware composes with manually typed middleware", async () => {
    const order: string[] = [];

    const manual: Middleware = async (_ctx, next) => {
      order.push("manual");
      return next();
    };

    const defined = defineMiddleware(async (_ctx, next) => {
      order.push("defined");
      return next();
    });

    await composeMiddleware(
      [manual, defined],
      async () => {
        order.push("handler");
        return "ok";
      },
      createCtx(),
    );

    expect(order).toEqual(["manual", "defined", "handler"]);
  });

  it("defined middleware can transform the result", async () => {
    const mw = defineMiddleware(async (_ctx, next) => {
      const result = await next();
      return { transformed: true, value: result };
    });

    const result = await composeMiddleware(
      [mw],
      async () => 42,
      createCtx(),
    );

    expect(result).toEqual({ transformed: true, value: 42 });
  });

  it("defined middleware can short-circuit by throwing", async () => {
    const mw = defineMiddleware(async (_ctx, _next) => {
      throw new Error("blocked by defineMiddleware");
    });

    await expect(
      composeMiddleware([mw], async () => "ok", createCtx()),
    ).rejects.toThrow("blocked by defineMiddleware");
  });
});

describe("Middleware generic context extension", () => {
  it("extended middleware receives additional context properties at runtime", async () => {
    interface WithAuth { userId: string; role: string }

    // This middleware expects the extended context
    const authGuard: Middleware<WithAuth> = async (ctx, next) => {
      if (ctx.role !== "admin") {
        throw new Error(`User ${ctx.userId} is not admin`);
      }
      return next();
    };

    // Create a context with the extra properties
    const ctx = {
      ...createCtx(),
      userId: "user-123",
      role: "admin",
    };

    // When cast to base Middleware, it works with composeMiddleware
    const result = await composeMiddleware(
      [authGuard as Middleware],
      async () => "secret-data",
      ctx,
    );

    expect(result).toBe("secret-data");
  });

  it("extended middleware rejects when role check fails", async () => {
    interface WithAuth { userId: string; role: string }

    const authGuard: Middleware<WithAuth> = async (ctx, _next) => {
      if (ctx.role !== "admin") {
        throw new Error(`Access denied for ${ctx.userId}`);
      }
      return _next();
    };

    const ctx = {
      ...createCtx(),
      userId: "user-456",
      role: "viewer",
    };

    await expect(
      composeMiddleware(
        [authGuard as Middleware],
        async () => "secret",
        ctx,
      ),
    ).rejects.toThrow("Access denied for user-456");
  });

  it("base Middleware type is assignable from Middleware with no extra", () => {
    // Verify that Middleware (no generic) is the same as Middleware<Record<never, never>>
    const mw1: Middleware = async (_ctx, next) => next();
    const mw2: Middleware<Record<never, never>> = async (_ctx, next) => next();

    // Both should be usable in a ReadonlyArray<Middleware>
    const middlewares: ReadonlyArray<Middleware> = [mw1, mw2];
    expect(middlewares).toHaveLength(2);
  });
});
