// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useQuery } from "#src/react/useQuery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ===========================================================================
// onSuccess / onError / onSettled callbacks
// ===========================================================================

describe("useQuery callbacks", () => {
  describe("onSuccess", () => {
    it("is called with data when query succeeds", async () => {
      const onSuccess = vi.fn();
      const fn = vi.fn(() => Promise.resolve("hello"));

      renderHook(() => useQuery(fn, { onSuccess }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith("hello");
      });
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it("is not called when query fails", async () => {
      const onSuccess = vi.fn();
      const fn = vi.fn(() => Promise.reject(new Error("fail")));

      renderHook(() => useQuery(fn, { onSuccess }));

      await waitFor(() => {
        expect(onSuccess).not.toHaveBeenCalled();
      });
    });

    it("is called on each successful refetch", async () => {
      let callCount = 0;
      const onSuccess = vi.fn();
      const fn = vi.fn(() => Promise.resolve(++callCount));

      const { result } = renderHook(() => useQuery(fn, { onSuccess }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith(1);
      });

      await act(async () => {
        await result.current.refetch();
      });

      expect(onSuccess).toHaveBeenCalledTimes(2);
      expect(onSuccess).toHaveBeenLastCalledWith(2);
    });

    it("works with typed input", async () => {
      const onSuccess = vi.fn();
      const fn = vi.fn((input: { id: number }) =>
        Promise.resolve(`user-${input.id}`),
      );

      renderHook(() => useQuery(fn, { id: 1 }, { onSuccess }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith("user-1");
      });
    });
  });

  describe("onError", () => {
    it("is called with error when query fails", async () => {
      const onError = vi.fn();
      const error = new Error("network failure");
      const fn = vi.fn(() => Promise.reject(error));

      renderHook(() => useQuery(fn, { onError }));

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith(error);
      });
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("is not called when query succeeds", async () => {
      const onError = vi.fn();
      const fn = vi.fn(() => Promise.resolve("ok"));

      renderHook(() => useQuery(fn, { onError }));

      await waitFor(() => {
        expect(onError).not.toHaveBeenCalled();
      });
    });

    it("wraps non-Error rejections before passing to callback", async () => {
      const onError = vi.fn();
      const fn = vi.fn(() => Promise.reject("string error"));

      renderHook(() => useQuery(fn, { onError }));

      await waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      });
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(onError.mock.calls[0]![0].message).toBe("string error");
    });
  });

  describe("onSettled", () => {
    it("is called after success with data and no error", async () => {
      const onSettled = vi.fn();
      const fn = vi.fn(() => Promise.resolve("data"));

      renderHook(() => useQuery(fn, { onSettled }));

      await waitFor(() => {
        expect(onSettled).toHaveBeenCalledWith("data", undefined);
      });
    });

    it("is called after error with no data and the error", async () => {
      const onSettled = vi.fn();
      const error = new Error("fail");
      const fn = vi.fn(() => Promise.reject(error));

      renderHook(() => useQuery(fn, { onSettled }));

      await waitFor(() => {
        expect(onSettled).toHaveBeenCalledWith(undefined, error);
      });
    });

    it("is called on every fetch (success and error)", async () => {
      const onSettled = vi.fn();
      let callNum = 0;
      const fn = vi.fn(() => {
        callNum++;
        if (callNum === 1) return Promise.resolve("first");
        return Promise.reject(new Error("second"));
      });

      const { result } = renderHook(() => useQuery(fn, { onSettled }));

      await waitFor(() => {
        expect(onSettled).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        await result.current.refetch();
      });

      expect(onSettled).toHaveBeenCalledTimes(2);
    });
  });
});

// ===========================================================================
// initialData
// ===========================================================================

describe("useQuery initialData", () => {
  it("data is set to initialData before fetch completes", async () => {
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);

    const { result } = renderHook(() =>
      useQuery(fn, { initialData: "placeholder" }),
    );

    // Should have the initial data immediately
    expect(result.current.data).toBe("placeholder");
    // isLoading should still be true since the fetch is in flight
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      d.resolve("real data");
    });

    await waitFor(() => {
      expect(result.current.data).toBe("real data");
    });
    expect(result.current.isLoading).toBe(false);
  });

  it("data is initialData when disabled", async () => {
    const fn = vi.fn(() => Promise.resolve("should not run"));

    const { result } = renderHook(() =>
      useQuery(fn, { initialData: "default", enabled: false }),
    );

    expect(result.current.data).toBe("default");
    expect(fn).not.toHaveBeenCalled();
  });

  it("initialData with typed input", async () => {
    const d = deferred<string>();
    const fn = vi.fn((_input: { id: number }) => d.promise);

    const { result } = renderHook(() =>
      useQuery(fn, { id: 1 }, { initialData: "loading..." }),
    );

    expect(result.current.data).toBe("loading...");

    await act(async () => {
      d.resolve("user-1");
    });

    await waitFor(() => {
      expect(result.current.data).toBe("user-1");
    });
  });
});

// ===========================================================================
// keepPreviousData
// ===========================================================================

describe("useQuery keepPreviousData", () => {
  it("keeps previous data while refetching with new input", async () => {
    const fn = vi.fn((input: { id: number }) =>
      Promise.resolve(`user-${input.id}`),
    );

    const { result, rerender } = renderHook(
      ({ id }) => useQuery(fn, { id }, { keepPreviousData: true }),
      { initialProps: { id: 1 } },
    );

    await waitFor(() => {
      expect(result.current.data).toBe("user-1");
    });

    // Change input -- data should stay while loading
    const d = deferred<string>();
    fn.mockReturnValueOnce(d.promise);

    rerender({ id: 2 });

    // Should keep previous data while loading
    expect(result.current.data).toBe("user-1");
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      d.resolve("user-2");
    });

    await waitFor(() => {
      expect(result.current.data).toBe("user-2");
    });
    expect(result.current.isLoading).toBe(false);
  });

  it("does NOT keep data when keepPreviousData is false (default)", async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    let callNum = 0;
    const fn = vi.fn((_input: { id: number }) => {
      callNum++;
      return callNum === 1 ? d1.promise : d2.promise;
    });

    const { result, rerender } = renderHook(
      ({ id }) => useQuery(fn, { id }),
      { initialProps: { id: 1 } },
    );

    await act(async () => {
      d1.resolve("user-1");
    });

    await waitFor(() => {
      expect(result.current.data).toBe("user-1");
    });

    // Change input without keepPreviousData -- data should be cleared
    rerender({ id: 2 });

    // Data should be undefined while the new fetch is in progress
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      d2.resolve("user-2");
    });

    await waitFor(() => {
      expect(result.current.data).toBe("user-2");
    });
  });

  it("clears previous data on error when keepPreviousData is true", async () => {
    const fn = vi.fn((input: { id: number }) =>
      Promise.resolve(`user-${input.id}`),
    );

    const { result, rerender } = renderHook(
      ({ id }) => useQuery(fn, { id }, { keepPreviousData: true }),
      { initialProps: { id: 1 } },
    );

    await waitFor(() => {
      expect(result.current.data).toBe("user-1");
    });

    // Next call will fail
    fn.mockReturnValueOnce(Promise.reject(new Error("fail")));

    rerender({ id: 2 });

    // Should keep data while loading
    expect(result.current.data).toBe("user-1");

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // After error, error should be set
    expect(result.current.error).toBeInstanceOf(Error);
  });
});

// ===========================================================================
// select (transform)
// ===========================================================================

describe("useQuery select", () => {
  it("transforms data before setting state", async () => {
    const fn = vi.fn(() =>
      Promise.resolve({ users: [{ name: "Alice" }, { name: "Bob" }] }),
    );

    const { result } = renderHook(() =>
      useQuery(fn, {
        select: (data) => data.users.map((u) => u.name),
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual(["Alice", "Bob"]);
    });
  });

  it("transforms data on refetch", async () => {
    let callCount = 0;
    const fn = vi.fn(() => {
      callCount++;
      return Promise.resolve({ value: callCount * 10 });
    });

    const { result } = renderHook(() =>
      useQuery(fn, {
        select: (data) => data.value,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toBe(10);
    });

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.data).toBe(20);
  });

  it("select with typed input", async () => {
    const fn = vi.fn((input: { id: number }) =>
      Promise.resolve({ id: input.id, name: "Alice", age: 30 }),
    );

    const { result } = renderHook(() =>
      useQuery(fn, { id: 1 }, {
        select: (data) => data.name,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toBe("Alice");
    });
  });

  it("select error is caught and set as error", async () => {
    const fn = vi.fn(() => Promise.resolve({ data: "ok" }));

    const { result } = renderHook(() =>
      useQuery(fn, {
        select: () => {
          throw new Error("transform failed");
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("transform failed");
  });
});
