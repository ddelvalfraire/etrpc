/**
 * Tests for RpcError and structured error handling.
 */

import { describe, it, expect } from "vitest";
import { RpcError, RpcErrorCode } from "#src/shared/types";

describe("RpcError", () => {
  it("constructs with code and message", () => {
    const err = new RpcError(RpcErrorCode.HANDLER_ERROR, "something broke");

    expect(err.code).toBe(RpcErrorCode.HANDLER_ERROR);
    expect(err.message).toBe("something broke");
    expect(err.data).toBeUndefined();
    expect(err.name).toBe("RpcError");
    expect(err).toBeInstanceOf(Error);
  });

  it("constructs with optional data", () => {
    const zodIssues = [{ path: ["name"], message: "Required" }];
    const err = new RpcError(RpcErrorCode.VALIDATION_ERROR, "Invalid input", zodIssues);

    expect(err.data).toEqual(zodIssues);
  });

  it("serializes to wire format", () => {
    const err = new RpcError(RpcErrorCode.NOT_FOUND, "Procedure not found", { path: "foo" });
    const serialized = err.serialize();

    expect(serialized).toEqual({
      code: RpcErrorCode.NOT_FOUND,
      message: "Procedure not found",
      data: { path: "foo" },
    });
  });

  it("deserializes from wire format", () => {
    const serialized = {
      code: RpcErrorCode.TIMEOUT,
      message: "Request timed out",
      data: { durationMs: 5000 },
    };

    const err = RpcError.fromSerialized(serialized);

    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(RpcErrorCode.TIMEOUT);
    expect(err.message).toBe("Request timed out");
    expect(err.data).toEqual({ durationMs: 5000 });
  });

  it("round-trips through serialize/deserialize", () => {
    const original = new RpcError(RpcErrorCode.INTERNAL, "Unexpected error", { stack: "..." });
    const roundTripped = RpcError.fromSerialized(original.serialize());

    expect(roundTripped.code).toBe(original.code);
    expect(roundTripped.message).toBe(original.message);
    expect(roundTripped.data).toEqual(original.data);
  });
});
