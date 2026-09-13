# Placewatch migration runbook

Date: 2026-08-15. Status: **prepared, not executed**. Tracked as **LUI-169**.
Every push and every Toolforge action below is outward-facing and waits for
explicit go.

## What this migration is

Three moves, in order:

1. Fast-forward `main` to `integration` and push both.
2. Move the repository to its new home under the new name `placewatch`.
3. Create the Toolforge tool `placewatch` and migrate the deployment to it.

Toolforge tools cannot be renamed (Help:Toolforge/Tool accounts, read
2026-08-15: "Tools can't be renamed. You can create a new tool with a new
name and copy the code over from the old tool."). Step 3 is therefore a
new-tool migration, not a rename.

Name availability, verified 2026-08-15:

- Toolforge: `placewatch` is unregistered (toolsadmin returns 404).
- GitHub: no confusable repository (one 0-star hit).
- Toolhub: no tool with a similar name or title.

## Decisions

| Decision | State |
|---|---|
| New name: `placewatch`, same for repo and tool | **Decided** |
| Social accounts (`@SFedits@sfba.social`, `top500.thebay.wiki`, Discord) keep their names | **Decided** |
| Repo host: move to `gitlab.wikimedia.org/toolforge-repos/placewatch`; keep `tieguy/sfedits` on GitHub, archived, for possible upstream PRs | **Recommended, awaiting confirmation** |
| `SFEDITS_*` envvar names stay unchanged | Default: keep. Renaming them touches `lib/config.js`, stored Toolforge envvars, and docs, for no functional gain. Optional later cleanup. |
| Display identity: `"nick": "sfedits"` in config, web page title, User-Agent component strings such as `sfedits-autoupdate` | **Open** — decide before the Phase 2 commit |
| Old tool retirement: keep the `san-francisco-edit-stream` tool account (prevents name squatting), stop its jobs, mark its Toolhub record deprecated with `replaced_by` | Default: keep account, stop jobs |

## Preconditions (all must hold before any phase runs)

- [ ] Explicit go from Louie for the phase about to run.
- [ ] In-flight work is landed or parked. `substantive-edit-filter` edits
      `config.base.json`; land or rebase it around the Phase 2/3 commits to
      avoid conflicts.
- [ ] LUI-120 stability check (due ≈ 2026-08-16) is resolved. Phase 3
      replaces the pod environment and would contaminate the OOM A/B.
- [ ] `npm test` is green at the current baseline (782 on `integration`,
      verified 2026-08-14).
- [ ] `git fetch fork` ran, and local `integration` is not behind
      `fork/integration`.

## Pre-work — safe while the code is unsettled

None of these steps touches the running bot or the deploy path. The deploy
source stays the GitHub fork until Phase 2b step 3. Each outward-facing
item still needs a go, but none needs the code to be settled.

1. **Create the Toolforge tool `placewatch`** (Phase 3a step 1). The tool
   account is inert with no jobs and no webservice. This reserves the name
   and yields the new ToolsDB credential.
2. **Provision ToolsDB early** (Phase 3a steps 2–3): create the database
   and run the migrations. Nothing consumes it yet.
3. **Create the GitLab repo from the tool page in toolsadmin.** This
   reserves `toolforge-repos/placewatch`.
4. **Push all branches to the GitLab repo as a passive mirror.** Autoupdate
   watches the GitHub fork, so pushes to GitLab deploy nothing. Refresh the
   mirror with `git push wmf --all` whenever convenient.
5. **GitLab account setup** (Louie, one time): sign in to
   gitlab.wikimedia.org with the Wikimedia developer account, add an SSH
   key, install `glab` if wanted.
6. **Add CI on a branch pushed only to GitLab**: a `.gitlab-ci.yml` that
   runs `npm test`. Instance-wide Cloud Runners serve every project
   (2 vCPU, 1 GiB — read 2026-08-15). Use the `memory-optimized` tag if
   the MariaDB service container needs more memory. Keep the branch off
   the GitHub fork: any push there is a deploy.
7. **Write and test the Phase 2a commit on the same GitLab-only branch**:
   the `resolve_remote_sha()` GitLab port, the `record-deploy.js` URL
   parse, and the name changes. Once the mirror exists, test the GitLab
   API call against it for real.
8. **Draft the Toolhub toolinfo text** for placewatch (feeds the
   follow-up issue that is blocked on LUI-169).
9. Optional: create the replacement Discord webhook and Mastodon token
   now and store them as envvars on the new tool. This front-loads
   cutover work. It does not shorten the leak window — the old
   credentials stay valid until Phase 3d revokes them.

What this pre-work does NOT include: any push to the GitHub fork's
`integration` (a deploy), the GitHub archive step, the Phase 3b config
commit, and any change to the old tool's jobs or envvars.

## Phase 1 — fast-forward `main`, push both branches

`integration..main` is empty (verified 2026-08-15), so this is a
fast-forward. Do not check out `main`: the working tree is shared with
other sessions.

1. `git fetch . integration:main` — fast-forwards `main` without a checkout.
   It fails if `main` is not an ancestor. Investigate instead of forcing.
2. Push (sandbox disabled — keyring auth): `git push fork main integration`.
3. **Pushing `integration` is a deploy.** Within 15 minutes autoupdate
   builds and restarts the live bot. Verify: newest entry of
   <https://san-francisco-edit-stream.toolforge.org/changelog.json> shows
   the pushed SHA.

Note: `fork/main` currently sits at `96f2d11`, the frozen upstream mirror.
This push moves it to the fork mainline. The mirror stays available as
`origin/main` and in the three pinned `upstream-*` branches.

## Phase 2 — move the repo to WMF GitLab as `placewatch`

Target: `https://gitlab.wikimedia.org/toolforge-repos/placewatch`.
The `toolforge-repos` namespace is the ecosystem convention for tool
repositories. Creation goes through toolsadmin: the tool page has a
"create repository" function that creates the GitLab project (Striker
FAQ, read 2026-08-15). So the Phase 3a tool creation must happen before
this repo exists — create the tool account early (see Pre-work).

If the GitLab recommendation is declined, the fallback is an in-place
GitHub rename to `tieguy/placewatch`. GitHub redirects old URLs, so the
sequence is: rename in Settings, then immediately push the URL-update
commit below (minus the GitLab-specific ports).

### 2a. Code changes (one commit on `integration`, prepared before the move)

- `scripts/toolforge-autoupdate.sh`
  - line 27: `REPO_URL` default → the GitLab clone URL.
  - line 40: `IMAGE` default → `tool-placewatch/tool-placewatch:latest`
    (only if Phase 3 runs together with Phase 2 — otherwise this waits
    for the Phase 3 commit).
  - line 65: leave `WATCHLIST_PROBE_FALLBACK` at the old URL until Phase 3.
  - line 73–74: probe UA repo default.
  - `resolve_remote_sha()`: the no-git fallback parses `github.com` URLs
    and calls the GitHub commits API. Add a GitLab branch:
    `GET https://gitlab.wikimedia.org/api/v4/projects/toolforge-repos%2Fplacewatch/repository/branches/<branch>`,
    read `.commit.id`. Keep the GitHub branch for the fallback host.
- `scripts/record-deploy.js`: lines 30/99/116 — remote-URL parsing,
  User-Agent, default repo URL. Add GitLab URL parsing next to the GitHub
  parsing.
- `package.json`: `"name": "placewatch"`.
- `README.md`, `docs/deploy-toolforge.md`: new repo URL and name.
- Optional, per the open display-identity decision: UA component strings
  (`sfedits-autoupdate`, `sfedits-record-deploy`).
- Do NOT touch `config.base.json`, `toolforge-jobs.yaml`, or
  `public/server.js` in this phase. They carry the tool name, and the old
  tool still runs.

### 2b. Cutover sequence

1. Create the GitLab project. Push all branches and tags to it.
2. Add the GitLab remote locally: `git remote add wmf <url>`. Worktrees
   share repo-level remotes, so one command covers all of them.
3. Push the 2a commit to **both** hosts. The old tool's autoupdate still
   watches the GitHub URL, so this push deploys the 2a commit from GitHub.
4. **Two ticks rule**: the tick that ships 2a still runs the old image's
   script against GitHub. The next tick runs the new script against
   GitLab. Wait for both. Verify each via `/changelog.json`.
5. Check for a `SFEDITS_DEPLOY_REPO` envvar on the old tool:
   `toolforge envvars show --raw`. If set, update it to the GitLab URL.
6. After two clean GitLab-driven ticks: archive `tieguy/sfedits` on GitHub
   with a final README line pointing at the GitLab project. Keep it as
   the fork base for possible upstream PRs (upstream lives on GitHub).

### 2c. Rollback

Set `SFEDITS_DEPLOY_REPO` on the tool back to the GitHub URL and restart
the autoupdate job. The envvar overrides the script default, so no commit
is needed to roll back the deploy source.

## Phase 3 — new Toolforge tool `placewatch`

### 3a. Create and provision

1. Create tool `placewatch` at toolsadmin (maintainer:
   `luisvilla-personal`).
2. ToolsDB: note the new credential user (`s<new>`, from the new tool's
   `replica.my.cnf`). Create the database:
   `CREATE DATABASE s<new>__placewatch CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;`
   The collation is load-bearing.
3. Data: check <https://san-francisco-edit-stream.toolforge.org/api/topics.json>
   first. With zero production topics, a fresh `migrate` run is the whole
   data migration. If topics or subscriptions exist by execution time,
   `mysqldump` from `s57894__sfedits` and restore instead.
4. Envvars on the new tool (`toolforge envvars create`):
   - `SFEDITS_DISCORD_WEBHOOK_URL` — **create a NEW webhook** in Discord.
     This completes the rotation of the value leaked to scrollback
     2026-08-14.
   - `SFEDITS_MASTODON_ACCESS_TOKEN` — **regenerate the token** in the
     Mastodon account settings. Same rotation.
   - `SFEDITS_BLUESKY_PASSWORD` — copy over (not leaked).
   - `SFEDITS_INVITE_CODES` — copy over if set on the old tool.
   Reminder: `toolforge envvars delete` prints the value it deletes. Do
   not delete old-tool envvars in a shared or recorded session.

### 3b. The config commit (order matters)

The commit below changes `integration`, and the OLD tool's autoupdate
deploys `integration`. If the old autoupdate ships this commit, the old
bot starts pointing at the new webservice before the new webservice
exists. Therefore:

1. **Stop the old tool's `autoupdate` job first.** Then stop nothing else
   yet — the old bot keeps posting from its current image.
2. Commit and push (to GitLab) the tool-name changes:
   - `config.base.json`: `titles_url` →
     `https://placewatch.toolforge.org/watchlist-500.json`. Also
     `database` → `s<new>__placewatch`.
   - `toolforge-jobs.yaml`: all four image references →
     `tool-placewatch/tool-placewatch:latest`, and the `become` comment.
   - `scripts/toolforge-autoupdate.sh`: line 40 `IMAGE` default, line 65
     `WATCHLIST_PROBE_FALLBACK`.
   - `public/server.js` lines 627–630: `name` and `url`.
   - `docs/deploy-toolforge.md`: tool name, image, database, URLs.
3. Build on the new tool:
   `toolforge build start --ref integration <gitlab-url>` (as
   `placewatch`).

### 3c. Cutover (double-posting is the hazard)

Two bots running at once post every edit twice. Order:

1. Old tool: confirm `autoupdate` is stopped (3b step 1). Stop the `bot`
   job. Stop `rebuild-topics`.
2. New tool: run the one-off `migrate` job.
3. New tool: start the webservice with `--mount all`. A fresh start needs
   the flag. Verify `https://placewatch.toolforge.org/watchlist-500.json`
   returns the list.
4. New tool: `toolforge jobs load` the YAML (copy it to the bastion first —
   `jobs load` reads the bastion filesystem). This starts `bot`,
   `rebuild-topics`, and `autoupdate`.
5. Check the bot log for `✓ Watchlist sync: N articles`. A missing line
   means an empty watchlist for 24 hours (LUI-109).
6. Old tool: stop the webservice after the new bot is confirmed posting.

### 3d. Verify

- [ ] `https://placewatch.toolforge.org/api/topics.json` reports the
      expected watchlist source and article count.
- [ ] One live edit produces exactly ONE post on each of Discord,
      Mastodon, Bluesky. Verify against live Wikipedia activity, not tests.
- [ ] `/changelog.json` on the new tool records the deploy SHA.
- [ ] Next autoupdate tick on the new tool is a clean no-op or a clean
      deploy.
- [ ] Revoke the OLD Discord webhook and the OLD Mastodon token. This
      closes the 2026-08-14 leak.

### 3e. Aftermath

- Toolhub / toolsadmin: create accurate toolinfo for `placewatch`
  (the old record's description is stale). Mark the
  `san-francisco-edit-stream` record deprecated, `replaced_by` →
  placewatch. Keep the old tool account to hold the name.
- Update profile links on the Mastodon and Bluesky accounts if they point
  at the old webservice URL.
- The Bluesky handle `top500.thebay.wiki` is verified via thebay.wiki
  DNS/hosting, outside this repo. Confirm before cutover that nothing
  there references the Toolforge URL. No in-repo evidence says it does.
- Local housekeeping: rename the checkout directory (optional), update
  both CLAUDE.md files, the Claude memory index, `../sfedits-notes/`
  pointers, and the Linear project name.
- Rollback copy of the pre-cutover config remains at
  `~/sfedits-config-backup-2026-08-14.json`.

### 3f. Rollback

The old tool stays intact until 3d passes. To roll back: stop the new
tool's jobs and webservice, restart the old tool's webservice, `bot`,
`rebuild-topics`, and `autoupdate` (in that order: web before bot), and
set `SFEDITS_DEPLOY_REPO` on the old tool if Phase 2 moved the repo.

## Residual-reference sweep (run after Phase 3)

```
grep -rn "sfedits\|san-francisco-edit-stream\|tieguy" \
  --exclude-dir=node_modules --exclude-dir=.worktrees --exclude-dir=data \
  --exclude-dir=.git .
```

Expected survivors: this document, `docs/postmortem-*` and other dated
records, `SFEDITS_*` envvar names, and `public/watchlist-500.json` until
its next regeneration. Everything else is a miss.
