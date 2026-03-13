// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMutation } from "#src/react/useMutation";

// ===========================================================================
// onSuccess / onError / onSettled callbacks
// ===========================================================================

describe("useMutation callbacks", () => {
  describe("onSuccess", () => {
    it("is called with data and input after successful mutation", async () => {
      const onSuccess = vi.fn();
      const fn = vi.fn((input: number) => Promise.resolve(input * 2));

      const { result } = renderHook(() => useMutation(fn, { onSuccess }));

      await act(async () => {
        await result.current[0](5);
      });

      expect(onSuccess).toHaveBeenCalledWith(10, 5);
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it("is not called when mutation fails", async () => {
      const onSuccess = vi.fn();
      const fn = vi.fn(() => Promise.reject(new Error("fail")));

      const { result } = renderHook(() => useMutation(fn, { onSuccess }));

      await act(async () => {
        await result.current[0]("x").catch(() => {});
      });

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("is called on every successful mutation", async () => {
      const onSuccess = vi.fn();
      const fn = vi.fn((x: string) => Promise.resolve(`result-${x}`));

      const { result } = renderHook(() => useMutation(fn, { onSuccess }));

      await act(async () => {
        await result.current[0]("a");
      });
      await act(async () => {
        await result.current[0]("b");
      });

      expect(onSuccess).toHaveBeenCalledTimes(2);
      expect(onSuccess).toHaveBeenNthCalledWith(1, "result-a", "a");
      expect(onSuccess).toHaveBeenNthCalledWith(2, "result-b", "b");
    });
  });

  describe("onError", () => {
    it("is called with error and input when mutation fails", async () => {
      const onError = vi.fn();
      const error = new Error("mutation failed");
      const fn = vi.fn(() => Promise.reject(error));

      const { result } = renderHook(() => useMutation(fn, { onError }));

      await act(async () => {
        await result.current[0]("input").catch(() => {});
      });

      expect(onError).toHaveBeenCalledWith(error, "input");
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("is not called when mutation succeeds", async () => {
      const onError = vi.fn();
      const fn = vi.fn(() => Promise.resolve("ok"));

      const { result } = renderHook(() => useMutation(fn, { onError }));

      await act(async () => {
        await result.current[0]("x");
      });

      expect(onError).not.toHaveBeenCalled();
    });

    it("wraps non-Error rejections before passing to callback", async () => {
      const onError = vi.fn();
      const fn = vi.fn(() => Promise.reject("string error"));

      const { result } = renderHook(() => useMutation(fn, { onError }));

      await act(async () => {
        await result.current[0]("x").catch(() => {});
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(onError.mock.calls[0]![0].message).toBe("string error");
    });
  });

  describe("onSettled", () => {
    it("is called after success with data, no error, and input", async () => {
      const onSettled = vi.fn();
      const fn = vi.fn((x: number) => Promise.resolve(x * 2));

      const { result } = renderHook(() => useMutation(fn, { onSettled }));

      await act(async () => {
        await result.current[0](5);
      });

      expect(onSettled).toHaveBeenCalledWith(10, undefined, 5);
    });

    it("is called after error with no data, error, and input", async () => {
      const onSettled = vi.fn();
      const error = new Error("fail");
      const fn = vi.fn(() => Promise.reject(error));

      const { result } = renderHook(() => useMutation(fn, { onSettled }));

      await act(async () => {
        await result.current[0]("input").catch(() => {});
      });

      expect(onSettled).toHaveBeenCalledWith(undefined, error, "input");
    });

    it("is called on every mutation", async () => {
      const onSettled = vi.fn();
      let callNum = 0;
      const fn = vi.fn((x: string) => {
        callNum++;
        if (callNum === 1) return Promise.resolve(x);
        return Promise.reject(new Error("fail"));
      });

      const { result } = renderHook(() => useMutation(fn, { onSettled }));

      await act(async () => {
        await result.current[0]("a");
      });

      await act(async () => {
        await result.current[0]("b").catch(() => {});
      });

      expect(onSettled).toHaveBeenCalledTimes(2);
    });
  });

  describe("all callbacks together", () => {
    it("onSuccess and onSettled both fire on success", async () => {
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const onSettled = vi.fn();
      const fn = vi.fn(() => Promise.resolve(42));

      const { result } = renderHook(() =>
        useMutation(fn, { onSuccess, onError, onSettled }),
      );

      await act(async () => {
        await result.current[0]("x");
      });

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalledTimes(1);
    });

    it("onError and onSettled both fire on error", async () => {
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const onSettled = vi.fn();
      const fn = vi.fn(() => Promise.reject(new Error("fail")));

      const { result } = renderHook(() =>
        useMutation(fn, { onSuccess, onError, onSettled }),
      );

      await act(async () => {
        await result.current[0]("x").catch(() => {});
      });

      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledTimes(1);
    });
  });

  describe("backward compatibility", () => {
    it("useMutation works without options (existing behavior)", async () => {
      const fn = vi.fn(() => Promise.resolve("result"));
      const { result } = renderHook(() => useMutation(fn));

      await act(async () => {
        const value = await result.current[0]("input");
        expect(value).toBe("result");
      });

      expect(result.current[1].data).toBe("result");
    });
  });
});
