# etrpc

Type-safe RPC for Electron. Queries, mutations, and streaming subscriptions with Zod validation.

## Features

- Full type inference from router definition to client calls
- Zod-based input validation
- Queries, mutations, and real-time subscriptions
- Onion-model middleware (global, group, and per-procedure)
- Window-scoped routes via role-based registry
- React hooks (`useQuery`, `useMutation`, `useSubscription`)
- Multi-window support with targeted broadcast emitters
- Structured error handling with `RpcError`
- Zero runtime dependencies beyond Electron and Zod

## Install

```bash
npm install etrpc zod
```

Peer dependencies: `electron >=22`, `zod ^3.25 || ^4`, and optionally `react >=18`.

## Quick Start

### 1. Define your router (main process)

```typescript
// main/router.ts
import { query, mutation, subscription, createRouter } from 'etrpc/main';
import { z } from 'zod';

const users = createRouter({
  getById: query()
    .input(z.object({ id: z.string() }))
    .handler(async ({ id }, ctx) => {
      return db.users.find(id);
    }),

  create: mutation()
    .input(z.object({ name: z.string(), email: z.string().email() }))
    .handler(async (input) => {
      return db.users.create(input);
    }),
});

const notifications = createRouter({
  onNew: subscription()
    .output(z.object({ title: z.string(), body: z.string() }))
    .handler((_, ctx) => {
      const off = notificationService.on('new', (n) => ctx.emit(n));
      return () => off(); // cleanup on unsubscribe
    }),
});

export const router = { users, notifications };
export type AppRouter = typeof router;
```

### 2. Start the server (main process)

```typescript
// main/index.ts
import { createServer } from 'etrpc/main';
import { router } from './router';

const { emitters, cleanup } = createServer(router);

// Broadcast to all subscribers of a subscription
emitters['notifications.onNew']({ title: 'Hello', body: 'World' });

// Call cleanup() when the app quits
app.on('will-quit', cleanup);
```

### 3. Expose the bridge (preload script)

```typescript
// preload.ts
import { createPreloadBridge } from 'etrpc/preload';
createPreloadBridge();
```

### 4. Create the client (renderer process)

```typescript
// renderer/rpc.ts
import { createClient } from 'etrpc/renderer';
import type { AppRouter } from '../main/router';
import type { FlattenRouter } from 'etrpc/main';

const client = createClient<FlattenRouter<AppRouter>>();

// Fully typed - input and output inferred from the router
const user = await client.queries['users.getById']({ id: '123' });
const created = await client.mutations['users.create']({
  name: 'Alice',
  email: 'alice@example.com',
});

const unsub = client.subscriptions['notifications.onNew']({
  onData: (notification) => console.log(notification.title),
  onError: (err) => console.error(err),
});
```

## React Hooks

```typescript
import { useQuery, useMutation, useSubscription } from 'etrpc/react';
import type { AppRouter } from '../main/router';
import type { FlattenRouter } from 'etrpc/main';

type Router = FlattenRouter<AppRouter>;

function UserProfile({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useQuery<Router>(
    'users.getById',
    { id },
  );

  const { mutate, isPending } = useMutation<Router>('users.create', {
    onSuccess: (user) => console.log('Created:', user.name),
  });

  const { data: notification } = useSubscription<Router>(
    'notifications.onNew',
  );

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  return <div>{data.name}</div>;
}
```

## Middleware

```typescript
import { defineMiddleware, withMiddleware, createServer } from 'etrpc/main';

const logger = defineMiddleware(async (ctx, next) => {
  console.log(`${ctx.type} ${ctx.path}`);
  const start = Date.now();
  const result = await next();
  console.log(`${ctx.path} took ${Date.now() - start}ms`);
  return result;
});

const authCheck = defineMiddleware(async (ctx, next) => {
  if (!isAuthorized(ctx.sender.id)) {
    throw new RpcError(RpcErrorCode.UNAUTHORIZED, 'Not authorized');
  }
  return next();
});

// Global middleware applies to all procedures
createServer(router, { middleware: [logger] });

// Group middleware applies to a subset of procedures
const adminRouter = withMiddleware([authCheck], {
  deleteUser: mutation()
    .input(z.string())
    .handler((id) => db.users.delete(id)),
});

// Per-procedure middleware
const sensitiveQuery = query()
  .use(authCheck)
  .input(z.object({ secret: z.string() }))
  .handler(({ secret }) => decrypt(secret));
```

## Window Scoping

Restrict procedures to specific windows using a role-based registry:

```typescript
import { createWindowRegistry, scope, createServer } from 'etrpc/main';

const registry = createWindowRegistry();

// Register windows by role when they're created
const mainWin = new BrowserWindow();
registry.register('main', mainWin.webContents.id);

const settingsWin = new BrowserWindow();
registry.register('settings', settingsWin.webContents.id);

// Scope procedures to specific window roles
const settingsRouter = {
  getPreferences: query()
    .use(scope({ roles: ['settings'], registry }))
    .handler(() => loadPreferences()),
};

// Or use a custom predicate
const adminOnly = scope({
  allow: (webContentsId) => isAdminWindow(webContentsId),
});
```

## Error Handling

```typescript
import { RpcError, RpcErrorCode } from 'etrpc/main';

const secured = query().handler((_, ctx) => {
  throw new RpcError(RpcErrorCode.UNAUTHORIZED, 'Forbidden');
});

// On the client side
try {
  await client.queries.secured();
} catch (err) {
  if (err instanceof RpcError) {
    console.log(err.code);    // 'UNAUTHORIZED'
    console.log(err.message); // 'Forbidden'
  }
}
```

Error codes: `VALIDATION_ERROR`, `HANDLER_ERROR`, `NOT_FOUND`, `TIMEOUT`, `UNAUTHORIZED`, `INTERNAL`.

## Entry Points

| Import              | Environment | Description                          |
| ------------------- | ----------- | ------------------------------------ |
| `etrpc/main`        | Main        | Server, builders, middleware, scoping |
| `etrpc/preload`     | Preload     | Bridge for `contextBridge`           |
| `etrpc/renderer`    | Renderer    | Typed proxy client                   |
| `etrpc/react`       | Renderer    | React hooks                          |

## License

MIT
