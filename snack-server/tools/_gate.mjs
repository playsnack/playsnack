// Common gate report helper. Every quality gate emits the same envelope to
// stdout (JSON) and exits 0 (pass) / 1 (fail). See data-model.md.
//
//   import { runGate } from "./_gate.mjs";
//   runGate("content-quality", results, (r) => r.ok);

export function emit(report) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

// results: array of per-item objects. itemOk(r) => boolean ("did this item pass").
export function runGate(gate, results, itemOk, summaryFn) {
  const passed = results.filter(itemOk).length;
  const failed = results.length - passed;
  const ok = failed === 0;
  const report = {
    gate,
    ok,
    total: results.length,
    passed,
    failed,
    results,
    summary: summaryFn ? summaryFn({ ok, total: results.length, passed, failed, results })
                        : `${gate}: ${passed}/${results.length} pass${ok ? "" : ` — ${failed} FAIL`}`,
  };
  emit(report);
  process.exitCode = ok ? 0 : 1;
  return report;
}
