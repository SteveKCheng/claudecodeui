import fs from 'node:fs';
import type { Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';

const UNIX_SOCKET_PREFIX = 'unix:';
const DEFAULT_HOST = '0.0.0.0';

/**
 * Where the HTTP server accepts connections, as selected by `HOST` (or `--host`).
 *
 * - `unix:/absolute/path.sock` listens on a Unix domain socket; the port is unused.
 * - `localhost` listens on both 127.0.0.1 and ::1. A dual-stack socket only accepts
 *   IPv4 when it is bound to the `::` wildcard, so serving both loopback addresses
 *   without listening on every interface takes one socket per address family.
 * - Any other value is a single address (or hostname) passed to `listen()` as is.
 */
export type ListenTarget =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tcp'; hosts: string[]; port: number };

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

/** Parses the configured host into a listen target. Throws on an unusable value. */
export function parseListenTarget(host: string | undefined, port: number): ListenTarget {
  const value = host?.trim() || DEFAULT_HOST;

  if (value.startsWith(UNIX_SOCKET_PREFIX)) {
    const socketPath = value.slice(UNIX_SOCKET_PREFIX.length);
    if (!path.isAbsolute(socketPath)) {
      throw new Error(`Unix socket path must be absolute: ${value}`);
    }
    return { kind: 'unix', socketPath };
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid server port: ${port}`);
  }

  if (value === 'localhost') {
    return { kind: 'tcp', hosts: ['127.0.0.1', '::1'], port };
  }
  return { kind: 'tcp', hosts: [stripBrackets(value)], port };
}

/** Human-facing address for startup messages: a browser URL, or `unix:<path>`. */
export function describeListenTarget(target: ListenTarget): string {
  if (target.kind === 'unix') {
    return `${UNIX_SOCKET_PREFIX}${target.socketPath}`;
  }
  const [host] = target.hosts;
  const isLocal = target.hosts.length > 1 || ['0.0.0.0', '::', '127.0.0.1', '::1'].includes(host);
  return `http://${isLocal ? 'localhost' : formatHostForUrl(host)}:${target.port}`;
}

/**
 * Origin that processes on this machine can use to reach the server over TCP, or
 * null when the server only listens on a Unix socket. Wildcards and `localhost`
 * resolve to 127.0.0.1, which both an IPv4 wildcard and a dual-stack `::` accept.
 */
export function getLocalOrigin(target: ListenTarget): string | null {
  if (target.kind === 'unix') {
    return null;
  }
  const [host] = target.hosts;
  const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${formatHostForUrl(connectHost)}:${target.port}`;
}

function listenOnce(server: net.Server, ...listenArguments: [string] | [number, string]): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(...(listenArguments as [number, string]), () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * Removes a socket file left behind by a server that did not shut down cleanly.
 * Refuses to touch anything that is not a socket, or a socket something still
 * accepts connections on.
 */
async function removeStaleUnixSocket(socketPath: string): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(socketPath);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (!stats.isSocket()) {
    throw new Error(`Refusing to replace ${socketPath}: it exists and is not a socket`);
  }

  const inUse = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (inUse) {
    throw new Error(`Another server is already listening on ${socketPath}`);
  }
  fs.unlinkSync(socketPath);
}

/**
 * Starts `server` listening on `target`. Extra TCP addresses (the ::1 half of
 * `localhost`) get a plain listener that hands each connection to `server`, so
 * HTTP and WebSocket upgrades behave the same on every address. An address
 * family the machine does not support is skipped with a warning.
 */
export async function listenOnTarget(
  server: Server,
  target: ListenTarget,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  if (target.kind === 'unix') {
    await removeStaleUnixSocket(target.socketPath);
    await listenOnce(server, target.socketPath);
    return;
  }

  const [primaryHost, ...extraHosts] = target.hosts;
  await listenOnce(server, target.port, primaryHost);
  const { port } = server.address() as AddressInfo;

  for (const host of extraHosts) {
    const relay = net.createServer((socket) => server.emit('connection', socket));
    try {
      await listenOnce(relay, port, host);
    } catch (error) {
      const code = getErrorCode(error);
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
        warn(`[WARN] Not listening on ${host}: ${code}`);
        continue;
      }
      server.close();
      throw error;
    }
    server.once('close', () => relay.close());
  }
}
