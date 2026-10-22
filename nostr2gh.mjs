#!/usr/bin/env node
// nostr2gh: relay NIP-34 pull requests (kind 1618/1619) and patches (kind 1617)
// from Nostr to GitHub, so contributors without a working GitHub account can
// still land changes through a proxy account.
//
//   nostr2gh keygen                      print a fresh nsec/npub
//   nostr2gh send   [options]            contributor: publish a PR event for the current branch
//   nostr2gh relay  [--dry-run] [--event <id|file>]   proxy: open/update GitHub PRs
//
// Config (relay): ~/.config/nostr2gh/config.json, see README.md.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const KIND_REPO = 30617, KIND_PATCH = 1617, KIND_PR = 1618, KIND_PR_UPDATE = 1619;
const DEFAULT_RELAYS = ['wss://relay.gittr.space', 'wss://relay.ngit.dev', 'wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net'];
const CONFIG_PATH = join(homedir(), '.config', 'nostr2gh', 'config.json');

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const pool = new SimplePool(); // verifies signatures on every event it hands back

try {
  if (cmd === 'keygen') keygen();
  else if (cmd === 'send') await send();
  else if (cmd === 'relay') await relay();
  else { usage(); process.exitCode = 2; }
} finally {
  pool.destroy();
}

function usage() {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}

// ---------- keygen ----------
function keygen() {
  const sk = generateSecretKey();
  console.log(`nsec: ${nip19.nsecEncode(sk)}\nnpub: ${nip19.npubEncode(getPublicKey(sk))}`);
}

// ---------- send (contributor side) ----------
async function send() {
  const sk = loadSecret();
  const repoRef = parseRepoRef(need('repo', 'naddr1... or 30617:<hex>:<d>'));
  const relays = (args.relays || '').split(',').filter(Boolean);
  const [ann] = await pool.querySync(DEFAULT_RELAYS.concat(relays), { kinds: [KIND_REPO], authors: [repoRef.pubkey], '#d': [repoRef.d] }, { maxWait: 8000 });
  if (!ann) die(`repo announcement ${repoRef.a} not found on relays`);
  const euc = ann.tags.find(t => t[0] === 'r' && t[2] === 'euc')?.[1];
  const targetRelays = uniq([...relays, ...(ann.tags.find(t => t[0] === 'relays')?.slice(1) || []), ...DEFAULT_RELAYS]);

  const commit = args.commit || git(['rev-parse', 'HEAD']);
  const branch = args.branch || git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const clone = args.clone || git(['remote', 'get-url', 'origin']);
  if (!/^https?:\/\//.test(clone)) die(`--clone must be an https URL others can fetch from, got ${clone}`);
  const remoteTip = git(['ls-remote', clone, `refs/heads/${branch}`]).split('\t')[0];
  if (remoteTip !== commit) console.error(`warning: ${clone} ${branch} is at ${remoteTip || 'nothing'}, not ${commit}; push first or the relay cannot fetch it`);

  const tags = [['a', repoRef.a], ['p', repoRef.pubkey]];
  if (euc) tags.push(['r', euc]);
  let kind = KIND_PR;
  if (args.update) {
    kind = KIND_PR_UPDATE;
    tags.push(['E', hex(args.update)], ['P', getPublicKey(sk)]);
  } else {
    tags.push(['subject', need('subject', 'PR title')], ['branch-name', branch]);
  }
  tags.push(['c', commit], ['clone', clone]);
  const mergeBase = tryGit(['merge-base', commit, args.base || 'origin/master']);
  if (mergeBase) tags.push(['merge-base', mergeBase]);
  for (const t of (args.label || '').split(',').filter(Boolean)) tags.push(['t', t]);

  const content = args.update ? '' : (args['body-file'] ? readFileSync(args['body-file'], 'utf8') : (args.body || ''));
  const event = finalizeEvent({ kind, created_at: now(), tags, content }, sk);
  const results = await Promise.allSettled(pool.publish(targetRelays, event));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  if (!ok) die(`no relay accepted the event: ${results.map(r => r.reason?.message).join('; ')}`);
  console.log(`published kind ${kind} ${event.id} to ${ok}/${targetRelays.length} relays`);
  console.log(`nevent: ${nip19.neventEncode({ id: event.id, relays: targetRelays.slice(0, 2), author: event.pubkey })}`);
  console.log(`gittr:  https://gittr.space/${nip19.npubEncode(repoRef.pubkey)}/${repoRef.d}/pulls/${event.id}`);
}

// ---------- relay (proxy side) ----------
async function relay() {
  const cfg = JSON.parse(readFileSync(args.config || CONFIG_PATH, 'utf8'));
  const dry = !!args['dry-run'];
  const authors = Object.fromEntries(Object.entries(cfg.authors || {}).map(([k, v]) => [hex(k), v]));
  if (!Object.keys(authors).length) die('config.authors is empty; refuse to relay PRs from anyone');
  const relays = cfg.relays || DEFAULT_RELAYS;
  const statePath = expand(cfg.state || join(dirname(args.config || CONFIG_PATH), 'state.json'));
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const maxWrites = cfg.maxWritesPerRun ?? 2;
  let writes = 0;

  if (!dry) sh('gh', ['api', 'user', '-q', '.login']); // suspended or logged out: stop before touching anything

  for (const repo of cfg.repos) {
    const ref = parseRepoRef(repo.a);
    const local = expand(repo.local);
    const filter = { kinds: [KIND_PR, KIND_PR_UPDATE, KIND_PATCH], '#a': [ref.a] };
    let events = await pool.querySync(relays, filter, { maxWait: 10000 });
    if (args.event) events = existsSync(args.event) ? [JSON.parse(readFileSync(args.event, 'utf8'))] : events.filter(e => e.id === hex(args.event));
    events.sort((a, b) => a.created_at - b.created_at);
    console.log(`${ref.a}: ${events.length} event(s)`);

    for (const ev of events) {
      const who = authors[ev.pubkey];
      if (!who) { console.log(`  skip ${ev.id.slice(0, 8)} kind ${ev.kind}: author ${nip19.npubEncode(ev.pubkey)} not in authors`); continue; }
      const tags = Object.fromEntries(ev.tags.filter(t => t.length >= 2).map(t => [t[0], t[1]]));

      if (ev.kind === KIND_PR_UPDATE) {
        const rootId = tags.E;
        const root = state[rootId];
        if (!root) { console.log(`  skip update ${ev.id.slice(0, 8)}: PR ${rootId?.slice(0, 8)} not relayed`); continue; }
        if (root.updatedAt >= ev.created_at || root.head === tags.c) continue;
        if (root.author !== ev.pubkey) { console.log(`  skip update ${ev.id.slice(0, 8)}: not from PR author`); continue; }
        if (writes >= maxWrites) { console.log('  write budget spent'); break; }
        console.log(`  update ${root.url} -> ${tags.c}`);
        if (!dry) {
          fetchCommit(local, cloneUrls(ev), tags.c);
          git(['push', '--force-with-lease', repo.push || 'origin', `${tags.c}:refs/heads/${root.branch}`], local);
          sh('gh', ['pr', 'comment', root.url, '--body', `Updated from Nostr by the author (${who}): head is now ${tags.c}.\nNostr event: ${nevent(ev)}`]);
          Object.assign(root, { head: tags.c, updatedAt: ev.created_at });
          saveState(statePath, state); writes++;
        }
        continue;
      }

      if (state[ev.id]) continue;
      if (writes >= maxWrites) { console.log('  write budget spent'); break; }
      const subject = tags.subject || firstLine(ev.content) || `Nostr PR ${ev.id.slice(0, 8)}`;
      const branch = `nostr/${slug(who)}/${slug(tags['branch-name'] || ev.id.slice(0, 12))}`;
      let head = tags.c;
      console.log(`  new ${ev.kind === KIND_PATCH ? 'patch' : 'PR'} from ${who}: "${subject}" -> ${repo.upstream} ${branch}`);
      if (dry) continue;

      if (ev.kind === KIND_PATCH) head = applyPatch(local, repo, ev);
      else fetchCommit(local, cloneUrls(ev), head);
      const base = pickBase(local, repo, tags['merge-base']);
      git(['push', repo.push || 'origin', `${head}:refs/heads/${branch}`], local);

      const headRef = `${repo.pushOwner}:${branch}`;
      const existing = JSON.parse(sh('gh', ['pr', 'list', '-R', repo.upstream, '--head', headRef, '--state', 'all', '--json', 'url', '-L', '1']));
      let url;
      if (existing.length) url = existing[0].url;
      else {
        const body = `${ev.content.slice(0, 60000)}\n\n---\n` +
          `Relayed from Nostr on behalf of ${who} (${nip19.npubEncode(ev.pubkey)}), who cannot currently post on GitHub. ` +
          `The commits are the author's, unchanged.\n` +
          `Nostr ${ev.kind === KIND_PATCH ? 'patch' : 'PR'}: ${nevent(ev)}\n` +
          `https://gittr.space/${nip19.npubEncode(ref.pubkey)}/${ref.d}/pulls/${ev.id}\n` +
          `Head: ${head}${ev.kind === KIND_PATCH ? ' (applied with git am)' : ` from ${cloneUrls(ev)[0]}`}`;
        const bodyFile = join(dirname(statePath), `body-${ev.id.slice(0, 8)}.md`);
        writeFileSync(bodyFile, body);
        url = sh('gh', ['pr', 'create', '-R', repo.upstream, '--base', base, '--head', headRef, '--title', subject.slice(0, 250), '--body-file', bodyFile]).trim().split('\n').pop();
      }
      state[ev.id] = { url, branch, head, base, author: ev.pubkey, updatedAt: ev.created_at };
      saveState(statePath, state); writes++;
      console.log(`  opened ${url}`);
      await sleep(cfg.sleepMs ?? 30000);
    }
  }
}

function cloneUrls(ev) {
  const urls = ev.tags.filter(t => t[0] === 'clone').flatMap(t => t.slice(1)).filter(u => /^https?:\/\//.test(u));
  if (!urls.length) die(`event ${ev.id} has no https clone URL`);
  return urls;
}

function fetchCommit(local, urls, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) die(`bad commit id ${sha}`);
  if (tryGit(['cat-file', '-e', `${sha}^{commit}`], local) !== null) return;
  for (const url of urls) {
    try { git(['fetch', '--no-tags', url, sha], local); return; } catch (e) { console.error(`  fetch ${sha.slice(0, 8)} from ${url} failed: ${firstLine(e.stderr?.toString() || e.message)}`); }
  }
  die(`commit ${sha} not fetchable from ${urls.join(', ')}`);
}

function applyPatch(local, repo, ev) {
  const tags = Object.fromEntries(ev.tags.filter(t => t.length >= 2).map(t => [t[0], t[1]]));
  const parent = tags['parent-commit'] || `${repo.upstreamRemote || 'upstream'}/${repo.base || 'master'}`;
  const wt = join(local, '.git', 'nostr2gh-wt');
  tryGit(['worktree', 'remove', '--force', wt], local);
  git(['fetch', repo.upstreamRemote || 'upstream'], local);
  git(['worktree', 'add', '--detach', wt, parent], local);
  try {
    execFileSync('git', ['am', '--3way'], { cwd: wt, input: ev.content, stdio: ['pipe', 'pipe', 'pipe'] });
    return git(['rev-parse', 'HEAD'], wt);
  } finally {
    git(['worktree', 'remove', '--force', wt], local);
  }
}

function pickBase(local, repo, mergeBase) {
  const up = repo.upstreamRemote || 'upstream';
  const base = repo.base || 'master';
  if (!mergeBase) return base;
  tryGit(['fetch', up], local);
  if (tryGit(['merge-base', '--is-ancestor', mergeBase, `${up}/${base}`], local) !== null) return base;
  const other = tryGit(['for-each-ref', '--format=%(refname:strip=3)', '--contains', mergeBase, `refs/remotes/${up}`], local);
  return firstLine(other || '') || base;
}

// ---------- helpers ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true; }
    else out._.push(a);
  }
  return out;
}
function need(k, what) { if (!args[k] || args[k] === true) die(`--${k} <${what}> is required`); return args[k]; }
function die(msg) { console.error(`error: ${msg}`); process.exit(1); }
function now() { return Math.floor(Date.now() / 1000); }
function uniq(a) { return [...new Set(a)]; }
function firstLine(s) { return (s || '').split('\n')[0].trim(); }
function slug(s) { return s.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/\.\.+|\/\/+|^[-/.]+|[-/.]+$|\.lock$/g, '').slice(0, 80) || 'x'; }
function expand(p) { return p.replace(/^~(?=\/|$)/, homedir()); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nevent(ev) { return `nostr:${nip19.neventEncode({ id: ev.id, author: ev.pubkey })}`; }
function saveState(p, s) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(s, null, 2) + '\n'); }
function sh(bin, a, cwd) { return execFileSync(bin, a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function git(a, cwd) { return sh('git', a, cwd); }
function tryGit(a, cwd) { try { return git(a, cwd); } catch { return null; } }
function hex(s) {
  if (/^[0-9a-f]{64}$/.test(s)) return s;
  const d = nip19.decode(s);
  if (d.type === 'npub' || d.type === 'note') return d.data;
  if (d.type === 'nevent') return d.data.id;
  if (d.type === 'nprofile') return d.data.pubkey;
  die(`cannot read id ${s}`);
}
function parseRepoRef(s) {
  if (s.startsWith('naddr1')) { const { data } = nip19.decode(s); return { pubkey: data.pubkey, d: data.identifier, a: `${KIND_REPO}:${data.pubkey}:${data.identifier}` }; }
  const m = /^30617:([0-9a-f]{64}):(.+)$/.exec(s);
  if (!m) die(`repo must be naddr1... or 30617:<hex>:<d>, got ${s}`);
  return { pubkey: m[1], d: m[2], a: s };
}
function loadSecret() {
  const raw = args.nsec || process.env.NOSTR_NSEC || (existsSync(expand('~/.config/nostr2gh/nsec')) ? readFileSync(expand('~/.config/nostr2gh/nsec'), 'utf8').trim() : null);
  if (!raw) die('no key: pass --nsec, set NOSTR_NSEC, or write ~/.config/nostr2gh/nsec (run `nostr2gh keygen`)');
  return raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex'));
}
