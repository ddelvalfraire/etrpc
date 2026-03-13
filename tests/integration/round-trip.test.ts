/**
 * Integration tests — Full round-trip through mock Electron IPC.
 *
 * These tests wire together:
 *   server (createServer) → mock IPC → client (createClient)
 *
 * They validate that the entire pipeline works end-to-end:
 * queries, mutations, subscriptions, error handling, multi-window, cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { createMockElectron, type MockElectron } from "#test/helpers/electron-mock";
import { createServer } from "#src/main/server";
import { createClient } from "#src/renderer/client";
import { query } from "#src/main/builders/query";
import { mutation } from "#src/main/builders/mutation";
import { subscription } from "#src/main/builders/subscription";
import { RpcError, RpcErrorCode, type PreloadBridge, IPC_CHANNELS } from "#src/shared/types";

// =============================================================================
// Test router
// =============================================================================

function createTestRouter() {
  let counter = 0;

  const router = {
    // Void-input query
    ping: query().handler(() => "pong"),

    // Typed-input query
    greet: query()
      .input(z.object({ name: z.string() }))
      .handler(({ name }) => `Hello, ${name}!`),

    // Async query
    asyncGreet: query()
      .input(z.object({ name: z.string() }))
      .handler(async ({ name }) => {
        return `Async hello, ${name}!`;
      }),

    // Void-input mutation
    reset: mutation().handler(() => {
      counter = 0;
      return counter;
    }),

    // Typed-input mutation
    increment: mutation()
      .input(z.number())
      .handler((delta) => {
        counter += delta;
        return counter;
      }),

    // Mutation that throws
    failMutation: mutation().handler(() => {
      throw new Error("Intentional failure");
    }),

    // Query that throws RpcError
    failQuery: query().handler(() => {
      throw new RpcError(RpcErrorCode.HANDLER_ERROR, "Query failed");
    }),

    // Void-input subscription
    onTick: subscription()
      .output(z.object({ count: z.number() }))
      .handler((_input, ctx) => {
        let i = 0;
        const interval = setInterval(() => {
          ctx.emit({ count: i++ });
        }, 10);
        return () => clearInterval(interval);
      }),

    // Typed-input subscription
    watchValue: subscription()
      .input(z.object({ key: z.string() }))
      .output(z.object({ key: z.string(), value: z.number() }))
      .handler((input, ctx) => {
        const interval = setInterval(() => {
          ctx.emit({ key: input.key, value: Math.random() });
        }, 10);
        return () => clearInterval(interval);
      }),
  };

  return { router, getCounter: () => counter };
}

// =============================================================================
// Helper: Create a bridge-like object from mock IPC renderer
// =============================================================================

function createBridgeFromMock(mock: MockElectron): PreloadBridge {
  return {
    invoke(payload) {
      return mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, payload);
    },
    subscribe(payload) {
      mock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, payload);
    },
    unsubscribe(payload) {
      mock.ipcRenderer.send(IPC_CHANNELS.UNSUBSCRIBE, payload);
    },
    onSubscriptionMessage(callback) {
      const listener = (_event: unknown, message: unknown) => {
        callback(message as Parameters<typeof callback>[0]);
      };
      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, listener);
      return () => {
        mock.ipcRenderer.removeListener(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, listener);
      };
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("Integration: full round-trip", () => {
  let mock: MockElectron;
  let serverCleanup: () => void;

  beforeEach(() => {
    mock = createMockElectron();
  });

  afterEach(() => {
    serverCleanup?.();
    // Clean up global bridge
    delete (globalThis as Record<string, unknown>).__etrpc_test__;
  });

  function setup() {
    const { router, getCounter } = createTestRouter();
    const server = createServer(router, { ipcMain: mock.ipcMain });
    serverCleanup = server.cleanup;

    // Expose bridge on globalThis so createClient can find it
    const bridge = createBridgeFromMock(mock);
    (globalThis as Record<string, unknown>).__etrpc_test__ = bridge;

    const client = createClient<typeof router>({ bridgeKey: "__etrpc_test__" });
    return { server, client, getCounter, router };
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  describe("queries", () => {
    it("void-input query returns correct result", async () => {
      const { client } = setup();
      const result = await client.queries.ping();
      expect(result).toBe("pong");
    });

    it("typed-input query returns correct result", async () => {
      const { client } = setup();
      const result = await client.queries.greet({ name: "World" });
      expect(result).toBe("Hello, World!");
    });

    it("async query handler works", async () => {
      const { client } = setup();
      const result = await client.queries.asyncGreet({ name: "Async" });
      expect(result).toBe("Async hello, Async!");
    });

    it("query with invalid input throws validation error", async () => {
      const { client } = setup();
      try {
        // @ts-expect-error — intentionally passing wrong type for test
        await client.queries.greet({ name: 123 });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.VALIDATION_ERROR);
      }
    });

    it("query that throws returns RpcError to client", async () => {
      const { client } = setup();
      try {
        await client.queries.failQuery();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.HANDLER_ERROR);
        expect((err as RpcError).message).toBe("Query failed");
      }
    });
  });

  // ===========================================================================
  // Mutations
  // ===========================================================================

  describe("mutations", () => {
    it("void-input mutation returns correct result", async () => {
      const { client, getCounter } = setup();
      // First set counter to something
      await client.mutations.increment(5);
      expect(getCounter()).toBe(5);

      const result = await client.mutations.reset();
      expect(result).toBe(0);
      expect(getCounter()).toBe(0);
    });

    it("typed-input mutation returns correct result", async () => {
      const { client, getCounter } = setup();
      const result = await client.mutations.increment(10);
      expect(result).toBe(10);
      expect(getCounter()).toBe(10);

      const result2 = await client.mutations.increment(-3);
      expect(result2).toBe(7);
      expect(getCounter()).toBe(7);
    });

    it("mutation that throws returns RpcError to client", async () => {
      const { client } = setup();
      try {
        await client.mutations.failMutation();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.HANDLER_ERROR);
        expect((err as RpcError).message).toBe("Intentional failure");
      }
    });

    it("mutation with invalid input throws validation error", async () => {
      const { client } = setup();
      try {
        // @ts-expect-error — intentionally passing wrong type for test
        await client.mutations.increment("not a number");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.VALIDATION_ERROR);
      }
    });
  });

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  describe("subscriptions", () => {
    it("void-input subscription receives data", async () => {
      const { client } = setup();

      const received: unknown[] = [];
      const unsub = client.subscriptions.onTick({
        onData: (data) => received.push(data),
        onError: () => {},
      });

      // Wait for some ticks
      await new Promise((r) => setTimeout(r, 50));

      expect(received.length).toBeGreaterThan(0);
      expect(received[0]).toEqual({ count: 0 });
      expect(received[1]).toEqual({ count: 1 });

      unsub();
    });

    it("typed-input subscription receives data with correct input", async () => {
      const { client } = setup();

      const received: unknown[] = [];
      const unsub = client.subscriptions.watchValue(
        { key: "test-key" },
        {
          onData: (data) => received.push(data),
          onError: () => {},
        },
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(received.length).toBeGreaterThan(0);
      const first = received[0] as { key: string; value: number };
      expect(first.key).toBe("test-key");
      expect(typeof first.value).toBe("number");

      unsub();
    });

    it("unsubscribe stops receiving data", async () => {
      const { client } = setup();

      const received: unknown[] = [];
      const unsub = client.subscriptions.onTick({
        onData: (data) => received.push(data),
        onError: () => {},
      });

      await new Promise((r) => setTimeout(r, 35));
      unsub();

      const countAfterUnsub = received.length;
      await new Promise((r) => setTimeout(r, 50));

      // Should not have received more data after unsubscribe
      expect(received.length).toBe(countAfterUnsub);
    });

    it("server emitters broadcast to all subscribers of a path", async () => {
      const { client, server } = setup();

      const received: unknown[] = [];
      const unsub = client.subscriptions.onTick({
        onData: (data) => received.push(data),
        onError: () => {},
      });

      // Wait for subscription to be registered
      await new Promise((r) => setTimeout(r, 15));

      // Broadcast via emitter
      server.emitters.onTick({ count: 999 });

      // Wait for message to arrive
      await new Promise((r) => setTimeout(r, 15));

      expect(received).toContainEqual({ count: 999 });

      unsub();
    });
  });

  // ===========================================================================
  // Multi-window
  // ===========================================================================

  describe("multi-window", () => {
    it("multiple windows can subscribe independently", async () => {
      const { router } = createTestRouter();
      const server = createServer(router, { ipcMain: mock.ipcMain });
      serverCleanup = server.cleanup;

      // Window 1
      const bridge1 = createBridgeFromMock(mock);
      (globalThis as Record<string, unknown>).__etrpc_w1__ = bridge1;
      const client1 = createClient<typeof router>({ bridgeKey: "__etrpc_w1__" });

      // Window 2
      const { webContents: wc2, ipcRenderer: ir2 } = mock.createWebContents();
      const mock2: MockElectron = { ...mock, webContents: wc2, ipcRenderer: ir2 };
      const bridge2 = createBridgeFromMock(mock2);
      (globalThis as Record<string, unknown>).__etrpc_w2__ = bridge2;
      const client2 = createClient<typeof router>({ bridgeKey: "__etrpc_w2__" });

      const received1: unknown[] = [];
      const received2: unknown[] = [];

      const unsub1 = client1.subscriptions.onTick({
        onData: (data) => received1.push(data),
        onError: () => {},
      });

      const unsub2 = client2.subscriptions.onTick({
        onData: (data) => received2.push(data),
        onError: () => {},
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(received1.length).toBeGreaterThan(0);
      expect(received2.length).toBeGreaterThan(0);

      unsub1();
      unsub2();

      delete (globalThis as Record<string, unknown>).__etrpc_w1__;
      delete (globalThis as Record<string, unknown>).__etrpc_w2__;
    });

    it("destroying a webContents cleans up its subscriptions", async () => {
      const { router } = createTestRouter();
      const server = createServer(router, { ipcMain: mock.ipcMain });
      serverCleanup = server.cleanup;

      const bridge = createBridgeFromMock(mock);
      (globalThis as Record<string, unknown>).__etrpc_destroy__ = bridge;
      const client = createClient<typeof router>({ bridgeKey: "__etrpc_destroy__" });

      const received: unknown[] = [];
      client.subscriptions.onTick({
        onData: (data) => received.push(data),
        onError: () => {},
      });

      await new Promise((r) => setTimeout(r, 30));
      const countBefore = received.length;
      expect(countBefore).toBeGreaterThan(0);

      // Destroy the webContents — server should clean up
      mock.webContents.destroy();

      await new Promise((r) => setTimeout(r, 50));

      // No more data should arrive (cleanup function cleared the interval)
      expect(received.length).toBe(countBefore);

      delete (globalThis as Record<string, unknown>).__etrpc_destroy__;
    });
  });

  // ===========================================================================
  // Error propagation
  // ===========================================================================

  describe("error propagation", () => {
    it("calling a non-existent procedure returns NOT_FOUND error", async () => {
      setup();

      const bridge = (globalThis as Record<string, unknown>).__etrpc_test__ as PreloadBridge;

      try {
        await bridge.invoke({ type: "query", path: "nonExistent", input: undefined });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.NOT_FOUND);
      }
    });

    it("calling a query as a mutation returns NOT_FOUND error", async () => {
      setup();

      const bridge = (globalThis as Record<string, unknown>).__etrpc_test__ as PreloadBridge;

      try {
        await bridge.invoke({ type: "mutation", path: "ping", input: undefined });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.NOT_FOUND);
      }
    });
  });

  // ===========================================================================
  // Server cleanup
  // ===========================================================================

  describe("server cleanup", () => {
    it("cleanup() removes all IPC handlers and cleans up subscriptions", async () => {
      const { client, server } = setup();

      // Start a subscription
      const unsub = client.subscriptions.onTick({
        onData: () => {},
        onError: () => {},
      });

      await new Promise((r) => setTimeout(r, 20));

      // Cleanup the server
      serverCleanup();

      // IPC handlers should be removed — invoke should throw
      const bridge = (globalThis as Record<string, unknown>).__etrpc_test__ as PreloadBridge;
      try {
        await bridge.invoke({ type: "query", path: "ping", input: undefined });
        expect.fail("Should have thrown after cleanup");
      } catch {
        // Expected — handler was removed
      }

      unsub();
    });
  });
});
