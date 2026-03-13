import type {
  RouterDef,
  IpcClient,
  PreloadBridge,
  QueryClient,
  MutationClient,
  SubscriptionClient,
  SerializedError,
  SubscriptionOptions,
  UnsubscribeFn,
} from "../shared/types";
import { RpcError } from "../shared/types";

interface SubscriptionCallbacks {
  onData: (data: unknown) => void;
  onError: (error: Error) => void;
}

const subscriptionCallbacks = new Map<string, SubscriptionCallbacks>();

const registeredBridges = new WeakSet<PreloadBridge>();

function generateId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random()}`;
}

/** Reconstruct an `RpcError` from a serialized error, or re-throw as-is. */
function reconstructError(err: unknown): never {
  if (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    "message" in err
  ) {
    throw RpcError.fromSerialized(err as SerializedError);
  }
  throw err;
}

interface CreateClientOptions {
  bridgeKey?: string;
}

/**
 * Create a typed IPC client for the renderer process.
 *
 * @example
 * ```typescript
 * import { createClient } from 'etrpc/renderer';
 * import type { AppRouter } from '../main/router';
 *
 * const api = createClient<AppRouter>();
 *
 * // Queries — returns Promise
 * const greeting = await api.queries.greet({ name: "World" });
 *
 * // Mutations — returns Promise
 * const newCount = await api.mutations.increment(5);
 *
 * // Subscriptions — returns unsubscribe function
 * const unsub = api.subscriptions.onTick({
 *   onData: (data) => console.log(data.count),
 *   onError: (err) => console.error(err),
 * });
 *
 * // Later:
 * unsub();
 * ```
 */
export function createClient<T extends RouterDef>(
  options?: CreateClientOptions,
): IpcClient<T> {
  const bridgeKey = options?.bridgeKey ?? "__etrpc";
  const bridge = (globalThis as Record<string, unknown>)[
    bridgeKey
  ] as PreloadBridge;

  const queries = new Proxy(Object.create(null) as QueryClient<T>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (input?: unknown): Promise<unknown> =>
        bridge.invoke({ type: "query", path: prop, input }).catch(reconstructError);
    },
  });

  const mutations = new Proxy(Object.create(null) as MutationClient<T>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (input?: unknown): Promise<unknown> =>
        bridge.invoke({ type: "mutation", path: prop, input }).catch(reconstructError);
    },
  });

  function ensureListener(): void {
    if (registeredBridges.has(bridge)) return;
    registeredBridges.add(bridge);

    bridge.onSubscriptionMessage((message) => {
      const callbacks = subscriptionCallbacks.get(message.id);
      if (!callbacks) return;

      if (message.type === "data") {
        callbacks.onData(message.data);
      } else if (message.type === "error") {
        callbacks.onError(RpcError.fromSerialized(message.error));
      }
    });
  }

  const subscriptions = new Proxy(
    Object.create(null) as SubscriptionClient<T>,
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;

        return (...args: unknown[]): UnsubscribeFn => {
          let input: unknown;
          let opts: SubscriptionOptions<unknown>;

          if (args.length === 1) {
            input = undefined;
            opts = args[0] as SubscriptionOptions<unknown>;
          } else {
            input = args[0];
            opts = args[1] as SubscriptionOptions<unknown>;
          }

          const id = generateId();

          // Register before subscribe so synchronous messages are not lost
          subscriptionCallbacks.set(id, {
            onData: opts.onData,
            onError: opts.onError,
          });

          ensureListener();

          bridge.subscribe({ type: "subscribe", id, path: prop, input });

          return (): void => {
            bridge.unsubscribe({ type: "unsubscribe", id });
            subscriptionCallbacks.delete(id);
          };
        };
      },
    },
  );

  return { queries, mutations, subscriptions };
}
