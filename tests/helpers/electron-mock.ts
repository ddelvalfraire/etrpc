/**
 * Mock Electron IPC environment for testing without a real Electron process.
 *
 * Wires together MockIpcMain, MockIpcRenderer, MockWebContents, and MockContextBridge
 * so that `ipcRenderer.invoke` triggers `ipcMain.handle` handlers, and
 * `webContents.send` triggers `ipcRenderer.on` listeners.
 */

import { EventEmitter } from "events";

// =============================================================================
// MockWebContents
// =============================================================================

export class MockWebContents extends EventEmitter {
  readonly id: number;
  private _destroyed = false;
  private _sentMessages: Array<{ channel: string; args: unknown[] }> = [];

  constructor(id: number) {
    super();
    this.id = id;
  }

  send(channel: string, ...args: unknown[]): void {
    if (this._destroyed) {
      throw new Error("WebContents is destroyed");
    }
    this._sentMessages.push({ channel, args });
    // This will be wired to MockIpcRenderer in createMockElectron()
    this.emit("__internal_send__", channel, ...args);
  }

  isDestroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    this._destroyed = true;
    this.emit("destroyed");
  }

  simulateCrash(): void {
    this.emit("render-process-gone", {}, { reason: "crashed" });
  }

  getSentMessages(): Array<{ channel: string; args: unknown[] }> {
    return this._sentMessages;
  }

  clearSentMessages(): void {
    this._sentMessages = [];
  }
}

// =============================================================================
// MockIpcMain
// =============================================================================

interface MockIpcEvent {
  sender: MockWebContents;
}

type HandleFn = (event: MockIpcEvent, ...args: unknown[]) => Promise<unknown> | unknown;
type OnFn = (event: MockIpcEvent, ...args: unknown[]) => void;

export class MockIpcMain extends EventEmitter {
  private _handlers = new Map<string, HandleFn>();

  handle(channel: string, handler: HandleFn): void {
    if (this._handlers.has(channel)) {
      throw new Error(`Handler already registered for channel: ${channel}`);
    }
    this._handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this._handlers.delete(channel);
  }

  /** Called by MockIpcRenderer.invoke() */
  async __invokeHandler__(
    channel: string,
    event: MockIpcEvent,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = this._handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for channel: ${channel}`);
    }
    return handler(event, ...args);
  }

  /** Check if a handler is registered */
  hasHandler(channel: string): boolean {
    return this._handlers.has(channel);
  }
}

// =============================================================================
// MockIpcRenderer
// =============================================================================

export class MockIpcRenderer extends EventEmitter {
  private _ipcMain: MockIpcMain;
  private _webContents: MockWebContents;

  constructor(ipcMain: MockIpcMain, webContents: MockWebContents) {
    super();
    this._ipcMain = ipcMain;
    this._webContents = webContents;

    // Wire webContents.send → ipcRenderer listeners
    webContents.on("__internal_send__", (channel: string, ...args: unknown[]) => {
      this.emit(channel, {}, ...args);
    });
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const event = {
      sender: this._webContents,
      senderFrame: {},
    };
    return this._ipcMain.__invokeHandler__(channel, event, ...args);
  }

  send(channel: string, ...args: unknown[]): void {
    const event = {
      sender: this._webContents,
      senderFrame: {},
    };
    // Trigger ipcMain.on listeners
    this._ipcMain.emit(channel, event, ...args);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    return super.removeListener(event, listener);
  }
}

// =============================================================================
// MockContextBridge
// =============================================================================

export class MockContextBridge {
  private _exposed = new Map<string, unknown>();

  exposeInMainWorld(apiKey: string, api: unknown): void {
    this._exposed.set(apiKey, api);
    // Simulate what contextBridge does: make it available on globalThis
    (globalThis as Record<string, unknown>)[apiKey] = api;
  }

  getExposed(apiKey: string): unknown {
    return this._exposed.get(apiKey);
  }
}

// =============================================================================
// Factory
// =============================================================================

export interface MockElectron {
  ipcMain: MockIpcMain;
  ipcRenderer: MockIpcRenderer;
  webContents: MockWebContents;
  contextBridge: MockContextBridge;
  /** Create an additional webContents (simulates multiple windows) */
  createWebContents: () => { webContents: MockWebContents; ipcRenderer: MockIpcRenderer };
}

/**
 * Create a fully wired mock Electron environment.
 *
 * @param webContentsId - ID for the primary webContents (default: 1)
 */
export function createMockElectron(webContentsId = 1): MockElectron {
  const ipcMain = new MockIpcMain();
  const webContents = new MockWebContents(webContentsId);
  const ipcRenderer = new MockIpcRenderer(ipcMain, webContents);
  const contextBridge = new MockContextBridge();

  let nextId = webContentsId + 1;

  return {
    ipcMain,
    ipcRenderer,
    webContents,
    contextBridge,
    createWebContents: () => {
      const wc = new MockWebContents(nextId++);
      const renderer = new MockIpcRenderer(ipcMain, wc);
      return { webContents: wc, ipcRenderer: renderer };
    },
  };
}
