import "zod/compile";
import { describe, it, expect } from "vitest";
import * as core from "zod/v4/core";
import { buildContractSchema, contractCases, runThroughEtrpc } from "#test/helpers/zod-compile-contract";

describe('input validation under a global import "zod/compile"', () => {
  it("compiles schemas on their first parse", () => {
    expect(typeof core.globalConfig.postProcessor).toBe("function");
    const schema = buildContractSchema();
    schema.parse({ name: "ada" });
    expect(typeof (schema._zod.bag as { validator?: unknown }).validator).toBe("function");
  });

  it.each(contractCases)("$name", async ({ input, expected }) => {
    const outcome = await runThroughEtrpc(buildContractSchema(), input);
    expect(outcome).toEqual({ invoked: expected, subscribed: expected });
  });
});
