# Fork server changes: listening and login

Changes this fork makes to how the CloudCLI server listens and
authenticates, and how to keep them when merging an upstream release.

We merge upstream release tags into `main`; we don't rebase. These commit
hashes therefore stay valid, and `git show <hash>` gives the exact change
and its reasoning.

## Why: the deployment these serve

```
browser ──TLS + client cert──> Caddy ──Unix socket──> CloudCLI ──CLAUDE_CLI_PATH──> sandboxed claude
```

- **Caddy** terminates TLS and requires a client certificate (mTLS), so
  only our own devices get through.
- **systemd** owns the Unix socket (`/var/lib/http-servers/cloudcli.socket`)
  and starts CloudCLI on the first connection (socket activation).
  CloudCLI has no TCP port.
- **`--no-login`**: CloudCLI's own login page would be a second, weaker
  password check behind the mTLS check, so it is turned off.
- CloudCLI and the agents it starts run in bwrap sandboxes. Agents can't
  see the socket, CloudCLI's database or `~/.cloudcli`. See
  `agent-changes.md`.

## Commits

| Commit | Change |
|---|---|
| `9fdc3587` feat(server): add --host to listen on an address, localhost, or a Unix socket | `--host` sets `HOST`, as `--port` sets `SERVER_PORT`. `unix:/abs/path.sock` serves on a Unix socket only. A stale socket file left by a crash is replaced; a live socket or non-socket file is refused; the file is removed on SIGTERM/SIGINT. `localhost` listens on both 127.0.0.1 and ::1. Other values go to `listen()` as before, and the default is still `0.0.0.0`. New `server/shared/listen-target.ts` and tests. |
| `1fb40c94` feat: add --no-login to skip the login page | `--no-login` or `CLOUDCLI_NO_LOGIN=true` makes the HTTP and WebSocket token checks act as the single local user, like Platform mode but chosen at runtime and without Platform mode's other effects. `/api/auth/status` returns `loginDisabled`. The client then skips the token, opens WebSockets without one, and ignores logout. A fresh database still shows the one-time setup form. The agent API keeps its API-key check. The server warns about it at startup. |
| `1f9b9ebb` chore(lint): register listen-target as a shared backend utility | Adds `server/shared/listen-target.ts` to the "backend-shared-utils" list in `.oxlintrc.json`, so the module-boundaries lint rule accepts imports of it. |
| `2a22d808` feat(server): serve on sockets passed in by systemd socket activation | When `LISTEN_FDS` is set and `LISTEN_PID` is this process, serves on the sockets passed in (fd 3 onwards) and ignores `HOST` and the port. The `LISTEN_*` variables are removed from the environment once read, so agents never see them. Startup logs where it listens (via `/proc/net`), and explains why activation was ignored if `LISTEN_PID` doesn't match, as happens behind a forking wrapper. The socket file is left to systemd on shutdown. |
| `ef0a6d4e` fix(cli): align --no-login in the help text | Whitespace only. |

## Where the code lives

**`server/shared/listen-target.ts`** is our file, so conflicts can't
happen there. It exports:
- `parseListenTarget`
- `takeSocketActivation`
- `describeListenTarget`
- `getLocalOrigin`
- `listenOnTarget`
- `getActiveListenTarget`

The `ListenTarget` kinds are `unix`, `tcp` and `fds`. Extra sockets
(`::1`, and every activated socket after the first) are relay listeners:
each one hands its connections to the main `http.Server` with
`emit('connection')`, so WebSocket upgrades work on all of them.

The other files are upstream's, with our edits in them:

- **`server/index.ts`** (most likely to conflict):
  - Where `SERVER_PORT` and `HOST` are set, we call
    `takeSocketActivation()`, pick `LISTEN_TARGET`, and derive
    `SERVER_URL` and `DISPLAY_HOST` from it.
  - `server.listen(SERVER_PORT, HOST, cb)` became
    `listenOnTarget(server, LISTEN_TARGET).then(cb, onError)`.
  - The local-server marker records `port`, `socketPath` or
    `socketActivated` depending on the target kind.
  - The "Server URL" / "Listening on" startup line, and the `--no-login`
    warning, are ours.
  - The shutdown handler removes the Unix socket file. It has to, because
    `process.exit()` skips `server.close()`.
- **`server/modules/cli/cli.service.ts`**:
  - parses `--host`/`--host=` and `--no-login`
  - shows `HOST` and `LOGIN` in `cloudcli status`
  - documents both in the help text and the list of environment variables
  - copies them into `HOST` and `CLOUDCLI_NO_LOGIN` before the server
    starts
- **`server/modules/cli/tests/cli.service.test.ts`**: the help-text
  assertions.
- **`server/modules/browser-use/browser-use.service.ts`**:
  `getMcpApiUrl()` takes the address from `getActiveListenTarget()` /
  `getLocalOrigin()` instead of hard-coding `127.0.0.1:<port>`. It throws
  a clear error when there is no TCP address (Unix socket, or socket
  activation). Browser Use is therefore unavailable in our deployment, as
  intended.
- **`server/shared/utils.ts`**: `isLoginDisabled()`. It is a function, not
  a constant, because the CLI sets the variable after the module has
  loaded.
- **`server/modules/auth/auth.middleware.ts`**: `authenticateToken` and
  `authenticateWebSocket` test `IS_PLATFORM || isLoginDisabled()`.
- **`server/modules/auth/auth.service.ts`**: `loginDisabled` in the status
  response.
- **Client side:**
  - `src/shared/authToken.ts` holds the `setLoginDisabled` /
    `isLoginDisabled` flag.
  - `src/modules/auth/context/AuthContext.tsx` reads `loginDisabled` from
    the status response, loads the user without a token, and makes logout
    a no-op.
  - `src/shared/context/WebSocketContext.tsx` and
    `src/modules/shell/utils/socket.ts` open their WebSockets without a
    token when login is disabled.
- **`.env.example`**: `HOST` and `CLOUDCLI_NO_LOGIN`.

## Resolving conflicts

- **Upstream changes the `listen` call or the startup banner in
  `server/index.ts`:**
  - Keep our `LISTEN_TARGET` / `listenOnTarget` structure, and move
    upstream's new startup work into our `.then()` callback.
  - Wherever upstream builds `http://${DISPLAY_HOST}:${SERVER_PORT}`, use
    `SERVER_URL` instead; it is only a URL for `tcp` targets.
- **Upstream adds code that reaches the server over HTTP itself** (as
  Browser Use does), or that reads `HOST`/`SERVER_PORT` to build a URL:
  route it through `getActiveListenTarget()` and `getLocalOrigin()`. Under
  socket activation, `HOST` and the port say nothing about where the
  server is.
- **Upstream adds a new auth check** (a new middleware, WebSocket path, or
  `IS_PLATFORM` test in auth code): decide whether it should also accept
  `isLoginDisabled()`.
  - The rule: anything that would require the browser user to log in
    should be skipped under `--no-login`.
  - API-key checks for the agent API stay.
  - Search for new `IS_PLATFORM` tests under `server/modules/auth`,
    `src/modules/auth` and `src/shared` and look at each.
- **Upstream adds client code that needs the token**, for example a new
  WebSocket or `fetch` that bails out when there's no token: give it the
  same `isLoginDisabled()` exception as `WebSocketContext.tsx`.
- **Upstream adds CLI options:** merge both sides of the parser, the help
  text and the `status` output. The help-text test needs both sides too.
- **Upstream adds its own `--host`, Unix socket or socket activation
  support:** compare it with ours and prefer upstream's if it covers our
  deployment. That deployment needs:
  - systemd socket activation on a Unix socket
  - `LISTEN_*` removed from the environment
  - no TCP fallback

  Then drop ours, so the fork shrinks.

## Checks after a merge

```sh
npx tsx --tsconfig server/tsconfig.json --test \
  server/shared/tests/listen-target.test.ts server/modules/cli/tests/cli.service.test.ts
grep -rn "isLoginDisabled" server src | grep -v /tests/   # auth middleware, status, client: all still there
```

Then try the real deployment shape, without systemd, using
`systemd-socket-activate` (from the systemd package) to pass the socket:

```sh
systemd-socket-activate -l "$PWD/test.sock" \
  env DATABASE_PATH="$PWD/test.db" node dist-server/server/modules/cli/cli.js --no-login
curl --unix-socket test.sock http://localhost/api/auth/status   # expect "loginDisabled":true
```

Startup should print `Listening on: systemd socket activation: fd 3 ...`
and the `--no-login` warning. Always give tests a throwaway
`DATABASE_PATH`, never the live database.
