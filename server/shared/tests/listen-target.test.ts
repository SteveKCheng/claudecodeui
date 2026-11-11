import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  describeListenTarget,
  getLocalOrigin,
  listenOnTarget,
  parseListenTarget,
  takeSocketActivation,
} from '@/shared/listen-target.js';

const LISTEN_TARGET_MODULE = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'listen-target.ts'),
).href;

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function getText(options: http.RequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(options, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'listen-target-'));
}

test('parseListenTarget keeps the upstream default and single addresses', () => {
  assert.deepEqual(parseListenTarget(undefined, 3001), { kind: 'tcp', hosts: ['0.0.0.0'], port: 3001 });
  assert.deepEqual(parseListenTarget('::1', 3001), { kind: 'tcp', hosts: ['::1'], port: 3001 });
  assert.deepEqual(parseListenTarget('[::1]', 3001), { kind: 'tcp', hosts: ['::1'], port: 3001 });
});

test('parseListenTarget expands localhost to both loopback addresses', () => {
  assert.deepEqual(parseListenTarget('localhost', 3001), { kind: 'tcp', hosts: ['127.0.0.1', '::1'], port: 3001 });
});

test('parseListenTarget accepts absolute Unix socket paths only', () => {
  assert.deepEqual(parseListenTarget('unix:/run/web.sock', 3001), { kind: 'unix', socketPath: '/run/web.sock' });
  assert.throws(() => parseListenTarget('unix:web.sock', 3001), /must be absolute/);
});

test('describeListenTarget and getLocalOrigin produce connectable addresses', () => {
  assert.equal(describeListenTarget(parseListenTarget('::', 3001)), 'http://localhost:3001');
  assert.equal(describeListenTarget(parseListenTarget('2001:db8::1', 3001)), 'http://[2001:db8::1]:3001');
  assert.equal(describeListenTarget(parseListenTarget('unix:/run/web.sock', 3001)), 'unix:/run/web.sock');

  assert.equal(getLocalOrigin(parseListenTarget('0.0.0.0', 3001)), 'http://127.0.0.1:3001');
  assert.equal(getLocalOrigin(parseListenTarget('localhost', 3001)), 'http://127.0.0.1:3001');
  assert.equal(getLocalOrigin(parseListenTarget('::1', 3001)), 'http://[::1]:3001');
  assert.equal(getLocalOrigin(parseListenTarget('unix:/run/web.sock', 3001)), null);
});

test('listenOnTarget serves localhost on both IPv4 and IPv6 loopback', async () => {
  const server = http.createServer((_request, response) => response.end('ok'));
  const warnings: string[] = [];
  await listenOnTarget(server, parseListenTarget('localhost', 0), (message) => warnings.push(message));
  const { port } = server.address() as net.AddressInfo;
  try {
    assert.equal(await getText({ host: '127.0.0.1', port }), 'ok');
    if (warnings.length === 0) {
      assert.equal(await getText({ host: '::1', port }), 'ok');
    }
  } finally {
    await closeServer(server);
  }
});

test('listenOnTarget serves a Unix socket and replaces a stale one', async () => {
  const directory = makeTempDir();
  const socketPath = path.join(directory, 'web.sock');
  const target = parseListenTarget(`unix:${socketPath}`, 0);

  // A socket file nobody listens on, as a killed server leaves behind: Python
  // binds it and exits without unlinking it.
  execFileSync('python3', ['-c', 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', socketPath]);
  assert.ok(fs.lstatSync(socketPath).isSocket());

  const server = http.createServer((_request, response) => response.end('over unix'));
  try {
    await listenOnTarget(server, target);
    assert.equal(await getText({ socketPath, path: '/' }), 'over unix');
  } finally {
    await closeServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('listenOnTarget refuses a Unix socket path that is in use or not a socket', async () => {
  const directory = makeTempDir();
  const socketPath = path.join(directory, 'web.sock');
  const first = http.createServer();
  try {
    await listenOnTarget(first, parseListenTarget(`unix:${socketPath}`, 0));
    await assert.rejects(
      listenOnTarget(http.createServer(), parseListenTarget(`unix:${socketPath}`, 0)),
      /already listening/,
    );

    const regularFile = path.join(directory, 'not-a-socket');
    fs.writeFileSync(regularFile, 'keep me');
    await assert.rejects(
      listenOnTarget(http.createServer(), parseListenTarget(`unix:${regularFile}`, 0)),
      /not a socket/,
    );
    assert.equal(fs.readFileSync(regularFile, 'utf8'), 'keep me');
  } finally {
    await closeServer(first);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('takeSocketActivation follows sd_listen_fds and clears its variables', () => {
  assert.equal(takeSocketActivation({}, 100), null);

  const matching: NodeJS.ProcessEnv = {
    LISTEN_FDS: '2', LISTEN_PID: '100', LISTEN_PIDFDID: '4242', LISTEN_FDNAMES: 'web:web6', OTHER: 'kept',
  };
  assert.deepEqual(takeSocketActivation(matching, 100), {
    sockets: [{ fd: 3, name: 'web' }, { fd: 4, name: 'web6' }],
  });
  assert.deepEqual(matching, { OTHER: 'kept' });

  // A wrapper that forks (bwrap, `sh -c` without exec) leaves LISTEN_PID pointing elsewhere.
  const forked: NodeJS.ProcessEnv = { LISTEN_FDS: '1', LISTEN_PID: '99' };
  assert.deepEqual(takeSocketActivation(forked, 100), { ignored: 'LISTEN_PID is 99, not this process (100)' });
  assert.deepEqual(forked, {});

  assert.match(
    (takeSocketActivation({ LISTEN_FDS: '0', LISTEN_PID: '100' }, 100) as { ignored: string }).ignored,
    /not a positive number/,
  );
});

function listenTcp(host: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
  });
}

test('listenOnTarget accepts on sockets passed in as fds 3 and 4 without binding', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('socket activation is Linux-only');
    return;
  }
  // Stand in for systemd: open listening sockets, then hand them to a child as
  // fds 3 and 4. Only the child keeps them once this process closes its copies.
  const ipv4 = await listenTcp('127.0.0.1');
  const ipv6 = await listenTcp('::1').catch(() => null);
  if (!ipv6) {
    ipv4.close();
    t.skip('IPv6 loopback is unavailable');
    return;
  }
  const port4 = (ipv4.address() as net.AddressInfo).port;
  const port6 = (ipv6.address() as net.AddressInfo).port;
  const fdOf = (server: net.Server) => (server as unknown as { _handle: { fd: number } })._handle.fd;

  const script = `
    process.env.LISTEN_PID = String(process.pid);
    const { takeSocketActivation, listenOnTarget, describeListenTarget } = await import(${JSON.stringify(LISTEN_TARGET_MODULE)});
    const http = await import('node:http');
    const activation = takeSocketActivation();
    const target = { kind: 'fds', sockets: activation.sockets };
    const server = http.createServer((request, response) => response.end('served from ' + request.socket.localAddress));
    await listenOnTarget(server, target);
    console.log(JSON.stringify({ description: describeListenTarget(target), leftover: process.env.LISTEN_FDS ?? null }));
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, LISTEN_FDS: '2', LISTEN_FDNAMES: 'web:web6' },
    stdio: ['ignore', 'pipe', 'inherit', fdOf(ipv4), fdOf(ipv6)],
  });
  try {
    const report = await new Promise<{ description: string; leftover: string | null }>((resolve, reject) => {
      assert.ok(child.stdout, 'stdout is piped');
      child.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk))));
      child.once('exit', (code) => reject(new Error(`child exited early with ${code}`)));
    });
    await Promise.all([new Promise((resolve) => ipv4.close(resolve)), new Promise((resolve) => ipv6.close(resolve))]);

    assert.equal(report.leftover, null);
    assert.equal(
      report.description,
      `systemd socket activation: fd 3 "web" = tcp 127.0.0.1:${port4}, fd 4 "web6" = tcp [::1]:${port6}`,
    );
    assert.equal(await getText({ host: '127.0.0.1', port: port4 }), 'served from 127.0.0.1');
    assert.equal(await getText({ host: '::1', port: port6 }), 'served from ::1');
  } finally {
    child.kill();
  }
});
