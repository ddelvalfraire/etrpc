import { RpcError, RpcErrorCode } from "../shared/types";
import { defineMiddleware, type Middleware } from "./middleware";

/**
 * A registry that maps app-defined window roles to live webContents IDs.
 *
 * Populate this as windows are created/destroyed. The scope middleware
 * reads from it at request time, so windows can come and go freely.
 *
 * @example
 * ```typescript
 * const windows = createWindowRegistry();
 *
 * // When creating a window:
 * const mainWin = new BrowserWindow({ ... });
 * windows.register('main', mainWin.webContents.id);
 *
 * // When the window closes:
 * mainWin.on('closed', () => windows.unregister('main', mainWin.webContents.id));
 * ```
 */
export interface WindowRegistry {
  register(role: string, webContentsId: number): void;
  unregister(role: string, webContentsId: number): void;
  has(role: string, webContentsId: number): boolean;
}

export function createWindowRegistry(): WindowRegistry {
  const roleToIds = new Map<string, Set<number>>();

  return {
    register(role, webContentsId) {
      let ids = roleToIds.get(role);
      if (!ids) {
        ids = new Set();
        roleToIds.set(role, ids);
      }
      ids.add(webContentsId);
    },

    unregister(role, webContentsId) {
      const ids = roleToIds.get(role);
      if (!ids) return;
      ids.delete(webContentsId);
      if (ids.size === 0) roleToIds.delete(role);
    },

    has(role, webContentsId) {
      const ids = roleToIds.get(role);
      return ids !== undefined && ids.has(webContentsId);
    },
  };
}

/** Determines which senders are allowed. Checked at request time. */
export type ScopeRule =
  | { roles: string[]; registry: WindowRegistry }
  | { allow: (webContentsId: number) => boolean };

export interface ScopeOptions {
  /** Custom error message when access is denied. */
  message?: string;
}

/**
 * Create middleware that restricts procedures to specific windows.
 *
 * Accepts either role-based scoping (with a WindowRegistry) or a raw predicate.
 * The check runs at request time, so dynamic window creation is fully supported.
 *
 * @example
 * ```typescript
 * import { scope, createWindowRegistry, withMiddleware, query } from 'etrpc/main';
 *
 * const windows = createWindowRegistry();
 *
 * // Role-based: define routes before windows exist
 * const mainWindowRoutes = withMiddleware(
 *   [scope({ roles: ['main'], registry: windows })],
 *   {
 *     editSettings: mutation().handler(...),
 *     getConfig: query().handler(...),
 *   },
 * );
 *
 * const adminRoutes = withMiddleware(
 *   [scope({ roles: ['admin', 'superadmin'], registry: windows })],
 *   { deleteUser: mutation().handler(...) },
 * );
 *
 * // Predicate-based: full control
 * const debugRoutes = withMiddleware(
 *   [scope({ allow: (id) => debugWindowIds.has(id) })],
 *   { inspect: query().handler(...) },
 * );
 *
 * // Register windows at creation time
 * const mainWin = new BrowserWindow({ ... });
 * windows.register('main', mainWin.webContents.id);
 * mainWin.on('closed', () => windows.unregister('main', mainWin.webContents.id));
 * ```
 */
export function scope(rule: ScopeRule, options?: ScopeOptions): Middleware {
  const check = "allow" in rule
    ? rule.allow
    : (id: number) => rule.roles.some((role) => rule.registry.has(role, id));

  return defineMiddleware(async (ctx, next) => {
    if (!check(ctx.sender.id)) {
      throw new RpcError(
        RpcErrorCode.UNAUTHORIZED,
        options?.message ?? `Procedure "${ctx.path}" is not available to this window`,
      );
    }
    return next();
  });
}
