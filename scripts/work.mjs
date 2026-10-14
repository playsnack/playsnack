#!/usr/bin/env node
// Work-board helper (docs/git-as-jira.md): one command per state change, so an issue's
// label and its "playsnack Work Board" Status never drift apart.
//
//   node scripts/work.mjs add "<title>" --type task --area snack-player --priority medium [--parent 12] [--body "…"]
//   node scripts/work.mjs start  <issue>            → status: in-progress, prints the branch name to use
//   node scripts/work.mjs review <issue> [--pr 42]  → status: review
//   node scripts/work.mjs block  <issue> --reason "…"
//   node scripts/work.mjs ready  <issue>
//   node scripts/work.mjs done   <issue>            → status: done, closes the issue if still open
//   node scripts/work.mjs list   [--status backlog|ready|in-progress|review|blocked]
//
// Uses the GitHub CLI. Set GH_TOKEN (e.g. GH_TOKEN=$(gh auth token -u seukwoo)); the token
// needs the `project` scope to change board fields. `--dry-run` prints the gh calls only.
import { execFileSync } from "node:child_process";

const OWNER = "playsnack";
const REPO = "playsnack/playsnack";
const PROJECT_NUMBER = 1; // playsnack Work Board

export const STATUSES = {
  backlog: { label: "status: backlog", board: "Backlog" },
  ready: { label: "status: ready", board: "Ready" },
  "in-progress": { label: "status: in-progress", board: "In Progress" },
  review: { label: "status: review", board: "Review" },
  blocked: { label: "status: blocked", board: "Blocked" },
  done: { label: "status: done", board: "Done" },
};
export const TYPES = { epic: "Epic", story: "Story", task: "Task", subtask: "Subtask", bug: "Bug", feature: "Task" };
export const PRIORITIES = { high: "High", medium: "Medium", low: "Low" };
export const AREAS = ["snack-player", "snack-server", "bite-engine", "bite-layout", "bite-renderer", "snack-room", "content-templates", "docs-process", "infra-deploy"];

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

/** "Room results: 7 days" → "room-results-7-days" (ASCII only; Korean titles fall back to "work"). */
export function slugify(title) {
  const s = String(title).toLowerCase().replace(/\[[^\]]*\]/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "work";
}

/** Labels to remove and add when an issue moves to `status`. */
export function statusLabelChange(current, status) {
  const target = STATUSES[status]?.label;
  if (!target) throw new Error(`unknown status: ${status}`);
  const remove = current.filter((l) => /^status:\s?/.test(l) && l !== target);
  return { remove, add: current.includes(target) ? [] : [target] };
}

let DRY = false;
function gh(args, { json = false } = {}) {
  if (DRY) {
    console.log("gh " + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" "));
    return json ? {} : "";
  }
  const out = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return json ? JSON.parse(out || "{}") : out.trim();
}

let fieldsCache = null;
function boardFields() {
  if (fieldsCache) return fieldsCache;
  const f = gh(["project", "field-list", String(PROJECT_NUMBER), "--owner", OWNER, "--format", "json"], { json: true });
  const byName = {};
  for (const x of f.fields ?? []) byName[x.name] = x;
  const project = gh(["project", "view", String(PROJECT_NUMBER), "--owner", OWNER, "--format", "json"], { json: true });
  fieldsCache = { byName, projectId: project.id };
  return fieldsCache;
}

function itemIdFor(issueUrl) {
  // Adding an existing issue returns its existing item.
  const r = gh(["project", "item-add", String(PROJECT_NUMBER), "--owner", OWNER, "--url", issueUrl, "--format", "json"], { json: true });
  return r.id;
}

function setSelect(itemId, fieldName, optionName) {
  if (!optionName) return;
  const { byName, projectId } = boardFields();
  const field = byName[fieldName];
  const opt = field?.options?.find((o) => o.name === optionName);
  if (!field || !opt) {
    if (!DRY) console.warn(`board field ${fieldName}=${optionName} not found — skipped`);
    return;
  }
  gh(["project", "item-edit", "--id", itemId, "--project-id", projectId, "--field-id", field.id, "--single-select-option-id", opt.id]);
}

function issue(n) {
  return gh(["issue", "view", String(n), "--repo", REPO, "--json", "number,title,state,url,labels"], { json: true });
}

function move(n, status, note) {
  const it = issue(n);
  const current = (it.labels ?? []).map((l) => l.name);
  const { remove, add } = statusLabelChange(current, status);
  const args = ["issue", "edit", String(n), "--repo", REPO];
  for (const l of add) args.push("--add-label", l);
  for (const l of remove) args.push("--remove-label", l);
  if (add.length || remove.length) gh(args);
  setSelect(itemIdFor(it.url ?? `https://github.com/${REPO}/issues/${n}`), "Status", STATUSES[status].board);
  if (note) gh(["issue", "comment", String(n), "--repo", REPO, "--body", note]);
  return it;
}

function main(argv) {
  const a = parseArgs(argv);
  DRY = a["dry-run"] === true;
  const [cmd, arg] = a._;
  switch (cmd) {
    case "add": {
      if (!arg) throw new Error('usage: add "<title>" --type task --area <area> --priority <p>');
      const type = String(a.type ?? "task");
      const area = String(a.area ?? "docs-process");
      const priority = String(a.priority ?? "medium");
      if (!TYPES[type]) throw new Error(`type must be one of ${Object.keys(TYPES).join(", ")}`);
      if (!AREAS.includes(area)) throw new Error(`area must be one of ${AREAS.join(", ")}`);
      if (!PRIORITIES[priority]) throw new Error(`priority must be one of ${Object.keys(PRIORITIES).join(", ")}`);
      const title = /^\[/.test(arg) ? arg : `[${TYPES[type]}] ${arg}`;
      const body = String(a.body ?? "") + (a.parent ? `\n\nParent: #${a.parent}` : "");
      const url = gh(["issue", "create", "--repo", REPO, "--title", title, "--body", body || "(details in the first comment)",
        "--label", `type: ${type === "feature" ? "feature" : type}`, "--label", `area: ${area}`, "--label", `priority: ${priority}`, "--label", STATUSES.backlog.label]);
      const item = itemIdFor(url || `https://github.com/${REPO}/issues/0`);
      setSelect(item, "Status", "Backlog");
      setSelect(item, "Work Type", TYPES[type]);
      setSelect(item, "Priority", PRIORITIES[priority]);
      setSelect(item, "Area", area);
      if (a.parent && url) {
        // Sub-issue link (GitHub's native hierarchy).
        const num = Number(url.split("/").pop());
        try {
          const child = gh(["api", `repos/${REPO}/issues/${num}`, "--jq", ".id"]);
          gh(["api", "-X", "POST", `repos/${REPO}/issues/${a.parent}/sub_issues`, "-F", `sub_issue_id=${child}`]);
        } catch { console.warn("sub-issue link failed — kept 'Parent: #' in the body"); }
      }
      console.log(url || "(dry run)");
      return;
    }
    case "start": {
      const it = move(arg, "in-progress");
      console.log(`branch: claude/${arg}-${slugify(it.title ?? "")}`);
      return;
    }
    case "review": move(arg, "review", a.pr ? `In review: #${a.pr}` : undefined); return;
    case "ready": move(arg, "ready"); return;
    case "block": move(arg, "blocked", a.reason ? `Blocked: ${a.reason}` : undefined); return;
    case "done": {
      const it = move(arg, "done");
      if (it.state === "OPEN") gh(["issue", "close", String(arg), "--repo", REPO, "--reason", "completed"]);
      return;
    }
    case "list": {
      const want = a.status ? STATUSES[a.status]?.label : null;
      const args = ["issue", "list", "--repo", REPO, "--state", a.status === "done" ? "all" : "open", "--limit", "100", "--json", "number,title,labels"];
      if (want) args.push("--label", want);
      const rows = gh(args, { json: true });
      for (const r of Array.isArray(rows) ? rows : []) {
        const st = r.labels.map((l) => l.name).find((l) => /^status:/.test(l)) ?? "";
        console.log(`#${r.number}\t${st.replace(/^status:\s?/, "")}\t${r.title}`);
      }
      return;
    }
    default:
      console.log("commands: add | start | review | ready | block | done | list  (see the header of scripts/work.mjs)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
