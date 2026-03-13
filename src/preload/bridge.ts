import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/types";
import type {
  PreloadBridge,
  InvokePayload,
  SubscribePayload,
  UnsubscribePayload,
  SubscriptionMessage,
} from "../shared/types";

/**
 * Create and expose the IPC bridge in the preload script.
 *
 * @example
 * ```typescript
 * import { createPreloadBridge } from 'etrpc/preload';
 * createPreloadBridge();
 * ```
 */
export function createPreloadBridge(apiKey: string = "__etrpc"): void {
  const bridge: PreloadBridge = {
    invoke(payload: InvokePayload): Promise<unknown> {
      return ipcRenderer.invoke(IPC_CHANNELS.INVOKE, payload);
    },

    subscribe(payload: SubscribePayload): void {
      ipcRenderer.send(IPC_CHANNELS.SUBSCRIBE, payload);
    },

    unsubscribe(payload: UnsubscribePayload): void {
      ipcRenderer.send(IPC_CHANNELS.UNSUBSCRIBE, payload);
    },

    onSubscriptionMessage(
      callback: (message: SubscriptionMessage) => void,
    ): () => void {
      const listener = (_event: Electron.IpcRendererEvent, message: SubscriptionMessage): void => {
        callback(message);
      };

      ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, listener);

      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.SUBSCRIPTION_MESSAGE, listener);
      };
    },
  };

  contextBridge.exposeInMainWorld(apiKey, bridge);
}
