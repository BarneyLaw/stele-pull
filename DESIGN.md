# stele-pull: design

Phase 1 of stele-pull. Pulls Canvas LMS course files into an object store on a
schedule; an Obsidian plugin mirrors that store into a vault, read-only, with
per-device exclusion rules.

Phases 2 and 3 (peer sync, multi-writer collaboration) share almost nothing with
this beyond the manifest schema and the rule engine. That is deliberate. Do not
build phase 1 as the foundation of phase 3 or you will ship neither.

---

## 1. The load-bearing decision

The manifest is a **complete catalogue of what Canvas has**, not a list of what
was fetched. A skipped file is still an entry, with the rule that excluded it and
a human-readable reason.

An earlier draft of this design dropped skipped files entirely. That created two
problems at once:

- the plugin's "what will be pulled" preview needed a worker API to answer
  "what else is there?", meaning a round trip, a server, and an auth story
- a file the worker dropped was invisible to every consumer forever

Cataloguing everything collapses both. The preview becomes a **pure function
over data the plugin already has**: instant, offline, no API. And nothing Canvas
offers is ever silently withheld. The cost is a few hundred bytes per skipped
entry across maybe two thousand entries a semester, which is nothing.

Entry states:

| State | Meaning |
|---|---|
| `stored` | blob is in the store, `sha256` valid |
| `skipped` | catalogued, deliberately not fetched, `reason` says why |
| `locked` | Canvas reports not yet downloadable, `unlock_at` set |
| `failed` | fetch attempted, failed |
| `deleted` | tombstone, path was live before and is gone from Canvas now |

`locked` is separate from `failed` because Canvas genuinely returns
`locked_for_user: true` for files that are visible but not yet released.
Collapsing them means an alert every week before a lecture drops.

`rules_hash` on the manifest identifies the rule set that produced it. When it
changes, previously-skipped entries get re-evaluated. Without it, a rules edit
either silently does nothing or forces a full re-evaluation on every run.

---

## 2. Constraints that shaped everything

**Canvas gives you no content hash.** The REST file object carries `id`, `uuid`,
`folder_id`, `display_name`, `filename`, `content-type`, `url`, `size`,
`created_at`, `updated_at`, `modified_at`, `unlock_at`, `locked`, `hidden`,
`mime_class`. There is an md5/sha512 column, but it lives in the Canvas Data
(DAP) dataset, not in the API you are calling. So change detection is two-stage:
`(size, updated_at, modified_at)` is a *maybe changed* signal that triggers a
download, and SHA-256 over the downloaded bytes decides whether a new blob is
actually stored. The distinction between `updated_at` and `modified_at` is murky
enough that people ask Instructure directly, so treat either moving as a trigger.

**File identity is not the Canvas id.** Lecturers delete and re-upload instead of
replacing, which mints a new id for the same logical file. Identity is
`(course, folder path, display_name)`, with the Canvas id as metadata. A path
reappearing with a different id is a *resurrection*, not a collision. This is the
single most likely source of duplicate entries and it has a dedicated test.

**Canvas throttles on concurrency, not volume.** 50 units are charged up front
per in-flight request before the true cost is subtracted, specifically so
parallel calls cannot overflow the bucket unnoticed. Metadata concurrency: 2-4.
Downloads redirect to presigned storage URLs on a different host and consume no
API quota, so those run at 8+. The docs disagree about whether throttling
returns 403 or 429, so handle both; treat 401 as fatal, never retryable.

**Garage has no object versioning.** Overwriting is destructive with no
recovery. Hence: every key is write-once except one.

**Obsidian buffers whole HTTP responses.** `requestUrl` is the only networking
API that bypasses CORS, and it has no streaming variant. Mobile fails outright
around 20-50 MB. This *was* a hard ceiling until Obsidian 1.12.3 (Feb 2026)
added `appendBinary` to `Vault` and `DataAdapter`. Combined with HTTP Range
requests, peak memory becomes one chunk instead of one file. `CapacitorAdapter`
implements `DataAdapter`, so this works on phones.

---

## 3. Store layout

One bucket, Garage v2.3.x, three nodes, `replication_factor = 3`.

```
blobs/sha256/ab/cd/<hash>            immutable, content-addressed
manifests/<course_id>/<run_id>.json  immutable, one per run
manifests/<course_id>/latest         THE ONLY MUTABLE KEY
runs/<run_id>.json                   run summary, debugging
```

Content addressing gives free dedup (the same PDF in two courses is one blob),
makes renames a manifest-only change with no refetch, and removes any need for
rename, copy, or conditional-update in the `Store` interface. That is why four
different backends could implement it without leaking their differences upward.

Publishing `latest` is the commit. A crash anywhere before it leaves orphan
blobs and an unreferenced manifest, both invisible to consumers because `latest`
still points at the previous run. The worker holds no local state, so a fresh
pod is identical to a resumed one.

The accepted tradeoff: `latest` is read-modify-write with no compare-and-swap,
so two concurrent workers clobber each other. Phase 1 is safe because
`concurrencyPolicy: Forbid` guarantees one writer. **This is one of the
assumptions that breaks in phase 2.** Write it down.

It already bends in phase 1: manual pulls (`stele-pull-worker pull`, or
`kubectl create job --from=cronjob/...`) are not counted by Forbid. So every
writer also takes a lease, `locks/worker.json`, created with an exclusive put
and re-verified immediately before each `latest` publish. A crashed run's lease
is stealable after its TTL; because stealing is delete-then-create, the
pre-commit verify is what guarantees at most one stealer commits. `gc -apply`
takes the same lease. On a backend without exclusive create the lease is
best-effort and logs that it is.

Garage is such a backend. v2.3.0 accepts a second `PutObject` carrying
`If-None-Match: *` rather than returning 412, so the S3 store probes for the
behaviour instead of assuming it, and reports exclusive create as unsupported
when the probe's second write succeeds. On Garage, then, `Forbid` remains the
real guarantee for scheduled runs; the lease plus pre-commit verify narrows,
but does not close, the window for a manual pull racing one.

GC is a separate command, never in the worker: walk reachable manifests, list
`blobs/`, delete the difference, skip anything younger than 24 hours so it
cannot race an in-flight run.

### Why not a prefix-scoped write path for user content

An earlier draft proposed `canvas/` versus `user/` prefixes enforced by IAM
policy. Garage's permission model is bucket-level read/write/owner, so that does
not work. Phase 1 consumers are read-only anyway, and "upload extra stuff" is
served by simply writing to the vault locally, since nothing distributes it
until phase 2. **Do not build a write path you cannot secure.**

---

## 4. Rules, and how the frontend changes them

One schema, evaluated in two places with opposite defaults.

| | Worker rules | Consumer rules |
|---|---|---|
| Decides | what enters the store | what enters this vault |
| Reversible | only by refetching from Canvas | instantly, locally |
| Default posture | permissive, hard caps only | as aggressive as the user likes |
| Lives in | ConfigMap, changed via git | plugin settings |
| Applied to | the Canvas listing | the manifest |

Keep worker rules boring: two or three hard caps. Every aggressive filter belongs
on the consumer where reversing it is a checkbox rather than a full refetch.

Priority: highest wins, ties break by document order so a rules file reads top to
bottom. `Validate()` rejects a rule with an empty match, because that silently
swallows everything and is what `default` is for.

**Consumer rules need no server involvement at all.** They are applied to the
manifest locally. This is the whole preview feature, and it is what to build
first.

**Worker rules** are the harder case, since the consumer key is read-only.

- *Default: GitOps.* Rules are a ConfigMap in the Argo repo. Changing them is a
  commit: reviewable, revertible, consistent with how the rest of the cluster
  runs. Not a UI, so fine for you and useless for a friend.
- *When you want it in the UI: a request bucket.* `stele-pull-requests`, consumer
  writes, worker reads and deletes. The worker drains the prefix at the start of
  each run, folds requests into an overrides file it owns, acts, deletes.
  Asynchronous by one cron period, which is fine for "fetch me that recording".
  Bound the prefix size and ignore requests older than a week so a misbehaving
  client cannot make worker startup unbounded.

Build the GitOps path now. Build the request bucket when the ConfigMap workflow
actually annoys you.

---

## 5. Go worker

```
cmd/stele-pull-worker/     run (cron) / pull (manual, scoped) / courses; one pass, exits
cmd/stele-pull/            ls / preview / log / diff / cat / gc / serve
internal/portable/     path sanitisation            [pure]
internal/policy/       rule engine                  [pure]
internal/manifest/     schema, encode/decode, diff  [pure]
internal/plan/         the differ                   [pure]
internal/scope/        manual pull path patterns    [pure]
internal/canvas/       Source: pagination, limiter, downloads
internal/store/        Store: s3 / fs / memory, logging wrapper
internal/lease/        single-writer lease in the store
internal/run/          orchestration, the only package that cares about ordering
internal/gc/           unreferenced blob collection
internal/obs/          metrics, logging
```

The pure packages hold every decision the system makes. Values in, values
out, no context, no clock, no network. That is where the tests are and where the
bugs will be. `run` is a thin sequencer, and the one place decisions are
logged: the planner returns each decision with its reason as data.

### Interfaces

```go
type Store interface {
    Get(ctx, key) (io.ReadCloser, error)
    Put(ctx, key, r io.Reader, size int64) error
    Exists(ctx, key) (bool, error)
    Delete(ctx, key) error
    List(ctx, prefix string, fn func(ObjectInfo) error) error
}

// Optional, type-asserted, NOT in Store.
type RangeReader interface { GetRange(ctx, key string, off, n int64) (io.ReadCloser, error) }
type Presigner  interface { Presign(ctx, key string, ttl time.Duration) (string, error) }
```

`List` takes a callback rather than returning a slice because GC walks the whole
blob namespace and must not materialise it. `Files` on the Canvas side *does*
return a slice, because the differ needs the complete listing to compute
tombstones, so streaming buys nothing there. (An earlier draft used `iter.Seq2`
for both. Wrong for the same reason.)

### Run sequence

```
0. acquire lease (not for dry runs)
1. read manifests/<course>/latest -> run_id -> prev manifest
2. list Canvas files + folders, build portable paths
3. plan.Compute(prev, files, rules, overrides, scope)
4. for each Fetch: download to temp file -> hash -> Put blob if !Exists
5. assemble manifest (carry + skipped + locked + failed + tombstones + fetched)
6. Put manifests/<course>/<run_id>.json  (write-once)
7. verify lease, Put manifests/<course>/latest   <- COMMIT
8. after all courses: Put runs/<run_id>.json, release lease
```

One failing course does not abort the others: its previous manifest stays live,
which is the correct degraded state. Three things do stop the pass: a rejected
token (every later request fails the same way), a lost lease, and cancellation.
A course whose Files tab is hidden returns 403, and a scheduled run records it
as `forbidden`, not as a failure.

Hardening that follows from "nothing is silently withheld":

- A filename that cannot be made portable is stored under a stand-in name
  (`canvas-file-<id>.ext`) with the original in `reason`, not dropped.
- A failed refresh of a previously stored file keeps the previous entry
  verbatim, stale metadata included, so the consumer keeps the file and the
  next run retries.
- A download whose byte count differs from Canvas's `size` is a failure, never
  a blob: a clean short read would otherwise become the content of record.
- Skip decisions are re-evaluated every run. `rules_hash` records which rules
  produced a manifest; it no longer gates re-evaluation, which let a file that
  shrank under the size cap stay skipped forever.

### Manual pulls and scope

`stele-pull-worker pull -course CS3103 -path "Week 1" -path "**/*.pdf"` pulls on
demand. Scope limits **downloads, never the catalogue**: listing is cheap, so
skips, locks and tombstones stay complete. A file outside the scope keeps its
previous entry unchanged if it had been fetched before; otherwise it is
catalogued as `skipped` with rule `obsync:pull-scope`, and the next full pass
fetches it. A pattern that matches nothing fails the pull, since it is almost
always a typo. `-dry-run` plans and logs every decision and writes nothing.

### Audit log

Every non-trivial action is one JSON line on stderr with a stable dotted event
name (`plan.skip`, `file.fetched`, `store.put`, `latest.published`, ...) and the
run id, so a pass can be reconstructed from logs alone. Decisions, remote calls
and writes log at Info; degraded outcomes at Warn; aborts at Error; no-ops at
Debug. Tokens never appear; download verifiers are redacted.

### Path portability

Lecturers name files badly and the failure mode is silent. `internal/portable`
normalises to NFC (macOS hands you NFD; without this the same file is two
different paths depending on which device ran the worker), replaces
`< > : " | ? * \`, strips control characters, strips trailing dots and spaces
(Windows drops them behind your back), prefixes reserved device names
(`CON`, `com1.pdf`), caps component and total length, and rejects `..` and
absolute paths.

After sanitisation two Canvas files can collide on one path. `Disambiguate`
appends a suffix derived from the **Canvas file id**, never from iteration order,
so the manifest is stable across runs regardless of pagination order. There is a
test that reverses the input order and asserts the path set is identical.

Also: Canvas folder `full_name` comes back as `course files/Week 1`. Strip the
synthetic root or every vault gets a `course files` directory.

---

## 6. Deployment

Namespace `stele-pull`, everything through Argo.

**Garage.** StatefulSet, 3 replicas, `podAntiAffinity` by hostname (co-locating
two pods defeats replication), headless service for RPC on 3901, ClusterIP for
S3 on 3900 and admin on 3903. Volumes on a Longhorn class with **one**
replica, `strict-local`, **never** on the 3-replica default: Garage replicates
at the application layer, and replicating underneath is pure waste (9 copies)
plus a second rebuild on every reboot. One replica rather than `local-path` buys
enforced sizes, online expansion and Longhorn's visibility, at the cost of
Longhorn's `node-drain-policy` needing `allow-if-replica-is-stopped` so kured
can still drain those nodes.
`rpc_public_addr` must be the stable pod DNS name or the nodes never form a
layout.

Worth remembering: in phase 1 this store holds a **cache**, not a system of
record. Canvas is the source of truth and the whole bucket is reconstructible by
rerunning the worker. Three nodes is a learning goal, not a phase-1 requirement.
Single-node Garage would be defensible.

**Worker.** CronJob, daily at 18:17 `Asia/Singapore` (`timeZone`, so the
controller's UTC clock does not shift it to 02:17), `concurrencyPolicy:
Forbid`, `startingDeadlineSeconds`, `backoffLimit: 2`, `activeDeadlineSeconds`
below the lease TTL. Forbid is load-bearing, not a nicety. Run on demand with
`kubectl create job --from=cronjob/obsync-worker` or Argo CD's Create Job
action; the store lease holds that off a scheduled run.

**GitOps.** `deploy/` mirrors `apps/` and `argocd/` in homelab-cicd-config. On
`main`, CI publishes `ghcr.io/barneylaw/obsync-worker:<sha>`, bootstraps any of
those files that are absent, and bumps the kustomize image tag, the same
contract as lag-app. After the first deploy the config repo is the source of
truth for schedule, rules and Garage config.

**Secrets.** Canvas token and Garage keys via sealed-secrets. Vault is not
actually running in the homelab despite the original spec, and sealed-secrets is
the right weight: encrypted values commit to the Argo repo, the controller
decrypts in-cluster, nothing extra to keep alive.

**Metrics.** A CronJob's pod exits, so Prometheus will never scrape it. The
original plan was a Pushgateway, but the cluster does not run one, and it does
run kube-state-metrics, which already publishes the CronJob's last schedule and
last success times without the worker exporting anything. **Alert from
kube-state-metrics, keep Forbid.** If per-run counters (files fetched, bytes)
are ever wanted on a dashboard, that is the point to add a Pushgateway.

The alert that matters, with a daily schedule plus slack:

```yaml
alert: ObsyncWorkerStale
expr: time() - max(kube_cronjob_status_last_successful_time{namespace="stele-pull", cronjob="stele-pull-worker"}) > 26 * 3600
for: 30m
```

Everything else is a counter you look at once that fires.

---

## 7. Obsidian plugin

### Division of labour

The worker produces, the plugin consumes, they share no logic. Consumer-side
diffing (manifest entry vs what I wrote locally) is a **different algorithm**
from worker-side diffing (Canvas metadata vs previous manifest), so writing one
in Go and one in TypeScript is not duplication. Resist building a Go consumer
daemon as well, or you maintain two implementations of the same thing and mobile
still does not work.

What they *do* share is the manifest schema and the rule engine, and both are
pinned by fixtures in `schema/` that both test suites load. They catch every
drift before the user sees a preview that does not match what the worker did.

| Fixture | Owner | Go reads it in | Plugin reads it in |
|---|---|---|---|
| `policy-golden.json` | hand-written | `internal/policy` (decisions, and `invalid` policies `Parse` must reject) | `policy.test.ts` (same, via `validate`) |
| `manifest-golden.json` | **generated** by the Go types | `internal/manifest` (byte-for-byte equal to what `Encode` writes) | `contract.test.ts`, `preview.test.ts` |
| `store-contract.json` | **generated** | `internal/manifest` | `contract.test.ts` (key layout, `obsync:pull-scope`, states) |
| `manifest-invalid.json` | hand-written | `internal/manifest` (`Decode` must refuse) | `contract.test.ts` (`parseManifest` must refuse) |
| `canvas-paths.json` | **generated** by the worker's path builder | `internal/run` | `canvas.test.ts` (direct mode names every file identically) |

The generated fixtures are rewritten with
`go test ./internal/manifest -run TestContractFixtures -update`, so a change to
what the worker writes shows up as a diff in `schema/` that the plugin suite then
runs against. CI is split to match: `worker.yml` and `plugin.yml` each run when
their half changes, and both run when any contract path changes.

### Researched implementation choices

| Decision | Choice | Why |
|---|---|---|
| Networking | `requestUrl` | The only Obsidian API that bypasses CORS. Desktop routes through Electron's net module, mobile through Capacitor. Modern Obsidian needs **no bucket CORS config**; older builds required allowing `app://obsidian.md`, `capacitor://localhost`, `http://localhost` with ETag exposed, which the `minAppVersion` floor removes. |
| Large files | Range GET + `appendBinary` | 2 MB windows on mobile, 8 MB desktop, appended to a dot-prefixed part file, hash verified, then renamed. Peak memory is one chunk. Prior art: Tether 1.0.15 shipped exactly this pattern in Aug 2026. |
| S3 signing | `aws4fetch` **if needed at all** | ~3 KB gzipped versus 500 KB+ for `@aws-sdk/client-s3`. `AwsV4Signer` gives raw headers to hand to `requestUrl`. remotely-save uses the full SDK with a custom fetch handler; that works but the bundle cost is real. |
| Hashing | `@noble/hashes` | `crypto.subtle` needs a secure context and Obsidian mobile's origin scheme makes that unreliable. Noble behaves identically everywhere and supports incremental `update()`, so chunks are hashed as they arrive. |
| Build | esbuild, CJS, `external: ["obsidian", "electron", ...builtins]` | Standard for the ecosystem. Listing Node builtins as external means an accidental `require("fs")` fails the build loudly instead of silently breaking on mobile. |
| Tests | Vitest | Pure modules (`policy`, `preview`, `types`) test with no Obsidian mock at all. That is why they are separated from anything touching `Vault`. |

### The credentials problem, and how to avoid it

Plugin settings persist to `.obsidian/plugins/stele-pull/data.json`, **inside the
vault**, synced by whatever else syncs the vault. An S3 secret there travels
everywhere the vault does.

Since phase 1 consumers are read-only, the clean answer is to hold no
credentials at all: expose the bucket read-only behind Tailscale or an auth
proxy and do plain GETs. No SigV4, no signing library, no secret at rest.

If you do want direct S3, use `aws4fetch` with a **read-only** Garage key so a
leak costs course slides rather than the bucket. Verify early that SubtleCrypto
is available in Obsidian's mobile origin, since aws4fetch depends on it.

### Direct-Canvas mode

For users who cannot host a store, the plugin can read Canvas itself. This
bends two rules above, on purpose and only in that mode.

- **It holds a credential.** A Canvas token cannot be made read-only, so it
  must never reach `data.json`. It lives in Obsidian's per-device
  `SecretStorage`, is entered into a masked field and never shown again, and
  goes only to the configured Canvas origin. Downloads follow the file's
  verifier URL with no token, like the worker's credential-free client.
- **It shares the worker's path logic, ported.** The rule against two
  implementations still holds for the *diff*: direct mode builds the same
  `Manifest` and hands it to the same consumer loop. The one thing it cannot
  avoid duplicating is turning a Canvas listing into paths (`portable`, the
  `course files` strip, dedupe and disambiguation), because a vault switched
  between modes must not move a file. `canvas-paths.json` pins that.

With no content hash from Canvas, "unchanged" is the worker's own test
(`plan.unchanged`) against the Canvas metadata this device recorded when it
wrote the file. A new or changed file has no hash until it is downloaded, so
the conflict check that normally runs before a download runs after it instead,
and the size check is what catches a short read. Large files still use Range
GETs: Canvas's file storage answers them with 206.

### Consumer sync loop

```
fetch latest -> run_id; if unchanged since last sync, stop
fetch manifest, refuse unknown schema_version
for each live entry:
    apply LOCAL policy                  -> record skip + reason
    if state[path].sha256 == entry.sha256 -> up to date
    if file exists on disk:
        hash it
        if hash != state[path].sha256   -> CONFLICT: quarantine, continue
    fetch blob (whole, or ranged if large), hashing as it arrives
    verify hash, then rename into place
for each tombstone: move to trash folder, never hard delete
```

Two things that are not paranoia:

- **Verifying the hash before the rename.** It costs nothing, since the bytes
  already passed through the hasher, and it is the only check that the store
  returned the object you asked for.
- **Quarantining instead of overwriting.** One-way sync is not a licence to
  destroy local data. If what is on disk does not match the hash last written,
  the user edited a read-only file. It goes to `_conflicts/`.

Tombstones move to a trash folder, never hard delete: lecturers unpublish and
republish constantly.

### UI

- **Settings**: store URL, courses, target folder, interval, local rules
- **Status bar**: last sync result, click to sync
- **Preview modal**: what will be pulled, with per-file opt-out, *and a "not
  included" section listing everything withheld with its reason*. A file the user
  can see in Canvas that silently does not appear is the worst possible outcome.
- **Conflicts**: quarantined files, keep-mine or take-theirs

Sync triggers: on load with a delay, on an interval, manually. **Never on vault
file change** — a mirror that reacts to the user's own edits is a feedback loop.

One warning to put in the README: dropping hundreds of PDFs into a vault
triggers an Obsidian reindex. Keep the mirror in its own top-level folder and
tell people to add it to Excluded Files if search gets noisy.

---

## 8. Build order

Each step is useful on its own.

1. **`portable`, `policy`, `manifest`, `plan`.** Pure, table-tested, no I/O.
   A day, and it is the entire brain. *Done, tests green.*
2. **`canvas`.** Prove it by dumping a course listing to stdout with the limiter
   engaged. First real check: does your NUS token work, and does pagination
   terminate?
3. **`store` filesystem backend.** Run the whole pipeline into a local directory.
   `make run-dev`. *Done.*
4. **`cmd/stele-pull ls` and `preview`.** You cannot debug the differ without them,
   so do not defer them. Your blob keys are hashes: no generic S3 browser will
   ever show you anything meaningful, the manifest is the only human-readable
   index, and reading it is this tool's job.
5. **Swap in S3 against Garage.** Nothing above changes. **Make Range GET your
   first integration test**: the entire mobile story rests on it. *Done: Range
   GET, store conformance, presign and a full worker pass run against Garage
   v2.3.0 locally (`scripts/garage-dev.sh`) and in CI. `stele-pull serve` fronts any
   backend, so the plugin reads Garage without credentials.*
6. **CronJob, staleness alert.** *Manifests, image and GitOps pipeline ready
   in `deploy/`; alerts use kube-state-metrics, not a Pushgateway.*
7. **Plugin**: types + policy + preview first (pure, no Obsidian mocks needed),
   then transport, then the sync loop, then UI.
8. **Request bucket**, only if the ConfigMap workflow annoys you.

## 9. Open questions

- Confirm NUS has not disabled manual access token generation. Ten minute check
  that gates everything.
- ~~Verify Range GET against Garage before writing the plugin's chunked path.~~
  Verified on v2.3.0, through both the S3 API and the website endpoint.
- Garage ignores `If-None-Match` on `PutObject`, so the lease is best-effort
  there. Revisit if manual pulls ever run on a timer of their own.
- Verify SubtleCrypto availability on Obsidian mobile if you go the direct-S3
  route.
- Decide whether skipped-file "stub notes" (a small markdown placeholder with a
  Canvas link, in place of an excluded 400 MB recording) are worth it. Fits
  Obsidian's model well, but it is a feature, not a requirement.
