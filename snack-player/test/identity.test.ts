// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";

// A browser-like localStorage for identity.ts (read at call time).
const data = new Map<string, string>();
let broken = false;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => { if (broken) throw new Error("SecurityError"); return data.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (broken) throw new Error("QuotaExceededError"); data.set(k, v); },
    removeItem: (k: string) => { if (broken) throw new Error("SecurityError"); data.delete(k); },
  },
});
const { getNick, isNickAuto, setNick } = await import("../src/identity.ts");

test("an auto-assigned guest nickname is remembered as such; choosing a name clears it", () => {
  data.clear();
  assert.equal(isNickAuto(), true, "no nickname yet → the maker asks for a name");
  setNick("엉뚱한 수달", { auto: true });
  assert.equal(getNick(), "엉뚱한 수달");
  assert.equal(isNickAuto(), true);
  setNick("민지");
  assert.equal(getNick(), "민지");
  assert.equal(isNickAuto(), false);
});

test("blocked storage: setNick never throws and the name counts as not chosen", () => {
  broken = true;
  try {
    assert.doesNotThrow(() => setNick("민지"));
    assert.equal(isNickAuto(), true);
  } finally {
    broken = false;
  }
});
