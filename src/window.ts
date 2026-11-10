/**
 * Native window process: shows the UI served by the main process in the system webview
 * (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux).
 *
 * It runs as a child process so that a webview crash or a missing system library never takes
 * down the Bluetooth and fan side. Exit codes: 0 = window closed by the user,
 * WEBVIEW_UNAVAILABLE = no usable webview, the parent falls back to the browser.
 */
import { type ChildMessage, type ParentMessage, WEBVIEW_UNAVAILABLE } from './window-protocol.ts';

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: window <url>');
    process.exit(2);
  }
  const origin = new URL(url).origin;

  let webview: typeof import('@webviewjs/webview');
  try {
    webview = await import('@webviewjs/webview');
  } catch (err) {
    console.error(`[wattpure] native window unavailable: ${(err as Error).message}`);
    process.exit(WEBVIEW_UNAVAILABLE);
  }

  let app: InstanceType<typeof webview.Application>;
  let win: ReturnType<typeof app.createBrowserWindow>;
  try {
    app = new webview.Application();
    if (process.platform === 'darwin') {
      // Without an app menu, macOS shortcuts (copy/paste in fields, Cmd+Q) do not work.
      app.setMenu({
        items: [
          { label: 'WattPure', submenu: { items: [{ role: 'hide' }, { role: 'hideothers' }, { role: 'showall' }, { role: 'separator' }, { role: 'quit' }] } },
          {
            label: 'Edit',
            submenu: { items: [{ role: 'undo' }, { role: 'redo' }, { role: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectall' }] },
          },
          { label: 'Window', submenu: { items: [{ role: 'minimize' }, { role: 'close' }] } },
        ],
      });
    }
    win = app.createBrowserWindow({ title: 'WattPure', width: 480, height: 840, logical: true });
    win.setMinSize(380, 560, true);
    win.createWebview({
      url,
      enableDevtools: Boolean(process.env.WATTPURE_DEVTOOLS),
      // Links leaving the app open in the default browser instead of replacing the UI.
      navigationHandler: (target) => {
        if (target.startsWith(origin)) return true;
        process.send?.({ open: target } satisfies ChildMessage);
        return false;
      },
      newWindowHandler: (event) => {
        const target = (event as { url?: string }).url;
        if (target) process.send?.({ open: target } satisfies ChildMessage);
        return false;
      },
    });
  } catch (err) {
    console.error(`[wattpure] cannot open the native window: ${(err as Error).message}`);
    process.exit(WEBVIEW_UNAVAILABLE);
  }

  app.on('application-close-requested', () => {
    app.exit();
    process.exit(0);
  });
  process.on('message', (message: ParentMessage) => {
    if (message === 'focus') win.focus();
  });
  process.on('disconnect', () => process.exit(0)); // the main process is gone
  app.run();
}

void main();
