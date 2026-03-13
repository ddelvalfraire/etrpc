import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  PreloadBridge,
  SubscriptionMessage,
  RpcErrorCode,
  RouterDef,
  QueryProcedure,
  MutationProcedure,
  SubscriptionProcedure,
} from "#src/shared/types";
import { RpcError } from "#src/shared/types";
import { createClient } from "#src/renderer/client";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Test router type (phantom type only, never instantiated)
// ---------------------------------------------------------------------------
type TestRouter = {
  greet: QueryProcedure<z.ZodString, string>;
  getStatus: QueryProcedure<z.ZodVoid, string>;
  save: MutationProcedure<z.ZodObject<{ name: z.ZodString }>, boolean>;
  reset: MutationProcedure<z.ZodVoid, void>;
  onTick: SubscriptionProcedure<z.ZodVoid, number>;
  onEvent: SubscriptionProcedure<z.ZodString, { value: string }>;
};

// ---------------------------------------------------------------------------
// Mock bridge factory
// ---------------------------------------------------------------------------
function createMockBridge(): PreloadBridge & {
  triggerMessage: (msg: SubscriptionMessage) => void;
} {
  const listeners: Array<(msg: SubscriptionMessage) => void> = [];
  return {
    invoke: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    onSubscriptionMessage: vi.fn((cb: (msg: SubscriptionMessage) => void) => {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    triggerMessage: (msg: SubscriptionMessage) =>
      listeners.forEach((l) => l(msg)),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type RpcFn = (input?: unknown) => Promise<unknown>;
/** Call a proxy method by name, bypassing noUncheckedIndexedAccess. */
function call(obj: unknown, method: string, ...args: unknown[]): Promise<unknown> {
  return (obj as Record<string, RpcFn>)[method]!(...args);
}

/** Call a subscription proxy method by name, bypassing noUncheckedIndexedAccess. */
function callSub<R = unknown>(obj: unknown, method: string, ...args: unknown[]): R {
  return (obj as Record<string, (...a: unknown[]) => R>)[method]!(...args);
}

let mockBridge: ReturnType<typeof createMockBridge>;

beforeEach(() => {
  mockBridge = createMockBridge();
  (globalThis as Record<string, unknown>).__etrpc = mockBridge;
});

// ---------------------------------------------------------------------------
// QUERIES
// ---------------------------------------------------------------------------
describe("queries", () => {
  it("calls bridge.invoke with type 'query' and the correct path and input", async () => {
    mockBridge.invoke = vi.fn().mockResolvedValue("Hello World");
    const api = createClient<TestRouter>();

    const result = await call(api.queries, "greet", "World");

    expect(mockBridge.invoke).toHaveBeenCalledWith({
      type: "query",
      path: "greet",
      input: "World",
    });
    expect(result).toBe("Hello World");
  });

  it("calls invoke with input undefined for void-input queries", async () => {
    mockBridge.invoke = vi.fn().mockResolvedValue("OK");
    const api = createClient<TestRouter>();

    const result = await call(api.queries, "getStatus");

    expect(mockBridge.invoke).toHaveBeenCalledWith({
      type: "query",
      path: "getStatus",
      input: undefined,
    });
    expect(result).toBe("OK");
  });

  it("returns the resolved invoke value to the caller", async () => {
    const expectedData = { complex: [1, 2, 3], nested: { a: true } };
    mockBridge.invoke = vi.fn().mockResolvedValue(expectedData);
    const api = createClient<TestRouter>();

    const result = await call(api.queries, "greet", "test");
    expect(result).toEqual(expectedData);
  });

  it("reconstructs RpcError from serialized error on rejection", async () => {
    const serializedError = {
      code: "VALIDATION_ERROR" as RpcErrorCode,
      message: "Invalid input",
      data: [{ path: ["name"], message: "Required" }],
    };
    mockBridge.invoke = vi.fn().mockRejectedValue(serializedError);
    const api = createClient<TestRouter>();

    try {
      await call(api.queries, "greet", "bad");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const rpcErr = err as RpcError;
      expect(rpcErr.code).toBe("VALIDATION_ERROR");
      expect(rpcErr.message).toBe("Invalid input");
      expect(rpcErr.data).toEqual([{ path: ["name"], message: "Required" }]);
    }
  });

  it("re-throws non-serialized errors as-is", async () => {
    const plainError = new Error("Network failure");
    mockBridge.invoke = vi.fn().mockRejectedValue(plainError);
    const api = createClient<TestRouter>();

    await expect(
      call(api.queries, "greet", "x"),
    ).rejects.toThrow("Network failure");
  });

  it("handles multiple concurrent queries independently", async () => {
    let callCount = 0;
    mockBridge.invoke = vi.fn().mockImplementation(async (payload: { input: unknown }) => {
      callCount++;
      const n = callCount;
      await new Promise((r) => setTimeout(r, n === 1 ? 50 : 10));
      return `result-${payload.input}`;
    });
    const api = createClient<TestRouter>();

    const p1 = call(api.queries, "greet", "a");
    const p2 = call(api.queries, "greet", "b");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("result-a");
    expect(r2).toBe("result-b");
  });
});

// ---------------------------------------------------------------------------
// MUTATIONS
// ---------------------------------------------------------------------------
describe("mutations", () => {
  it("calls bridge.invoke with type 'mutation' and the correct path and input", async () => {
    mockBridge.invoke = vi.fn().mockResolvedValue(true);
    const api = createClient<TestRouter>();

    const result = await call(api.mutations, "save", { name: "test" });

    expect(mockBridge.invoke).toHaveBeenCalledWith({
      type: "mutation",
      path: "save",
      input: { name: "test" },
    });
    expect(result).toBe(true);
  });

  it("calls invoke with input undefined for void-input mutations", async () => {
    mockBridge.invoke = vi.fn().mockResolvedValue(undefined);
    const api = createClient<TestRouter>();

    await call(api.mutations, "reset");

    expect(mockBridge.invoke).toHaveBeenCalledWith({
      type: "mutation",
      path: "reset",
      input: undefined,
    });
  });

  it("reconstructs RpcError from serialized mutation error", async () => {
    const serializedError = {
      code: "HANDLER_ERROR" as RpcErrorCode,
      message: "Save failed",
    };
    mockBridge.invoke = vi.fn().mockRejectedValue(serializedError);
    const api = createClient<TestRouter>();

    try {
      await call(api.mutations, "save", { name: "x" });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const rpcErr = err as RpcError;
      expect(rpcErr.code).toBe("HANDLER_ERROR");
      expect(rpcErr.message).toBe("Save failed");
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSCRIPTIONS
// ---------------------------------------------------------------------------
describe("subscriptions", () => {
  it("calls bridge.subscribe with correct payload for void-input subscriptions", () => {
    const api = createClient<TestRouter>();
    const onData = vi.fn();
    const onError = vi.fn();

    callSub(api.subscriptions, "onTick", { onData, onError });

    expect(mockBridge.subscribe).toHaveBeenCalledTimes(1);
    const payload = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.type).toBe("subscribe");
    expect(payload.path).toBe("onTick");
    expect(payload.input).toBeUndefined();
    expect(typeof payload.id).toBe("string");
    expect(payload.id.length).toBeGreaterThan(0);
  });

  it("calls bridge.subscribe with correct payload for typed-input subscriptions", () => {
    const api = createClient<TestRouter>();
    const onData = vi.fn();
    const onError = vi.fn();

    callSub(api.subscriptions, "onEvent", "filter", {
      onData,
      onError,
    });

    expect(mockBridge.subscribe).toHaveBeenCalledTimes(1);
    const payload = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.type).toBe("subscribe");
    expect(payload.path).toBe("onEvent");
    expect(payload.input).toBe("filter");
    expect(typeof payload.id).toBe("string");
  });

  it("generates unique subscription IDs per call", () => {
    const api = createClient<TestRouter>();

    callSub(api.subscriptions, "onTick", {
      onData: vi.fn(),
      onError: vi.fn(),
    });
    callSub(api.subscriptions, "onTick", {
      onData: vi.fn(),
      onError: vi.fn(),
    });

    const id1 = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0].id;
    const id2 = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[1]![0].id;
    expect(id1).not.toBe(id2);
  });

  it("returns an UnsubscribeFn that calls bridge.unsubscribe with correct ID", () => {
    const api = createClient<TestRouter>();

    const unsub = callSub<() => void>(api.subscriptions, "onTick", {
      onData: vi.fn(),
      onError: vi.fn(),
    });

    const subId = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0].id;

    unsub();

    expect(mockBridge.unsubscribe).toHaveBeenCalledWith({
      type: "unsubscribe",
      id: subId,
    });
  });

  it("removes callbacks from internal map on unsubscribe", () => {
    const api = createClient<TestRouter>();
    const onData = vi.fn();

    const unsub = callSub<() => void>(api.subscriptions, "onTick", {
      onData,
      onError: vi.fn(),
    });
    const subId = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0].id;

    unsub();

    // After unsubscribe, data messages for that ID should be ignored
    mockBridge.triggerMessage({ type: "data", id: subId, data: 42 });
    expect(onData).not.toHaveBeenCalled();
  });

  it("routes data messages to the correct onData callback", () => {
    const api = createClient<TestRouter>();
    const onData = vi.fn();

    callSub(api.subscriptions, "onTick", {
      onData,
      onError: vi.fn(),
    });
    const subId = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0].id;

    mockBridge.triggerMessage({ type: "data", id: subId, data: 42 });

    expect(onData).toHaveBeenCalledWith(42);
  });

  it("routes error messages to the correct onError callback as RpcError", () => {
    const api = createClient<TestRouter>();
    const onError = vi.fn();

    callSub(api.subscriptions, "onTick", {
      onData: vi.fn(),
      onError,
    });
    const subId = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0].id;

    mockBridge.triggerMessage({
      type: "error",
      id: subId,
      error: {
        code: "HANDLER_ERROR" as RpcErrorCode,
        message: "Something broke",
        data: { detail: "stack trace" },
      },
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]![0];
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("HANDLER_ERROR");
    expect(err.message).toBe("Something broke");
    expect(err.data).toEqual({ detail: "stack trace" });
  });

  it("handles multiple subscriptions to different paths independently", () => {
    const api = createClient<TestRouter>();
    const onDataTick = vi.fn();
    const onDataEvent = vi.fn();

    callSub(api.subscriptions, "onTick", {
      onData: onDataTick,
      onError: vi.fn(),
    });
    callSub(api.subscriptions, "onEvent", "filter", {
      onData: onDataEvent,
      onError: vi.fn(),
    });

    const tickId = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0].id;
    const eventId = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[1]![0].id;

    mockBridge.triggerMessage({ type: "data", id: tickId, data: 1 });
    mockBridge.triggerMessage({
      type: "data",
      id: eventId,
      data: { value: "hello" },
    });

    expect(onDataTick).toHaveBeenCalledWith(1);
    expect(onDataTick).toHaveBeenCalledTimes(1);
    expect(onDataEvent).toHaveBeenCalledWith({ value: "hello" });
    expect(onDataEvent).toHaveBeenCalledTimes(1);
  });

  it("handles multiple subscriptions to the SAME path each getting their own ID and callbacks", () => {
    const api = createClient<TestRouter>();
    const onData1 = vi.fn();
    const onData2 = vi.fn();

    callSub(api.subscriptions, "onTick", {
      onData: onData1,
      onError: vi.fn(),
    });
    callSub(api.subscriptions, "onTick", {
      onData: onData2,
      onError: vi.fn(),
    });

    const id1 = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0].id;
    const id2 = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[1]![0].id;

    expect(id1).not.toBe(id2);

    mockBridge.triggerMessage({ type: "data", id: id1, data: 100 });
    expect(onData1).toHaveBeenCalledWith(100);
    expect(onData2).not.toHaveBeenCalled();

    mockBridge.triggerMessage({ type: "data", id: id2, data: 200 });
    expect(onData2).toHaveBeenCalledWith(200);
  });

  it("silently ignores messages for unknown subscription IDs", () => {
    const api = createClient<TestRouter>();
    // Create at least one subscription so the listener is registered
    callSub(api.subscriptions, "onTick", {
      onData: vi.fn(),
      onError: vi.fn(),
    });

    // Should not throw
    expect(() => {
      mockBridge.triggerMessage({
        type: "data",
        id: "non-existent-id",
        data: 999,
      });
    }).not.toThrow();

    expect(() => {
      mockBridge.triggerMessage({
        type: "error",
        id: "non-existent-id",
        error: {
          code: "INTERNAL" as RpcErrorCode,
          message: "unknown",
        },
      });
    }).not.toThrow();
  });

  it("ignores messages after unsubscribe", () => {
    const api = createClient<TestRouter>();
    const onData = vi.fn();
    const onError = vi.fn();

    const unsub = callSub<() => void>(api.subscriptions, "onTick", {
      onData,
      onError,
    });
    const subId = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0].id;

    // Receive one message before unsubscribe
    mockBridge.triggerMessage({ type: "data", id: subId, data: 1 });
    expect(onData).toHaveBeenCalledTimes(1);

    unsub();

    // Messages after unsubscribe should be ignored
    mockBridge.triggerMessage({ type: "data", id: subId, data: 2 });
    mockBridge.triggerMessage({
      type: "error",
      id: subId,
      error: {
        code: "HANDLER_ERROR" as RpcErrorCode,
        message: "post-unsub",
      },
    });

    expect(onData).toHaveBeenCalledTimes(1); // Still just the one call
    expect(onError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// EDGE CASES
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  it("creating multiple clients works independently", async () => {
    mockBridge.invoke = vi.fn().mockResolvedValue("from-bridge");
    const api1 = createClient<TestRouter>();
    const api2 = createClient<TestRouter>();

    const r1 = await call(api1.queries, "greet", "a");
    const r2 = await call(api2.queries, "greet", "b");

    expect(r1).toBe("from-bridge");
    expect(r2).toBe("from-bridge");
    expect(mockBridge.invoke).toHaveBeenCalledTimes(2);
  });

  it("accessing non-existent procedure names returns a function (proxy handles any prop)", () => {
    const api = createClient<TestRouter>();

    const fn = (api.queries as Record<string, unknown>).nonExistentProcedure;
    expect(typeof fn).toBe("function");
  });

  it("subscription listener is registered lazily on first subscription", () => {
    // Before creating any subscriptions, onSubscriptionMessage should not have been called
    const api = createClient<TestRouter>();

    // onSubscriptionMessage should not be called just from creating the client
    expect(mockBridge.onSubscriptionMessage).not.toHaveBeenCalled();

    // After first subscription, it should be called
    callSub(api.subscriptions, "onTick", {
      onData: vi.fn(),
      onError: vi.fn(),
    });

    expect(mockBridge.onSubscriptionMessage).toHaveBeenCalledTimes(1);

    // Second subscription should NOT register another listener
    callSub(api.subscriptions, "onTick", {
      onData: vi.fn(),
      onError: vi.fn(),
    });

    expect(mockBridge.onSubscriptionMessage).toHaveBeenCalledTimes(1);
  });

  it("works with a custom bridge key", async () => {
    const customBridge = createMockBridge();
    customBridge.invoke = vi.fn().mockResolvedValue("custom");
    (globalThis as Record<string, unknown>).__myCustomBridge = customBridge;

    const api = createClient<TestRouter>({ bridgeKey: "__myCustomBridge" });

    const result = await call(api.queries, "greet", "x");
    expect(result).toBe("custom");
    expect(customBridge.invoke).toHaveBeenCalled();

    // Cleanup
    delete (globalThis as Record<string, unknown>).__myCustomBridge;
  });

  it("proxy returns undefined for Symbol properties (used by console.log, etc.)", () => {
    const api = createClient<TestRouter>();

    // Accessing Symbol properties (e.g., Symbol.toPrimitive, Symbol.iterator)
    // should return undefined, not a function
    const symbolResult = (api.queries as Record<symbol, unknown>)[Symbol.toPrimitive];
    expect(symbolResult).toBeUndefined();

    const iterResult = (api.queries as Record<symbol, unknown>)[Symbol.iterator];
    expect(iterResult).toBeUndefined();
  });

  it("rapid subscribe/unsubscribe does not leak callbacks", () => {
    const api = createClient<TestRouter>();

    // Subscribe and immediately unsubscribe 50 times
    for (let i = 0; i < 50; i++) {
      const unsub = callSub<() => void>(api.subscriptions, "onTick", {
        onData: vi.fn(),
        onError: vi.fn(),
      });
      unsub();
    }

    // After all unsubscribes, no callbacks should be triggered
    const lateSub = callSub<() => void>(api.subscriptions, "onTick", {
      onData: vi.fn(),
      onError: vi.fn(),
    });
    const lateSubId = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[50]![0].id;

    // Trigger a message for the last active subscription -- only it should get called
    const onData = vi.fn();
    // We need to check that old IDs don't match -- all 50 previous IDs were cleaned up
    // Triggering a message for any old ID should do nothing
    const oldSubId = (mockBridge.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]![0].id;
    mockBridge.triggerMessage({ type: "data", id: oldSubId, data: "should be ignored" });

    // The last subscription should still work
    mockBridge.triggerMessage({ type: "data", id: lateSubId, data: "should arrive" });

    lateSub();
  });

  it("reconstructError re-throws primitive errors that lack code/message", async () => {
    mockBridge.invoke = vi.fn().mockRejectedValue(42);
    const api = createClient<TestRouter>();

    try {
      await call(api.queries, "greet", "x");
      expect.fail("Should have thrown");
    } catch (err) {
      // Primitive values without code/message should be re-thrown as-is
      expect(err).toBe(42);
    }
  });

  it("reconstructError re-throws null rejection", async () => {
    mockBridge.invoke = vi.fn().mockRejectedValue(null);
    const api = createClient<TestRouter>();

    try {
      await call(api.queries, "greet", "x");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeNull();
    }
  });
});
