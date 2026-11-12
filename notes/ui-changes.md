# Fork UI changes

Changes this fork makes to CloudCLI's user interface, and how to keep
them when merging an upstream release.

We merge upstream release tags into `main`; we don't rebase. These commit
hashes therefore stay valid, and `git show <hash>` gives the exact change.

## Sidebar de-cluttering (on top of v1.37.8)

The sidebar showed a GitHub star badge under the logo, and "Report Issue",
"Join Community", an "Update available" banner and a
"CloudCLI vX.Y.Z – Open Source" line in its footer. They pushed the
project list into a smaller space. The links elsewhere, in Settings →
About and on the login screen, are left alone on purpose: the branding is
fine, only the sidebar clutter was the problem.

| Commit | Change |
|---|---|
| `927d6d09` chore(sidebar): remove the GitHub star badge | Deletes `GitHubStarBadge.tsx` and `hooks/useGitHubStars.ts`, and their use in `SidebarHeader.tsx`. The browser no longer asks `api.github.com` for the star count. |
| `2e9a91d9` chore(sidebar): remove the Report Issue and Join Community links | Removes them from the desktop and mobile footer (`SidebarFooter.tsx`) and the collapsed rail (`SidebarCollapsed.tsx`), with their URL constants and the Discord icon. |
| `595f53ff` chore(sidebar): remove the version and Open Source line from the footer | Deletes the version line from `SidebarFooter.tsx`. `currentVersion` is no longer passed to the footer. The version is still in Settings → About and the version dialog. |
| `c54570d0` feat(sidebar): show the update notice as a small icon beside the logo | Replaces the footer's two-line banner with `UpdateNoticeButton` in `SidebarHeader.tsx`: a small, static `ArrowUpCircle` beside the wordmark, in both the desktop and mobile headers. It opens the version dialog. `updateAvailable`, `latestVersion` and `onShowVersionModal` go to the header now, not the footer. `releaseInfo` no longer goes through `SidebarContent`. |

Kept on purpose:

- The amber "restart required" warning in the footer.
- The update icon in the collapsed rail (`SidebarCollapsed.tsx`).
- The translation strings (`actions.reportIssue`, `actions.joinCommunity`,
  `branding.openSource`, ...). Removing them would touch every locale file
  for no gain.

### Resolving conflicts

All of these changes are in `src/modules/sidebar/`. The files involved are
`Sidebar.tsx`, `SidebarContent.tsx`, `SidebarHeader.tsx`,
`SidebarFooter.tsx` and `SidebarCollapsed.tsx`.

- **Upstream edited a block we deleted** (star badge, community links,
  version line, footer update banner): keep it deleted. If upstream's edit
  matters elsewhere, for example a new prop that the footer passes on, carry
  only that part over.
- **Upstream changed or modified `GitHubStarBadge.tsx` or
  `useGitHubStars.ts`:** git reports a modify/delete conflict. Delete the
  files again with `git rm`.
- **Upstream added a new link or banner to the footer:** decide whether it
  is clutter. Upstream tends to add community and promotion items there.
- **Upstream changed the update banner** (new text, release title, install
  mode): bring any useful behaviour over to `UpdateNoticeButton` in
  `SidebarHeader.tsx`, and keep the icon small.
- **Upstream changed the props of `SidebarFooter` or `SidebarHeader`:**
  merge both sets of changes. Ours remove `updateAvailable`,
  `releaseInfo`, `latestVersion`, `currentVersion` and
  `onShowVersionModal` from the footer, and add `updateAvailable`,
  `latestVersion` and `onShowVersionModal` to the header.
- **Upstream changed the logo area of `SidebarHeader.tsx`:** keep our
  wrapper, `<div className="flex min-w-0 items-center gap-1">`, around the
  logo, followed by the `UpdateNoticeButton`. It appears twice, once in
  the desktop header and once in the mobile header.

After resolving, check that nothing we removed has come back:

```sh
grep -rnE "GitHubStarBadge|useGitHubStars|reportIssue|joinCommunity|branding.openSource" \
  src/modules/sidebar
```

It should print nothing. Then run `npm run typecheck`,
`npm run lint` and `npm test`, and look at the sidebar in a browser.
