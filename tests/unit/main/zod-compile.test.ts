import { describe, it, expect } from "vitest";
import { z } from "zod";
import * as core from "zod/v4/core";
import { buildContractSchema, contractCases, runThroughEtrpc } from "#test/helpers/zod-compile-contract";

function hasCompiledFastPath(schema: z.ZodType): boolean {
  return typeof (schema._zod.bag as { validator?: unknown }).validator === "function";
}

describe("input validation with compiled Zod schemas", () => {
  it("runs without global compilation in this file", () => {
    expect(core.globalConfig.postProcessor).toBeUndefined();
    const schema = buildContractSchema();
    schema.parse({ name: "ada" });
    expect(hasCompiledFastPath(schema)).toBe(false);
  });

  it("z.compile() gives the schema a compiled fast path", () => {
    expect(hasCompiledFastPath(z.compile(buildContractSchema()))).toBe(true);
  });

  describe.each([
    { flavor: "plain schema", make: () => buildContractSchema() },
    { flavor: "z.compile() schema", make: () => z.compile(buildContractSchema()) },
  ])("$flavor", ({ make }) => {
    it.each(contractCases)("$name", async ({ input, expected }) => {
      const outcome = await runThroughEtrpc(make(), input);
      expect(outcome).toEqual({ invoked: expected, subscribed: expected });
    });
  });
});
