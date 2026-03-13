export { createServer } from "./server";
export { query } from "./builders/query";
export { mutation } from "./builders/mutation";
export { subscription } from "./builders/subscription";
export { createRouter } from "./router";

export type {
  RouterDef,
  QueryProcedure,
  MutationProcedure,
  SubscriptionProcedure,
  QueryContext,
  MutationContext,
  SubscriptionContext,
  ServerResult,
  ServerEmitters,
  BroadcastEmitter,
  RpcErrorCode,
  RpcError,
} from "../shared/types";

export { defineMiddleware, withMiddleware } from "./middleware";
export type { Middleware, MiddlewareContext, ExtendedMiddlewareContext, NextFunction } from "./middleware";
export { scope, createWindowRegistry } from "./scope";
export type { ScopeOptions, ScopeRule, WindowRegistry } from "./scope";
