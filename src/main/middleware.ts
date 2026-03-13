import type { ProcedureType, SenderInfo } from "../shared/types";

/** Context provided to each middleware function. */
export interface MiddlewareContext {
  readonly type: ProcedureType;
  readonly path: string;
  readonly input: unknown;
  readonly sender: SenderInfo;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** Middleware context extended with additional properties from earlier middleware. */
export type ExtendedMiddlewareContext<TExtra extends Record<string, unknown>> =
  MiddlewareContext & Readonly<TExtra>;

/**
 * Calls the next middleware or handler in the chain.
 *
 * Returns `unknown` because a single middleware runs across all procedures
 * in a router, each of which may return a different type.
 */
export type NextFunction = () => Promise<unknown>;

/**
 * A middleware function in the onion-model chain.
 *
 * @typeParam TExtra - Additional context properties this middleware expects.
 *
 * @example
 * ```typescript
 * const logger: Middleware = async (ctx, next) => {
 *   console.log(`[${ctx.type}] ${ctx.path}`);
 *   return next();
 * };
 *
 * interface WithUser { userId: string }
 * const requireUser: Middleware<WithUser> = async (ctx, next) => {
 *   console.log(`User: ${ctx.userId}`);
 *   return next();
 * };
 * ```
 */
export type Middleware<TExtra extends Record<string, unknown> = Record<never, never>> = (
  ctx: [keyof TExtra] extends [never] ? MiddlewareContext : ExtendedMiddlewareContext<TExtra>,
  next: NextFunction,
) => Promise<unknown>;

/**
 * Identity helper that provides type inference for middleware definitions.
 *
 * @example
 * ```typescript
 * const logger = defineMiddleware(async (ctx, next) => {
 *   console.log(`[${ctx.type}] ${ctx.path} called`);
 *   return next();
 * });
 * ```
 */
export function defineMiddleware<TExtra extends Record<string, unknown> = Record<never, never>>(
  fn: Middleware<TExtra>,
): Middleware<TExtra> {
  return fn;
}

/** Compose middleware into an onion-model chain wrapping the handler. */
export function composeMiddleware(
  middlewares: ReadonlyArray<Middleware>,
  handler: () => Promise<unknown>,
  ctx: MiddlewareContext,
): Promise<unknown> {
  if (middlewares.length === 0) {
    return handler();
  }

  let index = -1;

  function dispatch(i: number): Promise<unknown> {
    if (i <= index) {
      return Promise.reject(new Error("next() called multiple times in the same middleware"));
    }
    index = i;

    if (i >= middlewares.length) {
      return handler();
    }

    const mw = middlewares[i]!;
    return mw(ctx, () => dispatch(i + 1));
  }

  return dispatch(0);
}

/**
 * Apply middleware to a group of procedures.
 *
 * Execution order: global -> group -> per-procedure -> handler
 *
 * @example
 * ```typescript
 * const protectedRoutes = withMiddleware([requireAuth], {
 *   getUser: query().input(z.object({ id: z.string() })).handler(...),
 *   deleteUser: mutation().use(requireAdmin).input(...).handler(...),
 * });
 * ```
 */
export function withMiddleware<T extends Record<string, { _middleware: ReadonlyArray<unknown> }>>(
  middlewares: ReadonlyArray<Middleware>,
  procedures: T,
): T {
  const result = {} as Record<string, unknown>;
  for (const [key, proc] of Object.entries(procedures)) {
    result[key] = {
      ...proc,
      _middleware: [...middlewares, ...(proc._middleware as ReadonlyArray<Middleware>)],
    };
  }
  return result as T;
}
