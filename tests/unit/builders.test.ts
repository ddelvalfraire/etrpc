/**
 * Tests for procedure builders (query, mutation, subscription).
 *
 * Validates that builders produce correctly structured procedure definitions
 * with proper type tags, input schemas, and handler functions.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { query } from "#src/main/builders/query";
import { mutation } from "#src/main/builders/mutation";
import { subscription } from "#src/main/builders/subscription";
import type { Middleware } from "#src/main/middleware";

describe("query builder", () => {
  it("creates a query with no input", () => {
    const proc = query().handler(() => "hello");

    expect(proc._type).toBe("query");
    expect(proc._inputSchema).toBeDefined();
    expect(proc.handler).toBeTypeOf("function");
  });

  it("creates a query with typed input", () => {
    const proc = query()
      .input(z.object({ name: z.string() }))
      .handler(({ name }) => `hello ${name}`);

    expect(proc._type).toBe("query");
    expect(proc._inputSchema).toBeDefined();
    // Validate the schema works
    const result = proc._inputSchema.parse({ name: "World" });
    expect(result).toEqual({ name: "World" });
  });

  it("handler is callable and returns correct value", () => {
    const proc = query()
      .input(z.number())
      .handler((n) => n * 2);

    const result = proc.handler(5, { sender: { id: 1 } });
    expect(result).toBe(10);
  });

  it("handler supports async", async () => {
    const proc = query().handler(async () => {
      return 42;
    });

    const result = await proc.handler(undefined, { sender: { id: 1 } });
    expect(result).toBe(42);
  });
});

describe("mutation builder", () => {
  it("creates a mutation with no input", () => {
    const proc = mutation().handler(() => ({ success: true }));

    expect(proc._type).toBe("mutation");
  });

  it("creates a mutation with typed input", () => {
    const proc = mutation()
      .input(z.object({ amount: z.number() }))
      .handler(({ amount }) => amount * 2);

    expect(proc._type).toBe("mutation");
    const result = proc._inputSchema.parse({ amount: 10 });
    expect(result).toEqual({ amount: 10 });
  });
});

describe("subscription builder", () => {
  it("creates a subscription with output only", () => {
    const proc = subscription()
      .output(z.object({ count: z.number() }))
      .handler((_, ctx) => {
        ctx.emit({ count: 0 });
      });

    expect(proc._type).toBe("subscription");
    expect(proc._outputSchema).toBeDefined();
    expect(proc._inputSchema).toBeDefined();
  });

  it("creates a subscription with input and output", () => {
    const proc = subscription()
      .input(z.object({ path: z.string() }))
      .output(z.object({ event: z.string() }))
      .handler(({ path }, ctx) => {
        ctx.emit({ event: `watching ${path}` });
      });

    expect(proc._type).toBe("subscription");
    const inputResult = proc._inputSchema.parse({ path: "/tmp" });
    expect(inputResult).toEqual({ path: "/tmp" });
  });

  it("handler receives typed emit function", () => {
    const emitted: Array<{ count: number }> = [];

    const proc = subscription()
      .output(z.object({ count: z.number() }))
      .handler((_, ctx) => {
        ctx.emit({ count: 1 });
        ctx.emit({ count: 2 });
      });

    const ctx = {
      sender: { id: 1 },
      emit: (data: { count: number }) => emitted.push(data),
      emitError: () => {},
    };

    proc.handler(undefined, ctx);
    expect(emitted).toEqual([{ count: 1 }, { count: 2 }]);
  });

  it("handler can return cleanup function", () => {
    let cleaned = false;

    const proc = subscription()
      .output(z.object({ tick: z.number() }))
      .handler((_, ctx) => {
        return () => {
          cleaned = true;
        };
      });

    const ctx = {
      sender: { id: 1 },
      emit: () => {},
      emitError: () => {},
    };

    const cleanup = proc.handler(undefined, ctx);
    expect(cleanup).toBeTypeOf("function");
    (cleanup as () => void)();
    expect(cleaned).toBe(true);
  });
});

// =============================================================================
// Per-procedure middleware (.use())
// =============================================================================

describe("per-procedure middleware (.use())", () => {
  const noopMw: Middleware = async (_ctx, next) => next();
  const otherMw: Middleware = async (_ctx, next) => next();

  describe("query builder", () => {
    it("stores middleware from .use()", () => {
      const proc = query().use(noopMw).handler(() => "pong");
      expect(proc._middleware).toEqual([noopMw]);
    });

    it("chains multiple .use() calls", () => {
      const proc = query().use(noopMw).use(otherMw).handler(() => "pong");
      expect(proc._middleware).toEqual([noopMw, otherMw]);
    });

    it(".use() before .input() carries middleware through", () => {
      const proc = query()
        .use(noopMw)
        .input(z.string())
        .handler((s) => s.toUpperCase());
      expect(proc._middleware).toEqual([noopMw]);
    });

    it(".use() after .input() works", () => {
      const proc = query()
        .input(z.string())
        .use(noopMw)
        .handler((s) => s.toUpperCase());
      expect(proc._middleware).toEqual([noopMw]);
    });

    it("no .use() produces empty middleware array", () => {
      const proc = query().handler(() => "pong");
      expect(proc._middleware).toEqual([]);
    });

    it(".use() returns a new builder (immutable)", () => {
      const builder = query();
      const withMw = builder.use(noopMw);
      const withoutMw = builder.handler(() => "a");
      const withOneMw = withMw.handler(() => "b");
      expect(withoutMw._middleware).toEqual([]);
      expect(withOneMw._middleware).toEqual([noopMw]);
    });
  });

  describe("mutation builder", () => {
    it("stores middleware from .use()", () => {
      const proc = mutation().use(noopMw).handler(() => 1);
      expect(proc._middleware).toEqual([noopMw]);
    });

    it("chains multiple .use() calls", () => {
      const proc = mutation().use(noopMw).use(otherMw).handler(() => 1);
      expect(proc._middleware).toEqual([noopMw, otherMw]);
    });

    it(".use() before .input() carries middleware through", () => {
      const proc = mutation()
        .use(noopMw)
        .input(z.number())
        .handler((n) => n * 2);
      expect(proc._middleware).toEqual([noopMw]);
    });

    it("no .use() produces empty middleware array", () => {
      const proc = mutation().handler(() => 1);
      expect(proc._middleware).toEqual([]);
    });
  });

  describe("subscription builder", () => {
    it("stores middleware from .use() on initial builder", () => {
      const proc = subscription()
        .use(noopMw)
        .output(z.object({ n: z.number() }))
        .handler((_, ctx) => { ctx.emit({ n: 1 }); });
      expect(proc._middleware).toEqual([noopMw]);
    });

    it(".use() on withInput builder carries through", () => {
      const proc = subscription()
        .input(z.string())
        .use(noopMw)
        .output(z.object({ n: z.number() }))
        .handler((_, ctx) => { ctx.emit({ n: 1 }); });
      expect(proc._middleware).toEqual([noopMw]);
    });

    it(".use() on final builder (after .output()) works", () => {
      const proc = subscription()
        .output(z.object({ n: z.number() }))
        .use(noopMw)
        .handler((_, ctx) => { ctx.emit({ n: 1 }); });
      expect(proc._middleware).toEqual([noopMw]);
    });

    it("chains multiple .use() at different stages", () => {
      const proc = subscription()
        .use(noopMw)
        .input(z.string())
        .use(otherMw)
        .output(z.object({ n: z.number() }))
        .handler((_, ctx) => { ctx.emit({ n: 1 }); });
      expect(proc._middleware).toEqual([noopMw, otherMw]);
    });

    it("no .use() produces empty middleware array", () => {
      const proc = subscription()
        .output(z.object({ n: z.number() }))
        .handler((_, ctx) => { ctx.emit({ n: 1 }); });
      expect(proc._middleware).toEqual([]);
    });
  });
});
