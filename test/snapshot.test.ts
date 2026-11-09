import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSnapshot } from "../src/snapshot.js";
import type { EspnLeagueResponse, EspnPlayer } from "../src/espn/types.js";

const SEASON = 2026;

function makePlayer(id: number, fullName: string, injuryStatus: string, seasonProj: number): EspnPlayer {
  return {
    id,
    fullName,
    defaultPositionId: 2,
    proTeamId: 12,
    eligibleSlots: [2, 23, 20],
    injuryStatus,
    // Split 0 is the rest of season; a full season split 2 sits beside it and must not be read.
    stats: [{ statSourceId: 1, scoringPeriodId: 0, seasonId: SEASON, statSplitTypeId: 2, appliedTotal: seasonProj * 1.6 },
      { statSourceId: 1, scoringPeriodId: 0, seasonId: SEASON, statSplitTypeId: 0, appliedTotal: seasonProj }],
  };
}

const R: EspnLeagueResponse = {
  id: 1,
  seasonId: SEASON,
  teams: [
    {
      id: 5,
      roster: {
        entries: [
          {
            playerId: 100,
            lineupSlotId: 2,
            playerPoolEntry: { player: makePlayer(100, "Test Back", "ACTIVE", 210) },
          },
        ],
      },
    },
  ],
};

const M: EspnLeagueResponse = {
  id: 1,
  seasonId: SEASON,
  teams: [{ id: 5, waiverRank: 3 }],
};

const S: EspnLeagueResponse = {
  id: 1,
  seasonId: SEASON,
  settings: {
    rosterSettings: { lineupSlotCounts: {} },
    acquisitionSettings: {
      acquisitionType: "WAIVERS",
      waiverOrderReset: true,
      waiverHours: 2,
      waiverProcessDays: ["WEDNESDAY"],
      waiverProcessHour: 3,
    },
    scheduleSettings: { playoffTeamCount: 6 },
    tradeSettings: { deadlineDate: Date.UTC(2026, 10, 20, 0, 0), vetoVotesRequired: 4 },
    draftSettings: { keeperCount: 2 },
  },
};

const P = {
  pendingTransactions: [
    {
      id: "abc",
      teamId: 5,
      type: "WAIVER",
      status: "PENDING",
      items: [{ playerId: 200, type: "ADD" }],
    },
  ],
};

const FA = {
  players: [{ player: { ...makePlayer(300, "Free Agent Guy", "ACTIVE", 50), ownership: { percentOwned: 42.4 } } }],
};

test("roster row matches teamId|playerId|name|injury|seasonProj", () => {
  const text = formatSnapshot(SEASON, R, M, S, P, FA);
  assert.match(text, /^5\|100\|Test Back\|ACTIVE\|210$/m);
});

test("free agent row appends |pctOwned", () => {
  const text = formatSnapshot(SEASON, R, M, S, P, FA);
  assert.match(text, /^FA\|300\|Free Agent Guy\|ACTIVE\|50\|42$/m);
});

test("includes SETTINGS and WAIVERORDER lines", () => {
  const text = formatSnapshot(SEASON, R, M, S, P, FA);
  assert.match(text, /^SETTINGS\|acquisitionType=WAIVERS\|waiverOrderReset=true\|waiverHours=2\|processDays=WED\|processHour=3\|tradeDeadline=2026-11-20 00:00\|vetoVotes=4\|playoffTeams=6\|keepers=2$/m);
  assert.match(text, /^WAIVERORDER\|5:3$/m);
});

test("wraps content in SNAPSTART/SNAPEND and includes a PEND line", () => {
  const text = formatSnapshot(SEASON, R, M, S, P, FA);
  assert.ok(text.startsWith("PEND:"));
  assert.ok(text.includes("SNAPSTART\n"));
  assert.ok(text.includes("\nSNAPEND\n"));
  const pendLine = text.split("\n")[0];
  const pend = JSON.parse(pendLine.slice("PEND:".length));
  assert.deepEqual(pend, ["5 WAIVER PENDING ADD:200"]);
});
