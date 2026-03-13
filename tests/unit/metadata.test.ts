import { describe, it, expect, vi } from "vitest";
import { query } from "#src/main/builders/query";
import { mutation } from "#src/main/builders/mutation";
import { subscription } from "#src/main/builders/subscription";
import { z } from "zod";
import { createMockElectron } from "#test/helpers/electron-mock";
import { createServer } from "#src/main/server";
import type { MiddlewareContext } from "#src/main/middleware";

// ===========================================================================
// Procedure metadata
// ===========================================================================

describe("procedure metadata", () => {
  describe("query builder", () => {
    it("meta() attaches metadata to the procedure", () => {
      const proc = query()
        .meta({ rateLimit: 100, description: "Get user" })
        .handler(() => "ok");

      expect(proc._meta).toEqual({ rateLimit: 100, description: "Get user" });
    });

    it("meta() can be chained with input()", () => {
      const proc = query()
        .meta({ auth: true })
        .input(z.object({ id: z.string() }))
        .handler(({ id }) => id);

      expect(proc._meta).toEqual({ auth: true });
    });

    it("meta() can be chained with use()", () => {
      const mw = async (_ctx: MiddlewareContext, next: () => Promise<unknown>) => next();
      const proc = query()
        .use(mw)
        .meta({ cached: true })
        .handler(() => "ok");

      expect(proc._meta).toEqual({ cached: true });
    });

    it("procedure without meta() has undefined _meta", () => {
      const proc = query().handler(() => "ok");
      expect(proc._meta).toBeUndefined();
    });
  });

  describe("mutation builder", () => {
    it("meta() attaches metadata to the procedure", () => {
      const proc = mutation()
        .meta({ dangerous: true })
        .handler(() => "ok");

      expect(proc._meta).toEqual({ dangerous: true });
    });

    it("meta() can be chained with input()", () => {
      const proc = mutation()
        .meta({ audit: true })
        .input(z.number())
        .handler((n) => n);

      expect(proc._meta).toEqual({ audit: true });
    });

    it("procedure without meta() has undefined _meta", () => {
      const proc = mutation().handler(() => "ok");
      expect(proc._meta).toBeUndefined();
    });
  });

  describe("subscription builder", () => {
    it("meta() attaches metadata to the procedure", () => {
      const proc = subscription()
        .meta({ maxSubscribers: 10 })
        .output(z.string())
        .handler(() => {});

      expect(proc._meta).toEqual({ maxSubscribers: 10 });
    });

    it("meta() can be chained with input()", () => {
      const proc = subscription()
        .meta({ throttle: 100 })
        .input(z.string())
        .output(z.number())
        .handler(() => {});

      expect(proc._meta).toEqual({ throttle: 100 });
    });

    it("procedure without meta() has undefined _meta", () => {
      const proc = subscription()
        .output(z.string())
        .handler(() => {});

      expect(proc._meta).toBeUndefined();
    });
  });

  describe("middleware can read metadata", () => {
    it("metadata is available in middleware context", async () => {
      const mock = createMockElectron();
      const capturedMeta: unknown[] = [];

      const metaLogger = async (ctx: MiddlewareContext & { meta?: Record<string, unknown> }, next: () => Promise<unknown>) => {
        capturedMeta.push(ctx.meta);
        return next();
      };

      const router = {
        withMeta: query()
          .meta({ rateLimit: 50 })
          .handler(() => "ok"),
        withoutMeta: query()
          .handler(() => "also ok"),
      };

      const { cleanup } = createServer(router, {
        ipcMain: mock.ipcMain,
        middleware: [metaLogger],
      });

      // Invoke the procedure with metadata
      await mock.ipcRenderer.invoke("__etrpc_invoke__", {
        type: "query",
        path: "withMeta",
        input: undefined,
      });

      expect(capturedMeta[0]).toEqual({ rateLimit: 50 });

      // Invoke the procedure without metadata
      await mock.ipcRenderer.invoke("__etrpc_invoke__", {
        type: "query",
        path: "withoutMeta",
        input: undefined,
      });

      expect(capturedMeta[1]).toBeUndefined();

      cleanup();
    });
  });
});
