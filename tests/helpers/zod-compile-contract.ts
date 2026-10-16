import { z } from "zod";
import { query } from "#src/main/builders/query";
import { subscription } from "#src/main/builders/subscription";
import { createServer } from "#src/main/server";
import {
  IPC_CHANNELS,
  RpcError,
  type SerializedError,
  type SubscriptionMessage,
} from "#src/shared/types";
import { createMockElectron } from "#test/helpers/electron-mock";

/**
 * Apps may hand etrpc schemas compiled by Zod 4.6 (`z.compile()` or a global
 * `import "zod/compile"`). These fixtures pin what etrpc's input validation
 * returns so every schema flavor can be checked against the same values.
 */
export function buildContractSchema() {
  return z
    .object({
      name: z.string().trim().min(2),
      count: z.number().int().nonnegative().default(1),
      tags: z.array(z.enum(["a", "b"])).max(2).optional(),
    })
    .refine((v) => v.name !== "admin", { message: "reserved name", path: ["name"] })
    .transform((v) => ({ ...v, label: `${v.name}:${v.count}` }));
}

export type Outcome =
  | { ok: unknown }
  | { code: string; message: string; issues: unknown };

function errorOutcome(err: SerializedError): Outcome {
  return { code: err.code, message: err.message, issues: err.data };
}

export async function runThroughEtrpc(schema: z.ZodType, input: unknown) {
  const mock = createMockElectron();
  const server = createServer(
    {
      echo: query().input(schema).handler((value) => value),
      watch: subscription()
        .input(schema)
        .output(z.unknown())
        .handler((value, ctx) => {
          ctx.emit(value);
        }),
    },
    { ipcMain: mock.ipcMain },
  );

  try {
    let invoked: Outcome;
    try {
      invoked = { ok: await mock.ipcRenderer.invoke(IPC_CHANNELS.INVOKE, { type: "query", path: "echo", input }) };
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      invoked = errorOutcome(err.serialize());
    }

    const message = new Promise<SubscriptionMessage>((resolve) => {
      mock.ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, (_event: unknown, msg: SubscriptionMessage) => resolve(msg));
    });
    mock.ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, { type: "subscribe", id: "sub-1", path: "watch", input });
    const msg = await message;
    const subscribed: Outcome = msg.type === "data" ? { ok: msg.data } : errorOutcome(msg.error);

    return { invoked, subscribed };
  } finally {
    server.cleanup();
  }
}

function rejected(issues: unknown[]): Outcome {
  return { code: "VALIDATION_ERROR", message: JSON.stringify(issues, null, 2), issues };
}

export const contractCases: ReadonlyArray<{ name: string; input: unknown; expected: Outcome }> = [
  {
    name: "valid input runs trim, default and transform",
    input: { name: "  ada  " },
    expected: { ok: { name: "ada", count: 1, label: "ada:1" } },
  },
  {
    name: "valid input keeps the optional array",
    input: { name: "bob", count: 3, tags: ["a", "b"] },
    expected: { ok: { name: "bob", count: 3, tags: ["a", "b"], label: "bob:3" } },
  },
  {
    name: "unknown keys and an own __proto__ key are stripped",
    input: JSON.parse('{"name":"cy","extra":true,"__proto__":{"polluted":true}}'),
    expected: { ok: { name: "cy", count: 1, label: "cy:1" } },
  },
  {
    name: "string check runs after trim",
    input: { name: " x " },
    expected: rejected([
      { origin: "string", code: "too_small", minimum: 2, inclusive: true, path: ["name"], message: "Too small: expected string to have >=2 characters" },
    ]),
  },
  {
    name: "refinement failure keeps its custom path and message",
    input: { name: "admin" },
    expected: rejected([{ code: "custom", path: ["name"], message: "reserved name" }]),
  },
  {
    name: "issues from several fields are reported together",
    input: { name: 5, count: -1.5, tags: ["a", "c", "b"] },
    expected: rejected([
      { expected: "string", code: "invalid_type", path: ["name"], message: "Invalid input: expected string, received number" },
      { expected: "int", format: "safeint", code: "invalid_type", path: ["count"], message: "Invalid input: expected int, received number" },
      { origin: "array", code: "too_big", maximum: 2, inclusive: true, path: ["tags"], message: "Too big: expected array to have <=2 items" },
    ]),
  },
  {
    name: "non-object input is rejected at the root",
    input: null,
    expected: rejected([
      { expected: "object", code: "invalid_type", path: [], message: "Invalid input: expected object, received null" },
    ]),
  },
];
