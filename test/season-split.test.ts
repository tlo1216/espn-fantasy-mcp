import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlayer } from "../src/espn/reads.js";
import type { EspnPlayer } from "../src/espn/types.js";

const SEASON = 2026;
const player = (stats: EspnPlayer["stats"]): EspnPlayer =>
  ({ id: 1, fullName: "Test Receiver", defaultPositionId: 3, proTeamId: 14, eligibleSlots: [4, 20], stats }) as EspnPlayer;

test("seasonProjection is split 0 (rest of season), never the full season split 2", () => {
  // Listed full season first, so an unpinned or wrongly pinned read shows up.
  const p = player([
    { statSourceId: 1, scoringPeriodId: 0, seasonId: SEASON, statSplitTypeId: 2, appliedTotal: 315.34 },
    { statSourceId: 1, scoringPeriodId: 0, seasonId: SEASON, statSplitTypeId: 0, appliedTotal: 209.12 },
  ]);
  assert.equal(normalizePlayer("ffl", SEASON, p).seasonProjection, 209.12);
});

test("seasonProjection is 0 when only a full season split exists", () => {
  const p = player([{ statSourceId: 1, scoringPeriodId: 0, seasonId: SEASON, statSplitTypeId: 2, appliedTotal: 315 }]);
  assert.equal(normalizePlayer("ffl", SEASON, p).seasonProjection, 0);
});
