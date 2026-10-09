#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./env.js";
import { EspnApiError } from "./espn/client.js";
import { lineupSlotMap, type Sport } from "./espn/constants.js";
import {
  getLeague,
  getTeams,
  getRosters,
  getFreeAgents,
  getMatchups,
  getBoxscore,
  getTransactions,
  getPending,
  getPlayer,
  type LeagueParams,
} from "./espn/reads.js";
import { buildSnapshot } from "./snapshot.js";
import { computeOptimalLineup } from "./optimalLineup.js";
import { waiverClaim, addFreeAgent, cancelClaim, setLineup, moveToIr, activateFromIr } from "./espn/writes.js";
import { IR_SLOT_ID } from "./espn/constants.js";

const cfg = loadConfig();

const server = new McpServer({ name: "espn-fantasy-mcp", version: "0.1.0" });

// ---------------------------------------------------------------------------
// shared schema pieces
// ---------------------------------------------------------------------------

const sportSchema = z
  .enum(["ffl", "fba", "flb"])
  .default(cfg.defaultSport)
  .describe("ffl (football), fba (basketball), or flb (baseball). Defaults to ESPN_SPORT.");
const seasonSchema = z.number().int().default(cfg.defaultSeason).describe("Season year. Defaults to ESPN_SEASON.");
const leagueIdSchema = z
  .string()
  .default(cfg.defaultLeagueId ?? "")
  .describe("ESPN league id. Defaults to ESPN_LEAGUE_ID.");

const leagueParamsShape = { sport: sportSchema, season: seasonSchema, league_id: leagueIdSchema };

function toParams(args: { sport: Sport; season: number; league_id: string }): LeagueParams {
  if (!args.league_id) {
    throw new Error("league_id is required (pass it explicitly or set ESPN_LEAGUE_ID in .env).");
  }
  return { sport: args.sport, season: args.season, leagueId: args.league_id };
}

const CHARACTER_LIMIT = 25_000;

function ok(data: unknown) {
  // Backstop for the tools that don't already paginate (get_transactions
  // does): if a top-level array response is too big, trim it rather than
  // hand back an unbounded blob. Most tools here are naturally bounded (one
  // roster, one scoring period) so this rarely triggers.
  let payload = data;
  let truncationNote = "";
  if (Array.isArray(data) && data.length > 1) {
    let arr = data;
    while (arr.length > 1 && JSON.stringify(arr).length > CHARACTER_LIMIT) {
      arr = arr.slice(0, Math.ceil(arr.length / 2));
    }
    if (arr.length < data.length) {
      payload = arr;
      truncationNote = `\n\n[Response truncated: showing ${arr.length} of ${data.length} items. Narrow your query — a limit, position/slot filter, or a single scoring period — to see the rest.]`;
    }
  }

  // MCP requires structuredContent to be an object, not an array — most read
  // tools here return arrays (teams, rosters, ...), so wrap uniformly.
  const structured =
    payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : { result: payload };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) + truncationNote }],
    structuredContent: structured as Record<string, unknown>,
  };
}

function errorResult(err: unknown) {
  const message = err instanceof EspnApiError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function tryCatch<T>(fn: () => Promise<T>) {
  return fn().then(ok).catch(errorResult);
}

// ---------------------------------------------------------------------------
// output schemas
//
// The SDK only uses these to validate structuredContent (safeParseAsync,
// checked but never substituted back in) — see node_modules/@modelcontextprotocol/sdk
// dist/esm/server/mcp.js's validateToolOutput. So an under-specified schema
// for a passthrough ESPN blob (settings, verification payloads) can't cause
// silent data loss, only a validation *failure* if a field's type is wrong —
// which is why those loosely-known objects use z.record/z.unknown rather
// than fully replicating ESPN's undocumented settings shape.
//
// ok() wraps array results as { result: [...] } (structuredContent must be
// an object per MCP spec) but passes single-object results through as-is —
// each outputSchema below matches whichever of those two shapes its tool
// actually produces.
// ---------------------------------------------------------------------------

const playerOutputSchema = z.object({
  id: z.number(),
  name: z.string(),
  position: z.string(),
  proTeam: z.string(),
  eligibleSlotIds: z.array(z.number()),
  eligibleSlotNames: z.array(z.string()),
  lineupSlotId: z.number().optional(),
  lineupSlotName: z.string().optional(),
  injuryStatus: z.string().optional(),
  locked: z.boolean().optional(),
  seasonProjection: z.number(),
  periodProjection: z.number().optional(),
  periodActual: z.number().optional(),
  percentOwned: z.number().optional(),
  teamId: z.number().optional(),
});

const passthroughObject = z.record(z.string(), z.unknown()).optional();

const getLeagueOutputSchema = {
  leagueId: z.number(),
  seasonId: z.number(),
  name: z.string().optional(),
  currentScoringPeriod: z.number().optional(),
  finalScoringPeriod: z.number().optional(),
  currentMatchupPeriod: z.number().optional(),
  rosterSlotCounts: z.record(z.string(), z.number()).optional(),
  acquisitionSettings: passthroughObject,
  scheduleSettings: passthroughObject,
  tradeSettings: passthroughObject,
  draftSettings: passthroughObject,
  teamCount: z.number().optional(),
};

const teamOutputSchema = z.object({
  id: z.number(),
  name: z.string(),
  abbrev: z.string().optional(),
  owners: z.array(z.string()).optional(),
  record: passthroughObject,
  waiverRank: z.number().optional(),
});

const rosterOutputSchema = z.object({
  teamId: z.number(),
  teamName: z.string(),
  players: z.array(playerOutputSchema),
});

const matchupTeamOutputSchema = z.object({
  teamId: z.number(),
  totalPoints: z.number(),
  totalPointsLive: z.number().optional(),
  totalProjectedPoints: z.number().optional(),
  totalProjectedPointsLive: z.number().optional(),
  winProbability: z.number().optional(),
});

const matchupOutputSchema = z.object({
  matchupPeriodId: z.number(),
  home: matchupTeamOutputSchema.optional(),
  away: matchupTeamOutputSchema.optional(),
  winner: z.string().optional(),
});

const boxscoreTeamOutputSchema = z.object({
  teamId: z.number(),
  players: z.array(playerOutputSchema),
});

const boxscoreOutputSchema = z.object({
  home: boxscoreTeamOutputSchema.optional(),
  away: boxscoreTeamOutputSchema.optional(),
});

const transactionItemOutputSchema = z.object({
  type: z.string(),
  playerId: z.number(),
  playerName: z.string(),
  fromTeamId: z.number().optional(),
  toTeamId: z.number().optional(),
});

const transactionOutputSchema = z.object({
  id: z.string(),
  teamId: z.number().optional(),
  type: z.string(),
  scoringPeriodId: z.number().optional(),
  proposedDate: z.string().optional(),
  items: z.array(transactionItemOutputSchema),
});

const getTransactionsOutputSchema = {
  transactions: z.array(transactionOutputSchema),
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
};

const pendingOutputSchema = z.object({
  id: z.string(),
  teamId: z.number(),
  type: z.string(),
  status: z.string(),
  scoringPeriodId: z.number().optional(),
  bidAmount: z.number().nullable().optional(),
  items: z.array(transactionItemOutputSchema),
});

/** Shared by every write tool's WriteOutcome<T>: dryRun/wouldSend/sent/response/verification/blockedReason. */
function writeOutcomeOutputSchema(extra: Record<string, z.ZodTypeAny> = {}) {
  return {
    dryRun: z.boolean(),
    wouldSend: passthroughObject,
    sent: passthroughObject,
    response: z.object({ status: z.number(), body: z.unknown() }).optional(),
    verification: z.unknown().optional(),
    verifyMismatches: z.array(z.string()).optional(),
    blockedReason: z.string().optional(),
    ...extra,
  };
}

const lineupValidationOutputSchema = z.object({
  valid: z.boolean(),
  accepted: z.array(z.object({ playerId: z.number(), toSlot: z.number() })),
  rejected: z.array(z.object({ playerId: z.number(), toSlot: z.number(), reason: z.string() })),
});

const optimalLineupOutputSchema = {
  usingPeriodProjection: z.boolean(),
  starters: z.array(
    z.object({
      slotId: z.number(),
      slotName: z.string(),
      playerId: z.number().nullable(),
      playerName: z.string().nullable(),
      projection: z.number().nullable(),
      currentSlotId: z.number().optional(),
      isChange: z.boolean(),
      locked: z.boolean().optional(),
    }),
  ),
  bench: z.array(z.object({ playerId: z.number(), name: z.string(), projection: z.number(), locked: z.boolean().optional() })),
};

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

server.registerTool(
  "get_league",
  {
    title: "Get League Settings",
    description:
      "League settings: scoring format, roster slot counts, acquisition (waiver) settings, schedule, trade settings, draft/keeper settings, and the current scoring/matchup period.",
    inputSchema: leagueParamsShape,
    outputSchema: getLeagueOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => tryCatch(() => getLeague(toParams(args))),
);

server.registerTool(
  "get_teams",
  {
    title: "Get Teams",
    description: "All teams in the league: id, name, owners, record, and waiver rank.",
    inputSchema: leagueParamsShape,
    outputSchema: { result: z.array(teamOutputSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => tryCatch(() => getTeams(toParams(args))),
);

server.registerTool(
  "get_rosters",
  {
    title: "Get Rosters",
    description:
      "Every team's roster, or one team's roster if team_id is given. Each player includes id, name, position, pro team, eligible slots, current lineup slot, injury status, lock state, and season/period projections.",
    inputSchema: { ...leagueParamsShape, team_id: z.number().int().optional().describe("Limit to one team id.") },
    outputSchema: { result: z.array(rosterOutputSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => tryCatch(() => getRosters(toParams(args), args.team_id)),
);

server.registerTool(
  "get_free_agents",
  {
    title: "Get Free Agents",
    description:
      "Free agents and waiver-wire players, sorted by ownership percent (default) or projection. Optionally filter by lineup slot id (see get_league for slot ids, or the README's slot tables).",
    inputSchema: {
      ...leagueParamsShape,
      position_slot_id: z.number().int().optional().describe("Filter to one lineup slot id, e.g. 2 for RB in football."),
      limit: z.number().int().min(1).max(200).default(60).describe("Max players to return."),
      sort_by: z.enum(["owned", "projection"]).default("owned"),
    },
    outputSchema: { result: z.array(playerOutputSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    tryCatch(() =>
      getFreeAgents(toParams(args), { positionSlotId: args.position_slot_id, limit: args.limit, sortBy: args.sort_by }),
    ),
);

server.registerTool(
  "get_matchups",
  {
    title: "Get Matchups",
    description: "Matchups for a scoring period: home/away team ids, live/final totals, and live projections.",
    inputSchema: { ...leagueParamsShape, scoring_period_id: z.number().int().describe("Week (football) or day (basketball/baseball).") },
    outputSchema: { result: z.array(matchupOutputSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => tryCatch(() => getMatchups(toParams(args), args.scoring_period_id)),
);

server.registerTool(
  "get_boxscore",
  {
    title: "Get Boxscore",
    description: "Per-player actual stats for a scoring period, for both teams in each matchup.",
    inputSchema: { ...leagueParamsShape, scoring_period_id: z.number().int() },
    outputSchema: { result: z.array(boxscoreOutputSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => tryCatch(() => getBoxscore(toParams(args), args.scoring_period_id)),
);

server.registerTool(
  "get_transactions",
  {
    title: "Get Transactions",
    description:
      "Executed transactions (adds, drops, trades, lineup moves, draft picks), most recent first, with items resolved to player names. Paginated — a full season's draft alone can be 100+ records, so use limit/offset rather than expecting everything at once. Response includes total/count/offset/hasMore.",
    inputSchema: {
      ...leagueParamsShape,
      limit: z.number().int().min(1).max(200).default(50).describe("Max transactions to return."),
      offset: z.number().int().min(0).default(0).describe("Number to skip, for paging through more."),
      scoring_period_id: z.number().int().min(1).optional().describe("Only this scoring period. Omit to read every period of the season so far."),
    },
    outputSchema: getTransactionsOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => tryCatch(() => getTransactions(toParams(args), { limit: args.limit, offset: args.offset, scoringPeriodId: args.scoring_period_id })),
);

server.registerTool(
  "get_pending",
  {
    title: "Get Pending Transactions",
    description: "Pending waiver claims and trade proposals, with items resolved to player names. Trades are read-only here — this server never proposes, accepts, or rejects trades.",
    inputSchema: leagueParamsShape,
    outputSchema: { result: z.array(pendingOutputSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => tryCatch(() => getPending(toParams(args))),
);

server.registerTool(
  "get_player",
  {
    title: "Get Player",
    description: "Look up one player by ESPN player id, or by a case-insensitive name substring search across rosters and free agents.",
    inputSchema: {
      ...leagueParamsShape,
      id: z.number().int().optional(),
      name_search: z.string().optional(),
    },
    outputSchema: playerOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const player = await getPlayer(toParams(args), { id: args.id, nameSearch: args.name_search });
      if (!player) {
        // isError:true skips output-schema validation (there's nothing to validate) — see the note above ok().
        return errorResult(new Error(`No player found for ${args.id !== undefined ? `id ${args.id}` : `name search "${args.name_search}"`}.`));
      }
      return ok(player);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "snapshot",
  {
    title: "League Snapshot",
    description:
      "The league in the exact line-oriented text format used by frontoffice-manager's tools/diff-snapshot.mjs: `teamId|playerId|name|injury|seasonProj` roster rows, `FA|...|pctOwned` free-agent rows, a SETTINGS line, a WAIVERORDER line, and a PEND: line, wrapped in SNAPSTART/SNAPEND markers.",
    inputSchema: leagueParamsShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const text = await buildSnapshot(toParams(args));
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "optimal_lineup",
  {
    title: "Optimal Lineup Suggestion",
    description:
      "Suggests a starting lineup for one team: fills the most restrictive slots first (fewest eligible roster players), then the best remaining projection for each slot — the same approach the cheat sheets describe by hand. A heuristic, not a guaranteed-optimal assignment. Ranks by season projection by default, or by a specific scoring period's projection if scoring_period_id is given (a bye-week/no-game player ranks 0 for that period, not by season total). Locked players keep their current slot. This is a suggestion only — pass the resulting moves to set_lineup yourself if you want to apply them.",
    inputSchema: {
      ...leagueParamsShape,
      team_id: z.number().int().default(cfg.defaultTeamId ?? 0),
      scoring_period_id: z.number().int().optional().describe("Rank by this period's projection instead of season total."),
    },
    outputSchema: optimalLineupOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    tryCatch(async () => {
      const p = toParams(args);
      const [league, rosters] = await Promise.all([getLeague(p), getRosters(p, args.team_id, args.scoring_period_id)]);
      if (rosters.length === 0) throw new Error(`No roster found for team ${args.team_id}.`);
      return computeOptimalLineup(p.sport, rosters[0].players, league.rosterSlotCounts ?? {}, {
        scoringPeriodId: args.scoring_period_id,
      });
    }),
);

// ---------------------------------------------------------------------------
// writes — all dry_run: true by default
// ---------------------------------------------------------------------------

const dryRunSchema = z
  .boolean()
  .default(true)
  .describe("Default true: validates and reports what would be sent without sending it. Set false to actually execute (still a no-op if WRITES_ENABLED=false in .env).");

const moveSchema = z.object({
  player_id: z.number().int(),
  to_slot: z.number().int().describe("Target lineup slot id, e.g. 20 for bench in football. See get_league's roster slot counts or the README's slot tables."),
});

server.registerTool(
  "set_lineup",
  {
    title: "Set Lineup",
    description:
      "Apply a batch of lineup moves to one team. Validates every move locally first (player is on the roster, target slot is eligible, player isn't locked, and the resulting lineup respects the league's slot counts) before sending anything. Rejected moves are reported with a reason and never sent.",
    inputSchema: {
      ...leagueParamsShape,
      team_id: z.number().int().default(cfg.defaultTeamId ?? 0),
      moves: z.array(moveSchema).min(1),
      scoring_period_id: z.number().int().min(1).optional().describe(
        "Scoring period to set the lineup for (a day in basketball/baseball, a week in football). Omit for ESPN's current period. A later period sets a future day's lineup, e.g. tomorrow's tonight; locks and slots are read for that period. Past periods and periods after the league's last are refused.",
      ),
      dry_run: dryRunSchema,
    },
    outputSchema: writeOutcomeOutputSchema({ validation: lineupValidationOutputSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) =>
    tryCatch(() =>
      setLineup(
        toParams(args),
        {
          teamId: args.team_id,
          moves: args.moves.map((m) => ({ playerId: m.player_id, toSlot: m.to_slot })),
          scoringPeriodId: args.scoring_period_id,
        },
        args.dry_run,
      ),
    ),
);

server.registerTool(
  "add_free_agent",
  {
    title: "Add Free Agent",
    description: "Add an unclaimed free agent (not a waiver-wire player — use waiver_claim for those), optionally dropping another player in the same move.",
    inputSchema: {
      ...leagueParamsShape,
      team_id: z.number().int().default(cfg.defaultTeamId ?? 0),
      add_player_id: z.number().int(),
      drop_player_id: z.number().int().optional(),
      dry_run: dryRunSchema,
    },
    outputSchema: writeOutcomeOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) =>
    tryCatch(() =>
      addFreeAgent(
        toParams(args),
        { teamId: args.team_id, addPlayerId: args.add_player_id, dropPlayerId: args.drop_player_id },
        args.dry_run,
      ),
    ),
);

server.registerTool(
  "waiver_claim",
  {
    title: "Waiver Claim",
    description: "Submit a waiver claim, optionally with a conditional drop. `bid` is only used in FAAB leagues (see get_league's acquisitionSettings.acquisitionType); leave it unset in priority-waiver leagues.",
    inputSchema: {
      ...leagueParamsShape,
      team_id: z.number().int().default(cfg.defaultTeamId ?? 0),
      add_player_id: z.number().int(),
      drop_player_id: z.number().int().optional(),
      bid: z.number().int().min(0).optional(),
      dry_run: dryRunSchema,
    },
    outputSchema: writeOutcomeOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) =>
    tryCatch(() =>
      waiverClaim(
        toParams(args),
        { teamId: args.team_id, addPlayerId: args.add_player_id, dropPlayerId: args.drop_player_id, bid: args.bid },
        args.dry_run,
      ),
    ),
);

server.registerTool(
  "cancel_claim",
  {
    title: "Cancel Claim",
    description: "Cancel a pending waiver claim by its transaction id (from get_pending).",
    inputSchema: {
      ...leagueParamsShape,
      team_id: z.number().int().default(cfg.defaultTeamId ?? 0),
      transaction_id: z.string(),
      dry_run: dryRunSchema,
    },
    outputSchema: writeOutcomeOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) => tryCatch(() => cancelClaim(toParams(args), { teamId: args.team_id, transactionId: args.transaction_id }, args.dry_run)),
);

server.registerTool(
  "move_to_ir",
  {
    title: "Move to IR",
    description: "Move one player into the IR/IL slot, as a lineup move. Refuses if the player isn't eligible for IR or is locked.",
    inputSchema: {
      ...leagueParamsShape,
      team_id: z.number().int().default(cfg.defaultTeamId ?? 0),
      player_id: z.number().int(),
      dry_run: dryRunSchema,
    },
    outputSchema: writeOutcomeOutputSchema({ validation: lineupValidationOutputSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => tryCatch(() => moveToIr(toParams(args), { teamId: args.team_id, playerId: args.player_id }, args.dry_run)),
);

server.registerTool(
  "activate_from_ir",
  {
    title: "Activate From IR",
    description: "Move one player out of the IR/IL slot into an active or bench slot, as a lineup move.",
    inputSchema: {
      ...leagueParamsShape,
      team_id: z.number().int().default(cfg.defaultTeamId ?? 0),
      player_id: z.number().int(),
      to_slot: z.number().int().describe("Destination slot id (e.g. bench). Must not be the IR slot itself."),
      dry_run: dryRunSchema,
    },
    outputSchema: writeOutcomeOutputSchema({ validation: lineupValidationOutputSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => {
    if (args.to_slot === IR_SLOT_ID[args.sport as Sport]) {
      return Promise.resolve(errorResult(new Error("to_slot must not be the IR slot — use move_to_ir to move a player into IR.")));
    }
    return tryCatch(() => activateFromIr(toParams(args), { teamId: args.team_id, playerId: args.player_id, toSlot: args.to_slot }, args.dry_run));
  },
);

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `espn-fantasy-mcp running (sport=${cfg.defaultSport}, season=${cfg.defaultSeason}, writes ${cfg.writesEnabled ? "ENABLED" : "disabled (dry run only)"})`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting espn-fantasy-mcp:", err instanceof Error ? err.message : err);
  process.exit(1);
});

void lineupSlotMap; // referenced only for the type import in tool descriptions above
