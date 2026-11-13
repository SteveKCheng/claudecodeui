#!/bin/bash
# Installs a CloudCLI build from a commit of this repository into its own
# prefix (default ~/.local/opt/cloudcli), laid out as `npm install -g` would:
# <prefix>/lib/node_modules/@cloudcli-ai/cloudcli and <prefix>/bin/cloudcli.
# The installed copy is self-contained and runs from a read-only mount, so it
# can live outside npm's own directories, which agent sandboxes mount writable.
#
# `npm install -g <tarball>` is not used: it looks up registry metadata for
# every dependency, which the proxy refuses for scoped packages. Instead the
# package is unpacked in place and its locked production dependencies are
# installed with `npm ci`, which only downloads exact tarball URLs.
#
# Usage:
#   install-cloudcli.sh [<commit>]   build, stage and (if CloudCLI is stopped) swap in
#   install-cloudcli.sh --swap       swap in an already staged build
#   install-cloudcli.sh --rollback   go back to the previously installed build
#
# The Agent SDK's bundled `claude` binary is moved out of the package into
# CLAUDE_PREFIX/<version>/claude, with CLAUDE_PREFIX/bin/claude pointing at
# the version matching the installed CloudCLI. CloudCLI never runs the bundled
# copy on Linux (it always hands the SDK a path), so this is a read-only,
# checksum-verified `claude` for CLAUDE_CLI_PATH launchers, not a second copy.
# The Codex CLI binaries are removed unless KEEP_CODEX=1.
#
# Environment:
#   REPO           repository to build from (default: the one holding this script)
#   BUILDS         work area for worktrees, build logs and tarballs
#                  (default: cloudcli-builds beside the repository)
#   PREFIX         install prefix (default ~/.local/opt/cloudcli)
#   CLAUDE_PREFIX  where the claude binaries go (default ~/.local/opt/claude-code)
#   KEEP_CODEX     1 keeps the Codex CLI binaries (default 0)
#
# Notes on how and why: notes/distribution.md.

set -euo pipefail

script_dir=$(dirname "$(readlink -f "$0")")
REPO=${REPO:-$(git -C "$script_dir" rev-parse --show-toplevel)}
BUILDS=${BUILDS:-$(dirname "$REPO")/cloudcli-builds}
PREFIX=${PREFIX:-$HOME/.local/opt/cloudcli}
CLAUDE_PREFIX=${CLAUDE_PREFIX:-$HOME/.local/opt/claude-code}
KEEP_CODEX=${KEEP_CODEX:-0}
NPM_FLAGS=(--no-audit --no-fund
    --registry=https://registry.npmjs.org/
    # The lockfile pins some packages to a mirror the proxy blocks; fetch them from npmjs instead.
    --replace-registry-host=registry.npmmirror.com)

target=$PREFIX/lib/node_modules/@cloudcli-ai/cloudcli
staged=$target.staged
previous=$target.previous
bin_link=$PREFIX/bin/cloudcli
bin_target=../lib/node_modules/@cloudcli-ai/cloudcli/dist-server/server/modules/cli/cli.js

describe() {
    if [[ -f $1/.local-build ]]; then cat "$1/.local-build"; else echo "upstream $(node -p "require('$1/package.json').version")"; fi
}

# Points CLAUDE_PREFIX/bin/claude at the claude version recorded for an install.
point_claude_link() {
    [[ -f $1/.claude-version ]] || return 0
    local version
    version=$(cat "$1/.claude-version")
    mkdir -p "$CLAUDE_PREFIX/bin"
    ln -sfn "../$version/claude" "$CLAUDE_PREFIX/bin/claude"
    echo "claude: $CLAUDE_PREFIX/bin/claude -> $version"
}

cloudcli_running() {
    # A running CloudCLI usually shows as `node <prefix>/bin/cloudcli`, the symlink
    # npm creates; match the package directory too in case it was started directly.
    pgrep -f -- "$bin_link|$target/" >/dev/null
}

swap_in() {
    [[ -d $staged ]] || { echo "Nothing staged at $staged" >&2; exit 1; }
    if cloudcli_running; then
        echo "CloudCLI is running from $target." >&2
        echo "Stop it, then run: $0 --swap" >&2
        exit 2
    fi
    rm -rf "$previous"
    [[ -d $target ]] && mv "$target" "$previous"
    mv "$staged" "$target"
    mkdir -p "$PREFIX/bin"
    ln -sfn "$bin_target" "$bin_link"
    chmod +x "$target/dist-server/server/modules/cli/cli.js"
    echo "Installed: $(describe "$target")"
    point_claude_link "$target"
    [[ -d $previous ]] && echo "Previous build kept for --rollback: $(describe "$previous")"
}

case ${1:-} in
    --swap)
        swap_in
        exit 0
        ;;
    --rollback)
        [[ -d $previous ]] || { echo "No previous build at $previous" >&2; exit 1; }
        if cloudcli_running; then echo "Stop CloudCLI first." >&2; exit 2; fi
        mv "$target" "$target.rolled-back"
        mv "$previous" "$target"
        mv "$target.rolled-back" "$previous"
        echo "Installed: $(describe "$target")"
        point_claude_link "$target"
        exit 0
        ;;
esac

ref=${1:-HEAD}
commit=$(git -C "$REPO" rev-parse --verify "$ref^{commit}")
short=$(git -C "$REPO" rev-parse --short "$commit")
subject=$(git -C "$REPO" log -1 --format=%s "$commit")

mkdir -p "$BUILDS"

# 1. Build the commit in its own worktree, so uncommitted changes never ship.
work=$BUILDS/work-$short
rm -rf "$work"
git -C "$REPO" worktree prune
git -C "$REPO" worktree add --detach --quiet "$work" "$commit"
trap 'git -C "$REPO" worktree remove --force "$work"' EXIT
(
    cd "$work"
    HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci "${NPM_FLAGS[@]}" --loglevel=error
    # The frontend build is noisy (CSS warnings); show its output only if it fails.
    if ! npm run build > "$BUILDS/build-$short.log" 2>&1; then
        tail -40 "$BUILDS/build-$short.log" >&2
        echo "Build failed; full log: $BUILDS/build-$short.log" >&2
        exit 1
    fi
    HUSKY=0 npm pack --pack-destination "$BUILDS" --loglevel=error >/dev/null
)
version=$(node -p "require('$work/package.json').version")
tarball=$BUILDS/cloudcli-$version-$short.tgz
mv "$BUILDS/cloudcli-ai-cloudcli-$version.tgz" "$tarball"
echo "Built $tarball"

# 2. Stage it beside the live install, with its locked production dependencies.
rm -rf "$staged"
mkdir -p "$staged"
tar xzf "$tarball" --strip-components=1 -C "$staged"
cp "$work/package-lock.json" "$staged/"
(
    cd "$staged"
    # husky is a dev dependency and is not installed here.
    npm pkg delete scripts.prepare
    npm ci --omit=dev "${NPM_FLAGS[@]}" --loglevel=error
)

# 3. Move the bundled claude out to its own versioned directory. npm verified it
#    against the lockfile's checksum; check it runs before dropping the package.
modules=$staged/node_modules
claude_version=$(node -p "require('$modules/@anthropic-ai/claude-agent-sdk/package.json').claudeCodeVersion")
bundled_claude=
for platform_package in "$modules"/@anthropic-ai/claude-agent-sdk-*/; do
    # npm cannot tell glibc from musl, so both Linux variants may be present.
    if [[ -z $bundled_claude && $platform_package != *-musl/ && -x ${platform_package}claude ]]; then
        bundled_claude=${platform_package}claude
    fi
done
claude_dir=$CLAUDE_PREFIX/$claude_version
if [[ ! -x $claude_dir/claude ]]; then
    [[ -n $bundled_claude ]] || { echo "No bundled claude binary found in $modules/@anthropic-ai" >&2; exit 1; }
    "$bundled_claude" --version | grep -q "^$claude_version " || { echo "Bundled claude is not version $claude_version" >&2; exit 1; }
    mkdir -p "$claude_dir"
    cp "$bundled_claude" "$claude_dir/claude.partial"
    chmod 0555 "$claude_dir/claude.partial"
    mv "$claude_dir/claude.partial" "$claude_dir/claude"
fi
rm -rf "$modules"/@anthropic-ai/claude-agent-sdk-*/
echo "$claude_version" > "$staged/.claude-version"
echo "claude $claude_version: $claude_dir/claude"

# 4. Drop the Codex CLI binaries; the Codex provider then reports it is not installed.
if [[ $KEEP_CODEX != 1 ]]; then
    # The launcher package goes too: with only the binary gone, CloudCLI resolves
    # the launcher and reports Codex as installed with no version.
    rm -rf "$modules"/@openai/codex-{linux,darwin,win32}-*/ "$modules"/@openai/codex/
fi

echo "$version + local build $short ($subject), installed $(date -Iseconds)" > "$staged/.local-build"
echo "Staged: $(describe "$staged")"

# 5. Swap it in unless CloudCLI is running from the target.
swap_in
