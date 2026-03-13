/**
 * Tests for IPC payload validation edge cases.
 *
 * These tests verify that the server handles malformed payloads gracefully
 * instead of crashing with unstructured errors.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { query } from "#src/main/builders/query";
import { createServer } from "#src/main/server";
import {
  createMockElectron,
  type MockElectron,
} from "#test/helpers/electron-mock";
import {
  RpcError,
  RpcErrorCode,
  IPC_CHANNELS,
  type ServerResult,
} from "#src/shared/types";

describe("payload validation", () => {
  let mock: MockElectron;
  let server: ServerResult<Record<string, ReturnType<ReturnType<typeof query>["handler"]>>>;

  beforeEach(() => {
    mock = createMockElectron();
    const router = {
      ping: query().handler(() => "pong"),
    };
    server = createServer(router, { ipcMain: mock.ipcMain });
  });

  afterEach(() => {
    server.cleanup();
  });

  it("returns INTERNAL error when payload is null", async () => {
    try {
      await mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, null);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(RpcErrorCode.INTERNAL);
    }
  });

  it("returns INTERNAL error when payload is undefined", async () => {
    try {
      await mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, undefined);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(RpcErrorCode.INTERNAL);
    }
  });

  it("returns INTERNAL error when payload is a string", async () => {
    try {
      await mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, "not a payload");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(RpcErrorCode.INTERNAL);
    }
  });

  it("returns INTERNAL error when payload is missing required fields", async () => {
    try {
      await mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, { foo: "bar" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(RpcErrorCode.INTERNAL);
    }
  });

  it("returns INTERNAL error when type field is invalid", async () => {
    try {
      await mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, {
        type: "invalid",
        path: "ping",
        input: undefined,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(RpcErrorCode.INTERNAL);
    }
  });

  it("returns NOT_FOUND when type is valid but path is empty string", async () => {
    try {
      await mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, {
        type: "query",
        path: "",
        input: undefined,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(RpcErrorCode.NOT_FOUND);
    }
  });
});
