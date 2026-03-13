/**
 * Tests for createServer() — the main process IPC server.
 *
 * Uses MockElectron to simulate Electron's IPC without a real process.
 * The server accepts an optional `electronDeps` config for dependency injection,
 * allowing tests to provide mock ipcMain instead of importing from electron.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  type UnsubscribePayload,
  type SubscriptionDataMessage,
  type SubscriptionErrorMessage,
  type ServerResult,
} from "#src/shared/types";

// =============================================================================
// Test router definition
// =============================================================================

function createTestRouter() {
  return {
    greet: query()
      .input(z.object({ name: z.string() }))
      .handler(({ name }) => `Hello, ${name}!`),

    ping: query().handler(() => "pong"),

    asyncQuery: query()
      .input(z.object({ delay: z.number() }))
      .handler(async ({ delay }) => {
        await new Promise((r) => setTimeout(r, delay));
        return "done";
      }),

    increment: mutation()
      .input(z.object({ amount: z.number() }))
      .handler(({ amount }) => amount + 1),

    reset: mutation().handler(() => ({ success: true })),

    throwingQuery: query().handler(() => {
      throw new Error("handler exploded");
    }),

    throwingAsyncQuery: query().handler(async () => {
      throw new Error("async handler exploded");
    }),

    onTick: subscription()
      .output(z.object({ count: z.number() }))
      .handler((_, ctx) => {
        ctx.emit({ count: 0 });
        return () => {
          // cleanup
        };
      }),

    onEvents: subscription()
      .input(z.object({ channel: z.string() }))
      .output(z.object({ event: z.string() }))
      .handler(({ channel }, ctx) => {
        ctx.emit({ event: `subscribed to ${channel}` });
        return () => {};
      }),
  };
}

type TestRouter = ReturnType<typeof createTestRouter>;

// =============================================================================
// Helper to simulate ipcRenderer.invoke from a specific webContents
// =============================================================================

function invokeFrom(mock: MockElectron, payload: InvokePayload) {
  return mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, payload);
}

function subscribeFrom(
  mock: MockElectron,
  webContentsObj: MockElectron["webContents"],
  ipcRendererObj: MockElectron["ipcRenderer"],
  payload: SubscribePayload,
) {
  ipcRendererObj.send(IPC_CHANNELS.SUBSCRIBE, payload);
}

function unsubscribeFrom(
  ipcRendererObj: MockElectron["ipcRenderer"],
  payload: UnsubscribePayload,
) {
  ipcRendererObj.send(IPC_CHANNELS.UNSUBSCRIBE, payload);
}

// =============================================================================
// Tests
// =============================================================================

describe("createServer", () => {
  let mock: MockElectron;
  let server: ServerResult<TestRouter>;

  beforeEach(() => {
    mock = createMockElectron();
    const router = createTestRouter();
    server = createServer(router, { ipcMain: mock.ipcMain });
  });

  afterEach(() => {
    server.cleanup();
  });

  // ===========================================================================
  // Queries
  // ===========================================================================

  describe("queries", () => {
    it("resolves with correct data", async () => {
      const result = await invokeFrom(mock, {
        type: "query",
        path: "greet",
        input: { name: "World" },
      });
      expect(result).toBe("Hello, World!");
    });

    it("works with typed input", async () => {
      const result = await invokeFrom(mock, {
        type: "query",
        path: "greet",
        input: { name: "TypeScript" },
      });
      expect(result).toBe("Hello, TypeScript!");
    });

    it("works with void input", async () => {
      const result = await invokeFrom(mock, {
        type: "query",
        path: "ping",
        input: undefined,
      });
      expect(result).toBe("pong");
    });

    it("handles async handlers", async () => {
      const result = await invokeFrom(mock, {
        type: "query",
        path: "asyncQuery",
        input: { delay: 1 },
      });
      expect(result).toBe("done");
    });
  });

  // ===========================================================================
  // Mutations
  // ===========================================================================

  describe("mutations", () => {
    it("resolves with correct data", async () => {
      const result = await invokeFrom(mock, {
        type: "mutation",
        path: "increment",
        input: { amount: 5 },
      });
      expect(result).toBe(6);
    });

    it("works with void input", async () => {
      const result = await invokeFrom(mock, {
        type: "mutation",
        path: "reset",
        input: undefined,
      });
      expect(result).toEqual({ success: true });
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  describe("error handling", () => {
    it("returns RpcError with VALIDATION_ERROR for invalid input", async () => {
      try {
        await invokeFrom(mock, {
          type: "query",
          path: "greet",
          input: { name: 123 }, // should be string
        });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RpcError);
        const rpcErr = err as RpcError;
        expect(rpcErr.code).toBe(RpcErrorCode.VALIDATION_ERROR);
        expect(rpcErr.data).toBeDefined();
        // Zod issues should be in data
        expect(Array.isArray(rpcErr.data)).toBe(true);
      }
    });

    it("returns RpcError with NOT_FOUND for unknown procedure path", async () => {
      try {
        await invokeFrom(mock, {
          type: "query",
          path: "nonExistent",
          input: undefined,
        });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RpcError);
        const rpcErr = err as RpcError;
        expect(rpcErr.code).toBe(RpcErrorCode.NOT_FOUND);
        expect(rpcErr.message).toContain("nonExistent");
      }
    });

    it("returns RpcError with HANDLER_ERROR when handler throws", async () => {
      try {
        await invokeFrom(mock, {
          type: "query",
          path: "throwingQuery",
          input: undefined,
        });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RpcError);
        const rpcErr = err as RpcError;
        expect(rpcErr.code).toBe(RpcErrorCode.HANDLER_ERROR);
        expect(rpcErr.message).toBe("handler exploded");
      }
    });

    it("returns RpcError with HANDLER_ERROR when async handler throws", async () => {
      try {
        await invokeFrom(mock, {
          type: "query",
          path: "throwingAsyncQuery",
          input: undefined,
        });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RpcError);
        const rpcErr = err as RpcError;
        expect(rpcErr.code).toBe(RpcErrorCode.HANDLER_ERROR);
        expect(rpcErr.message).toBe("async handler exploded");
      }
    });

    it("returns NOT_FOUND when procedure type does not match", async () => {
      // "greet" is a query, not a mutation
      try {
        await invokeFrom(mock, {
          type: "mutation",
          path: "greet",
          input: { name: "World" },
        });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RpcError);
        const rpcErr = err as RpcError;
        expect(rpcErr.code).toBe(RpcErrorCode.NOT_FOUND);
      }
    });
  });

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  describe("subscriptions", () => {
    it("receives data via emit()", async () => {
      const received: unknown[] = [];
      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionDataMessage) => {
        if (msg.type === "data") {
          received.push(msg.data);
        }
      });

      subscribeFrom(mock, mock.webContents, mock.ipcRenderer, {
        type: "subscribe",
        id: "sub-1",
        path: "onTick",
        input: undefined,
      });

      // The handler emits { count: 0 } immediately
      // Give it a tick to process
      await new Promise((r) => setTimeout(r, 10));

      expect(received).toContainEqual({ count: 0 });
    });

    it("receives errors via emitError()", async () => {
      const errors: unknown[] = [];

      // Create a subscription that emits an error
      const errorRouter = {
        onError: subscription()
          .output(z.object({ msg: z.string() }))
          .handler((_, ctx) => {
            ctx.emitError(new Error("subscription failed"));
            return () => {};
          }),
      };

      const errorMock = createMockElectron();
      const errorServer = createServer(errorRouter, { ipcMain: errorMock.ipcMain });

      errorMock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionErrorMessage) => {
        if (msg.type === "error") {
          errors.push(msg.error);
        }
      });

      errorMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-err-1",
        path: "onError",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toMatchObject({
        code: RpcErrorCode.HANDLER_ERROR,
        message: "subscription failed",
      });

      errorServer.cleanup();
    });

    it("cleanup function is called on unsubscribe", async () => {
      let cleaned = false;

      const cleanupRouter = {
        onCleanup: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            return () => {
              cleaned = true;
            };
          }),
      };

      const cleanupMock = createMockElectron();
      const cleanupServer = createServer(cleanupRouter, { ipcMain: cleanupMock.ipcMain });

      cleanupMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-cleanup-1",
        path: "onCleanup",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(cleaned).toBe(false);

      unsubscribeFrom(cleanupMock.ipcRenderer, {
        type: "unsubscribe",
        id: "sub-cleanup-1",
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(cleaned).toBe(true);

      cleanupServer.cleanup();
    });

    it("validates subscription input", async () => {
      // onEvents requires { channel: string }
      // Sending invalid input should not crash, but the subscription should not be created
      const errors: unknown[] = [];

      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionErrorMessage) => {
        if (msg.type === "error") {
          errors.push(msg.error);
        }
      });

      subscribeFrom(mock, mock.webContents, mock.ipcRenderer, {
        type: "subscribe",
        id: "sub-invalid",
        path: "onEvents",
        input: { channel: 123 }, // should be string
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toMatchObject({
        code: RpcErrorCode.VALIDATION_ERROR,
      });
    });
  });

  // ===========================================================================
  // External emitters
  // ===========================================================================

  describe("external emitters", () => {
    it("push data to all matching subscribers", async () => {
      const received: unknown[] = [];

      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionDataMessage) => {
        if (msg.type === "data") {
          received.push(msg.data);
        }
      });

      // Start a subscription
      subscribeFrom(mock, mock.webContents, mock.ipcRenderer, {
        type: "subscribe",
        id: "sub-emit-1",
        path: "onTick",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));
      received.length = 0; // clear initial emit from handler

      // Use external emitter
      server.emitters.onTick({ count: 42 });

      await new Promise((r) => setTimeout(r, 10));

      expect(received).toContainEqual({ count: 42 });
    });

    it("with targetWebContentsIds only send to matching windows", async () => {
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      // Create a second window
      const { webContents: wc2, ipcRenderer: renderer2 } = mock.createWebContents();

      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionDataMessage) => {
        if (msg.type === "data" && msg.id === "sub-target-1") {
          received1.push(msg.data);
        }
      });

      renderer2.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionDataMessage) => {
        if (msg.type === "data" && msg.id === "sub-target-2") {
          received2.push(msg.data);
        }
      });

      // Subscribe from window 1
      subscribeFrom(mock, mock.webContents, mock.ipcRenderer, {
        type: "subscribe",
        id: "sub-target-1",
        path: "onTick",
        input: undefined,
      });

      // Subscribe from window 2
      renderer2.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-target-2",
        path: "onTick",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));
      received1.length = 0;
      received2.length = 0;

      // Emit only to window 2
      server.emitters.onTick({ count: 99 }, [wc2.id]);

      await new Promise((r) => setTimeout(r, 10));

      expect(received1).toHaveLength(0);
      expect(received2).toContainEqual({ count: 99 });
    });

    it("multiple subscribers to the same path all receive data", async () => {
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      // Create a second window
      const { ipcRenderer: renderer2 } = mock.createWebContents();

      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionDataMessage) => {
        if (msg.type === "data" && msg.id === "sub-multi-1") {
          received1.push(msg.data);
        }
      });

      renderer2.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionDataMessage) => {
        if (msg.type === "data" && msg.id === "sub-multi-2") {
          received2.push(msg.data);
        }
      });

      subscribeFrom(mock, mock.webContents, mock.ipcRenderer, {
        type: "subscribe",
        id: "sub-multi-1",
        path: "onTick",
        input: undefined,
      });

      renderer2.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-multi-2",
        path: "onTick",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));
      received1.length = 0;
      received2.length = 0;

      server.emitters.onTick({ count: 7 });

      await new Promise((r) => setTimeout(r, 10));

      expect(received1).toContainEqual({ count: 7 });
      expect(received2).toContainEqual({ count: 7 });
    });
  });

  // ===========================================================================
  // WebContents lifecycle cleanup
  // ===========================================================================

  describe("webContents lifecycle", () => {
    it("destruction cleans up all subscriptions for that sender", async () => {
      let cleaned = false;

      const lifecycleRouter = {
        onLife: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            return () => {
              cleaned = true;
            };
          }),
      };

      const lifecycleMock = createMockElectron();
      const lifecycleServer = createServer(lifecycleRouter, { ipcMain: lifecycleMock.ipcMain });

      lifecycleMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-life-1",
        path: "onLife",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(cleaned).toBe(false);

      // Destroy the webContents
      lifecycleMock.webContents.destroy();

      await new Promise((r) => setTimeout(r, 10));
      expect(cleaned).toBe(true);

      lifecycleServer.cleanup();
    });

    it("renderer crash (render-process-gone) cleans up subscriptions", async () => {
      let cleaned = false;

      const crashRouter = {
        onCrash: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            return () => {
              cleaned = true;
            };
          }),
      };

      const crashMock = createMockElectron();
      const crashServer = createServer(crashRouter, { ipcMain: crashMock.ipcMain });

      crashMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-crash-1",
        path: "onCrash",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(cleaned).toBe(false);

      // Simulate crash
      crashMock.webContents.simulateCrash();

      await new Promise((r) => setTimeout(r, 10));
      expect(cleaned).toBe(true);

      crashServer.cleanup();
    });
  });

  // ===========================================================================
  // cleanup()
  // ===========================================================================

  describe("cleanup()", () => {
    it("tears down everything: clears subscriptions, removes IPC handlers", async () => {
      let cleaned = false;

      const teardownRouter = {
        onTeardown: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            return () => {
              cleaned = true;
            };
          }),
      };

      const teardownMock = createMockElectron();
      const teardownServer = createServer(teardownRouter, { ipcMain: teardownMock.ipcMain });

      teardownMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-teardown-1",
        path: "onTeardown",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      teardownServer.cleanup();

      expect(cleaned).toBe(true);
      // IPC handlers should be removed
      expect(teardownMock.ipcMain.hasHandler(IPC_CHANNELS.INVOKE)).toBe(false);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe("edge cases", () => {
    it("emit after unsubscribe does not send (no crash)", async () => {
      const received: unknown[] = [];

      const edgeRouter = {
        onEdge: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            // Don't emit in handler, we'll use external emitter
            return () => {};
          }),
      };

      const edgeMock = createMockElectron();
      const edgeServer = createServer(edgeRouter, { ipcMain: edgeMock.ipcMain });

      edgeMock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionDataMessage) => {
        if (msg.type === "data") {
          received.push(msg.data);
        }
      });

      edgeMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-edge-1",
        path: "onEdge",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      // Unsubscribe
      unsubscribeFrom(edgeMock.ipcRenderer, {
        type: "unsubscribe",
        id: "sub-edge-1",
      });

      await new Promise((r) => setTimeout(r, 10));

      // Now try to emit - should not crash
      expect(() => edgeServer.emitters.onEdge({ v: 1 })).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(0);

      edgeServer.cleanup();
    });

    it("emit to destroyed webContents does not crash", async () => {
      const edgeRouter = {
        onEdge: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            return () => {};
          }),
      };

      const edgeMock = createMockElectron();
      const edgeServer = createServer(edgeRouter, { ipcMain: edgeMock.ipcMain });

      edgeMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-edge-2",
        path: "onEdge",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      // Destroy webContents
      edgeMock.webContents.destroy();
      await new Promise((r) => setTimeout(r, 10));

      // External emit should not crash (subscription already cleaned up)
      expect(() => edgeServer.emitters.onEdge({ v: 99 })).not.toThrow();

      edgeServer.cleanup();
    });

    it("emit inside subscription handler checks isDestroyed before sending", async () => {
      // Create a subscription where the handler emits immediately
      // but the webContents is already destroyed by the time emit is called
      // This verifies the guard in the emit closure

      const lateRouter = {
        onLate: subscription()
          .output(z.object({ v: z.number() }))
          .handler(async (_, ctx) => {
            // Delay emit to allow time for destruction
            await new Promise((r) => setTimeout(r, 50));
            // This should not crash even if webContents is destroyed
            ctx.emit({ v: 1 });
            return () => {};
          }),
      };

      const lateMock = createMockElectron();
      const lateServer = createServer(lateRouter, { ipcMain: lateMock.ipcMain });

      lateMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-late-1",
        path: "onLate",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      // Destroy before the delayed emit happens
      lateMock.webContents.destroy();

      // Wait for the delayed emit to fire (should not crash)
      await new Promise((r) => setTimeout(r, 100));

      lateServer.cleanup();
    });

    it("unknown subscription path sends error to subscriber", async () => {
      const errors: unknown[] = [];

      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionErrorMessage) => {
        if (msg.type === "error") {
          errors.push(msg.error);
        }
      });

      subscribeFrom(mock, mock.webContents, mock.ipcRenderer, {
        type: "subscribe",
        id: "sub-unknown",
        path: "nonExistent",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toMatchObject({
        code: RpcErrorCode.NOT_FOUND,
      });
    });

    it("double unsubscribe does not crash", async () => {
      const cleanupRouter = {
        onDouble: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            return () => {};
          }),
      };

      const doubleMock = createMockElectron();
      const doubleServer = createServer(cleanupRouter, { ipcMain: doubleMock.ipcMain });

      doubleMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-double-1",
        path: "onDouble",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      // First unsubscribe
      unsubscribeFrom(doubleMock.ipcRenderer, {
        type: "unsubscribe",
        id: "sub-double-1",
      });

      // Second unsubscribe -- should not crash
      expect(() => {
        unsubscribeFrom(doubleMock.ipcRenderer, {
          type: "unsubscribe",
          id: "sub-double-1",
        });
      }).not.toThrow();

      doubleServer.cleanup();
    });

    it("subscription cleanup function that throws does not crash server", async () => {
      let cleanupCalled = false;

      const throwingCleanupRouter = {
        onThrowingCleanup: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            return () => {
              cleanupCalled = true;
              throw new Error("cleanup explosion");
            };
          }),
      };

      const throwMock = createMockElectron();
      const throwServer = createServer(throwingCleanupRouter, { ipcMain: throwMock.ipcMain });

      throwMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-throw-cleanup-1",
        path: "onThrowingCleanup",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      // Unsubscribe should not throw even though cleanup does
      expect(() => {
        unsubscribeFrom(throwMock.ipcRenderer, {
          type: "unsubscribe",
          id: "sub-throw-cleanup-1",
        });
      }).not.toThrow();

      expect(cleanupCalled).toBe(true);

      throwServer.cleanup();
    });

    it("async subscription handler that throws sends error to subscriber", async () => {
      const errors: unknown[] = [];

      const asyncErrorRouter = {
        onAsyncError: subscription()
          .output(z.object({ v: z.number() }))
          .handler(async (_, _ctx) => {
            throw new Error("async handler boom");
          }),
      };

      const asyncErrMock = createMockElectron();
      const asyncErrServer = createServer(asyncErrorRouter, { ipcMain: asyncErrMock.ipcMain });

      asyncErrMock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionErrorMessage) => {
        if (msg.type === "error") {
          errors.push(msg.error);
        }
      });

      asyncErrMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-async-err-1",
        path: "onAsyncError",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toMatchObject({
        code: RpcErrorCode.HANDLER_ERROR,
        message: "async handler boom",
      });

      asyncErrServer.cleanup();
    });

    it("handler that throws a non-Error value wraps it in HANDLER_ERROR", async () => {
      const nonErrorRouter = {
        throwsString: query().handler(() => {
          throw "string error value";
        }),
      };

      const nonErrMock = createMockElectron();
      const nonErrServer = createServer(nonErrorRouter, { ipcMain: nonErrMock.ipcMain });

      try {
        await nonErrMock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, {
          type: "query",
          path: "throwsString",
          input: undefined,
        });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RpcError);
        const rpcErr = err as RpcError;
        expect(rpcErr.code).toBe(RpcErrorCode.HANDLER_ERROR);
        expect(rpcErr.message).toBe("string error value");
      }

      nonErrServer.cleanup();
    });

    it("handler that re-throws an existing RpcError preserves it", async () => {
      const rpcErrRouter = {
        throwsRpc: query().handler(() => {
          throw new RpcError(RpcErrorCode.TIMEOUT, "custom timeout");
        }),
      };

      const rpcErrMock = createMockElectron();
      const rpcErrServer = createServer(rpcErrRouter, { ipcMain: rpcErrMock.ipcMain });

      try {
        await rpcErrMock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, {
          type: "query",
          path: "throwsRpc",
          input: undefined,
        });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RpcError);
        const rpcErr = err as RpcError;
        expect(rpcErr.code).toBe(RpcErrorCode.TIMEOUT);
        expect(rpcErr.message).toBe("custom timeout");
      }

      rpcErrServer.cleanup();
    });

    it("sender context id is correctly passed to query handler", async () => {
      let receivedSenderId: number | undefined;

      const ctxRouter = {
        whoAmI: query().handler((_input, ctx) => {
          receivedSenderId = ctx.sender.id;
          return ctx.sender.id;
        }),
      };

      const ctxMock = createMockElectron(42);
      const ctxServer = createServer(ctxRouter, { ipcMain: ctxMock.ipcMain });

      const result = await ctxMock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, {
        type: "query",
        path: "whoAmI",
        input: undefined,
      });

      expect(receivedSenderId).toBe(42);
      expect(result).toBe(42);

      ctxServer.cleanup();
    });

    it("sender context id is correctly passed to mutation handler", async () => {
      let receivedSenderId: number | undefined;

      const ctxRouter = {
        doThing: mutation().handler((_input, ctx) => {
          receivedSenderId = ctx.sender.id;
          return ctx.sender.id;
        }),
      };

      const ctxMock = createMockElectron(77);
      const ctxServer = createServer(ctxRouter, { ipcMain: ctxMock.ipcMain });

      const result = await ctxMock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, {
        type: "mutation",
        path: "doThing",
        input: undefined,
      });

      expect(receivedSenderId).toBe(77);
      expect(result).toBe(77);

      ctxServer.cleanup();
    });

    it("empty router does not crash and handles unknown procedures", async () => {
      const emptyRouter = {};
      const emptyMock = createMockElectron();
      const emptyServer = createServer(emptyRouter, { ipcMain: emptyMock.ipcMain });

      try {
        await emptyMock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, {
          type: "query",
          path: "anything",
          input: undefined,
        });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(RpcErrorCode.NOT_FOUND);
      }

      // cleanup should not crash on empty router
      expect(() => emptyServer.cleanup()).not.toThrow();
    });

    it("subscribing to a query path sends NOT_FOUND error to subscriber", async () => {
      const errors: unknown[] = [];

      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionErrorMessage) => {
        if (msg.type === "error") {
          errors.push(msg.error);
        }
      });

      subscribeFrom(mock, mock.webContents, mock.ipcRenderer, {
        type: "subscribe",
        id: "sub-type-mismatch",
        path: "greet",
        input: { name: "test" },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toMatchObject({
        code: RpcErrorCode.NOT_FOUND,
      });
    });

    it("multiple subscriptions from the same webContents all cleaned up on destroy", async () => {
      let cleaned1 = false;
      let cleaned2 = false;

      const multiSubRouter = {
        sub1: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            return () => { cleaned1 = true; };
          }),
        sub2: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            return () => { cleaned2 = true; };
          }),
      };

      const multiMock = createMockElectron();
      const multiServer = createServer(multiSubRouter, { ipcMain: multiMock.ipcMain });

      multiMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-multi-a",
        path: "sub1",
        input: undefined,
      });

      multiMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-multi-b",
        path: "sub2",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(cleaned1).toBe(false);
      expect(cleaned2).toBe(false);

      multiMock.webContents.destroy();

      await new Promise((r) => setTimeout(r, 10));

      expect(cleaned1).toBe(true);
      expect(cleaned2).toBe(true);

      multiServer.cleanup();
    });

    it("emitter skips destroyed webContents without crashing", async () => {
      const emitterRouter = {
        onBroadcast: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            return () => {};
          }),
      };

      const emitterMock = createMockElectron();
      const emitterServer = createServer(emitterRouter, { ipcMain: emitterMock.ipcMain });

      // Two windows
      const { ipcRenderer: renderer2, webContents: wc2 } = emitterMock.createWebContents();

      const received1: unknown[] = [];
      const received2: unknown[] = [];

      emitterMock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionDataMessage) => {
        if (msg.type === "data" && msg.id === "sub-bcast-1") {
          received1.push(msg.data);
        }
      });

      renderer2.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionDataMessage) => {
        if (msg.type === "data" && msg.id === "sub-bcast-2") {
          received2.push(msg.data);
        }
      });

      emitterMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-bcast-1",
        path: "onBroadcast",
        input: undefined,
      });

      renderer2.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-bcast-2",
        path: "onBroadcast",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      // Destroy window 2
      wc2.destroy();
      await new Promise((r) => setTimeout(r, 10));

      // Emit to all -- should not crash, window 1 still receives
      expect(() => emitterServer.emitters.onBroadcast({ v: 42 })).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));

      expect(received1).toContainEqual({ v: 42 });

      emitterServer.cleanup();
    });

    it("rapid subscribe/unsubscribe does not leak subscriptions", async () => {
      let activeCount = 0;
      let cleanupCount = 0;

      const rapidRouter = {
        onRapid: subscription()
          .output(z.object({ v: z.number() }))
          .handler((_, _ctx) => {
            activeCount++;
            return () => {
              activeCount--;
              cleanupCount++;
            };
          }),
      };

      const rapidMock = createMockElectron();
      const rapidServer = createServer(rapidRouter, { ipcMain: rapidMock.ipcMain });

      // Rapidly subscribe and unsubscribe 10 times
      for (let i = 0; i < 10; i++) {
        rapidMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
          type: "subscribe",
          id: `sub-rapid-${i}`,
          path: "onRapid",
          input: undefined,
        });
      }

      await new Promise((r) => setTimeout(r, 10));

      // All 10 should be active
      expect(activeCount).toBe(10);

      // Unsubscribe all
      for (let i = 0; i < 10; i++) {
        unsubscribeFrom(rapidMock.ipcRenderer, {
          type: "unsubscribe",
          id: `sub-rapid-${i}`,
        });
      }

      await new Promise((r) => setTimeout(r, 10));

      expect(activeCount).toBe(0);
      expect(cleanupCount).toBe(10);

      rapidServer.cleanup();
    });

    it("emitError on destroyed sender does not crash", async () => {
      const emitErrRouter = {
        onEmitErr: subscription()
          .output(z.object({ v: z.number() }))
          .handler(async (_, ctx) => {
            await new Promise((r) => setTimeout(r, 50));
            ctx.emitError(new Error("late error"));
            return () => {};
          }),
      };

      const emitErrMock = createMockElectron();
      const emitErrServer = createServer(emitErrRouter, { ipcMain: emitErrMock.ipcMain });

      emitErrMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-emit-err-1",
        path: "onEmitErr",
        input: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      // Destroy before emitError fires
      emitErrMock.webContents.destroy();

      // Wait for the delayed emitError to fire
      await new Promise((r) => setTimeout(r, 100));

      // Test passes if no crash occurred
      emitErrServer.cleanup();
    });

    it("subscribe error to destroyed sender does not crash", async () => {
      // Destroy the webContents immediately after subscribing to a non-existent path
      const destroyMock = createMockElectron();
      const destroyRouter = {};
      const destroyServer = createServer(destroyRouter, { ipcMain: destroyMock.ipcMain });

      destroyMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "sub-destroy-err",
        path: "nonExistent",
        input: undefined,
      });

      // Destroy immediately -- the error send should check isDestroyed
      destroyMock.webContents.destroy();

      await new Promise((r) => setTimeout(r, 10));

      // Test passes if no crash occurred
      destroyServer.cleanup();
    });
  });

  // ===========================================================================
  // Subscribe race condition: unsubscribe during pending async handler
  // ===========================================================================

  describe("subscribe race condition", () => {
    it("unsubscribe during pending handler runs cleanup when handler resolves", async () => {
      const raceMock = createMockElectron();
      const cleanupCalled = { value: false };
      let resolveHandler: (() => void) | undefined;

      const router = {
        slowSub: subscription()
          .output(z.object({ n: z.number() }))
          .handler((_, ctx) => {
            // Return a promise that doesn't resolve until we say so
            return new Promise<() => void>((resolve) => {
              resolveHandler = () => resolve(() => { cleanupCalled.value = true; });
            });
          }),
      };

      const raceServer = createServer(router, { ipcMain: raceMock.ipcMain });

      // Start subscribing (handler is now pending)
      raceMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "race-sub-1",
        path: "slowSub",
        input: undefined,
      } satisfies SubscribePayload);

      // Give the handler a tick to start
      await new Promise((r) => setTimeout(r, 5));

      // Unsubscribe while handler is still pending
      raceMock.ipcRenderer.send(IPC_CHANNELS.UNSUBSCRIBE, {
        type: "unsubscribe",
        id: "race-sub-1",
      } satisfies UnsubscribePayload);

      // Now resolve the handler
      expect(resolveHandler).toBeDefined();
      resolveHandler!();

      // Let the .then() callback run
      await new Promise((r) => setTimeout(r, 10));

      // Cleanup should have been called even though unsubscribe came before resolve
      expect(cleanupCalled.value).toBe(true);

      raceServer.cleanup();
    });

    it("unsubscribe during pending handler prevents subscription from being registered", async () => {
      const raceMock = createMockElectron();
      const data: unknown[] = [];
      let resolveHandler: (() => void) | undefined;

      const router = {
        slowSub: subscription()
          .output(z.object({ n: z.number() }))
          .handler((_, ctx) => {
            return new Promise<() => void>((resolve) => {
              resolveHandler = () => resolve(() => {});
            });
          }),
      };

      const raceServer = createServer(router, { ipcMain: raceMock.ipcMain });

      raceMock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: unknown) => {
        const message = msg as { type: string; data?: unknown };
        if (message.type === "data") data.push(message.data);
      });

      raceMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "race-sub-2",
        path: "slowSub",
        input: undefined,
      } satisfies SubscribePayload);

      await new Promise((r) => setTimeout(r, 5));

      // Unsubscribe while pending
      raceMock.ipcRenderer.send(IPC_CHANNELS.UNSUBSCRIBE, {
        type: "unsubscribe",
        id: "race-sub-2",
      } satisfies UnsubscribePayload);

      // Resolve the handler
      resolveHandler!();
      await new Promise((r) => setTimeout(r, 10));

      // Emitting via server emitters should NOT reach this subscription
      // because it was cancelled before being registered
      raceServer.emitters.slowSub({ n: 999 });

      await new Promise((r) => setTimeout(r, 10));
      expect(data).toEqual([]);

      raceServer.cleanup();
    });
  });

  // ===========================================================================
  // Error forwarding: non-RpcError exceptions in SUBSCRIBE catch blocks
  // ===========================================================================

  describe("subscribe error forwarding", () => {
    it("non-RpcError thrown during subscription handler setup is forwarded to renderer", async () => {
      const errMock = createMockElectron();
      const errors: unknown[] = [];

      const router = {
        badSub: subscription()
          .output(z.string())
          .handler(() => {
            throw new TypeError("unexpected type error");
          }),
      };

      const errServer = createServer(router, { ipcMain: errMock.ipcMain });

      errMock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: unknown) => {
        const message = msg as { type: string; error?: unknown };
        if (message.type === "error") errors.push(message.error);
      });

      errMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "err-sub-1",
        path: "badSub",
        input: undefined,
      } satisfies SubscribePayload);

      await new Promise((r) => setTimeout(r, 20));

      expect(errors.length).toBe(1);
      expect(errors[0]).toMatchObject({
        code: RpcErrorCode.HANDLER_ERROR,
        message: "unexpected type error",
      });

      errServer.cleanup();
    });

    it("non-RpcError from middleware during subscribe is forwarded to renderer", async () => {
      const errMock = createMockElectron();
      const errors: unknown[] = [];

      const router = {
        sub: subscription()
          .output(z.string())
          .handler(() => {}),
      };

      const errServer = createServer(router, {
        ipcMain: errMock.ipcMain,
        middleware: [async () => { throw new Error("middleware crashed"); }],
      });

      errMock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: unknown) => {
        const message = msg as { type: string; error?: unknown };
        if (message.type === "error") errors.push(message.error);
      });

      errMock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, {
        type: "subscribe",
        id: "err-sub-2",
        path: "sub",
        input: undefined,
      } satisfies SubscribePayload);

      await new Promise((r) => setTimeout(r, 20));

      expect(errors.length).toBe(1);
      expect(errors[0]).toMatchObject({
        code: RpcErrorCode.HANDLER_ERROR,
        message: "middleware crashed",
      });

      errServer.cleanup();
    });
  });
});
