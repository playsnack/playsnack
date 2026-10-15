# Git as Jira

This repo uses GitHub as a lightweight Jira replacement:

- Issues are tickets.
- Labels describe type, status, priority, severity, and area.
- Branches are workspaces for one ticket.
- Pull requests are the completion report and review surface.
- Merge commits move finished work into `main`.

## Hierarchy

Use GitHub sub-issues like Jira hierarchy:

1. Epic
2. Story / Task / Bug
3. Subtask

Use `Story`, `Task`, and `Bug` at the same level under an Epic:

- `Story`: user-facing capability or workflow improvement.
- `Task`: internal work, docs, cleanup, investigation, release chore.
- `Bug`: broken or regressed behavior.
- `Subtask`: small checklist item under a Story, Task, or Bug.

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
- `stage: beta`
- `area: snack-player`
- `area: snack-server`
- `area: bite-engine`
- `area: bite-layout`
- `area: bite-renderer`
- `area: snack-room`
- `area: content-templates`
- `area: docs-process`
- `area: infra-deploy`

## Branches

Do not work directly on `main`. `main` is the integration and live-release line.

Create one branch per issue, or per tightly scoped feature/task when one issue
needs to be split into reviewable parts:

```bash
git switch main
git pull
git switch -c <your-name>/<issue-number>-<short-topic>
```

Examples:

```bash
git switch -c seukwoo/123-room-results
git switch -c moonjong/124-template-lint
```

Branch rules:

- Start from the latest `main`.
- Keep one branch focused on one issue or one small feature/task slice.
- Do not mix unrelated cleanup with product work.
- If work grows, create another issue and branch instead of expanding the branch forever.
- Push the branch and open a PR into `main`; do not push commits directly to `main`.

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

- The PR is merged to `main`.
- The issue is closed by the PR or manually closed with a reason.
- The relevant quality gate or manual verification is recorded in the PR.
- Any known leftover work has its own issue.
