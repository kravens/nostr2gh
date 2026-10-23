# nostr2gh

Relay NIP-34 pull requests and patches from Nostr to GitHub. Built for
contributors whose GitHub account is suspended by a false positive: they keep
working on Nostr (gittr.space, ngit-relay, any GRASP host) and a friend with a
working account relays their PRs, unchanged, under a clear "on behalf of" note.

Needs node 22+ (built-in WebSocket), git, and `gh` logged in on the relaying side.

```sh
git clone https://github.com/kravens/nostr2gh && cd nostr2gh && npm i
```

## Contributor: publish a PR to Nostr

1. Get a key once: `node nostr2gh.mjs keygen`, save the nsec in `~/.config/nostr2gh/nsec` (or `NOSTR_NSEC`).
   Send the npub to the person relaying for you; they whitelist it.
2. Push your branch anywhere git can fetch over https: your repo on gittr.space
   (register your SSH key under Settings, then `git push git@git.gittr.space:<npub>/<repo>.git`),
   Codeberg, GitLab, a self-hosted server.
3. From that checkout, on the branch:

```sh
node nostr2gh.mjs send \
  --repo naddr1...            # or 30617:<owner-hex>:<repo-id>, the target repo's announcement
  --clone https://git.gittr.space/<npub>/walletwasabi.git \
  --subject "Fix regtest coinjoin test" \
  --body-file pr.md \
  --base origin/master        # ref to compute merge-base against (optional)
```

Pushed more commits? `node nostr2gh.mjs send --repo ... --update <pr event id>` publishes a kind 1619 update with the new head.

For WalletWasabi the target is
`30617:24cf5e0ea5ffe5e084bdf7195f793e60c3278e5e6a6819a67865b90e9904d481:walletwasabi`.

Patches work too: anything that publishes kind 1617 (`ngit send`) is applied with `git am --3way` on the upstream base.

## Relayer: open the GitHub PRs

`~/.config/nostr2gh/config.json`:

```json
{
  "authors": { "npub1...": "Carti-it" },
  "repos": [{
    "a": "30617:<owner-hex>:walletwasabi",
    "local": "~/Documents/GitHub/WalletWasabi",
    "push": "origin", "pushOwner": "kravens",
    "upstream": "WalletWasabi/WalletWasabi", "upstreamRemote": "upstream", "base": "master"
  }],
  "maxWritesPerRun": 2,
  "sleepMs": 30000
}
```

`node nostr2gh.mjs relay --dry-run` lists what would happen; without the flag it
fetches each new PR head by commit id from the event's clone URL into `local`,
pushes it to `push` as `nostr/<author>/<branch>`, and opens a PR on `upstream`
with the author's text plus a provenance footer (npub, nevent, gittr link, head
commit). Kind 1619 updates from the same author force-push the branch and leave
a comment. `state.json` next to the config remembers what was relayed; delete an
entry to redo it. `--event <id|file.json>` relays one event only.

PRs opened in the gittr.space web UI work too. The UI may tag the *target*
repo's clone URL, so the relay also tries the clone URLs from the author's own
repo announcement with the same name. To relay PRs the contributor opens on
their own fork announcement, add a second `repos` entry with that `a`
(`30617:<their-hex>:walletwasabi`) and the same `local`/`upstream`. If an open
upstream PR from `pushOwner` already carries the head commit (for example one
carried by hand), the relay adopts it instead of opening a duplicate, and later
updates force-push to that PR's branch. `--dry-run` fetches the head commit into
`local` to prove it is reachable, but writes nothing to GitHub.

Only npubs listed in `authors` are relayed. Everything else is ignored, so a
stranger cannot open PRs under your GitHub name. Writes are paced
(`maxWritesPerRun`, `sleepMs`) and the run aborts if `gh api user` fails.

Cron it: `*/30 * * * * cd ~/src/nostr2gh && node nostr2gh.mjs relay >> relay.log 2>&1`.

Not done yet: comments in either direction, and merged/closed status back to
Nostr (kind 1631/1632). The contributor can read the GitHub PR anonymously.
