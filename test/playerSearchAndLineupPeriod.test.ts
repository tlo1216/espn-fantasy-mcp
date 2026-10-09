import { test } from "node:test";
import assert from "node:assert/strict";

// Fake cookies, no .env, writes off: nothing here can reach ESPN, and the
// fetch stub below refuses anything that is not a GET to the reads host.
process.env.ESPN_S2 = "test-s2";
process.env.ESPN_SWID = "{TEST-SWID}";
process.env.WRITES_ENABLED = "false";
process.env.ESPN_MCP_ENV = "Z:/no/such/.env";

import { buildNameSearchFilter, getPlayer, getTransactions, pickNameMatch } from "../src/espn/reads.js";
import { buildLineupBody, lineupMismatches, resolveLineupPeriod, setLineup, settle } from "../src/espn/writes.js";

type Route = (url: URL, filter: Record<string, any> | undefined) => unknown;
const calls: Array<{ url: URL; filter: Record<string, any> | undefined }> = [];

function stubFetch(route: Route) {
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") !== "GET" || !url.hostname.startsWith("lm-api-reads")) {
      throw new Error(`test stub refuses ${init?.method ?? "GET"} ${url.hostname}`);
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const filter = headers["X-Fantasy-Filter"] ? JSON.parse(headers["X-Fantasy-Filter"]) : undefined;
    calls.push({ url, filter });
    return new Response(JSON.stringify(route(url, filter)), { status: 200 });
  }) as typeof fetch;
}

const P = { sport: "ffl" as const, season: 2026, leagueId: "12345" };
const espnPlayer = (id: number, fullName: string, owned: number) => ({
  id,
  fullName,
  defaultPositionId: 1,
  proTeamId: 3,
  eligibleSlots: [0, 7, 20],
  ownership: { percentOwned: owned },
  stats: [],
});
const views = (url: URL) => url.searchParams.getAll("view");

// ---------------------------------------------------------------------------
// get_player name_search
// ---------------------------------------------------------------------------

test("name search asks ESPN by name across the whole pool, not a top-owned slice", () => {
  const f = buildNameSearchFilter("  Quillfeather ");
  assert.deepEqual(f.players.filterName, { value: "Quillfeather" });
  assert.equal((f.players as Record<string, unknown>).filterStatus, undefined, "no status filter: rostered players count too");
});

test("pickNameMatch prefers an exact full name, then a contained one, and refuses an unrelated top-of-pool answer", () => {
  const pool = [{ player: { fullName: "Alex Marlowe" } }, { player: { fullName: "Sam Marlowe" } }];
  assert.equal(pickNameMatch(pool, "sam marlowe")?.player.fullName, "Sam Marlowe");
  assert.equal(pickNameMatch(pool, "Marlowe")?.player.fullName, "Alex Marlowe");
  // ESPN ignoring filterName would hand back the most-owned players; none of
  // them matches, so nothing is returned rather than a wrong player.
  assert.equal(pickNameMatch([{ player: { fullName: "Popular Star" } }], "Quillfeather"), undefined);
  assert.equal(pickNameMatch(pool, "   "), undefined);
});

test("get_player name_search finds a low-owned free agent outside the top 200", async () => {
  // The top-200 free agent slice holds 200 other players, which is exactly
  // what made the old search report a low-owned player as nonexistent.
  const top200 = Array.from({ length: 200 }, (_, i) => ({ player: espnPlayer(1000 + i, `Popular Guy ${i}`, 90 - i / 10), status: "FREEAGENT" }));
  stubFetch((url, filter) => {
    if (views(url).includes("mRoster")) return { id: 12345, seasonId: 2026, teams: [{ id: 3, roster: { entries: [] } }] };
    if (filter?.players?.filterName) {
      return filter.players.filterName.value.toLowerCase() === "quillfeather"
        ? { players: [{ player: espnPlayer(900001, "Jordan Quillfeather", 1.3), status: "FREEAGENT", onTeamId: 0 }] }
        : { players: [] };
    }
    if (views(url).includes("kona_player_info")) return { players: top200 };
    return { id: 12345, seasonId: 2026, status: { latestScoringPeriod: 5 }, settings: {}, teams: [] };
  });
  const hit = await getPlayer(P, { nameSearch: "Quillfeather" });
  assert.equal(hit?.id, 900001);
  assert.equal(hit?.name, "Jordan Quillfeather");
  assert.equal(hit?.teamId, undefined, "onTeamId 0 means unrostered, not team 0");
  assert.ok(calls.some((c) => c.filter?.players?.filterName), "the search went to ESPN by name");
});

test("get_player name_search still falls back to the substring scan when the name query has no hit", async () => {
  stubFetch((url, filter) => {
    if (views(url).includes("mRoster")) return { id: 1, seasonId: 2026, teams: [] };
    if (filter?.players?.filterName) return { players: [] };
    if (views(url).includes("kona_player_info"))
      return { players: [{ player: espnPlayer(900001, "Jordan Quillfeather", 1.3), status: "WAIVERS" }] };
    return { id: 1, seasonId: 2026, status: { latestScoringPeriod: 5 }, settings: {}, teams: [] };
  });
  const hit = await getPlayer(P, { nameSearch: "feather" });
  assert.equal(hit?.id, 900001);
});

// ---------------------------------------------------------------------------
// get_transactions reads every scoring period
// ---------------------------------------------------------------------------

test("get_transactions reads periods 1..current and merges by id", async () => {
  stubFetch((url) => {
    if (views(url).includes("mTransactions2")) {
      const sp = Number(url.searchParams.get("scoringPeriodId"));
      const tx = (id: string, date: number) => ({ id, teamId: 1, type: "FREEAGENT", status: "EXECUTED", scoringPeriodId: sp, proposedDate: date, items: [] });
      // period 2 repeats a period-1 transaction: it must appear once
      if (sp === 1) return { transactions: [tx("a", 1000)] };
      if (sp === 2) return { transactions: [tx("a", 1000), tx("b", 2000)] };
      if (sp === 3) return { transactions: [tx("c", 3000), { ...tx("d", 4000), status: "CANCELED" }] };
      return { transactions: [] };
    }
    return { id: 1, seasonId: 2026, status: { latestScoringPeriod: 3 }, settings: {}, teams: [] };
  });
  const page = await getTransactions(P);
  assert.deepEqual(page.transactions.map((t: any) => t.id), ["c", "b", "a"]);
  assert.equal(page.total, 3);
});

test("get_transactions with scoring_period_id reads only that period", async () => {
  stubFetch((url) => {
    if (views(url).includes("mTransactions2")) return { transactions: [] };
    return { id: 1, seasonId: 2026, status: { latestScoringPeriod: 3 }, settings: {}, teams: [] };
  });
  await getTransactions(P, { scoringPeriodId: 2 });
  const txReads = calls.filter((c) => views(c.url).includes("mTransactions2"));
  assert.deepEqual(txReads.map((c) => c.url.searchParams.get("scoringPeriodId")), ["2"]);
});

// ---------------------------------------------------------------------------
// write read-back settle
// ---------------------------------------------------------------------------

test("settle re-reads a lagging read-back until it converges", async () => {
  const reads = [[{ id: 7, lineupSlotId: 20 }], [{ id: 7, lineupSlotId: 20 }], [{ id: 7, lineupSlotId: 2 }]];
  let n = 0;
  const out = await settle(
    async () => reads[Math.min(n++, reads.length - 1)] as any,
    (r) => lineupMismatches(r, [{ playerId: 7, toSlot: 2 }]),
    [0, 0, 0, 0],
  );
  assert.deepEqual(out.mismatches, []);
  assert.equal(n, 3, "stops reading once the write shows up");
});

test("settle still reports a write that never lands", async () => {
  let n = 0;
  const out = await settle(
    async () => (n++, [{ id: 7, lineupSlotId: 20 }] as any),
    (r) => lineupMismatches(r, [{ playerId: 7, toSlot: 2 }]),
    [0, 0, 0],
  );
  assert.equal(n, 3);
  assert.match(out.mismatches[0], /intended slot 2, roster read-back shows slot 20/);
});

// ---------------------------------------------------------------------------
// set_lineup scoring_period_id
// ---------------------------------------------------------------------------

test("resolveLineupPeriod defaults to ESPN's current period", () => {
  assert.equal(resolveLineupPeriod(undefined, 8, 188, "L"), 8);
});

test("resolveLineupPeriod accepts the current and a future period", () => {
  assert.equal(resolveLineupPeriod(8, 8, 188, "L"), 8);
  assert.equal(resolveLineupPeriod(9, 8, 188, "L"), 9);
  assert.equal(resolveLineupPeriod(9, 8, undefined, "L"), 9, "no final period known: no upper bound");
});

test("resolveLineupPeriod refuses a past period, one past the season, a fraction, and a missing current period", () => {
  assert.throws(() => resolveLineupPeriod(7, 8, 188, "L"), /before ESPN's current period 8/);
  assert.throws(() => resolveLineupPeriod(189, 8, 188, "L"), /after the league's final period 188/);
  assert.throws(() => resolveLineupPeriod(8.5, 8, 188, "L"), /not a whole period/);
  assert.throws(() => resolveLineupPeriod(9, undefined, 188, "L"), /no status.latestScoringPeriod/);
});

test("buildLineupBody carries the requested period, not the current one", () => {
  const body = buildLineupBody({ teamId: 3, scoringPeriodId: 9, moves: [{ playerId: 1, toSlot: 2 }], currentSlots: new Map([[1, 20]]) });
  assert.equal(body.scoringPeriodId, 9);
});

function lineupRoute(lockedInCurrent: boolean) {
  return (url: URL) => {
    if (views(url).includes("mRoster")) {
      const asOf = url.searchParams.get("scoringPeriodId");
      // Locked today (current period, game started), free for tomorrow.
      const locked = asOf === null ? lockedInCurrent : false;
      return {
        id: 1,
        seasonId: 2026,
        teams: [
          {
            id: 3,
            roster: {
              entries: [
                { lineupSlotId: 20, playerPoolEntry: { lineupLocked: locked, player: { ...espnPlayer(11, "Bench Back", 10), eligibleSlots: [2, 23, 20] } } },
              ],
            },
          },
        ],
      };
    }
    return {
      id: 1,
      seasonId: 2026,
      status: { latestScoringPeriod: 8, finalScoringPeriod: 188 },
      settings: { rosterSettings: { lineupSlotCounts: { "2": 2, "20": 7, "23": 1 } } },
      teams: [],
    };
  };
}

test("set_lineup with scoring_period_id reads that period's roster, so a player locked today can be set for tomorrow", async () => {
  stubFetch(lineupRoute(true));
  const out = await setLineup(P, { teamId: 3, moves: [{ playerId: 11, toSlot: 2 }], scoringPeriodId: 9 }, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.validation.valid, true, JSON.stringify(out.validation.rejected));
  assert.equal(out.wouldSend?.scoringPeriodId, 9);
  const rosterRead = calls.find((c) => views(c.url).includes("mRoster"));
  assert.equal(rosterRead?.url.searchParams.get("scoringPeriodId"), "9");
});

test("set_lineup without scoring_period_id is unchanged: current period, current locks", async () => {
  stubFetch(lineupRoute(true));
  const out = await setLineup(P, { teamId: 3, moves: [{ playerId: 11, toSlot: 2 }] }, true);
  assert.equal(out.validation.valid, false);
  assert.match(out.validation.rejected[0].reason, /locked/);
  const rosterRead = calls.find((c) => views(c.url).includes("mRoster"));
  assert.equal(rosterRead?.url.searchParams.get("scoringPeriodId"), null);
});

test("set_lineup refuses a past scoring_period_id before reading the roster", async () => {
  stubFetch(lineupRoute(false));
  await assert.rejects(setLineup(P, { teamId: 3, moves: [{ playerId: 11, toSlot: 2 }], scoringPeriodId: 3 }, true), /before ESPN's current period 8/);
  assert.equal(calls.some((c) => views(c.url).includes("mRoster")), false);
});
