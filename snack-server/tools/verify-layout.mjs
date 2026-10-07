// Layout + liveness gate (V/F). For every template: validate the Bite doc, play
// it headless (start, a few frames, every visible tappable node once) and lint
// the layout of each phase reached — off-screen nodes, text that does not fit,
// children spilling out of their parent, numeric props that are not numbers,
// runtime expression errors. Same check the AI builder runs on generated apps.
//   node snack-server/tools/verify-layout.mjs [id ...]
import { validate } from "@snack/bite";
import { lintDoc } from "../src/builder.mjs";
import { listIds, loadDoc } from "./_doc.mjs";
import { runGate } from "./_gate.mjs";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : listIds();
const results = [];
for (const id of ids) {
  const doc = loadDoc(id);
  const v = validate(doc);
  if (!v.ok) {
    results.push({ id, ok: false, problems: v.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`) });
    continue;
  }
  const lint = await lintDoc(doc);
  results.push({ id, ok: !lint, problems: lint ? lint.split("\n") : [] });
}
runGate("verify-layout", results, (r) => r.ok);
