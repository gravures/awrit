import { installExtension } from 'electron-chrome-web-store';
import { app } from 'electron';
import { sessionPromise } from './session';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import path from 'node:path';

const CHROME_WEB_STORE_EXTENSIONS = [
  // uBlock Origin Lite
  'ddkjiahejlhfcafbddmgiahcphecmpfh',
];

export const extensionsPromise = sessionPromise.then((session) => {
  return new ElectronChromeExtensions({
    session,
    license: 'GPL-3.0',
    // __dirname is inlined at build time to the build machine's source tree
    // (Bun --root src), so it cannot locate the package at runtime. The
    // preload is shipped beside the app (bundle_electron, and the dev runner)
    // and located through the runtime app directory instead.
    modulePath: path.join(app.getAppPath(), 'electron-chrome-extensions'),
  });
});

export const installedExtensionsPromise = sessionPromise.then((session) =>
  Promise.allSettled(CHROME_WEB_STORE_EXTENSIONS.map((id) => installExtension(id, { session }))),
);
