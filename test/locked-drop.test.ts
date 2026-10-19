// A locked player cannot be dropped; the refusal names the reason instead of
// letting ESPN answer with an unrelated 409.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lockedDropReason } from "../src/espn/writes.js";

test("locked football player: refused with the end-of-week reason", () => {
  const why = lockedDropReason({ name: "Player A", locked: true }, "ffl");
  assert.ok(why && /locked/.test(why) && /Tuesday/.test(why));
});

test("locked basketball player: next scoring period", () => {
  assert.match(lockedDropReason({ name: "Player B", locked: true }, "fba") ?? "", /next scoring period/);
});

test("unlocked or unknown player: not refused", () => {
  assert.equal(lockedDropReason({ name: "Player C", locked: false }, "ffl"), undefined);
  assert.equal(lockedDropReason(undefined, "ffl"), undefined);
});
