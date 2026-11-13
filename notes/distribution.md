# Fork distribution changes: packages, SDK and installing

Changes this fork makes to CloudCLI's dependencies and the way we install
it, and how to keep them when merging an upstream release.

We merge upstream release tags into `main`; we don't rebase. These commit
hashes therefore stay valid, and `git show <hash>` gives the exact change
and its reasoning.

## Why

Agents run sandboxed, and the sandboxes mount npm's global directories
writable. So CloudCLI is installed somewhere else, read-only, and as a
self-contained copy:

- `/opt/CloudCLI`: the CloudCLI package with its production dependencies.
- `/opt/claude`: the `claude` binary that ships with the Agent SDK. The
  `CLAUDE_CLI_PATH` launcher (`~/bin/inner-claude`) runs it inside the
  agent sandbox.

Keeping the install small makes it quicker to build, review and mount.
Fewer packages in production also means fewer that could be compromised.

## Commits

| Commit | Change |
|---|---|
| `d2b4a5b7` build: install frontend-only packages as dev dependencies | Moves 42 packages that only the browser frontend uses from `dependencies` to `devDependencies`: React, CodeMirror, xterm, mermaid, KaTeX, lucide-react, the markdown and i18n stack, and so on. Vite bundles them into `dist/`, and the server never loads them. Production installs (`npm ci --omit=dev`) go from 1146 to 384 packages. The lockfile change only flips `dev`/`devOptional` flags and drops 13 unreachable dev-only entries. |
| `929941bd` build(deps): upgrade @anthropic-ai/claude-agent-sdk to 0.3.322 | The lockfile pinned SDK 0.3.165, whose bundled Claude Code (2.1.165) predates Opus 5.5. 0.3.322 pairs with Claude Code 2.1.322. Only the SDK and its 8 platform packages change in the lockfile. `Query.interrupt()` now returns `Promise<unknown>`. Upstream made the same change to `server/shared/types.ts` in v1.37.8, so that part is now identical. |
| `16719c4f` build: add a script that installs a self-contained build of a commit | `scripts/install-cloudcli.sh`, described below. |

## `scripts/install-cloudcli.sh`

```sh
# Build, stage, and swap in if CloudCLI is stopped:
PREFIX=/opt/CloudCLI CLAUDE_PREFIX=/opt/claude scripts/install-cloudcli.sh [<commit>]
# Later, once CloudCLI is stopped:
PREFIX=/opt/CloudCLI CLAUDE_PREFIX=/opt/claude scripts/install-cloudcli.sh --swap
# Go back to the previous build:
PREFIX=/opt/CloudCLI CLAUDE_PREFIX=/opt/claude scripts/install-cloudcli.sh --rollback
```

What it does:

1. **Build** the commit (default `HEAD`) in a temporary git worktree, so
   uncommitted changes never ship: `npm ci`, `npm run build`, `npm pack`.
   The worktree, build log (`build-<hash>.log`) and tarball
   (`cloudcli-<version>-<hash>.tgz`) are in `$BUILDS`. That defaults to
   `cloudcli-builds` beside the repository, i.e. `~/dev/cloudcli-builds`.
2. **Stage** at `<prefix>/lib/node_modules/@cloudcli-ai/cloudcli.staged`,
   laid out like `npm install -g` would. It unpacks the tarball, copies in
   the lockfile and runs `npm ci --omit=dev`.

   The script doesn't use `npm install -g <tarball>` because that looks up
   registry metadata for every dependency, and the sandbox's proxy refuses
   that for scoped packages. `npm ci` only downloads the exact tarball
   URLs in the lockfile.
3. **Move `claude` out:** the SDK's bundled `claude` goes to
   `$CLAUDE_PREFIX/<version>/claude` (mode 0555), and
   `$CLAUDE_PREFIX/bin/claude` points at the version matching the
   installed CloudCLI.
   - The script checks the binary's `--version` first. npm has already
     checked it against the lockfile's checksum.
   - The platform packages are then deleted from the CloudCLI copy.
     CloudCLI always passes the SDK an explicit path on Linux, so it never
     runs the bundled copy itself.
4. **Drop Codex:** deletes the Codex CLI and its launcher package unless
   `KEEP_CODEX=1`. The Codex provider then reports "not installed" rather
   than "installed, no version".
5. **Swap in:** only if no CloudCLI process is running from the prefix.
   The old build is kept as `.previous` for `--rollback`. `.local-build`
   in the package records the commit, its subject and the install time.

npm flags it always uses:
- `--registry=https://registry.npmjs.org/ --replace-registry-host=registry.npmmirror.com`:
  the lockfile has some URLs on a mirror the proxy blocks.
- `HUSKY=0` and `ELECTRON_SKIP_BINARY_DOWNLOAD=1`: Electron's postinstall
  downloads from github.com directly, bypassing the proxy.

### Testing a fresh deploy

1. Stop CloudCLI. systemd starts it again on the next connection.
2. Run the script.
3. Load the page through Caddy.
4. Check that `/opt/claude/bin/claude` points at the new version and that
   `CLAUDE_CLI_PATH` (inner-claude) uses it.

## Resolving conflicts

### `package.json`: dependencies vs. devDependencies

Upstream keeps adding packages to `dependencies`. For each new or moved
package, decide which side it belongs on:

```sh
pkg=ajv-formats   # the package in question
grep -rlE "(from |require\(|import\()['\"]$pkg(/|['\"])" server shared scripts electron || echo "frontend-only"
```

- **Used only from `src/`:** it goes in `devDependencies`, kept sorted.
- **Used from `server/`, `shared/`, `scripts/` or `electron/`:** it goes
  in `dependencies`.
- **Upstream bumps a version:** take their version, on whichever side we
  have the package. For example, in v1.37.8 the Codex packages went to
  0.166.0 and `ajv-formats` was new and frontend-only.
- **The SDK (`@anthropic-ai/claude-agent-sdk`):** keep the higher version.
  When upstream catches up or passes us, take theirs. Our pin then stops
  mattering.

### `package-lock.json`

Don't merge it by hand. Take upstream's version, then let npm reconcile
it with our merged `package.json`:

```sh
git checkout --theirs package-lock.json   # during the merge
npm install --package-lock-only --ignore-scripts \
  --registry=https://registry.npmjs.org/ --replace-registry-host=registry.npmmirror.com
git diff v<X.Y.Z> -- package-lock.json | grep '^[-+] *"version"'   # should be only our deliberate differences
```

### `server/shared/types.ts`

The SDK commit's change there has been upstream's since v1.37.8. If it
conflicts again, take upstream's version. Then check that the `Query`
control methods still match `sdk.d.ts` of the SDK version we install.

### The script

`scripts/install-cloudcli.sh` is our own file, so merges can't conflict
there. It ships in the npm package too, because `scripts/` is listed in
`files`. Things to watch in upstream releases:

- **A new native or platform-binary dependency:** the script may need to
  handle it, as it does for `claude` and Codex.
- **A change to the bin path** (`dist-server/server/modules/cli/cli.js`)
  **or the package name** (`@cloudcli-ai/cloudcli`): both are hard-coded
  in the script.
- **A new `prepare` or `postinstall` step:** the staged install deletes
  `scripts.prepare`, because husky isn't installed in production.

## Checks after a merge

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci \
  --registry=https://registry.npmjs.org/ --replace-registry-host=registry.npmmirror.com
# Lockfile entries a production install can get (400 after v1.37.8, platform variants included):
node -e "const l=require('./package-lock.json');console.log(Object.entries(l.packages).filter(([k,v])=>k&&!v.dev).length)"
npm run build
```

`node_modules` has to be reinstalled after every merge: a stale one fails
tests, for example the Codex model tests. `npm ci` deletes `node_modules`
before installing, so if it fails partway (DNS for github.com, say), there
is nothing left until it succeeds.
