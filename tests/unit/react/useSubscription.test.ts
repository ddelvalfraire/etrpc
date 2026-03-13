// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSubscription } from "#src/react/useSubscription";
import type { SubscriptionOptions, UnsubscribeFn } from "#src/shared/types";

// ---------------------------------------------------------------------------
// Helper: creates a mock subscription function with controls for emitting
// ---------------------------------------------------------------------------
function createMockSubscription() {
  let onData: ((data: any) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;
  const unsubscribe = vi.fn();

  const fn = vi.fn((inputOrOptions: any, maybeOptions?: any) => {
    const options = maybeOptions || inputOrOptions;
    onData = options.onData;
    onError = options.onError;
    return unsubscribe;
  });

  return {
    fn,
    unsubscribe,
    emitData: (data: any) => onData?.(data),
    emitError: (error: Error) => onError?.(error),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSubscription", () => {
  beforeEach(() => {
    cleanup();
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================
  describe("lifecycle", () => {
    it("subscribes on mount (fn is called once)", () => {
      const { fn } = createMockSubscription();

      renderHook(() => useSubscription(fn));

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes on unmount (unsubscribe fn is called)", () => {
      const { fn, unsubscribe } = createMockSubscription();

      const { unmount } = renderHook(() => useSubscription(fn));

      expect(unsubscribe).not.toHaveBeenCalled();
      unmount();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("re-subscribes when input changes (old unsub called, new sub created)", () => {
      const { fn, unsubscribe } = createMockSubscription();

      const { rerender } = renderHook(
        ({ input }: { input: { path: string } }) =>
          useSubscription(fn, input),
        { initialProps: { input: { path: "/a" } } },
      );

      expect(fn).toHaveBeenCalledTimes(1);

      rerender({ input: { path: "/b" } });

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("does NOT re-subscribe when input is referentially different but serializes the same", () => {
      const { fn, unsubscribe } = createMockSubscription();

      const { rerender } = renderHook(
        ({ input }: { input: { path: string } }) =>
          useSubscription(fn, input),
        { initialProps: { input: { path: "/a" } } },
      );

      expect(fn).toHaveBeenCalledTimes(1);

      // Pass a new object with the same serialized value
      rerender({ input: { path: "/a" } });

      expect(unsubscribe).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Data flow
  // =========================================================================
  describe("data flow", () => {
    it("data is undefined initially", () => {
      const { fn } = createMockSubscription();

      const { result } = renderHook(() => useSubscription(fn));

      expect(result.current.data).toBeUndefined();
    });

    it("data updates when onData is called", () => {
      const mock = createMockSubscription();

      const { result } = renderHook(() => useSubscription(mock.fn));

      act(() => {
        mock.emitData({ count: 1 });
      });

      expect(result.current.data).toEqual({ count: 1 });
    });

    it("data reflects the most recent emission", () => {
      const mock = createMockSubscription();

      const { result } = renderHook(() => useSubscription(mock.fn));

      act(() => {
        mock.emitData({ count: 1 });
      });
      act(() => {
        mock.emitData({ count: 2 });
      });

      expect(result.current.data).toEqual({ count: 2 });
    });

    it("multiple emissions update data each time", () => {
      const mock = createMockSubscription();
      const values: any[] = [];

      const { result } = renderHook(() => useSubscription(mock.fn));

      act(() => {
        mock.emitData("first");
      });
      values.push(result.current.data);

      act(() => {
        mock.emitData("second");
      });
      values.push(result.current.data);

      act(() => {
        mock.emitData("third");
      });
      values.push(result.current.data);

      expect(values).toEqual(["first", "second", "third"]);
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  describe("error handling", () => {
    it("error is undefined initially", () => {
      const { fn } = createMockSubscription();

      const { result } = renderHook(() => useSubscription(fn));

      expect(result.current.error).toBeUndefined();
    });

    it("error is set when onError is called", () => {
      const mock = createMockSubscription();

      const { result } = renderHook(() => useSubscription(mock.fn));

      act(() => {
        mock.emitError(new Error("connection lost"));
      });

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error!.message).toBe("connection lost");
    });

    it("status changes to 'error' on error", () => {
      const mock = createMockSubscription();

      const { result } = renderHook(() => useSubscription(mock.fn));

      act(() => {
        mock.emitError(new Error("fail"));
      });

      expect(result.current.status).toBe("error");
    });
  });

  // =========================================================================
  // Status transitions
  // =========================================================================
  describe("status transitions", () => {
    it("initial status is 'loading' (enabled by default)", () => {
      const { fn } = createMockSubscription();

      const { result } = renderHook(() => useSubscription(fn));

      expect(result.current.status).toBe("loading");
    });

    it("status changes to 'active' on first data", () => {
      const mock = createMockSubscription();

      const { result } = renderHook(() => useSubscription(mock.fn));

      act(() => {
        mock.emitData("hello");
      });

      expect(result.current.status).toBe("active");
    });

    it("status changes to 'error' on error", () => {
      const mock = createMockSubscription();

      const { result } = renderHook(() => useSubscription(mock.fn));

      act(() => {
        mock.emitError(new Error("oops"));
      });

      expect(result.current.status).toBe("error");
    });

    it("status is 'idle' when enabled: false", () => {
      const { fn } = createMockSubscription();

      const { result } = renderHook(() =>
        useSubscription(fn, { enabled: false }),
      );

      expect(result.current.status).toBe("idle");
    });
  });

  // =========================================================================
  // Enabled option
  // =========================================================================
  describe("enabled option", () => {
    it("enabled: false prevents subscription (fn not called)", () => {
      const { fn } = createMockSubscription();

      renderHook(() => useSubscription(fn, { enabled: false }));

      expect(fn).not.toHaveBeenCalled();
    });

    it("status is 'idle' when disabled", () => {
      const { fn } = createMockSubscription();

      const { result } = renderHook(() =>
        useSubscription(fn, { enabled: false }),
      );

      expect(result.current.status).toBe("idle");
      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toBeUndefined();
    });

    it("changing enabled from false to true triggers subscription", () => {
      const { fn } = createMockSubscription();

      const { rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useSubscription(fn, { enabled }),
        { initialProps: { enabled: false } },
      );

      expect(fn).not.toHaveBeenCalled();

      rerender({ enabled: true });

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("changing enabled from true to false calls unsubscribe", () => {
      const { fn, unsubscribe } = createMockSubscription();

      const { rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useSubscription(fn, { enabled }),
        { initialProps: { enabled: true } },
      );

      expect(fn).toHaveBeenCalledTimes(1);
      expect(unsubscribe).not.toHaveBeenCalled();

      rerender({ enabled: false });

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Callbacks
  // =========================================================================
  describe("callbacks", () => {
    it("options.onData is called when data arrives", () => {
      const mock = createMockSubscription();
      const onData = vi.fn();

      renderHook(() => useSubscription(mock.fn, { onData }));

      act(() => {
        mock.emitData("payload");
      });

      expect(onData).toHaveBeenCalledWith("payload");
    });

    it("options.onError is called when error arrives", () => {
      const mock = createMockSubscription();
      const onError = vi.fn();

      renderHook(() => useSubscription(mock.fn, { onError }));

      act(() => {
        mock.emitError(new Error("boom"));
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError.mock.calls[0]![0].message).toBe("boom");
    });
  });

  // =========================================================================
  // Stale callback prevention
  // =========================================================================
  describe("stale callback prevention", () => {
    it("after unmount, emitting data does NOT update state", () => {
      const mock = createMockSubscription();

      const { result, unmount } = renderHook(() =>
        useSubscription(mock.fn),
      );

      unmount();

      // Should not throw or update state
      act(() => {
        mock.emitData("stale");
      });

      // After unmount, we can only check that the last captured result
      // did not change from its pre-unmount value
      expect(result.current.data).toBeUndefined();
      expect(result.current.status).not.toBe("active");
    });

    it("after re-subscribe (input change), old subscription's callbacks are ignored", () => {
      // We need individual mocks per subscription so we can emit on the old one
      let subscriptionIndex = 0;
      const unsubscribes = [vi.fn(), vi.fn()];
      const emitters: { onData: ((d: any) => void) | null }[] = [];

      const fn = vi.fn((input: any, options: any) => {
        const idx = subscriptionIndex++;
        emitters[idx] = { onData: options.onData };
        return unsubscribes[idx]!;
      });

      const { result, rerender } = renderHook(
        ({ input }: { input: { id: number } }) =>
          useSubscription(fn, input),
        { initialProps: { input: { id: 1 } } },
      );

      // Re-subscribe with new input
      rerender({ input: { id: 2 } });

      // Emit on old subscription (index 0) -- should be ignored
      act(() => {
        emitters[0]!.onData("stale-from-old-sub");
      });

      expect(result.current.data).toBeUndefined();

      // Emit on new subscription (index 1) -- should work
      act(() => {
        emitters[1]!.onData("fresh-from-new-sub");
      });

      expect(result.current.data).toBe("fresh-from-new-sub");
    });
  });

  // =========================================================================
  // Void input
  // =========================================================================
  describe("void input", () => {
    it("useSubscription(fn) works without input argument", () => {
      const mock = createMockSubscription();

      const { result } = renderHook(() => useSubscription(mock.fn));

      expect(mock.fn).toHaveBeenCalledTimes(1);
      // Should have been called with options object containing onData/onError
      const callArgs = mock.fn.mock.calls[0]!;
      expect(callArgs[0]).toHaveProperty("onData");
      expect(callArgs[0]).toHaveProperty("onError");

      act(() => {
        mock.emitData("tick");
      });

      expect(result.current.data).toBe("tick");
    });

    it("useSubscription(fn, { enabled: false }) treats 2nd arg as options", () => {
      const { fn } = createMockSubscription();

      const { result } = renderHook(() =>
        useSubscription(fn, { enabled: false }),
      );

      expect(fn).not.toHaveBeenCalled();
      expect(result.current.status).toBe("idle");
    });
  });

  // =========================================================================
  // State reset on re-subscribe
  // =========================================================================
  describe("state reset on re-subscribe", () => {
    it("when input changes, data and error reset to undefined", () => {
      const mock = createMockSubscription();

      const { result, rerender } = renderHook(
        ({ input }: { input: { id: number } }) =>
          useSubscription(mock.fn, input),
        { initialProps: { input: { id: 1 } } },
      );

      // Get some data
      act(() => {
        mock.emitData("value-1");
      });
      expect(result.current.data).toBe("value-1");

      // Change input -- data and error should reset
      rerender({ input: { id: 2 } });

      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toBeUndefined();
    });

    it("status resets to 'loading' when input changes", () => {
      const mock = createMockSubscription();

      const { result, rerender } = renderHook(
        ({ input }: { input: { id: number } }) =>
          useSubscription(mock.fn, input),
        { initialProps: { input: { id: 1 } } },
      );

      // Become active
      act(() => {
        mock.emitData("value");
      });
      expect(result.current.status).toBe("active");

      // Change input -- status should reset to loading
      rerender({ input: { id: 2 } });

      expect(result.current.status).toBe("loading");
    });
  });

  // =========================================================================
  // Error then data recovery
  // =========================================================================
  describe("error then data recovery", () => {
    it("data after error transitions status to 'active'", () => {
      const mock = createMockSubscription();

      const { result } = renderHook(() => useSubscription(mock.fn));

      // Emit error first
      act(() => {
        mock.emitError(new Error("temp failure"));
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBeInstanceOf(Error);

      // Then emit data -- should recover
      act(() => {
        mock.emitData("recovered");
      });

      expect(result.current.status).toBe("active");
      expect(result.current.data).toBe("recovered");
    });
  });

  // =========================================================================
  // Stale emissions after unmount
  // =========================================================================
  describe("stale emissions after unmount", () => {
    it("error emission after unmount does not update state", () => {
      const mock = createMockSubscription();

      const { result, unmount } = renderHook(() =>
        useSubscription(mock.fn),
      );

      unmount();

      // Emit error after unmount -- should not throw or update
      act(() => {
        mock.emitError(new Error("post-unmount"));
      });

      expect(result.current.status).not.toBe("error");
    });
  });

  // =========================================================================
  // State reset when toggling enabled
  // =========================================================================
  describe("state reset when toggling enabled", () => {
    it("disabling clears data, error, and sets status to idle", () => {
      const mock = createMockSubscription();

      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useSubscription(mock.fn, { enabled }),
        { initialProps: { enabled: true } },
      );

      // Get some data
      act(() => {
        mock.emitData("value");
      });
      expect(result.current.data).toBe("value");
      expect(result.current.status).toBe("active");

      // Disable
      rerender({ enabled: false });

      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toBeUndefined();
      expect(result.current.status).toBe("idle");
    });

    it("re-enabling after disable starts fresh", () => {
      const mock = createMockSubscription();

      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useSubscription(mock.fn, { enabled }),
        { initialProps: { enabled: true } },
      );

      act(() => {
        mock.emitData("first");
      });

      // Disable then re-enable
      rerender({ enabled: false });
      rerender({ enabled: true });

      expect(result.current.status).toBe("loading");
      expect(result.current.data).toBeUndefined();

      // New data should work
      act(() => {
        mock.emitData("after re-enable");
      });

      expect(result.current.data).toBe("after re-enable");
      expect(result.current.status).toBe("active");
    });
  });

  // =========================================================================
  // Typed-input with options
  // =========================================================================
  describe("typed-input with options callbacks", () => {
    it("three-arg call: fn(input, options) passes input correctly", () => {
      const mock = createMockSubscription();

      const onData = vi.fn();
      const { result } = renderHook(() =>
        useSubscription(mock.fn, { key: "test" }, { onData }),
      );

      // fn should have been called with input and options
      expect(mock.fn).toHaveBeenCalledTimes(1);
      const callArgs = mock.fn.mock.calls[0]!;
      expect(callArgs[0]).toEqual({ key: "test" });
      expect(callArgs[1]).toHaveProperty("onData");
      expect(callArgs[1]).toHaveProperty("onError");

      // Data should be routed to both state and callback
      act(() => {
        mock.emitData("payload");
      });

      expect(result.current.data).toBe("payload");
      expect(onData).toHaveBeenCalledWith("payload");
    });

    it("onError callback is invoked alongside state update", () => {
      const mock = createMockSubscription();

      const onError = vi.fn();
      const { result } = renderHook(() =>
        useSubscription(mock.fn, { onError }),
      );

      act(() => {
        mock.emitError(new Error("callback error test"));
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error?.message).toBe("callback error test");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0].message).toBe("callback error test");
    });
  });
});
