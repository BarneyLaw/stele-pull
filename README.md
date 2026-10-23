# stele-pull

Phase 1 (`stele-pull`): mirror Canvas LMS course files into an object store, and
from there into an Obsidian vault. One-way. See [DESIGN.md](DESIGN.md).

## Status

| Component | State |
|---|---|
| `internal/portable`, `policy`, `manifest`, `plan`, `scope` | done, tests green |
| `internal/canvas` | client + rate limiter, tested against httptest; token and files API verified on NUS Canvas |
| `internal/store` FS + Memory + logging wrapper | done |
| `internal/store` S3 | done; integration-tested against Garage v2.3.0 locally and in CI |
| `internal/lease` | done; exclusive on FS/Memory; best-effort on Garage, which ignores `If-None-Match` |
| `internal/run` | hardened, audit-logged; downloads still serial |
| `internal/gc` | done |
| `cmd/stele-pull-worker` run / pull / courses | done |
| `cmd/stele-pull` ls / preview / log / diff / cat / gc / serve | done |
| `internal/obs` | JSON audit log; Pushgateway not wired |
| plugin: types/policy/preview | done, contract-tested against the Go fixtures in `schema/` |
| plugin: sync/store/UI | sync unit-tested against an in-memory adapter; untested in a real vault |
| CI | `worker.yml` and `plugin.yml`, path-filtered, both on contract changes |
| Deployment | `deploy/` bootstraps homelab-cicd-config: Garage StatefulSet and a CronJob daily at 18:17 SGT; see [deploy/README.md](deploy/README.md) |

## Worker commands

```sh
stele-pull-worker run      # scheduled pass over every active course (the CronJob)
stele-pull-worker pull     # manual pull, outside the schedule
stele-pull-worker courses  # list active courses; -probe checks their files are reachable
```

`pull` targets exactly what you ask for:

```sh
# one course, everything
stele-pull-worker pull -course CS3103 -rules deploy/apps/obsync-worker/rules.json -fs-store .stele-pull-store

# only some directories and files (paths as `stele-pull ls <course>` prints them)
stele-pull-worker pull -course CS3103 -path "Week 1" -path "Tutorials/T3.pdf" ...

# globs: * is one path segment, ** spans any number
stele-pull-worker pull -course CS3103 -path "**/*.pdf" ...

# see every decision without downloading or writing anything
stele-pull-worker pull -course CS3103 -path "Week 1" -dry-run ...

# a scheduled run is in progress: wait for it instead of exiting 3
stele-pull-worker pull -course CS3103 -wait 15m ...
```

Scope limits what is downloaded, never what is catalogued. Files outside it keep
what the store already had; files never fetched are listed as skipped with rule
`obsync:pull-scope` and the next full run fetches them. Patterns are
case-insensitive, and one that matches nothing fails the pull.

Exit codes: `0` ok, `1` failed, `2` usage or config, `3` another run holds the
lease, `4` Canvas rejected the token.

**In the cluster**, `kubectl -n obsync create job --from=cronjob/obsync-worker
obsync-manual-$(date +%s)` runs a full pass now. It is safe next to the
schedule: the store lease makes one of them exit 3.

## Store inspection

```sh
stele-pull ls                        # every course: last run, counts, size
stele-pull ls <course-id>            # the file tree with real names
stele-pull preview <course-id>       # what a vault gets, and everything withheld with why
stele-pull log <course-id>           # run history with added/removed/changed counts
stele-pull diff <course-id> <a> latest
stele-pull cat <course-id> <path>    # stream a file, verifying its hash
stele-pull gc                        # report unreferenced blobs; -apply deletes
stele-pull serve                     # read-only HTTP on 127.0.0.1:8765 for the plugin
```

## Audit log

Every non-trivial action is one JSON line on stderr: a stable event name in
`msg`, plus `run_id`, `course_id` and the details. For example:

```sh
stele-pull-worker pull ... 2> pull.log
jq 'select(.msg=="latest.published")' pull.log                 # every commit
jq 'select(.msg=="plan.skip") | {path, rule, reason}' pull.log  # what was withheld, why
jq 'select(.level=="WARN" or .level=="ERROR")' pull.log
```

Each writing pass also leaves `runs/<run_id>.json` in the store: trigger, host,
rules hash, scope, and per-course outcome and counts. Use `-log-level debug` to
also see unchanged files and store reads.

## Dev loop, no cluster needed

bash:

```sh
set -a; . ./.env; set +a
make test
make courses                         # find the course code
make pull-dev COURSE=CS3103 DRY=1    # plan only
make pull-dev COURSE=CS3103          # full pipeline into ./.stele-pull-store
make serve-dev                       # plugin base URL: http://127.0.0.1:8765
```

PowerShell (no make):

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*(?:export\s+)?(\w+)=(.*)$') { Set-Item "env:$($Matches[1])" $Matches[2].Trim('"', "'") }
}
go build -o bin/stele-pull-worker.exe ./cmd/stele-pull-worker; go build -o bin/stele-pull.exe ./cmd/stele-pull
./bin/stele-pull-worker.exe pull -course CS3103 -rules deploy/apps/obsync-worker/rules.json -fs-store .stele-pull-store
./bin/stele-pull.exe serve
```

## Garage (S3) store

Every command that takes `-fs-store` uses S3 instead when the flag is omitted
and `GARAGE_*` is set: `GARAGE_ENDPOINT`, `GARAGE_BUCKET`, `GARAGE_ACCESS_KEY`,
`GARAGE_SECRET_KEY`, optionally `GARAGE_REGION` (default `garage`). These are
the variables the CronJob already sets.

A single-node Garage in Docker for development, the same one CI uses:

```sh
scripts/garage-dev.sh up             # container obsync-garage: bucket obsync, key obsync-dev
eval "$(scripts/garage-dev.sh env)"
make s3-test                         # Range GET, conformance, presign, a full worker pass
./bin/stele-pull-worker pull -course CS3103 -path Labs -rules deploy/apps/obsync-worker/rules.json
./bin/stele-pull ls
./bin/stele-pull serve                   # read-only proxy in front of Garage
scripts/garage-dev.sh down           # removes the container and its data
```

From PowerShell, use the wrapper. It runs the script under Git Bash in your
session and sets `GARAGE_*` there:

```powershell
./scripts/garage-dev.ps1 up      # start (idempotent) and set GARAGE_* in this session
./scripts/garage-dev.ps1 env     # a new terminal, Garage already running
./scripts/garage-dev.ps1 down
```

Do not run `scripts/garage-dev.sh` directly from PowerShell: Windows opens the
`.sh` in a separate window and returns before Garage is up.

**Pointing the plugin at Garage.** The S3 API needs signed requests and the
plugin holds no credentials, so it reads through one of two unsigned doors:

| | `stele-pull serve` in front of Garage | Garage's website endpoint |
|---|---|---|
| Store URL | `http://127.0.0.1:8765` | `http://stele-pull.web.garage.localhost:3902` in dev, a Tailscale name in the cluster |
| Bucket setting | `stele-pull` or empty | empty (the host name selects the bucket) |
| Credentials | on the machine running `serve`; a read-only key is enough | none |
| Exposes | only `manifests/` and `blobs/` | every key, including `locks/` and `runs/` |
| Range | yes (206) | yes (206) |

**Single writer on Garage.** Garage v2.3.0 accepts a second `PutObject` with
`If-None-Match: *` instead of refusing it (`TestS3ConditionalWrites` records
this, and the store probes it at runtime). So on Garage the lease is
best-effort: the worker logs `lease.best_effort`, and re-verifies the lease
straight after taking it and before every commit. Scheduled runs are still kept
single by the CronJob's `concurrencyPolicy: Forbid`, so run manual pulls away
from the `:17` schedule. If a later Garage honours the header, the probe picks
it up with no code change.

## Plugin

```sh
cd plugin
npm ci
npm test                     # vitest, including the contract fixtures in ../schema
npm run lint
npm run dev                  # esbuild watch into main.js
ln -s $PWD ~/ObsidianDev/.obsidian/plugins/stele-pull
```

On Windows, link with a junction instead:
`cmd /c mklink /J "%USERPROFILE%\ObsidianDev\.obsidian\plugins\stele-pull" "%CD%"`.

Point it at a dev store: run `stele-pull serve`, then in the plugin's Setup set
**Store URL** to `http://127.0.0.1:8765`, leave **Bucket** as `stele-pull` (or
empty; `serve` accepts both), and put the numeric id from `stele-pull ls` in
**Course IDs**.

Requires Obsidian >= 1.12.3 for `appendBinary`.

## The worker/plugin contract and CI

The worker and the plugin ship as a pair, so the contract between them is
checked from both sides against the same files in `schema/`:

| File | Written by | Checked by |
|---|---|---|
| `policy-golden.json` | hand | Go `internal/policy`, plugin `policy.test.ts` |
| `manifest-golden.json` | `go test ./internal/manifest -run TestContractFixtures -update` | Go (byte-for-byte), plugin `contract.test.ts`, `preview.test.ts` |
| `store-contract.json` | same command | Go, plugin `contract.test.ts` |
| `manifest-invalid.json` | hand | Go `Decode`, plugin `parseManifest` |
| `canvas-paths.json` | `go test ./internal/run -run TestCanvasPathsFixture -update` | Go (byte-for-byte), plugin `canvas.test.ts`: direct mode must name every file as the worker does |

Never edit a generated fixture by hand; never copy any of them into `plugin/`.

CI is two workflows in `.github/workflows/`:

| Workflow | Runs when these change | Does |
|---|---|---|
| `worker.yml` | `cmd/`, `internal/`, `go.mod`, `go.sum`, `Dockerfile`, `deploy/`, the Garage and render scripts | tidy, gofmt, vet, race tests, fixture regeneration diff, build, cross-compile, smoke, manifest render, Garage S3 integration, image smoke; on `main`, publish the image and update homelab-cicd-config (see [deploy/README.md](deploy/README.md)) |
| `plugin.yml` | `plugin/` (not Markdown) | `npm ci`, lint, tests, type-check and bundle on Node 22 and 24, release metadata, bundle artifact |
| **both** | `schema/`, `internal/manifest`, `internal/policy`, `internal/plan`, `internal/portable`, `internal/run`, `cmd/stele-pull`, and the plugin's `types`, `policy`, `preview`, `store`, `sync`, `portable`, `canvas` and tests | cross-check each half against the same contract |

The contract path list is identical in both files; change them together. Each
runs on pushes to `main`, on pull requests, and manually. Because of the path
filters, a workflow that does not apply to a PR never reports, so do not make
either one a blanket required check.

## Before you start

Confirm NUS has not disabled manual access token generation in Canvas user
settings. If it has, phase 1 has no data source. (Verified working on
2026-09-13.) Some courses hide the Files tab from students; `courses -probe`
shows which, and scheduled runs record them as `forbidden` rather than failing.
