// ---------------------------------------------------------------------------
// Chromium proxy port state — shared module that avoids circular dependencies.
// Set by server.js (from Electron main process), read by urlImportService.js.
// ---------------------------------------------------------------------------

let chromiumProxyPort = null;

export function getChromiumProxyPort() {
  return chromiumProxyPort;
}

export function setChromiumProxyPort(port) {
  chromiumProxyPort = port;
}
