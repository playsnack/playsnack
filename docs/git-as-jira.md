# Git as Jira

This repo uses GitHub as a lightweight Jira replacement:

- Issues are tickets.
- Labels describe type, status, priority, severity, and area.
- Branches are workspaces for one ticket.
- Pull requests are the completion report and review surface.
- Merge commits move finished work into `develop`; release PRs move tested work into `main`.

## Hierarchy

Use GitHub sub-issues like Jira hierarchy:

1. Epic
2. Story
3. Task
4. Subtask

## Board Columns

Use GitHub Projects with these columns:

1. Backlog
2. Ready
3. In Progress
4. Review
5. Done
6. Blocked

Create the org-level project after GitHub CLI auth is ready:

```bash
node scripts/setup-github-project.mjs
```

The script creates or reuses `playsnack Work Board`, links it to
`playsnack/playsnack`, and adds project fields for Work Type, Priority,
Severity, Area, and Target Date.

## Labels

Recommended labels:

- `type: epic`
- `type: story`
- `type: feature`
- `type: bug`
- `type: task`
- `type: subtask`
- `status: backlog`
- `status: ready`
- `status: in-progress`
- `status: review`
- `status: blocked`
- `status: done`
- `priority: high`
- `priority: medium`
- `priority: low`
- `severity: critical`
- `severity: major`
- `severity: minor`
- `area: snack-player`
- `area: snack-server`
- `area: bite-engine`
- `area: bite-layout`
- `area: bite-renderer`
- `area: snack-room`
- `area: content-templates`
- `area: docs-process`
- `area: infra-deploy`

## Branch strategy

Two long-lived branches; nothing is developed on either of them directly.

| Branch | What it is | Deploys to (automatically, `.github/workflows/deploy-cloudflare.yml`) |
|---|---|---|
| `develop` (default) | Integration: finished work waiting for a release | Test: `https://develop.playsnack.pages.dev` + test room server `snack-room-dev.playsnack.workers.dev` |
| `main` (protected) | What real users get | Live: `https://playsnack.pages.dev` + `snack-room.playsnack.workers.dev` |

Flow:

1. **Work branch per issue**, off the latest `develop`: `<who>/<issue>-<topic>` (people use their
   name, e.g. `scott/170-balance-vote-timer`; Claude sessions use `claude/…`).
2. **PR into `develop`** (the default base). Gates in the PR's Checked section. Merge commit.
   `Closes #N` closes the issue when it lands on `develop` (default branch).
3. **Check on a phone** at `https://develop.playsnack.pages.dev` (test rooms, test stats — real
   `/stats` is untouched).
4. **Release PR `develop` → `main`**, batching what was checked; title `release: …` listing the
   issues. Merging it deploys live. Only the owner (or with the owner's OK) merges releases.
5. **Hotfix** (live is broken): branch off `main`, PR into `main`, then merge `main` back into
   `develop` right away.

`main` accepts changes only through pull requests (no direct pushes, no force pushes).

## Branches

Create one branch per issue:

```bash
git switch develop
git pull
git switch -c <your-name>/<issue-number>-<short-topic>
```

Examples:

```bash
git switch -c seukwoo/123-room-results
git switch -c moonjong/124-template-lint
```

## Commits

Use short conventional commit prefixes and include the issue number when useful:

```bash
git commit -m "feat: add room result share action (#123)"
git commit -m "fix: keep Bite layout stable on hidden nodes (#124)"
git commit -m "docs: document release gate checklist (#125)"
```

## Pull Requests

Every PR should include:

- What changed.
- Which issue it closes.
- Which gate or manual flow was checked.
- Any follow-up that should become a new issue.

Use `Closes #123` in the PR body so GitHub closes the issue when the PR merges.

## Done Definition

An issue is done only when:

- The PR is merged to `develop` (released to `main` in the next release PR).
- The issue is closed by the PR or manually closed with a reason.
- The relevant quality gate or manual verification is recorded in the PR.
- Any known leftover work has its own issue.
