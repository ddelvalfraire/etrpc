# Implementation Tickets

Each ticket is self-contained and can be worked on independently once its dependencies are met. Tickets are organized by package and sized for a single work session.

## Dependencies Graph

```
                    SHARED TYPES (done)
                    ┌─────┴─────┐
                    │           │
              ┌─────▼───┐ ┌────▼────┐
              │ Builders│ │ Preload │
              │ (done)  │ │  P-1    │
              └────┬────┘ └────┬────┘
                   │           │
              ┌────▼────┐ ┌────▼────┐
              │ Server  │ │ Client  │
              │  M-1    │ │  R-1    │
              └────┬────┘ └────┬────┘
                   │           │
              ┌────▼───────────▼────┐
              │    React Hooks      │
              │  H-1, H-2, H-3     │
              └─────────────────────┘
                        │
              ┌─────────▼──────────┐
              │   Integration      │
              │  Tests: T-4, T-5   │
              └────────────────────┘
```

---

## Package: shared (DONE)

### S-1: Core Type Definitions ✅
**File:** `src/shared/types.ts`
**Status:** Complete
- All procedure types, handler signatures, client types, server types
- Wire protocol messages, error types, preload bridge interface
- IPC channel constants

---

## Package: main/builders (DONE)

### B-1: Query Builder ✅
**File:** `src/main/builders/query.ts`
**Status:** Complete

### B-2: Mutation Builder ✅
**File:** `src/main/builders/mutation.ts`
**Status:** Complete

### B-3: Subscription Builder ✅
**File:** `src/main/builders/subscription.ts`
**Status:** Complete

---

## Package: main

### M-1: IPC Server
**File:** `src/main/server.ts`
**Priority:** Critical — blocks R-1, H-*, T-4
**Depends on:** S-1, B-*
**Estimated effort:** Large

**Requirements:**
1. Register `ipcMain.handle(IPC_CHANNELS.INVOKE, handler)` for queries/mutations
   - Parse incoming `InvokePayload`
   - Look up procedure by `path` in the router
   - Validate `procedure._type` matches `payload.type`
   - Call `procedure._inputSchema.parse(payload.input)` for runtime validation
   - Call `procedure.handler(validatedInput, ctx)` with a `QueryContext` or `MutationContext`
   - Return the result (serialized automatically by Electron)
   - On Zod validation error: throw `RpcError(VALIDATION_ERROR, message, zodIssues)`
   - On handler error: throw `RpcError(HANDLER_ERROR, message)`
   - On unknown path: throw `RpcError(NOT_FOUND, "Procedure not found: {path}")`

2. Register `ipcMain.on(IPC_CHANNELS.SUBSCRIBE, handler)` for subscription-start
   - Parse incoming `SubscribePayload`
   - Look up subscription procedure by `path`
   - Validate input with `_inputSchema.parse()`
   - Create `emit` and `emitError` closures bound to this subscription ID
   - `emit` must check `!sender.isDestroyed()` before sending
   - Call handler, store cleanup function in `activeSubscriptions` Map
   - Map key: subscription ID. Map value: `{ path, webContentsId, cleanup }`

3. Register `ipcMain.on(IPC_CHANNELS.UNSUBSCRIBE, handler)` for subscription-stop
   - Look up subscription by ID
   - Call cleanup function if it exists
   - Remove from `activeSubscriptions`

4. Build `emitters` object for external broadcast
   - For each subscription procedure in the router, create a `BroadcastEmitter<TOutput>`
   - The emitter iterates `activeSubscriptions` matching the path
   - Checks `isDestroyed()` before sending
   - Supports optional `targetWebContentsIds` filter
   - Emitter must be strongly typed (no `as any`)

5. Automatic cleanup on webContents destruction
   - When a subscription is registered, also register a one-time listener on `webContents.on('destroyed')`
   - On destroy: clean up ALL subscriptions for that webContents
   - Also listen to `webContents.on('render-process-gone')` for crash recovery
   - Use a `Set<number>` to track which webContents IDs have already been registered for cleanup

6. Return `{ emitters, cleanup }`
   - `cleanup()` calls all subscription cleanup functions, clears the map, removes IPC handlers

**Test file:** `tests/unit/main/server.test.ts`

**Acceptance criteria:**
- [ ] Queries resolve with correct data
- [ ] Mutations resolve with correct data
- [ ] Invalid input throws `RpcError` with `VALIDATION_ERROR` code and Zod issues
- [ ] Unknown path throws `RpcError` with `NOT_FOUND`
- [ ] Handler errors are caught and serialized as `RpcError(HANDLER_ERROR)`
- [ ] Subscriptions receive data via `emit()`
- [ ] Subscriptions receive errors via `emitError()`
- [ ] External emitters push data to all matching subscribers
- [ ] External emitters with `targetWebContentsIds` filter correctly
- [ ] Unsubscribe calls cleanup function
- [ ] WebContents destruction cleans up all subscriptions for that sender
- [ ] Renderer crash (`render-process-gone`) cleans up subscriptions
- [ ] `cleanup()` tears down everything
- [ ] No `as any` casts in the implementation

---

## Package: preload

### P-1: Preload Bridge
**File:** `src/preload/bridge.ts`
**Priority:** Critical — blocks R-1
**Depends on:** S-1
**Estimated effort:** Small

**Requirements:**
1. Import `contextBridge`, `ipcRenderer` from `electron`
2. Create a `PreloadBridge` conforming object:
   - `invoke`: calls `ipcRenderer.invoke(IPC_CHANNELS.INVOKE, payload)`
   - `subscribe`: calls `ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, payload)`
   - `unsubscribe`: calls `ipcRenderer.send(IPC_CHANNELS.UNSUBSCRIBE, payload)`
   - `onSubscriptionMessage`: registers listener on `IPC_CHANNELS.SUBSCRIPTION_MESSAGE`, returns cleanup
3. Call `contextBridge.exposeInMainWorld(apiKey, bridge)`

**Test file:** `tests/unit/preload/bridge.test.ts`

**Acceptance criteria:**
- [ ] Bridge is exposed at `window[apiKey]`
- [ ] `invoke` calls `ipcRenderer.invoke` with correct channel and payload
- [ ] `subscribe` calls `ipcRenderer.send` with correct channel
- [ ] `unsubscribe` calls `ipcRenderer.send` with correct channel
- [ ] `onSubscriptionMessage` registers listener and returns cleanup function
- [ ] Cleanup function removes the listener

---

## Package: renderer

### R-1: IPC Client
**File:** `src/renderer/client.ts`
**Priority:** Critical — blocks H-*
**Depends on:** S-1, P-1
**Estimated effort:** Medium

**Requirements:**
1. Read bridge from `window.__etrpc` (or configurable key)
2. Create `queries` proxy:
   - Intercept property access with `Proxy.get`
   - Return a function that calls `bridge.invoke({ type: "query", path: propName, input })`
   - For void-input procedures, input is `undefined`
   - Catch rejected promises and reconstruct `RpcError` from serialized error
3. Create `mutations` proxy:
   - Same as queries but with `type: "mutation"`
4. Create `subscriptions` proxy:
   - Intercept property access
   - Return a function that:
     a. Generates a unique subscription ID (`crypto.randomUUID()`)
     b. Stores `{ onData, onError }` callbacks in a module-level Map
     c. Calls `bridge.subscribe({ type: "subscribe", id, path: propName, input })`
     d. Returns an `UnsubscribeFn` that sends unsubscribe and removes callbacks
5. Register a single `bridge.onSubscriptionMessage` listener on module init:
   - Route `data` messages to the correct `onData` callback
   - Route `error` messages to the correct `onError` callback (reconstruct `RpcError`)
6. Handle void inputs at the proxy level:
   - If the function is called with a single arg that has `onData`/`onError`, treat it as options (void input)
   - If called with two args, first is input, second is options

**Test file:** `tests/unit/renderer/client.test.ts`

**Acceptance criteria:**
- [ ] `api.queries.foo(input)` calls bridge.invoke with type "query"
- [ ] `api.queries.bar()` works without args (void input)
- [ ] `api.mutations.baz(input)` calls bridge.invoke with type "mutation"
- [ ] `api.subscriptions.onFoo({ onData, onError })` starts a subscription (void input)
- [ ] `api.subscriptions.onBar(input, { onData, onError })` starts with input
- [ ] Returned `UnsubscribeFn` sends unsubscribe message and cleans up callbacks
- [ ] Subscription data messages route to correct `onData`
- [ ] Subscription error messages route to correct `onError` as `RpcError`
- [ ] Invoke errors are reconstructed as `RpcError`

---

## Package: react

### H-1: useQuery Hook
**File:** `src/react/useQuery.ts`
**Priority:** High
**Depends on:** R-1
**Estimated effort:** Small

**Requirements:**
1. Accept function ref + optional input + optional options
2. Call function on mount (if `enabled !== false`)
3. Track `data`, `error`, `isLoading` state
4. Re-fetch when serialized input changes
5. Expose `refetch()` that re-calls the function
6. Handle void-input overload (no input arg)
7. Prevent stale closures (track latest request ID, discard stale results)

**Test file:** `tests/unit/react/useQuery.test.ts`

**Acceptance criteria:**
- [ ] Fetches on mount and resolves `data`
- [ ] Sets `isLoading` during fetch
- [ ] Sets `error` on rejection
- [ ] Re-fetches when input changes
- [ ] Does not fetch when `enabled: false`
- [ ] `refetch()` re-calls the query
- [ ] Discards stale results from superseded calls
- [ ] Works with void-input queries (no input arg)

---

### H-2: useMutation Hook
**File:** `src/react/useMutation.ts`
**Priority:** High
**Depends on:** R-1
**Estimated effort:** Small

**Requirements:**
1. Return `[mutate, state]` tuple
2. `mutate(input)` calls the function and returns Promise
3. Track `data`, `error`, `isLoading`, `called`
4. `reset()` clears state to initial
5. Handle void-input (mutate with no args)
6. Concurrent calls: last call wins

**Test file:** `tests/unit/react/useMutation.test.ts`

**Acceptance criteria:**
- [ ] `mutate(input)` resolves and sets `data`
- [ ] Sets `isLoading` during mutation
- [ ] Sets `error` on rejection
- [ ] `called` is true after first call
- [ ] `reset()` clears all state
- [ ] Concurrent: stale results are discarded
- [ ] Works with void-input mutations

---

### H-3: useSubscription Hook
**File:** `src/react/useSubscription.ts`
**Priority:** High
**Depends on:** R-1
**Estimated effort:** Medium

**Requirements:**
1. Subscribe on mount, unsubscribe on unmount
2. Re-subscribe when serialized input changes
3. Track `data`, `error`, `status` ("idle" | "loading" | "active" | "error")
4. `enabled` option to defer subscription
5. Forward `onData` / `onError` callbacks
6. Prevent stale callbacks via `isUnsubscribed` flag
7. Handle void-input overload

**Test file:** `tests/unit/react/useSubscription.test.ts`

**Acceptance criteria:**
- [ ] Subscribes on mount
- [ ] Unsubscribes on unmount
- [ ] Re-subscribes when input changes
- [ ] Sets `status` correctly through lifecycle
- [ ] `data` updates on each emission
- [ ] `error` set and `status` = "error" on emitError
- [ ] `enabled: false` prevents subscription
- [ ] `onData` callback is called
- [ ] `onError` callback is called
- [ ] Stale callbacks after unmount do not update state
- [ ] Works with void-input subscriptions

---

## Testing

### T-1: Type Safety Tests
**File:** `tests/types/type-safety.test.ts`
**Priority:** Critical
**Depends on:** S-1, B-*
**Estimated effort:** Medium

**Requirements — compile-time tests using `expectTypeOf` or `@ts-expect-error`:**
1. Query with input: client function requires the correct input type
2. Query without input: client function accepts zero arguments
3. Mutation with input: same as query
4. Mutation without input: same as query
5. Subscription with input: function requires input + options
6. Subscription without input: function requires only options
7. `InferInput<T>` correctly extracts input type
8. `InferOutput<T>` correctly extracts output type
9. Wrong input type: `@ts-expect-error`
10. Wrong procedure type: `api.queries.someMutation` should not exist
11. Subscription `onData` callback receives correctly typed data
12. Server emitters are typed: `emitters.onTick({ count: 1 })` works, `emitters.onTick("wrong")` errors
13. Router type inference: `typeof router` carries all procedure types

---

### T-2: Builder Unit Tests
**File:** `tests/unit/builders.test.ts`
**Priority:** High
**Depends on:** B-*
**Estimated effort:** Small

**Requirements:**
1. `query().handler(fn)` produces `{ _type: "query", _inputSchema: ZodVoid }`
2. `query().input(z.string()).handler(fn)` produces correct input schema
3. `mutation()` — same tests as query
4. `subscription().output(schema).handler(fn)` produces correct output schema
5. `subscription().input(schema).output(schema).handler(fn)` produces both schemas
6. Handler functions are stored correctly and callable
7. `.input()` cannot be called after `.handler()` (compile-time, via type test)

---

### T-3: Error Handling Tests
**File:** `tests/unit/errors.test.ts`
**Priority:** High
**Depends on:** S-1
**Estimated effort:** Small

**Requirements:**
1. `RpcError` constructor sets `code`, `message`, `data`
2. `RpcError.serialize()` produces correct `SerializedError`
3. `RpcError.fromSerialized()` reconstructs from serialized form
4. Round-trip: `serialize → fromSerialized` preserves all fields
5. `RpcError` is an instance of `Error`
6. `RpcError.name` is `"RpcError"`

---

### T-4: Integration — Query/Mutation Round-Trip
**File:** `tests/integration/query-mutation.test.ts`
**Priority:** Critical
**Depends on:** M-1, P-1, R-1
**Estimated effort:** Large

**Requirements:**
- Mock Electron IPC in a test environment (create mock ipcMain, ipcRenderer, webContents)
- Full round-trip: define router → createServer → createClient → call query → verify result
- Test Zod validation errors propagate correctly
- Test handler errors propagate correctly
- Test void-input procedures
- Test with complex input/output types (nested objects, arrays, enums)

---

### T-5: Integration — Subscription Round-Trip
**File:** `tests/integration/subscription.test.ts`
**Priority:** Critical
**Depends on:** M-1, P-1, R-1
**Estimated effort:** Large

**Requirements:**
- Full round-trip: define subscription → createServer → createClient → subscribe → emit → verify
- Test multiple subscribers to same path
- Test external emitter broadcast
- Test targeted broadcast (specific webContents)
- Test unsubscribe calls cleanup
- Test webContents destruction triggers cleanup
- Test emitError propagation
- Test void-input subscriptions

---

### T-6: Electron IPC Mocks
**File:** `tests/helpers/electron-mock.ts`
**Priority:** Critical — blocks T-4, T-5
**Depends on:** None
**Estimated effort:** Medium

**Requirements:**
Create a mock Electron IPC environment for testing without a real Electron process:

1. `MockIpcMain` — implements `handle()`, `on()`, `removeHandler()`, `removeAllListeners()`
2. `MockIpcRenderer` — implements `invoke()`, `send()`, `on()`, `removeListener()`
3. `MockWebContents` — implements `send()`, `isDestroyed()`, `id`, event emitter for `destroyed` and `render-process-gone`
4. Wire them together so `ipcRenderer.invoke` triggers `ipcMain.handle` and vice versa
5. `MockContextBridge` — implements `exposeInMainWorld()`

---

## Non-Functional Requirements

### NFR-1: Zero `as any` Casts
Every file must compile with `strict: true` and contain zero `as any` casts.
The only exception is the phantom `_outputType` field which uses `undefined as unknown as TOutput`.

### NFR-2: Bundle Size
The library must be <5kb min+gzip per entry point (main, renderer, preload, react).

### NFR-3: No Runtime Dependencies
Zero dependencies beyond peer deps (electron, zod, react).

### NFR-4: Tree-Shakeable
Each entry point must be tree-shakeable. No side effects at module level (except the subscription message listener in the renderer, which is lazy-initialized).

### NFR-5: Memory Safety
- No subscription leaks: every `subscribe` must have a corresponding cleanup path
- Pending promises must not accumulate (invoke/handle has built-in cleanup)
- WebContents destruction must clean up all associated state
