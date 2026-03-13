import type { z } from "zod";

/** Discriminant for procedure types */
export type ProcedureType = "query" | "mutation" | "subscription";

/** A fully-defined query procedure. */
export interface QueryProcedure<
  TInput extends z.ZodType = z.ZodVoid,
  TOutput = unknown,
> {
  readonly _type: "query";
  readonly _inputSchema: TInput;
  /** Phantom type — carries output type for inference, undefined at runtime */
  readonly _outputType: TOutput;
  readonly handler: QueryHandler<z.infer<TInput>, TOutput>;
  /** Per-procedure middleware chain (runs after global middleware) */
  readonly _middleware: ReadonlyArray<unknown>;
  /** Arbitrary metadata attached via `.meta()`, readable by middleware. */
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** A fully-defined mutation procedure. */
export interface MutationProcedure<
  TInput extends z.ZodType = z.ZodVoid,
  TOutput = unknown,
> {
  readonly _type: "mutation";
  readonly _inputSchema: TInput;
  readonly _outputType: TOutput;
  readonly handler: MutationHandler<z.infer<TInput>, TOutput>;
  /** Per-procedure middleware chain (runs after global middleware) */
  readonly _middleware: ReadonlyArray<unknown>;
  /** Arbitrary metadata attached via `.meta()`, readable by middleware. */
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** A fully-defined subscription procedure. */
export interface SubscriptionProcedure<
  TInput extends z.ZodType = z.ZodVoid,
  TOutput = unknown,
> {
  readonly _type: "subscription";
  readonly _inputSchema: TInput;
  readonly _outputSchema: z.ZodType;
  readonly _outputType: TOutput;
  readonly handler: SubscriptionHandler<z.infer<TInput>, TOutput>;
  /** Per-procedure middleware chain (runs after global middleware) */
  readonly _middleware: ReadonlyArray<unknown>;
  /** Arbitrary metadata attached via `.meta()`, readable by middleware. */
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** Union of all procedure types */
export type AnyProcedure =
  | QueryProcedure<z.ZodType, unknown>
  | MutationProcedure<z.ZodType, unknown>
  | SubscriptionProcedure<z.ZodType, unknown>;

/** Context provided to query handlers. */
export interface QueryContext {
  readonly sender: SenderInfo;
}

/** Context provided to mutation handlers. */
export interface MutationContext {
  readonly sender: SenderInfo;
}

/** Context provided to subscription handlers. */
export interface SubscriptionContext<TOutput> {
  readonly sender: SenderInfo;
  /** Emit data to this specific subscriber */
  readonly emit: (data: TOutput) => void;
  /** Emit an error to this specific subscriber */
  readonly emitError: (error: Error) => void;
}

/** Abstracted sender info, decoupled from Electron types for testability. */
export interface SenderInfo {
  readonly id: number;
}

/** Query handler function signature. */
export type QueryHandler<TInput, TOutput> = (
  input: TInput,
  ctx: QueryContext,
) => TOutput | Promise<TOutput>;

/** Mutation handler function signature. */
export type MutationHandler<TInput, TOutput> = (
  input: TInput,
  ctx: MutationContext,
) => TOutput | Promise<TOutput>;

/** Subscription handler function signature. May return a cleanup function. */
export type SubscriptionHandler<TInput, TOutput> = (
  input: TInput,
  ctx: SubscriptionContext<TOutput>,
) => void | (() => void) | Promise<void> | Promise<() => void>;

/** A router is a record of string keys to procedures. */
export type RouterDef = Record<string, AnyProcedure>;

/** A nested router supports grouping procedures by domain. */
export type NestedRouterDef = Record<string, AnyProcedure | RouterDef>;

/** Convert a union to an intersection via distributive conditional types. */
type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;

/**
 * Helper: produces a union of single-key records for every leaf procedure.
 * Each member maps one dot-separated path to its procedure.
 */
type FlatEntries<T extends NestedRouterDef, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends AnyProcedure
    ? Record<`${Prefix}${K}`, T[K]>
    : T[K] extends RouterDef
      ? FlatEntries<T[K], `${Prefix}${K}.`>
      : never;
}[keyof T & string];

/**
 * Flatten a nested router into a single record with dot-separated keys.
 * Uses `UnionToIntersection` to merge the per-key records into one flat type,
 * then re-maps through a mapped type to produce a clean object.
 */
export type FlattenRouter<T extends NestedRouterDef, Prefix extends string = ""> = {
  [K in keyof UnionToIntersection<FlatEntries<T, Prefix>>]: UnionToIntersection<
    FlatEntries<T, Prefix>
  >[K];
};

/** Extract the inferred input type from a procedure. */
export type InferInput<T> = T extends { _inputSchema: infer U extends z.ZodType }
  ? z.infer<U>
  : never;

/** Extract the inferred output type from a procedure. */
export type InferOutput<T> = T extends { _outputType: infer U } ? U : never;

/** Check if a procedure's input is void. */
export type IsVoidInput<T> = T extends { _inputSchema: z.ZodVoid } ? true : false;

/** Typed query client. Void-input procedures accept zero arguments. */
export type QueryClient<T extends RouterDef> = {
  [K in keyof T & string as T[K] extends QueryProcedure<z.ZodType, unknown>
    ? K
    : never]: T[K] extends QueryProcedure<infer TInput, infer TOutput>
    ? z.infer<TInput> extends void
      ? () => Promise<TOutput>
      : (input: z.infer<TInput>) => Promise<TOutput>
    : never;
};

/** Typed mutation client. Void-input procedures accept zero arguments. */
export type MutationClient<T extends RouterDef> = {
  [K in keyof T & string as T[K] extends MutationProcedure<z.ZodType, unknown>
    ? K
    : never]: T[K] extends MutationProcedure<infer TInput, infer TOutput>
    ? z.infer<TInput> extends void
      ? () => Promise<TOutput>
      : (input: z.infer<TInput>) => Promise<TOutput>
    : never;
};

/** Subscription options passed by the caller. */
export interface SubscriptionOptions<TOutput> {
  onData: (data: TOutput) => void;
  onError: (error: Error) => void;
}

/** Function that unsubscribes from a subscription. */
export type UnsubscribeFn = () => void;

/** Typed subscription client. Void-input subscriptions accept zero arguments. */
export type SubscriptionClient<T extends RouterDef> = {
  [K in keyof T & string as T[K] extends SubscriptionProcedure<z.ZodType, unknown>
    ? K
    : never]: T[K] extends SubscriptionProcedure<infer TInput, infer TOutput>
    ? z.infer<TInput> extends void
      ? (options: SubscriptionOptions<TOutput>) => UnsubscribeFn
      : (input: z.infer<TInput>, options: SubscriptionOptions<TOutput>) => UnsubscribeFn
    : never;
};

/** The complete IPC client returned by `createClient()`. */
export interface IpcClient<T extends RouterDef> {
  queries: QueryClient<T>;
  mutations: MutationClient<T>;
  subscriptions: SubscriptionClient<T>;
}

/** Emitter function for pushing data to subscribers, optionally targeting specific windows. */
export type BroadcastEmitter<TOutput> = (
  data: TOutput,
  targetWebContentsIds?: number[],
) => void;

/** The emitters object returned by `createServer()`, one per subscription procedure. */
export type ServerEmitters<T extends RouterDef> = {
  [K in keyof T & string as T[K] extends SubscriptionProcedure<z.ZodType, unknown>
    ? K
    : never]: T[K] extends SubscriptionProcedure<z.ZodType, infer TOutput>
    ? BroadcastEmitter<TOutput>
    : never;
};

/** Result returned by `createServer()`. */
export interface ServerResult<T extends RouterDef> {
  emitters: ServerEmitters<T>;
  cleanup: () => void;
}

/** Message sent from renderer to main for a query or mutation. */
export interface InvokePayload {
  type: "query" | "mutation";
  path: string;
  input: unknown;
}

/** Message sent from renderer to main to start a subscription. */
export interface SubscribePayload {
  type: "subscribe";
  id: string;
  path: string;
  input: unknown;
}

/** Message sent from renderer to main to stop a subscription. */
export interface UnsubscribePayload {
  type: "unsubscribe";
  id: string;
}

/** Message sent from main to renderer with subscription data. */
export interface SubscriptionDataMessage {
  type: "data";
  id: string;
  data: unknown;
}

/** Message sent from main to renderer with a subscription error. */
export interface SubscriptionErrorMessage {
  type: "error";
  id: string;
  error: SerializedError;
}

/** Union of all messages the renderer receives on the subscription channel. */
export type SubscriptionMessage = SubscriptionDataMessage | SubscriptionErrorMessage;

export enum RpcErrorCode {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  HANDLER_ERROR = "HANDLER_ERROR",
  NOT_FOUND = "NOT_FOUND",
  TIMEOUT = "TIMEOUT",
  UNAUTHORIZED = "UNAUTHORIZED",
  INTERNAL = "INTERNAL",
}

/** Structured error for wire serialization. */
export interface SerializedError {
  code: RpcErrorCode;
  message: string;
  data?: unknown;
}

/** RPC error with structured code, reconstructed from `SerializedError` on the client. */
export class RpcError extends Error {
  readonly code: RpcErrorCode;
  readonly data?: unknown;

  constructor(code: RpcErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }

  static fromSerialized(err: SerializedError): RpcError {
    return new RpcError(err.code, err.message, err.data);
  }

  serialize(): SerializedError {
    return { code: this.code, message: this.message, data: this.data };
  }
}

/** The bridge object exposed via `contextBridge` between preload and renderer. */
export interface PreloadBridge {
  invoke: (payload: InvokePayload) => Promise<unknown>;
  subscribe: (payload: SubscribePayload) => void;
  unsubscribe: (payload: UnsubscribePayload) => void;
  onSubscriptionMessage: (
    callback: (message: SubscriptionMessage) => void,
  ) => () => void;
}

export const IPC_CHANNELS = {
  INVOKE: "__etrpc_invoke__",
  SUBSCRIBE: "__etrpc_subscribe__",
  UNSUBSCRIBE: "__etrpc_unsubscribe__",
  SUBSCRIPTION_MESSAGE: "__etrpc_sub_msg__",
} as const;
