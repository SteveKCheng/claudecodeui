import fs from 'node:fs';
import type { Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';

const UNIX_SOCKET_PREFIX = 'unix:';
const DEFAULT_HOST = '0.0.0.0';
// sd_listen_fds(3): passed sockets start at file descriptor 3.
const SD_LISTEN_FDS_START = 3;

/**
 * Where the HTTP server accepts connections, as selected by `HOST` (or `--host`).
 *
 * - `unix:/absolute/path.sock` listens on a Unix domain socket; the port is unused.
 * - `localhost` listens on both 127.0.0.1 and ::1. A dual-stack socket only accepts
 *   IPv4 when it is bound to the `::` wildcard, so serving both loopback addresses
 *   without listening on every interface takes one socket per address family.
 * - Any other value is a single address (or hostname) passed to `listen()` as is.
 *
 * When systemd socket activation passes listening sockets in, those are used
 * instead (`fds`), and HOST and the port are not consulted.
 *
 * Consumed by the server bootstrap (server/index.ts), which picks the target
 * once at startup and reports it in startup messages and the local-server marker.
 */
export type ListenTarget =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tcp'; hosts: string[]; port: number }
  | { kind: 'fds'; sockets: InheritedSocket[] };

/** A listening socket passed in by systemd, with its FileDescriptorName= if any. */
type InheritedSocket = { fd: number; name?: string };

type SocketActivation =
  | { sockets: InheritedSocket[] }
  | { ignored: string };

let activeListenTarget: ListenTarget | null = null;

/**
 * The target the server is listening on, once listenOnTarget() has succeeded.
 * Used by the Browser Use module, which must not re-read HOST and the port: with
 * socket activation those do not say where the server is.
 */
export function getActiveListenTarget(): ListenTarget | null {
  return activeListenTarget;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

/**
 * Reads systemd socket activation from the environment, following
 * sd_listen_fds(3): the sockets are only ours when LISTEN_PID is this process.
 * The variables are removed either way, so processes spawned later (agents get
 * the server's whole environment) do not see them. Returns null when the
 * server was not socket-activated, and the reason when activation is ignored.
 * Called once by the server bootstrap, before anything is spawned.
 */
export function takeSocketActivation(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): SocketActivation | null {
  const { LISTEN_FDS: count, LISTEN_PID: listenPid, LISTEN_FDNAMES: names } = env;
  delete env.LISTEN_FDS;
  delete env.LISTEN_PID;
  delete env.LISTEN_FDNAMES;
  // Newer systemd also identifies the receiving process by pidfd inode.
  delete env.LISTEN_PIDFDID;

  if (count === undefined) {
    return null;
  }
  if (listenPid === undefined || Number(listenPid) !== pid) {
    return { ignored: `LISTEN_PID is ${listenPid ?? 'unset'}, not this process (${pid})` };
  }
  const socketCount = Number(count);
  if (!Number.isInteger(socketCount) || socketCount < 1) {
    return { ignored: `LISTEN_FDS is not a positive number: ${count}` };
  }

  const nameList = names?.split(':') ?? [];
  return {
    sockets: Array.from({ length: socketCount }, (_, index) => ({
      fd: SD_LISTEN_FDS_START + index,
      ...(nameList[index] ? { name: nameList[index] } : {}),
    })),
  };
}

function readProcNetTable(file: string): string[][] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(1)
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/));
  } catch {
    return [];
  }
}

/** Formats a /proc/net/tcp{,6} address (`0100007F:0BB9`) as `127.0.0.1:3001` or `[::1]:3001`. */
function formatProcNetAddress(value: string, ipv6: boolean): string {
  const [hexAddress, hexPort] = value.split(':');
  const port = Number.parseInt(hexPort, 16);
  // The address is stored as 32-bit words in host (little-endian) byte order.
  const bytes = (hexAddress.match(/.{8}/g) ?? [])
    .flatMap((word) => (word.match(/../g) ?? []).reverse())
    .map((byte) => Number.parseInt(byte, 16));
  if (!ipv6) {
    return `${bytes.join('.')}:${port}`;
  }
  const groups = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2] << 8) | bytes[index * 2 + 1]).toString(16));
  // The URL parser puts an IPv6 address in its canonical, compressed form.
  return `${new URL(`http://[${groups.join(':')}]`).hostname}:${port}`;
}

/**
 * Best-effort address of an inherited socket, for startup messages: Node reports
 * no address for a server listening on a passed-in descriptor. The socket is
 * looked up by inode in /proc/net, which only lists sockets of this network
 * namespace; one created outside it is reported by inode alone.
 */
function locateInheritedSocket(fd: number): string {
  let link: string;
  try {
    link = fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return 'not open';
  }
  const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
  if (!inode) {
    return `not a socket (${link})`;
  }

  const unixRow = readProcNetTable('/proc/net/unix').find((columns) => columns[6] === inode);
  if (unixRow) {
    return unixRow[7] ? `${UNIX_SOCKET_PREFIX}${unixRow[7]}` : 'unnamed Unix socket';
  }
  for (const [file, ipv6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]] as const) {
    const tcpRow = readProcNetTable(file).find((columns) => columns[9] === inode);
    if (tcpRow) {
      return `tcp ${formatProcNetAddress(tcpRow[1], ipv6)}`;
    }
  }
  return `socket inode ${inode}, not visible in this network namespace`;
}

/**
 * Parses the configured host into a listen target. Throws on an unusable value.
 * Used by the server bootstrap to choose where to listen, and by the Browser Use
 * module as a fallback before the server has started listening.
 */
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

/**
 * Human-facing address for startup messages: a browser URL, `unix:<path>`, or
 * the sockets systemd passed in. Used by the server bootstrap for its startup
 * log and the local-server marker.
 */
export function describeListenTarget(target: ListenTarget): string {
  if (target.kind === 'unix') {
    return `${UNIX_SOCKET_PREFIX}${target.socketPath}`;
  }
  if (target.kind === 'fds') {
    const sockets = target.sockets.map(({ fd, name }) => `fd ${fd}${name ? ` "${name}"` : ''} = ${locateInheritedSocket(fd)}`);
    return `systemd socket activation: ${sockets.join(', ')}`;
  }
  const [host] = target.hosts;
  const isLocal = target.hosts.length > 1 || ['0.0.0.0', '::', '127.0.0.1', '::1'].includes(host);
  return `http://${isLocal ? 'localhost' : formatHostForUrl(host)}:${target.port}`;
}

/**
 * Origin that processes on this machine can use to reach the server over TCP, or
 * null when the server only listens on a Unix socket or on sockets passed in by
 * systemd (whose addresses it does not know). Wildcards and `localhost` resolve
 * to 127.0.0.1, which both an IPv4 wildcard and a dual-stack `::` accept.
 * Used by the Browser Use module to build the callback URL for its MCP process.
 */
export function getLocalOrigin(target: ListenTarget): string | null {
  if (target.kind !== 'tcp') {
    return null;
  }
  const [host] = target.hosts;
  const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${formatHostForUrl(connectHost)}:${target.port}`;
}

function listenOnce(server: net.Server, ...listenArguments: [string] | [number, string] | [{ fd: number }]): Promise<void> {
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

function relayTo(server: Server): net.Server {
  const relay = net.createServer((socket) => server.emit('connection', socket));
  server.once('close', () => relay.close());
  return relay;
}

/**
 * Starts `server` listening on `target`. Extra addresses (the ::1 half of
 * `localhost`, or every passed-in socket after the first) get a plain listener
 * that hands each connection to `server`, so HTTP and WebSocket upgrades
 * behave the same on every address. An address family the machine does not
 * support is skipped with a warning. Passed-in sockets are accepted on as
 * they are, without binding. Called once by the server bootstrap.
 */
export async function listenOnTarget(
  server: Server,
  target: ListenTarget,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  await listenOnTargetUnrecorded(server, target, warn);
  activeListenTarget = target;
}

async function listenOnTargetUnrecorded(
  server: Server,
  target: ListenTarget,
  warn: (message: string) => void,
): Promise<void> {
  if (target.kind === 'unix') {
    await removeStaleUnixSocket(target.socketPath);
    await listenOnce(server, target.socketPath);
    return;
  }

  if (target.kind === 'fds') {
    const [primary, ...extra] = target.sockets;
    await listenOnce(server, { fd: primary.fd });
    for (const { fd } of extra) {
      await listenOnce(relayTo(server), { fd });
    }
    return;
  }

  const [primaryHost, ...extraHosts] = target.hosts;
  await listenOnce(server, target.port, primaryHost);
  const { port } = server.address() as AddressInfo;

  for (const host of extraHosts) {
    try {
      await listenOnce(relayTo(server), port, host);
    } catch (error) {
      const code = getErrorCode(error);
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
        warn(`[WARN] Not listening on ${host}: ${code}`);
        continue;
      }
      server.close();
      throw error;
    }
  }
}
