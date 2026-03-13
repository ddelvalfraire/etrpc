/**
 * Compile-time type safety tests.
 *
 * These tests verify that the type system correctly:
 * - Infers input/output types from router definitions
 * - Makes void inputs optional on the client
 * - Separates queries/mutations/subscriptions into correct client namespaces
 * - Types subscription `onData` callbacks correctly
 * - Types server emitters correctly
 *
 * Tests that should FAIL compilation use @ts-expect-error annotations.
 * If the annotation is not needed (the code compiles when it shouldn't), tsc will error.
 */

import { z } from "zod";
import { query } from "#src/main/builders/query";
import { mutation } from "#src/main/builders/mutation";
import { subscription } from "#src/main/builders/subscription";
import type {
  InferInput,
  InferOutput,
  QueryClient,
  MutationClient,
  SubscriptionClient,
  ServerEmitters,
  IpcClient,
  FlattenRouter,
  RouterDef,
} from "#src/shared/types";

// =============================================================================
// Test Router Definition
// =============================================================================

const testRouter = {
  // Queries
  ping: query().handler(() => "pong" as const),

  getUser: query()
    .input(z.object({ id: z.string() }))
    .handler(({ id }) => ({ id, name: "Alice" })),

  // Mutations
  increment: mutation()
    .input(z.number())
    .handler((n) => n + 1),

  reset: mutation().handler(() => ({ done: true })),

  // Subscriptions
  onTick: subscription()
    .output(z.object({ count: z.number(), timestamp: z.number() }))
    .handler((_, ctx) => {
      ctx.emit({ count: 0, timestamp: Date.now() });
    }),

  onFileChange: subscription()
    .input(z.object({ path: z.string() }))
    .output(z.object({ event: z.string() }))
    .handler(({ path }, ctx) => {
      ctx.emit({ event: "changed" });
    }),
};

type TestRouter = typeof testRouter;

// =============================================================================
// InferInput / InferOutput Tests
// =============================================================================

// Query with input
type GetUserInput = InferInput<TestRouter["getUser"]>;
const _getUserInput: GetUserInput = { id: "123" };
// @ts-expect-error - missing id field
const _getUserInputBad: GetUserInput = {};

// Query without input
type PingInput = InferInput<TestRouter["ping"]>;
const _pingInput: PingInput = undefined as unknown as void;

// Query output
type PingOutput = InferOutput<TestRouter["ping"]>;
const _pingOutput: PingOutput = "pong";
// @ts-expect-error - wrong output type
const _pingOutputBad: PingOutput = "not-pong";

// Mutation output
type IncrementOutput = InferOutput<TestRouter["increment"]>;
const _incOutput: IncrementOutput = 42;
// @ts-expect-error - wrong output type
const _incOutputBad: IncrementOutput = "not a number";

// Subscription output
type TickOutput = InferOutput<TestRouter["onTick"]>;
const _tickOutput: TickOutput = { count: 1, timestamp: 123 };
// @ts-expect-error - missing timestamp
const _tickOutputBad: TickOutput = { count: 1 };

// Subscription _outputSchema preserves output type (not bare z.ZodType)
type TickSchema = TestRouter["onTick"]["_outputSchema"];
declare const _tickSchema: TickSchema;
const _parsedTick: { count: number; timestamp: number } = _tickSchema.parse({});
// @ts-expect-error - _outputSchema.parse returns typed output, not string
const _parsedTickBad: string = _tickSchema.parse({});

// =============================================================================
// Client Type Tests
// =============================================================================

// Query client
type QClient = QueryClient<TestRouter>;

// Void-input query: callable with no args
declare const qc: QClient;
const _pingCall: Promise<"pong"> = qc.ping();

// Typed-input query: requires input
const _getUserCall: Promise<{ id: string; name: string }> = qc.getUser({ id: "123" });
// @ts-expect-error - missing input
const _getUserCallBad = qc.getUser();

// Mutations should NOT appear on query client
// @ts-expect-error - increment is a mutation, not a query
const _notOnQueries = qc.increment;

// Mutation client
type MClient = MutationClient<TestRouter>;
declare const mc: MClient;

const _incCall: Promise<number> = mc.increment(5);
const _resetCall: Promise<{ done: boolean }> = mc.reset();
// @ts-expect-error - wrong input type
const _incCallBad = mc.increment("not a number");

// Subscription client
type SClient = SubscriptionClient<TestRouter>;
declare const sc: SClient;

// Void-input subscription: only options, no input arg
const _tickUnsub = sc.onTick({
  onData: (data) => {
    // data should be typed
    const _count: number = data.count;
    const _ts: number = data.timestamp;
  },
  onError: (err) => {},
});

// Typed-input subscription: requires input + options
const _fileUnsub = sc.onFileChange(
  { path: "/tmp" },
  {
    onData: (data) => {
      const _event: string = data.event;
    },
    onError: (err) => {},
  },
);

const _fileUnsubBad = sc.onFileChange(
  // @ts-expect-error - number is not a valid subscription input
  42,
  { onData: () => {}, onError: () => {} },
);

// =============================================================================
// Server Emitter Tests
// =============================================================================

type Emitters = ServerEmitters<TestRouter>;
declare const emitters: Emitters;

// Subscription emitters exist and are typed
emitters.onTick({ count: 1, timestamp: 123 });
emitters.onFileChange({ event: "modified" });

// @ts-expect-error - wrong data type for emitter
emitters.onTick({ count: "not a number", timestamp: 123 });

// @ts-expect-error - queries/mutations don't have emitters
emitters.ping;

// =============================================================================
// IpcClient combines all three
// =============================================================================

type Client = IpcClient<TestRouter>;
declare const client: Client;

// All three namespaces exist
client.queries.ping();
client.mutations.increment(1);
client.subscriptions.onTick({ onData: () => {}, onError: () => {} });

// =============================================================================
// Middleware Type Tests
// =============================================================================

import type {
  Middleware,
  MiddlewareContext,
  ExtendedMiddlewareContext,
  NextFunction,
} from "#src/main/middleware";
import { defineMiddleware } from "#src/main/middleware";

// --- Base middleware: receives MiddlewareContext ---

// Middleware with no generic gets the base MiddlewareContext
const _baseMiddleware: Middleware = async (ctx, next) => {
  // All base properties are accessible
  const _type: "query" | "mutation" | "subscription" = ctx.type;
  const _path: string = ctx.path;
  const _input: unknown = ctx.input;
  const _senderId: number = ctx.sender.id;
  return next();
};

// --- next() returns Promise<unknown> ---

// The return of next() is unknown, which is correct for cross-cutting concerns
const _nextReturnType: Middleware = async (_ctx, next) => {
  const result: unknown = await next();
  // Cannot treat result as a specific type without narrowing
  // @ts-expect-error - result is unknown, not string
  const _str: string = await next();
  return result;
};

// --- NextFunction type ---

// NextFunction returns Promise<unknown>
declare const _nextFn: NextFunction;
const _nextResult: Promise<unknown> = _nextFn();

// --- Extended context middleware ---

// Middleware with extra context properties
type WithUser = { userId: string; role: "admin" | "user" };

const _authMiddleware: Middleware<WithUser> = async (ctx, next) => {
  // Extended properties are accessible alongside base properties
  const _userId: string = ctx.userId;
  const _role: "admin" | "user" = ctx.role;
  const _path: string = ctx.path;
  const _type: "query" | "mutation" | "subscription" = ctx.type;
  return next();
};

// Extended context requires the right types
const _strictAuthMiddleware: Middleware<WithUser> = async (ctx, _next) => {
  // @ts-expect-error - role must be "admin" | "user", not number
  const _badRole: number = ctx.role;
  return _next();
};

// --- ExtendedMiddlewareContext type ---

type AuthContext = ExtendedMiddlewareContext<WithUser>;

// AuthContext has both base and extended properties
declare const _authCtx: AuthContext;
const _authType: "query" | "mutation" | "subscription" = _authCtx.type;
const _authPath: string = _authCtx.path;
const _authUserId: string = _authCtx.userId;
const _authRole: "admin" | "user" = _authCtx.role;

// --- defineMiddleware preserves types ---

const _definedMw = defineMiddleware(async (ctx, next) => {
  // ctx should be typed as MiddlewareContext
  const _path: string = ctx.path;
  return next();
});

// defineMiddleware result is assignable to Middleware
const _asMw: Middleware = _definedMw;

// --- Middleware composability: base middleware is assignable to ReadonlyArray<Middleware> ---

const _middlewareArray: ReadonlyArray<Middleware> = [
  _baseMiddleware,
  _definedMw,
  _asMw,
];

// =============================================================================
// FlattenRouter Tests
// =============================================================================

// Helper: assert two types are identical
type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
type Assert<T extends true> = T;

// --- 1. Simple nested router flattens correctly (dot-separated keys) ---

const _nestedRouter = {
  users: {
    getById: query()
      .input(z.object({ id: z.string() }))
      .handler(({ id }) => ({ id, name: "Alice" })),
    delete: mutation()
      .input(z.object({ id: z.string() }))
      .handler(({ id }) => ({ deleted: true })),
  },
};

type FlatNested = FlattenRouter<typeof _nestedRouter>;

// The flattened type has the expected dot-separated keys
type _AssertGetById = Assert<AssertEqual<
  FlatNested["users.getById"],
  (typeof _nestedRouter)["users"]["getById"]
>>;
type _AssertDelete = Assert<AssertEqual<
  FlatNested["users.delete"],
  (typeof _nestedRouter)["users"]["delete"]
>>;

// Both keys exist simultaneously (not a union of single-key records)
declare const _flatNested: FlatNested;
const _gnb = _flatNested["users.getById"];
const _gnd = _flatNested["users.delete"];

// --- 2. Deeply nested router (3+ levels) flattens correctly ---

const _deepRouter = {
  api: {
    v1: {
      users: {
        list: query().handler(() => [{ id: "1" }]),
      },
    },
  },
};

type FlatDeep = FlattenRouter<typeof _deepRouter>;

type _AssertDeepList = Assert<AssertEqual<
  FlatDeep["api.v1.users.list"],
  (typeof _deepRouter)["api"]["v1"]["users"]["list"]
>>;

declare const _flatDeep: FlatDeep;
const _deepList = _flatDeep["api.v1.users.list"];

// --- 3. Mixed flat + nested procedures work ---

const _mixedRouter = {
  health: query().handler(() => "ok" as const),
  users: {
    getById: query()
      .input(z.object({ id: z.string() }))
      .handler(({ id }) => ({ id, name: "Alice" })),
  },
  system: {
    reboot: mutation().handler(() => ({ rebooting: true })),
  },
};

type FlatMixed = FlattenRouter<typeof _mixedRouter>;

// Flat procedure stays as-is (no prefix)
type _AssertHealth = Assert<AssertEqual<
  FlatMixed["health"],
  (typeof _mixedRouter)["health"]
>>;

// Nested procedures get dot-separated keys
type _AssertMixedGetById = Assert<AssertEqual<
  FlatMixed["users.getById"],
  (typeof _mixedRouter)["users"]["getById"]
>>;
type _AssertReboot = Assert<AssertEqual<
  FlatMixed["system.reboot"],
  (typeof _mixedRouter)["system"]["reboot"]
>>;

// All three keys coexist on a single type
declare const _flatMixed: FlatMixed;
const _fmh = _flatMixed["health"];
const _fmu = _flatMixed["users.getById"];
const _fms = _flatMixed["system.reboot"];

// --- 4. The result satisfies RouterDef ---

// RouterDef = Record<string, AnyProcedure>, so FlattenRouter output must be assignable
type _AssertRouterDefSimple = Assert<FlatNested extends RouterDef ? true : false>;
type _AssertRouterDefDeep = Assert<FlatDeep extends RouterDef ? true : false>;
type _AssertRouterDefMixed = Assert<FlatMixed extends RouterDef ? true : false>;

// Verify at value level too: assignable to a RouterDef-typed variable
const _routerDefFromFlat: RouterDef = _flatMixed;
const _routerDefFromNested: RouterDef = _flatNested;
const _routerDefFromDeep: RouterDef = _flatDeep;
