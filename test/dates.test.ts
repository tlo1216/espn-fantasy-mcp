import { test } from "node:test";
import assert from "node:assert/strict";
import { safeIso } from "../src/espn/dates.js";

test("safeIso converts a valid epoch-ms date", () => {
  assert.equal(safeIso(1_770_000_000_000), new Date(1_770_000_000_000).toISOString());
  assert.equal(safeIso("1770000000000"), new Date(1_770_000_000_000).toISOString());
});

test("safeIso returns undefined instead of throwing for missing or invalid dates", () => {
  for (const v of [undefined, null, "", 0, -1, NaN, Infinity, "not a date", 9e18]) {
    assert.equal(safeIso(v), undefined, `value ${String(v)}`);
  }
});

// Regression: get_league threw "Invalid time value" for a basketball league
// with no trade deadline set. Fake cookies; the stub refuses non-read hosts.
process.env.ESPN_S2 = "test-s2";
process.env.ESPN_SWID = "{TEST-SWID}";
process.env.WRITES_ENABLED = "false";
process.env.ESPN_MCP_ENV = "Z:/no/such/.env";

const { getLeague } = await import("../src/espn/reads.js");

for (const deadlineDate of [undefined, null, 0, "garbage", 1_770_000_000_000]) {
  test(`getLeague handles tradeSettings.deadlineDate=${String(deadlineDate)}`, async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") !== "GET" || !url.hostname.startsWith("lm-api-reads")) {
        throw new Error(`test stub refuses ${url.hostname}`);
      }
      const tradeSettings: Record<string, unknown> = { vetoVotesRequired: 4 };
      if (deadlineDate !== undefined) tradeSettings.deadlineDate = deadlineDate;
      return new Response(
        JSON.stringify({
          id: 12345,
          seasonId: 2027,
          status: { latestScoringPeriod: 1, finalScoringPeriod: 160, currentMatchupPeriod: 1 },
          settings: { name: "Example League", tradeSettings },
          teams: [{ id: 28 }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const league = await getLeague({ sport: "fba", season: 2027, leagueId: "12345" });
    assert.equal(league.name, "Example League");
    assert.equal(league.tradeSettings?.vetoVotesRequired, 4);
    const expected = deadlineDate === 1_770_000_000_000 ? new Date(1_770_000_000_000).toISOString() : undefined;
    assert.equal(league.tradeSettings?.deadlineDateIso, expected);
  });
}
