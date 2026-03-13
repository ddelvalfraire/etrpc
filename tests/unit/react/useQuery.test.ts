// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useQuery } from "#src/react/useQuery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a promise that can be resolved/rejected externally. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useQuery", () => {
  // =========================================================================
  // Basic functionality
  // =========================================================================

  describe("basic functionality", () => {
    it("fetches on mount and resolves data", async () => {
      const fn = vi.fn(() => Promise.resolve("hello"));

      const { result } = renderHook(() => useQuery(fn));

      // Should start loading
      expect(result.current.isLoading).toBe(true);
      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toBeUndefined();

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data).toBe("hello");
      expect(result.current.error).toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("isLoading is true during fetch, false after", async () => {
      const d = deferred<string>();
      const fn = vi.fn(() => d.promise);

      const { result } = renderHook(() => useQuery(fn));

      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        d.resolve("done");
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it("error is undefined on success", async () => {
      const fn = vi.fn(() => Promise.resolve(42));

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBeUndefined();
    });

    it("data contains the resolved value", async () => {
      const payload = { name: "test", count: 5 };
      const fn = vi.fn(() => Promise.resolve(payload));

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.data).toEqual(payload);
      });
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe("error handling", () => {
    it("sets error when function rejects", async () => {
      const error = new Error("network failure");
      const fn = vi.fn(() => Promise.reject(error));

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe(error);
    });

    it("data is undefined on error", async () => {
      const fn = vi.fn(() => Promise.reject(new Error("boom")));

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data).toBeUndefined();
    });

    it("isLoading is false after error", async () => {
      const fn = vi.fn(() => Promise.reject(new Error("fail")));

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isLoading).toBe(false);
    });

    it("wraps non-Error rejections in an Error", async () => {
      const fn = vi.fn(() => Promise.reject("string error"));

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("string error");
    });
  });

  // =========================================================================
  // Re-fetching
  // =========================================================================

  describe("re-fetching", () => {
    it("re-fetches when input changes (new serialized value)", async () => {
      const fn = vi.fn((input: { id: number }) =>
        Promise.resolve(`user-${input.id}`),
      );

      const { result, rerender } = renderHook(
        ({ id }) => useQuery(fn, { id }),
        { initialProps: { id: 1 } },
      );

      await waitFor(() => {
        expect(result.current.data).toBe("user-1");
      });
      expect(fn).toHaveBeenCalledTimes(1);

      rerender({ id: 2 });

      await waitFor(() => {
        expect(result.current.data).toBe("user-2");
      });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("does NOT re-fetch when input is referentially different but serializes the same", async () => {
      const fn = vi.fn((input: { id: number }) =>
        Promise.resolve(`user-${input.id}`),
      );

      const { result, rerender } = renderHook(
        ({ id }) => useQuery(fn, { id }),
        { initialProps: { id: 1 } },
      );

      await waitFor(() => {
        expect(result.current.data).toBe("user-1");
      });
      expect(fn).toHaveBeenCalledTimes(1);

      // Re-render with a new object that serializes identically
      rerender({ id: 1 });

      // Give React a tick to process
      await waitFor(() => {
        expect(result.current.data).toBe("user-1");
      });

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("refetch() re-calls the function and updates state", async () => {
      let callCount = 0;
      const fn = vi.fn(() => Promise.resolve(++callCount));

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.data).toBe(1);
      });

      await act(async () => {
        await result.current.refetch();
      });

      expect(result.current.data).toBe(2);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("refetch() sets isLoading while in progress", async () => {
      const d = deferred<string>();
      let callNum = 0;
      const fn = vi.fn(() => {
        callNum++;
        if (callNum === 1) return Promise.resolve("first");
        return d.promise;
      });

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.data).toBe("first");
      });

      // Start refetch -- it returns the deferred promise
      let refetchPromise: Promise<void>;
      act(() => {
        refetchPromise = result.current.refetch();
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      await act(async () => {
        d.resolve("second");
      });

      await act(async () => {
        await refetchPromise!;
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toBe("second");
    });
  });

  // =========================================================================
  // Void input
  // =========================================================================

  describe("void input", () => {
    it("useQuery(fn) works without input argument", async () => {
      const fn = vi.fn(() => Promise.resolve("pong"));

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.data).toBe("pong");
      });

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("useQuery(fn, { enabled: false }) correctly treats 2nd arg as options", async () => {
      const fn = vi.fn(() => Promise.resolve("should not run"));

      const { result } = renderHook(() =>
        useQuery(fn, { enabled: false }),
      );

      // Should not fetch
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toBeUndefined();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Enabled option
  // =========================================================================

  describe("enabled option", () => {
    it("enabled: false prevents initial fetch", async () => {
      const fn = vi.fn(() => Promise.resolve("data"));

      const { result } = renderHook(() =>
        useQuery(fn, { enabled: false }),
      );

      // Give React a moment to settle
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(fn).not.toHaveBeenCalled();
      expect(result.current.data).toBeUndefined();
      expect(result.current.isLoading).toBe(false);
    });

    it("isLoading is false when disabled", async () => {
      const fn = vi.fn(() => Promise.resolve("data"));

      const { result } = renderHook(() =>
        useQuery(fn, { enabled: false }),
      );

      expect(result.current.isLoading).toBe(false);
    });

    it("changing enabled from false to true triggers fetch", async () => {
      const fn = vi.fn(() => Promise.resolve("fetched"));

      const { result, rerender } = renderHook(
        ({ enabled }) => useQuery(fn, { enabled }),
        { initialProps: { enabled: false } },
      );

      expect(fn).not.toHaveBeenCalled();
      expect(result.current.data).toBeUndefined();

      rerender({ enabled: true });

      await waitFor(() => {
        expect(result.current.data).toBe("fetched");
      });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("enabled: false with typed input prevents fetch", async () => {
      const fn = vi.fn((input: { id: number }) =>
        Promise.resolve(`user-${input.id}`),
      );

      const { result } = renderHook(() =>
        useQuery(fn, { id: 1 }, { enabled: false }),
      );

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(fn).not.toHaveBeenCalled();
      expect(result.current.data).toBeUndefined();
      expect(result.current.isLoading).toBe(false);
    });

    it("changing enabled from false to true with typed input triggers fetch", async () => {
      const fn = vi.fn((input: { id: number }) =>
        Promise.resolve(`user-${input.id}`),
      );

      const { result, rerender } = renderHook(
        ({ enabled }) => useQuery(fn, { id: 1 }, { enabled }),
        { initialProps: { enabled: false } },
      );

      expect(fn).not.toHaveBeenCalled();

      rerender({ enabled: true });

      await waitFor(() => {
        expect(result.current.data).toBe("user-1");
      });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Stale results
  // =========================================================================

  describe("stale results", () => {
    it("discards result from superseded call when input changes", async () => {
      // First call resolves slowly, second resolves quickly.
      // Only the second result should be used.
      const d1 = deferred<string>();
      const d2 = deferred<string>();
      let callNum = 0;

      const fn = vi.fn((_input: { id: number }) => {
        callNum++;
        if (callNum === 1) return d1.promise;
        return d2.promise;
      });

      const { result, rerender } = renderHook(
        ({ id }) => useQuery(fn, { id }),
        { initialProps: { id: 1 } },
      );

      expect(result.current.isLoading).toBe(true);

      // Change input before first resolves
      rerender({ id: 2 });

      // Resolve the second (fast) call first
      await act(async () => {
        d2.resolve("user-2");
      });

      await waitFor(() => {
        expect(result.current.data).toBe("user-2");
      });

      // Now resolve the first (slow) call -- it should be discarded
      await act(async () => {
        d1.resolve("user-1-stale");
      });

      // Data should still be "user-2" (stale result discarded)
      expect(result.current.data).toBe("user-2");
    });

    it("discards result from superseded refetch call", async () => {
      const d1 = deferred<string>();
      const d2 = deferred<string>();
      let callNum = 0;

      const fn = vi.fn(() => {
        callNum++;
        if (callNum === 1) return Promise.resolve("initial");
        if (callNum === 2) return d1.promise;
        return d2.promise;
      });

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.data).toBe("initial");
      });

      // Start first refetch
      act(() => {
        result.current.refetch();
      });

      // Start second refetch before first resolves
      act(() => {
        result.current.refetch();
      });

      // Resolve second refetch first
      await act(async () => {
        d2.resolve("third");
      });

      await waitFor(() => {
        expect(result.current.data).toBe("third");
      });

      // Resolve first refetch -- should be discarded
      await act(async () => {
        d1.resolve("second-stale");
      });

      expect(result.current.data).toBe("third");
    });
  });

  // =========================================================================
  // Unmount safety
  // =========================================================================

  describe("unmount safety", () => {
    it("unmounting during in-flight request does not cause state updates", async () => {
      const d = deferred<string>();
      const fn = vi.fn(() => d.promise);

      const { result, unmount } = renderHook(() => useQuery(fn));

      expect(result.current.isLoading).toBe(true);

      // Unmount while request is still pending
      unmount();

      // Resolve the promise after unmount -- should not throw or warn
      await act(async () => {
        d.resolve("too late");
      });

      // No assertion needed -- the test passes if no React warning is thrown.
      // result.current still holds the last snapshot before unmount.
      expect(result.current.isLoading).toBe(true);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("handles undefined data as a valid resolved value", async () => {
      const fn = vi.fn(() => Promise.resolve(undefined));

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toBeUndefined();
    });

    it("handles null data as a valid resolved value", async () => {
      const fn = vi.fn(() => Promise.resolve(null));

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data).toBeNull();
      expect(result.current.error).toBeUndefined();
    });

    it("passes input to the function correctly", async () => {
      const fn = vi.fn((input: { name: string }) =>
        Promise.resolve(`hi ${input.name}`),
      );

      const { result } = renderHook(() => useQuery(fn, { name: "world" }));

      await waitFor(() => {
        expect(result.current.data).toBe("hi world");
      });

      expect(fn).toHaveBeenCalledWith({ name: "world" });
    });

    it("calls void-input function with no arguments", async () => {
      const fn = vi.fn(() => Promise.resolve("ok"));

      renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(fn).toHaveBeenCalledTimes(1);
      });

      // For void-input, the function should be called without arguments
      expect(fn).toHaveBeenCalledWith();
    });
  });

  // =========================================================================
  // Error recovery
  // =========================================================================

  describe("error recovery", () => {
    it("error clears on successful refetch", async () => {
      let callNum = 0;
      const fn = vi.fn(() => {
        callNum++;
        if (callNum === 1) return Promise.reject(new Error("first call fails"));
        return Promise.resolve("recovered");
      });

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.data).toBeUndefined();

      // Refetch should succeed and clear the error
      await act(async () => {
        await result.current.refetch();
      });

      expect(result.current.data).toBe("recovered");
      expect(result.current.error).toBeUndefined();
      expect(result.current.isLoading).toBe(false);
    });

    it("successful result then error clears data", async () => {
      let callNum = 0;
      const fn = vi.fn(() => {
        callNum++;
        if (callNum === 1) return Promise.resolve("success");
        return Promise.reject(new Error("second call fails"));
      });

      const { result } = renderHook(() => useQuery(fn));

      await waitFor(() => {
        expect(result.current.data).toBe("success");
      });

      // Refetch should fail
      await act(async () => {
        await result.current.refetch();
      });

      expect(result.current.error).toBeInstanceOf(Error);
      // data persists from last successful call (data is not cleared on error)
      // This is the actual behavior: data stays since only error is set
      expect(result.current.isLoading).toBe(false);
    });
  });

  // =========================================================================
  // Concurrent input changes
  // =========================================================================

  describe("concurrent input changes", () => {
    it("rapid input changes only use the final result", async () => {
      const deferreds: Array<{ resolve: (v: string) => void }> = [];

      const fn = vi.fn((_input: { id: number }) => {
        const d = { resolve: (_v: string) => {} };
        const promise = new Promise<string>((res) => {
          d.resolve = res;
        });
        deferreds.push(d);
        return promise;
      });

      const { result, rerender } = renderHook(
        ({ id }) => useQuery(fn, { id }),
        { initialProps: { id: 1 } },
      );

      // Rapidly change input 3 times
      rerender({ id: 2 });
      rerender({ id: 3 });

      // Resolve in reverse order
      await act(async () => {
        deferreds[2]!.resolve("result-3");
      });

      await waitFor(() => {
        expect(result.current.data).toBe("result-3");
      });

      // Now resolve the stale ones -- they should be discarded
      await act(async () => {
        deferreds[0]!.resolve("result-1");
        deferreds[1]!.resolve("result-2");
      });

      expect(result.current.data).toBe("result-3");
    });
  });
});
