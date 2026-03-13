// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMutation } from "#src/react/useMutation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a deferred promise so tests can control when it resolves/rejects */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Basic functionality
// ---------------------------------------------------------------------------

describe("useMutation", () => {
  describe("basic functionality", () => {
    it("mutate(input) calls fn with the input", async () => {
      const fn = vi.fn().mockResolvedValue(42);
      const { result } = renderHook(() => useMutation(fn));

      await act(async () => {
        await result.current[0](10);
      });

      expect(fn).toHaveBeenCalledWith(10);
    });

    it("data is set after successful mutation", async () => {
      const fn = vi.fn().mockResolvedValue("hello");
      const { result } = renderHook(() => useMutation(fn));

      expect(result.current[1].data).toBeUndefined();

      await act(async () => {
        await result.current[0]("input");
      });

      expect(result.current[1].data).toBe("hello");
    });

    it("isLoading is true during mutation, false after", async () => {
      const deferred = createDeferred<string>();
      const fn = vi.fn().mockReturnValue(deferred.promise);
      const { result } = renderHook(() => useMutation(fn));

      expect(result.current[1].isLoading).toBe(false);

      let mutatePromise: Promise<unknown>;
      act(() => {
        mutatePromise = result.current[0]("input");
      });

      expect(result.current[1].isLoading).toBe(true);

      await act(async () => {
        deferred.resolve("done");
        await mutatePromise;
      });

      expect(result.current[1].isLoading).toBe(false);
    });

    it("error is undefined on success", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      const { result } = renderHook(() => useMutation(fn));

      await act(async () => {
        await result.current[0]("input");
      });

      expect(result.current[1].error).toBeUndefined();
    });

    it("called is false initially, true after first call", async () => {
      const fn = vi.fn().mockResolvedValue(1);
      const { result } = renderHook(() => useMutation(fn));

      expect(result.current[1].called).toBe(false);

      await act(async () => {
        await result.current[0]("x");
      });

      expect(result.current[1].called).toBe(true);
    });

    it("mutate returns the result via Promise", async () => {
      const fn = vi.fn().mockResolvedValue(99);
      const { result } = renderHook(() => useMutation(fn));

      let returnedValue: unknown;
      await act(async () => {
        returnedValue = await result.current[0]("x");
      });

      expect(returnedValue).toBe(99);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("error is set when fn rejects", async () => {
      const err = new Error("mutation failed");
      const fn = vi.fn().mockRejectedValue(err);
      const { result } = renderHook(() => useMutation(fn));

      await act(async () => {
        await result.current[0]("x").catch(() => {});
      });

      expect(result.current[1].error).toBe(err);
    });

    it("data is undefined after error", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("fail"));
      const { result } = renderHook(() => useMutation(fn));

      await act(async () => {
        await result.current[0]("x").catch(() => {});
      });

      expect(result.current[1].data).toBeUndefined();
    });

    it("isLoading is false after error", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("fail"));
      const { result } = renderHook(() => useMutation(fn));

      await act(async () => {
        await result.current[0]("x").catch(() => {});
      });

      expect(result.current[1].isLoading).toBe(false);
    });

    it("called is true even on error", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("fail"));
      const { result } = renderHook(() => useMutation(fn));

      await act(async () => {
        await result.current[0]("x").catch(() => {});
      });

      expect(result.current[1].called).toBe(true);
    });

    it("mutate rejects with the error", async () => {
      const err = new Error("boom");
      const fn = vi.fn().mockRejectedValue(err);
      const { result } = renderHook(() => useMutation(fn));

      await act(async () => {
        await expect(result.current[0]("x")).rejects.toBe(err);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  describe("reset", () => {
    it("reset() clears data, error, isLoading, called to initial values", async () => {
      const fn = vi.fn().mockResolvedValue("result");
      const { result } = renderHook(() => useMutation(fn));

      await act(async () => {
        await result.current[0]("x");
      });

      expect(result.current[1].data).toBe("result");
      expect(result.current[1].called).toBe(true);

      act(() => {
        result.current[1].reset();
      });

      expect(result.current[1].data).toBeUndefined();
      expect(result.current[1].error).toBeUndefined();
      expect(result.current[1].isLoading).toBe(false);
      expect(result.current[1].called).toBe(false);
    });

    it("after reset, can call mutate again fresh", async () => {
      const fn = vi.fn().mockResolvedValue("first");
      const { result } = renderHook(() => useMutation(fn));

      await act(async () => {
        await result.current[0]("a");
      });

      expect(result.current[1].data).toBe("first");

      act(() => {
        result.current[1].reset();
      });

      fn.mockResolvedValue("second");
      await act(async () => {
        await result.current[0]("b");
      });

      expect(result.current[1].data).toBe("second");
      expect(result.current[1].called).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent calls (last-write-wins)
  // -------------------------------------------------------------------------

  describe("concurrent calls (last-write-wins)", () => {
    it("if mutate is called twice quickly, only the result of the second call is used", async () => {
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();

      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? deferred1.promise : deferred2.promise;
      });

      const { result } = renderHook(() => useMutation(fn));

      let promise1: Promise<unknown>;
      let promise2: Promise<unknown>;

      // Fire two calls without waiting
      act(() => {
        promise1 = result.current[0]("first");
      });
      act(() => {
        promise2 = result.current[0]("second");
      });

      // Resolve the second call first
      await act(async () => {
        deferred2.resolve("result-2");
        await promise2;
      });

      expect(result.current[1].data).toBe("result-2");

      // Now resolve the first call (stale) — should be discarded
      await act(async () => {
        deferred1.resolve("result-1");
        await promise1;
      });

      // data should still be result-2, not result-1
      expect(result.current[1].data).toBe("result-2");
    });

    it("slow first call resolved after fast second call is discarded", async () => {
      const deferred1 = createDeferred<number>();
      const deferred2 = createDeferred<number>();

      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? deferred1.promise : deferred2.promise;
      });

      const { result } = renderHook(() => useMutation(fn));

      let promise1: Promise<unknown>;
      let promise2: Promise<unknown>;

      act(() => {
        promise1 = result.current[0](1);
      });
      act(() => {
        promise2 = result.current[0](2);
      });

      // Resolve second first
      await act(async () => {
        deferred2.resolve(200);
        await promise2;
      });

      expect(result.current[1].data).toBe(200);

      // Resolve first after (stale)
      await act(async () => {
        deferred1.resolve(100);
        await promise1;
      });

      // Should still show second call's result
      expect(result.current[1].data).toBe(200);
      expect(result.current[1].isLoading).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Stable reference
  // -------------------------------------------------------------------------

  describe("stable reference", () => {
    it("mutate function reference is the same across renders", () => {
      const fn = vi.fn().mockResolvedValue(1);
      const { result, rerender } = renderHook(() => useMutation(fn));

      const mutateRef1 = result.current[0];
      rerender();
      const mutateRef2 = result.current[0];

      expect(mutateRef1).toBe(mutateRef2);
    });
  });

  // -------------------------------------------------------------------------
  // Void input
  // -------------------------------------------------------------------------

  describe("void input", () => {
    it("mutate() works when fn accepts void", async () => {
      const fn = vi.fn().mockResolvedValue("pong");
      const { result } = renderHook(() =>
        useMutation(fn as () => Promise<string>),
      );

      await act(async () => {
        const value = await (result.current[0] as () => Promise<string>)();
        expect(value).toBe("pong");
      });

      expect(fn).toHaveBeenCalledWith(undefined);
      expect(result.current[1].data).toBe("pong");
    });
  });

  // -------------------------------------------------------------------------
  // Error → Success recovery
  // -------------------------------------------------------------------------

  describe("error recovery", () => {
    it("successful call after error clears the error", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error("first fails"))
        .mockResolvedValueOnce("second succeeds");

      const { result } = renderHook(() => useMutation(fn));

      // First call: error
      await act(async () => {
        await result.current[0]("a").catch(() => {});
      });

      expect(result.current[1].error).toBeInstanceOf(Error);
      expect(result.current[1].data).toBeUndefined();

      // Second call: success
      await act(async () => {
        await result.current[0]("b");
      });

      expect(result.current[1].data).toBe("second succeeds");
      expect(result.current[1].error).toBeUndefined();
    });

    it("concurrent: first errors, second succeeds -- stale error discarded", async () => {
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();

      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? deferred1.promise : deferred2.promise;
      });

      const { result } = renderHook(() => useMutation(fn));

      let promise1: Promise<unknown>;
      let promise2: Promise<unknown>;

      act(() => {
        promise1 = result.current[0]("first");
      });
      act(() => {
        promise2 = result.current[0]("second");
      });

      // Resolve the second call (success)
      await act(async () => {
        deferred2.resolve("success-2");
        await promise2;
      });

      expect(result.current[1].data).toBe("success-2");
      expect(result.current[1].error).toBeUndefined();

      // Reject the first call (stale error) -- should be discarded
      await act(async () => {
        deferred1.reject(new Error("stale error"));
        await promise1.catch(() => {});
      });

      // Data should still be from the second call, error should still be undefined
      expect(result.current[1].data).toBe("success-2");
      expect(result.current[1].error).toBeUndefined();
      expect(result.current[1].isLoading).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Uses latest fn ref
  // -------------------------------------------------------------------------

  describe("fn ref freshness", () => {
    it("mutate uses the latest fn reference even after re-renders", async () => {
      const fn1 = vi.fn().mockResolvedValue("from-fn1");
      const fn2 = vi.fn().mockResolvedValue("from-fn2");

      const { result, rerender } = renderHook(
        ({ fn }) => useMutation(fn),
        { initialProps: { fn: fn1 } },
      );

      // Re-render with a new fn
      rerender({ fn: fn2 });

      // Mutate should use fn2
      await act(async () => {
        await result.current[0]("input");
      });

      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).toHaveBeenCalledWith("input");
      expect(result.current[1].data).toBe("from-fn2");
    });
  });
});
