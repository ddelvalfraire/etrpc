/**
 * Tests for the preload bridge.
 *
 * Mocks the `electron` module to verify that createPreloadBridge correctly
 * wires up contextBridge.exposeInMainWorld with the right IPC calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { IPC_CHANNELS } from "#src/shared/types";
import type {
  InvokePayload,
  SubscribePayload,
  UnsubscribePayload,
  PreloadBridge,
} from "#src/shared/types";

// vi.hoisted ensures these are available when the hoisted vi.mock factory runs
const { mockContextBridge, mockIpcRenderer } = vi.hoisted(() => ({
  mockContextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  mockIpcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  contextBridge: mockContextBridge,
  ipcRenderer: mockIpcRenderer,
}));

import { createPreloadBridge } from "#src/preload/bridge";

/**
 * Helper to extract the bridge object passed to exposeInMainWorld.
 */
function getExposedBridge(): PreloadBridge {
  const call = mockContextBridge.exposeInMainWorld.mock.calls[0];
  if (!call) {
    throw new Error("exposeInMainWorld was not called");
  }
  return call[1] as PreloadBridge;
}

describe("createPreloadBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // contextBridge exposure
  // =========================================================================

  describe("contextBridge exposure", () => {
    it("exposes the bridge via contextBridge.exposeInMainWorld with default key '__etrpc'", () => {
      createPreloadBridge();

      expect(mockContextBridge.exposeInMainWorld).toHaveBeenCalledOnce();
      expect(mockContextBridge.exposeInMainWorld).toHaveBeenCalledWith(
        "__etrpc",
        expect.any(Object),
      );
    });

    it("exposes the bridge with a custom key when provided", () => {
      createPreloadBridge("myCustomApi");

      expect(mockContextBridge.exposeInMainWorld).toHaveBeenCalledOnce();
      expect(mockContextBridge.exposeInMainWorld).toHaveBeenCalledWith(
        "myCustomApi",
        expect.any(Object),
      );
    });
  });

  // =========================================================================
  // invoke
  // =========================================================================

  describe("invoke", () => {
    it("calls ipcRenderer.invoke with IPC_CHANNELS.INVOKE and the payload", () => {
      createPreloadBridge();
      const bridge = getExposedBridge();

      const payload: InvokePayload = {
        type: "query",
        path: "users.getById",
        input: { id: 42 },
      };

      bridge.invoke(payload);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledOnce();
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.INVOKE,
        payload,
      );
    });

    it("returns the Promise from ipcRenderer.invoke", async () => {
      const expectedResult = { name: "Alice", id: 42 };
      mockIpcRenderer.invoke.mockResolvedValueOnce(expectedResult);

      createPreloadBridge();
      const bridge = getExposedBridge();

      const payload: InvokePayload = {
        type: "query",
        path: "users.getById",
        input: { id: 42 },
      };

      const result = await bridge.invoke(payload);
      expect(result).toEqual(expectedResult);
    });
  });

  // =========================================================================
  // subscribe
  // =========================================================================

  describe("subscribe", () => {
    it("calls ipcRenderer.send with IPC_CHANNELS.SUBSCRIBE and the payload", () => {
      createPreloadBridge();
      const bridge = getExposedBridge();

      const payload: SubscribePayload = {
        type: "subscribe",
        id: "sub-123",
        path: "events.onTick",
        input: undefined,
      };

      bridge.subscribe(payload);

      expect(mockIpcRenderer.send).toHaveBeenCalledOnce();
      expect(mockIpcRenderer.send).toHaveBeenCalledWith(
        IPC_CHANNELS.SUBSCRIBE,
        payload,
      );
    });
  });

  // =========================================================================
  // unsubscribe
  // =========================================================================

  describe("unsubscribe", () => {
    it("calls ipcRenderer.send with IPC_CHANNELS.UNSUBSCRIBE and the payload", () => {
      createPreloadBridge();
      const bridge = getExposedBridge();

      const payload: UnsubscribePayload = {
        type: "unsubscribe",
        id: "sub-123",
      };

      bridge.unsubscribe(payload);

      expect(mockIpcRenderer.send).toHaveBeenCalledOnce();
      expect(mockIpcRenderer.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UNSUBSCRIBE,
        payload,
      );
    });
  });

  // =========================================================================
  // onSubscriptionMessage
  // =========================================================================

  describe("onSubscriptionMessage", () => {
    it("registers a listener on ipcRenderer.on with IPC_CHANNELS.SUBSCRIPTION_MESSAGE", () => {
      createPreloadBridge();
      const bridge = getExposedBridge();

      const callback = vi.fn();
      bridge.onSubscriptionMessage(callback);

      expect(mockIpcRenderer.on).toHaveBeenCalledOnce();
      expect(mockIpcRenderer.on).toHaveBeenCalledWith(
        IPC_CHANNELS.SUBSCRIPTION_MESSAGE,
        expect.any(Function),
      );
    });

    it("callback receives the message without the raw Electron event", () => {
      createPreloadBridge();
      const bridge = getExposedBridge();

      const callback = vi.fn();
      bridge.onSubscriptionMessage(callback);

      // Extract the internal listener registered on ipcRenderer.on
      const internalListener = mockIpcRenderer.on.mock.calls[0]![1] as (
        event: unknown,
        message: unknown,
      ) => void;

      const fakeElectronEvent = { sender: {} };
      const message = { type: "data" as const, id: "sub-1", data: { count: 1 } };

      // Simulate ipcRenderer emitting the event with the Electron event arg
      internalListener(fakeElectronEvent, message);

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(message);
    });

    it("returns a cleanup function", () => {
      createPreloadBridge();
      const bridge = getExposedBridge();

      const callback = vi.fn();
      const cleanup = bridge.onSubscriptionMessage(callback);

      expect(typeof cleanup).toBe("function");
    });

    it("cleanup function calls ipcRenderer.removeListener with the correct channel and listener", () => {
      createPreloadBridge();
      const bridge = getExposedBridge();

      const callback = vi.fn();
      const cleanup = bridge.onSubscriptionMessage(callback);

      // Get the internal listener that was registered
      const internalListener = mockIpcRenderer.on.mock.calls[0]![1];

      cleanup();

      expect(mockIpcRenderer.removeListener).toHaveBeenCalledOnce();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        IPC_CHANNELS.SUBSCRIPTION_MESSAGE,
        internalListener,
      );
    });

    it("multiple subscription message listeners can coexist", () => {
      createPreloadBridge();
      const bridge = getExposedBridge();

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      bridge.onSubscriptionMessage(callback1);
      bridge.onSubscriptionMessage(callback2);

      expect(mockIpcRenderer.on).toHaveBeenCalledTimes(2);

      // Simulate messages to both listeners
      const listener1 = mockIpcRenderer.on.mock.calls[0]![1] as (
        event: unknown,
        message: unknown,
      ) => void;
      const listener2 = mockIpcRenderer.on.mock.calls[1]![1] as (
        event: unknown,
        message: unknown,
      ) => void;

      const message = { type: "data" as const, id: "sub-1", data: 42 };

      listener1({}, message);
      listener2({}, message);

      expect(callback1).toHaveBeenCalledOnce();
      expect(callback2).toHaveBeenCalledOnce();
    });

    it("cleanup only removes its own listener", () => {
      createPreloadBridge();
      const bridge = getExposedBridge();

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const cleanup1 = bridge.onSubscriptionMessage(callback1);
      bridge.onSubscriptionMessage(callback2);

      const listener1 = mockIpcRenderer.on.mock.calls[0]![1];

      // Clean up only the first listener
      cleanup1();

      expect(mockIpcRenderer.removeListener).toHaveBeenCalledOnce();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        IPC_CHANNELS.SUBSCRIPTION_MESSAGE,
        listener1,
      );
    });
  });
});
