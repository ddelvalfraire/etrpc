import { ZodError, type z } from "zod";
import {
  type RouterDef,
  type ServerResult,
  type ServerEmitters,
  type AnyProcedure,
  type InvokePayload,
  type SubscribePayload,
  type SubscriptionProcedure,
  type SubscriptionDataMessage,
  type SubscriptionErrorMessage,
  type SubscriptionContext,
  type QueryContext,
  RpcError,
  RpcErrorCode,
  IPC_CHANNELS,
} from "../shared/types";
import { type Middleware, type MiddlewareContext, composeMiddleware } from "./middleware";

interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): this;
  removeAllListeners(channel: string): this;
}

interface IpcMainEvent {
  sender: WebContentsLike;
}

interface WebContentsLike {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

interface ActiveSubscription {
  readonly path: string;
  readonly webContentsId: number;
  readonly webContents: WebContentsLike;
  readonly cleanup: (() => void) | undefined;
}

export interface CreateServerOptions {
  ipcMain: IpcMainLike;
  middleware?: ReadonlyArray<Middleware>;
}

/**
 * Create the IPC server for the main process.
 *
 * @example
 * ```typescript
 * import { createServer, query, mutation, subscription } from 'etrpc/main';
 * import { z } from 'zod';
 *
 * const router = {
 *   greet: query()
 *     .input(z.object({ name: z.string() }))
 *     .handler(({ name }) => `Hello, ${name}!`),
 *
 *   counter: mutation()
 *     .input(z.number())
 *     .handler((delta) => { count += delta; return count; }),
 *
 *   onTick: subscription()
 *     .output(z.object({ count: z.number() }))
 *     .handler((_, ctx) => {
 *       const interval = setInterval(() => ctx.emit({ count: count++ }), 1000);
 *       return () => clearInterval(interval);
 *     }),
 * };
 *
 * export type AppRouter = typeof router;
 *
 * const { emitters, cleanup } = createServer(router);
 *
 * // Push data from outside a handler:
 * emitters.onTick({ count: 42 });
 *
 * // On app quit:
 * cleanup();
 * ```
 */
export function createServer<T extends RouterDef>(
  router: T,
  options?: CreateServerOptions,
): ServerResult<T> {
  const ipcMain = options?.ipcMain ?? getElectronIpcMain();
  const middlewares: ReadonlyArray<Middleware> = options?.middleware ?? [];

  const activeSubscriptions = new Map<string, ActiveSubscription>();
  const registeredWebContentsIds = new Set<number>();

  function parseInvokePayload(payload: unknown): InvokePayload {
    if (payload === null || payload === undefined || typeof payload !== "object") {
      throw new RpcError(RpcErrorCode.INTERNAL, "Invalid IPC payload: expected an object");
    }
    const obj = payload as Record<string, unknown>;
    if (typeof obj.type !== "string" || typeof obj.path !== "string") {
      throw new RpcError(RpcErrorCode.INTERNAL, "Invalid IPC payload: missing required fields 'type' and 'path'");
    }
    if (obj.type !== "query" && obj.type !== "mutation") {
      throw new RpcError(RpcErrorCode.INTERNAL, `Invalid IPC payload: 'type' must be "query" or "mutation", got "${obj.type}"`);
    }
    return { type: obj.type, path: obj.path, input: obj.input };
  }

  function parseSubscribePayload(payload: unknown): SubscribePayload {
    if (payload === null || payload === undefined || typeof payload !== "object") {
      return { type: "subscribe", id: "", path: "", input: undefined };
    }
    const obj = payload as Record<string, unknown>;
    return {
      type: "subscribe",
      id: typeof obj.id === "string" ? obj.id : "",
      path: typeof obj.path === "string" ? obj.path : "",
      input: obj.input,
    };
  }

  function parseUnsubscribePayload(payload: unknown): string | null {
    if (payload === null || payload === undefined || typeof payload !== "object") {
      return null;
    }
    const obj = payload as Record<string, unknown>;
    if (typeof obj.id !== "string" || obj.id === "") {
      return null;
    }
    return obj.id;
  }

  function lookupProcedure(path: string, expectedType: string): AnyProcedure {
    const procedure = router[path];
    if (!procedure) {
      throw new RpcError(RpcErrorCode.NOT_FOUND, `Procedure not found: ${path}`);
    }
    if (procedure._type !== expectedType) {
      throw new RpcError(
        RpcErrorCode.NOT_FOUND,
        `Procedure "${path}" is a ${procedure._type}, not a ${expectedType}`,
      );
    }
    return procedure;
  }

  function validateInput(procedure: AnyProcedure, input: unknown): unknown {
    try {
      return procedure._inputSchema.parse(input);
    } catch (err: unknown) {
      if (err instanceof ZodError) {
        throw new RpcError(RpcErrorCode.VALIDATION_ERROR, err.message, err.issues);
      }
      throw err;
    }
  }

  function cleanupSubscription(subId: string): void {
    const sub = activeSubscriptions.get(subId);
    if (!sub) return;
    activeSubscriptions.delete(subId);
    if (sub.cleanup) {
      try {
        sub.cleanup();
      } catch {
        // Swallow to prevent cascading failures during teardown
      }
    }
  }

  function cleanupSubscriptionsForWebContents(webContentsId: number): void {
    // Collect first: cleanup functions may themselves trigger subscribe/unsubscribe
    const toCleanup: string[] = [];
    for (const [subId, sub] of activeSubscriptions) {
      if (sub.webContentsId === webContentsId) {
        toCleanup.push(subId);
      }
    }
    for (const subId of toCleanup) {
      cleanupSubscription(subId);
    }
  }

  function registerWebContentsCleanup(webContents: WebContentsLike): void {
    if (registeredWebContentsIds.has(webContents.id)) return;
    registeredWebContentsIds.add(webContents.id);

    const onDestroyed = () => {
      cleanupSubscriptionsForWebContents(webContents.id);
      registeredWebContentsIds.delete(webContents.id);
    };

    const onCrash = () => {
      cleanupSubscriptionsForWebContents(webContents.id);
      registeredWebContentsIds.delete(webContents.id);
    };

    webContents.on("destroyed", onDestroyed);
    webContents.on("render-process-gone", onCrash);
  }

  ipcMain.handle(IPC_CHANNELS.INVOKE, async (event: IpcMainEvent, payload: unknown) => {
    const parsed = parseInvokePayload(payload);
    const { type, path, input } = parsed;

    const procedure = lookupProcedure(path, type);
    const validatedInput = validateInput(procedure, input);

    const handlerCtx: QueryContext = { sender: { id: event.sender.id } };

    const middlewareCtx: MiddlewareContext = {
      type: procedure._type,
      path,
      input: validatedInput,
      sender: { id: event.sender.id },
      meta: procedure._meta,
    };

    try {
      const handler = procedure.handler as (input: unknown, ctx: QueryContext) => unknown | Promise<unknown>;
      const allMiddleware = [...middlewares, ...(procedure._middleware as ReadonlyArray<Middleware>)];
      return await composeMiddleware(
        allMiddleware,
        async () => handler(validatedInput, handlerCtx),
        middlewareCtx,
      );
    } catch (err: unknown) {
      if (err instanceof RpcError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError(RpcErrorCode.HANDLER_ERROR, message);
    }
  });

  ipcMain.on(IPC_CHANNELS.SUBSCRIBE, (event: IpcMainEvent, payload: unknown) => {
    const { id: subId, path, input } = parseSubscribePayload(payload);
    const sender = event.sender;

    if (subId === "") {
      sendErrorToSender(sender, subId, new RpcError(RpcErrorCode.INTERNAL, "Invalid subscription: missing 'id'"));
      return;
    }

    if (activeSubscriptions.has(subId)) {
      sendErrorToSender(sender, subId, new RpcError(RpcErrorCode.INTERNAL, "Subscription ID already in use"));
      return;
    }

    let procedure: SubscriptionProcedure<z.ZodType, unknown>;
    try {
      procedure = lookupProcedure(path, "subscription") as SubscriptionProcedure<z.ZodType, unknown>;
    } catch (err: unknown) {
      if (err instanceof RpcError) {
        sendErrorToSender(sender, subId, err);
      }
      return;
    }

    let validatedInput: unknown;
    try {
      validatedInput = validateInput(procedure, input);
    } catch (err: unknown) {
      if (err instanceof RpcError) {
        sendErrorToSender(sender, subId, err);
      }
      return;
    }

    const emit = (data: unknown): void => {
      if (sender.isDestroyed()) return;
      const msg: SubscriptionDataMessage = { type: "data", id: subId, data };
      sender.send(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, msg);
    };

    const emitError = (error: Error): void => {
      if (sender.isDestroyed()) return;
      const serialized = new RpcError(
        RpcErrorCode.HANDLER_ERROR,
        error.message,
      ).serialize();
      const msg: SubscriptionErrorMessage = { type: "error", id: subId, error: serialized };
      sender.send(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, msg);
    };

    const subCtx: SubscriptionContext<unknown> = {
      sender: { id: sender.id },
      emit,
      emitError,
    };

    registerWebContentsCleanup(sender);

    const middlewareCtx: MiddlewareContext = {
      type: "subscription",
      path,
      input: validatedInput,
      sender: { id: sender.id },
      meta: procedure._meta,
    };

    const allMiddleware = [...middlewares, ...(procedure._middleware as ReadonlyArray<Middleware>)];
    const middlewareResult = composeMiddleware(
      allMiddleware,
      async () => {
        const handlerResult = procedure.handler(validatedInput, subCtx);
        return handlerResult instanceof Promise ? handlerResult : handlerResult;
      },
      middlewareCtx,
    );

    middlewareResult.then((cleanupFn) => {
      activeSubscriptions.set(subId, {
        path,
        webContentsId: sender.id,
        webContents: sender,
        cleanup: typeof cleanupFn === "function" ? (cleanupFn as () => void) : undefined,
      });
    }).catch((err: unknown) => {
      if (err instanceof RpcError) {
        sendErrorToSender(sender, subId, err);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        sendErrorToSender(sender, subId, new RpcError(RpcErrorCode.HANDLER_ERROR, message));
      }
    });
  });

  ipcMain.on(IPC_CHANNELS.UNSUBSCRIBE, (event: IpcMainEvent, payload: unknown) => {
    const subId = parseUnsubscribePayload(payload);
    if (!subId) return;

    const sub = activeSubscriptions.get(subId);
    if (sub && sub.webContentsId !== event.sender.id) return;

    cleanupSubscription(subId);
  });

  function sendErrorToSender(sender: WebContentsLike, subId: string, err: RpcError): void {
    if (sender.isDestroyed()) return;
    const msg: SubscriptionErrorMessage = {
      type: "error",
      id: subId,
      error: err.serialize(),
    };
    sender.send(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, msg);
  }

  let disposed = false;

  const emitters = {} as Record<string, (data: unknown, targetWebContentsIds?: number[]) => void>;

  for (const [path, procedure] of Object.entries(router)) {
    if (procedure._type === "subscription") {
      emitters[path] = (data: unknown, targetWebContentsIds?: number[]) => {
        if (disposed) return;

        for (const [subId, sub] of activeSubscriptions) {
          if (sub.path !== path) continue;
          if (targetWebContentsIds && !targetWebContentsIds.includes(sub.webContentsId)) continue;
          if (sub.webContents.isDestroyed()) continue;

          const msg: SubscriptionDataMessage = { type: "data", id: subId, data };
          sub.webContents.send(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, msg);
        }
      };
    }
  }

  function cleanup(): void {
    if (disposed) return;
    disposed = true;

    for (const subId of [...activeSubscriptions.keys()]) {
      cleanupSubscription(subId);
    }
    activeSubscriptions.clear();
    registeredWebContentsIds.clear();

    ipcMain.removeHandler(IPC_CHANNELS.INVOKE);
    ipcMain.removeAllListeners(IPC_CHANNELS.SUBSCRIBE);
    ipcMain.removeAllListeners(IPC_CHANNELS.UNSUBSCRIBE);
  }

  return {
    emitters: emitters as ServerEmitters<T>,
    cleanup,
  };
}

/**
 * Lazily imports `ipcMain` from electron at runtime.
 * Uses `Function` constructor to avoid ESM compile-time errors with `require`.
 */
function getElectronIpcMain(): IpcMainLike {
  const loadModule = new Function("moduleName", "return require(moduleName)") as (
    moduleName: string,
  ) => Record<string, unknown>;

  try {
    const electron = loadModule("electron") as { ipcMain: IpcMainLike };
    return electron.ipcMain;
  } catch {
    throw new Error(
      "etrpc: Cannot import electron. " +
        "createServer() must be called in Electron's main process, " +
        "or provide ipcMain via options.",
    );
  }
}
