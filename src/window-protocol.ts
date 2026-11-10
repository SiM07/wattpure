/** Contract between the main process and the native window process (window.ts). */

/** Exit code of the window process when no usable webview exists: the app falls back to the browser. */
export const WEBVIEW_UNAVAILABLE = 3;

/** Main process -> window. */
export type ParentMessage = 'focus';

/** Window -> main process: open a link in the default browser. */
export interface ChildMessage {
  open: string;
}
