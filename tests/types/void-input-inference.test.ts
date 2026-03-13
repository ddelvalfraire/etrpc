/**
 * Type-level tests for void-input inference through hooks.
 *
 * These tests verify that when a void-input procedure flows from the client
 * types (MutationClient, QueryClient, SubscriptionClient) through the React
 * hooks (useMutation, useQuery, useSubscription), the resulting types allow
 * calling the mutate/query function with zero arguments.
 *
 * The core issue: MutationClient produces `() => Promise<TOutput>` for void
 * mutations. When passed to `useMutation(fn: (input: TInput) => Promise<TOutput>)`,
 * TypeScript cannot infer `TInput = void` because there is no parameter to
 * infer from. The fix is to make the client types produce
 * `(input: void) => Promise<TOutput>` instead, so TInput can be inferred.
 *
 * Run with: tsc --noEmit -p tsconfig.test.json
 */

import { z } from "zod";
import { query } from "#src/main/builders/query";
import { mutation } from "#src/main/builders/mutation";
import { subscription } from "#src/main/builders/subscription";
import type {
  MutationClient,
  QueryClient,
  SubscriptionClient,
  SubscriptionOptions,
  UnsubscribeFn,
} from "#src/shared/types";
import type { UseMutationResult } from "#src/react/useMutation";

// =============================================================================
// Test Router
// =============================================================================

const testRouter = {
  // Void-input mutation
  reset: mutation().handler(() => ({ done: true })),

  // Typed-input mutation
  increment: mutation()
    .input(z.number())
    .handler((n) => n + 1),

  // Void-input query
  ping: query().handler(() => "pong" as const),

  // Typed-input query
  getUser: query()
    .input(z.object({ id: z.string() }))
    .handler(({ id }) => ({ id, name: "Alice" })),

  // Void-input subscription
  onTick: subscription()
    .output(z.object({ count: z.number() }))
    .handler((_, ctx) => {
      ctx.emit({ count: 0 });
    }),

  // Typed-input subscription
  onFileChange: subscription()
    .input(z.object({ path: z.string() }))
    .output(z.object({ event: z.string() }))
    .handler(({ path }, ctx) => {
      ctx.emit({ event: "changed" });
    }),
};

type TestRouter = typeof testRouter;

// =============================================================================
// Helper: simulate useMutation's inference
// =============================================================================

// This mirrors useMutation's signature. The key is that TInput is inferred
// from fn's parameter. If fn is `() => Promise<T>`, TInput cannot be inferred.
// If fn is `(input: void) => Promise<T>`, TInput is inferred as void.
declare function inferMutationInput<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
): UseMutationResult<TInput, TOutput>;

// =============================================================================
// MutationClient + useMutation: void-input inference
// =============================================================================

declare const mc: MutationClient<TestRouter>;

// TEST 1: Passing mc.reset to a function with useMutation's signature should
// infer TInput=void, making the returned mutate function callable with zero args.
const _resetResult = inferMutationInput(mc.reset);

// The mutate fn (first element) should be callable with no arguments
const _callResetNoArgs: Promise<{ done: boolean }> = _resetResult[0]();

// TEST 2: The non-void mutation should still require its argument
const _incResult = inferMutationInput(mc.increment);
const _callInc: Promise<number> = _incResult[0](5);

// @ts-expect-error - non-void mutation requires an argument
const _callIncBad: Promise<number> = _incResult[0]();

// TEST 3: mc.reset should still be directly callable with zero args
const _directResetCall: Promise<{ done: boolean }> = mc.reset();

// TEST 4: mc.increment should require its argument when called directly
const _directIncCall: Promise<number> = mc.increment(5);
// @ts-expect-error - increment requires a number
const _directIncCallBad = mc.increment();

// =============================================================================
// QueryClient: void-input should still be callable with zero args
// =============================================================================

declare const qc: QueryClient<TestRouter>;

// Void-input query callable with no args
const _pingCall: Promise<"pong"> = qc.ping();

// Typed-input query requires input
const _getUserCall: Promise<{ id: string; name: string }> = qc.getUser({ id: "1" });
// @ts-expect-error - getUser requires input
const _getUserCallBad = qc.getUser();

// =============================================================================
// SubscriptionClient: void-input should accept just options
// =============================================================================

declare const sc: SubscriptionClient<TestRouter>;

// Void-input subscription: only options, no input arg
const _tickUnsub: UnsubscribeFn = sc.onTick({
  onData: (data) => {
    const _count: number = data.count;
  },
  onError: () => {},
});

// Typed-input subscription: requires input + options
const _fileUnsub: UnsubscribeFn = sc.onFileChange(
  { path: "/tmp" },
  {
    onData: (data) => {
      const _event: string = data.event;
    },
    onError: () => {},
  },
);

// @ts-expect-error - onFileChange requires input before options
const _fileUnsubBad: UnsubscribeFn = sc.onFileChange({
  onData: () => {},
  onError: () => {},
});
