// Offline validation: only tsx parent IPC and HTTP servers owned by this test process.
const { syncBuiltinESMExports } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const deny = () => { throw new Error("OFFLINE_ONLY: network/provider/database access prohibited"); };
const id = process.geteuid ? process.geteuid() : os.userInfo().username;
const parentPipe = path.join(os.tmpdir(), `tsx-${id}`, `${process.ppid}.pipe`);
const slash = String.fromCharCode(92);
const allowedPipe = process.platform === "win32" ? slash.repeat(2) + "?" + slash + "pipe" + slash + parentPipe : parentPipe;
const ownedHttpPorts = new Set();
const http = require("node:http");
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  let port;
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address !== "string") { port = address.port; ownedHttpPorts.add(port); }
  });
  this.once("close", () => ownedHttpPorts.delete(port));
  return originalListen.apply(this, args);
};
const isOwned = (host, port) => ["127.0.0.1", "::1", "localhost"].includes(host) && ownedHttpPorts.has(Number(port));
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const target = typeof options === "string" ? options : options?.path;
  if (options && typeof options === "object" && isOwned(options.host || options.hostname, options.port)) return originalConnect.apply(this, args);
  if (target === allowedPipe) return originalConnect.apply(this, args);
  return deny();
};
require("node:tls").connect = deny;
for (const name of ["node:http", "node:https"]) {
  require(name).request = deny;
  require(name).get = deny;
}
require("node:dgram").Socket.prototype.send = deny;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.protocol === "http:" && isOwned(url.hostname, url.port)) return originalFetch(input, options);
  return deny();
};
syncBuiltinESMExports();
