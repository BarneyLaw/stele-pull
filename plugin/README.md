# stele-pull

Mirrors Canvas LMS course files into an Obsidian vault, read-only, with
per-device exclusion rules.

This is the **consumer** half of stele-pull. A Go worker (a Kubernetes CronJob)
pulls files out of Canvas into an object store and publishes a manifest; this
plugin mirrors that store into your vault.

No store of your own? **Direct mode** reads Canvas itself, with your Canvas
access token, and lands every file exactly where the worker would have. See
[Setup](#setup).

See `DESIGN.md` for the whole system.

## What it does

- Reads `manifests/<course>/latest`, then the manifest it points at.
- Applies **your** exclusion rules locally to decide what this device wants.
- Downloads blobs by content hash, verifying SHA-256 **before** anything is
  moved into place.
- Large files are pulled as Range requests and appended chunk by chunk, so peak
  memory is one chunk rather than one file. This is what makes mobile work.
- Files Canvas has removed go to a trash folder. Nothing is ever hard deleted.
- Files you have edited locally go to a conflict folder. A one-way mirror is not
  a licence to destroy your data.

## The panel

Everything happens in the sidebar panel. Click the cloud icon in the left
ribbon (or run **Open panel**) and it opens on the right:

- **Status** and the two global actions, Pull now and Refresh.
- **One section per course**: how much is new, changed or missing, and a folder
  tree of exactly what will be written. Tick or untick files, folders or
  **All files**, and press Pull selected. Nothing is downloaded until you do.
- **Not included**, per course: everything Canvas has that was withheld, with
  the reason. A file you can see in Canvas that silently does not appear in
  your vault is the worst possible outcome, so nothing is hidden from you.
- **Conflicts**: files you edited that the mirror refused to overwrite. Open
  one to inspect it, or Discard your copy to accept the mirrored version.
- **Setup**: the whole configuration form, inline.

The settings tab renders that same form (via `renderSettings`), so the two
surfaces cannot drift apart. Use whichever you prefer.

## Setup

First choose where **Read files from**.

**Your stele-pull store** (the worker runs somewhere):

1. Set **Store URL** to the read-only endpoint for your stele-pull bucket. For
   local development, run `stele-pull serve` in the repo root and use
   `http://127.0.0.1:8765`; leave **Bucket** as `stele-pull` or empty, it accepts
   both.
2. Set **Course IDs** to a comma-separated list of numeric Canvas course IDs.
   The store is keyed by ID, not course code: `stele-pull ls` or
   `stele-pull-worker courses` lists them.

**Canvas directly** (no store, no worker):

1. Set **Canvas URL**, e.g. `https://canvas.nus.edu.sg`.
2. In Canvas, go to Account, Settings, **New access token**, give it an expiry
   date, and paste it into **Canvas access token**. See
   [Credentials](#credentials) for where it is kept.
3. Press **Show my courses** and **Add** the ones you want, or type their IDs
   into **Course IDs**.

Then, either way, pick a **Target folder**. Keep it to itself; see the warning
below.

The panel starts fetching as soon as those are filled in.

### Credentials

With a store there are none, by design. Plugin settings persist to
`.obsidian/plugins/stele-pull/data.json` **inside the vault**, which is synced by
whatever else syncs the vault — an S3 secret there travels everywhere the vault
does. Since phase 1 consumers are read-only, expose the bucket behind Tailscale
or an auth proxy and do plain GETs.

If you must sign requests directly, use `aws4fetch` with a **read-only** Garage
key, and verify SubtleCrypto is actually available in Obsidian's mobile origin
first. See the comments at the top of `src/store.ts`.

Direct mode cannot avoid one: a Canvas access token acts as you, with your full
account access. So it is treated like a password. It is typed into a masked
field and never shown again, only whether one is saved. It is kept in
Obsidian's per-device **SecretStorage**, never in `data.json`, so it is not
synced with the vault: enter it on each device. It is sent only to the Canvas
URL you set. File downloads carry Canvas's own short verifier instead, and the
token never reaches Canvas's file storage. Give the token an expiry date, and
revoke it in Canvas if a device is lost.

How direct mode differs from a store:

- Canvas exposes no content hash. A file counts as unchanged while its Canvas
  id, size, `updated_at` and `modified_at` match what this device recorded
  writing, the worker's own test. A new or changed file is hashed as it
  downloads, and only then compared with anything already in the vault.
- There are no worker rules, only yours. The default `no-huge` rule still
  holds back anything over 50 MB until you change it.
- Every refresh and automatic pull lists each course in Canvas: three or four
  API requests per course.

## Exclusion rules

Rules are applied to the manifest locally, so changing them **never needs a
refetch** — that is why they can be as aggressive as you like. The worker's own
rules are deliberately boring hard caps; everything opinionated belongs here.

```json
{
  "version": 1,
  "default": "include",
  "rules": [
    { "name": "no-huge",  "priority": 10, "action": "skip",
      "match": { "min_size": 52428800 } },
    { "name": "no-video", "priority": 20, "action": "skip",
      "match": { "ext": ["mp4", "mov"] } },
    { "name": "slides",   "priority": 40, "action": "include",
      "match": { "ext": ["pdf"], "glob": ["*/lectures/*"] } }
  ]
}
```

Highest priority wins; ties break by document order, so the file reads top to
bottom. Every clause inside one `match` must hold. Globs follow Go's
`path.Match`: `*` does not cross `/`, `[a-z]` classes work, `^` negates.

A rule with an empty `match` is rejected — that is what `default` is for.

The panel's **"not included"** section lists everything withheld and why, so a
rule can never quietly cost you a file without saying so. Files tagged
**pending** were left for later by a scoped manual pull on the worker
(`stele-pull-worker pull -path ...`) and arrive with its next full pull; there is
nothing to change on your side.

## Folders

Each course gets its own folder under the target folder, named
`code [term] (id)`, and so do its trash and conflicts:

```
Canvas/
  CS3103 [2610] (93794)/Labs/labs-intro.pdf
  CS2103-CS2103T [2510] (77826)/...   "/" in a cross-listed code becomes "-"
  CP2106 (81917)/...                  no term tag in the Canvas name
  _trash/CS3103 [2610] (93794)/...
  _conflicts/CS3103 [2610] (93794)/...
```

The term is the tag the Canvas course name ends with. The id keeps two courses
apart even when both have a `Labs/lab1.pdf`. If the name format changes, the
folder is renamed on the next sync, not downloaded again.

Obsidian's `[[wikilinks]]` cannot contain `[` or `]`, so link to these files
with Markdown links (`[slides](<Canvas/CS3103 [2610] (93794)/Labs/x.pdf>)`)
or embeds made through Obsidian's own link picker. Files pulled by an earlier version
of the plugin, when every course shared one folder, are moved into their
course's folder by the next sync: renamed, not downloaded again. A manifest
from a worker too old to send the course code gives a folder named by id
alone, and that folder is renamed once a newer worker publishes the code.

## A warning about search

Dropping hundreds of PDFs into a vault triggers an Obsidian reindex. Keep the
mirror in its own top-level folder and add that folder to **Settings → Files and
links → Excluded files** if search gets noisy.

## Sync triggers

On load (after a delay), on an interval, and manually from the panel. **Never on vault file
change** — a mirror that reacts to your own edits is a feedback loop.

**Nothing enters the vault unless it is ticked and you press a pull button.**

| | Pull now / Pull selected | Automatic (startup, interval) |
|---|---|---|
| New file, ticked (the default) | pulled | not pulled |
| File you unticked | not pulled | not pulled |
| Changed in Canvas, already in the vault | pulled if ticked | refreshed unless unticked |
| Deleted from the vault (starts unticked) | pulled only if you tick it | never |
| Removed from Canvas | moved to trash | moved to trash |

Ticks and unticks are remembered per device until the file is pulled, so an
untick survives restarts. In the panel, each file is tagged **new** (not in
this vault yet), **changed** (Canvas has a newer version than your copy) or
**missing** (pulled before, then deleted from the vault). Unticking a folder,
or **All files**, unticks everything beneath it.

## Development

```sh
npm ci
npm run dev     # watch build into main.js
npm test        # vitest, including the contract fixtures in ../schema
npm run build   # tsc --noEmit, then a production bundle
npm run lint
```

`policy`, `preview`, and `types` are pure and test with no Obsidian mock at all;
that is why they are kept apart from anything touching `Vault`. `sync` is tested
against an in-memory `DataAdapter` in `test/obsidian.ts`.

The plugin and the Go worker ship as a pair, and the contract between them lives
in the repository root's `schema/`, one copy read by both test suites:

- `policy-golden.json`: decisions both rule engines must reach, and policies both
  validators must reject. Hand-written.
- `manifest-golden.json` and `store-contract.json`: a manifest covering every
  state, and the store keys and constants. **Generated** by the Go types with
  `go test ./internal/manifest -run TestContractFixtures -update`; never edit
  them by hand.
- `manifest-invalid.json`: manifests both `parseManifest` and Go's `Decode` must
  refuse. Hand-written.

CI for this folder is `.github/workflows/plugin.yml` at the repository root. It
runs on plugin changes and on any contract change, alongside the worker's
workflow.

## Requirements

Obsidian 1.12.3 or later. `appendBinary` landed there, and without it the mobile
file-size ceiling is structural rather than incidental.
