import { getJson, leaguePath } from "./client.js";
import { defaultPositionMap, lineupSlotMap, proTeamMap, type Sport } from "./constants.js";
import type {
  EspnLeagueResponse,
  EspnPlayer,
  EspnPendingTransaction,
  EspnTransaction,
  EspnMatchup,
  EspnMatchupTeamEntry,
  EspnBoxscore,
} from "./types.js";

export interface LeagueParams {
  sport: Sport;
  season: number;
  leagueId: string;
}

function viewQuery(views: string[], extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams();
  for (const v of views) params.append("view", v);
  for (const [k, v] of Object.entries(extra)) params.append(k, String(v));
  return `?${params.toString()}`;
}

async function fetchLeague(
  p: LeagueParams,
  views: string[],
  extra: Record<string, string | number> = {},
  headers?: Record<string, string>,
): Promise<EspnLeagueResponse> {
  const path = leaguePath(p.sport, p.season, p.leagueId, viewQuery(views, extra));
  return (await getJson(path, headers)) as EspnLeagueResponse;
}

// ---------------------------------------------------------------------------
// Normalized player shape shared by rosters, free agents, boxscores, search
// ---------------------------------------------------------------------------

export interface NormalizedPlayer {
  id: number;
  name: string;
  position: string;
  proTeam: string;
  eligibleSlotIds: number[];
  eligibleSlotNames: string[];
  lineupSlotId?: number;
  lineupSlotName?: string;
  injuryStatus?: string;
  locked?: boolean;
  seasonProjection: number;
  periodProjection?: number;
  periodActual?: number;
  percentOwned?: number;
  teamId?: number;
}

function statValue(
  player: EspnPlayer,
  statSourceId: number,
  scoringPeriodId: number,
  seasonId: number,
): number | undefined {
  const stat = (player.stats || []).find(
    (s) =>
      s.statSourceId === statSourceId &&
      s.scoringPeriodId === scoringPeriodId &&
      s.seasonId === seasonId,
  );
  return stat?.appliedTotal !== undefined ? Math.round(stat.appliedTotal) : undefined;
}

export function normalizePlayer(
  sport: Sport,
  season: number,
  player: EspnPlayer,
  opts: {
    lineupSlotId?: number;
    locked?: boolean;
    percentOwned?: number;
    periodId?: number;
    teamId?: number;
  } = {},
): NormalizedPlayer {
  const slotMap = lineupSlotMap(sport);
  const teamMap = proTeamMap(sport);
  const positionMap = defaultPositionMap(sport);
  return {
    id: player.id,
    name: player.fullName,
    position: positionMap[player.defaultPositionId] ?? String(player.defaultPositionId),
    proTeam: teamMap[player.proTeamId] ?? String(player.proTeamId),
    eligibleSlotIds: player.eligibleSlots || [],
    eligibleSlotNames: (player.eligibleSlots || []).map((id) => slotMap[id] ?? String(id)),
    lineupSlotId: opts.lineupSlotId,
    lineupSlotName:
      opts.lineupSlotId !== undefined ? (slotMap[opts.lineupSlotId] ?? String(opts.lineupSlotId)) : undefined,
    injuryStatus: player.injuryStatus,
    locked: opts.locked,
    seasonProjection: statValue(player, 1, 0, season) ?? 0,
    periodProjection: opts.periodId !== undefined ? statValue(player, 1, opts.periodId, season) : undefined,
    periodActual: opts.periodId !== undefined ? statValue(player, 0, opts.periodId, season) : undefined,
    percentOwned: opts.percentOwned !== undefined ? Math.round(opts.percentOwned) : undefined,
    teamId: opts.teamId,
  };
}

// ---------------------------------------------------------------------------
// get_league
// ---------------------------------------------------------------------------

export async function getLeague(p: LeagueParams) {
  const data = await fetchLeague(p, ["mSettings", "mTeam"]);
  const s = data.settings;
  return {
    leagueId: data.id,
    seasonId: data.seasonId,
    name: s?.name,
    currentScoringPeriod: data.status?.latestScoringPeriod,
    finalScoringPeriod: data.status?.finalScoringPeriod,
    currentMatchupPeriod: data.status?.currentMatchupPeriod,
    rosterSlotCounts: s?.rosterSettings?.lineupSlotCounts,
    acquisitionSettings: s?.acquisitionSettings,
    scheduleSettings: s?.scheduleSettings,
    tradeSettings: s?.tradeSettings
      ? {
          ...s.tradeSettings,
          deadlineDateIso: new Date(s.tradeSettings.deadlineDate).toISOString(),
        }
      : undefined,
    draftSettings: s?.draftSettings,
    teamCount: data.teams?.length,
  };
}

// ---------------------------------------------------------------------------
// get_teams
// ---------------------------------------------------------------------------

export async function getTeams(p: LeagueParams) {
  const data = await fetchLeague(p, ["mTeam"]);
  return (data.teams || []).map((t) => ({
    id: t.id,
    name: t.name || `${t.location ?? ""} ${t.nickname ?? ""}`.trim(),
    abbrev: t.abbrev,
    owners: t.owners,
    record: t.record?.overall,
    waiverRank: t.waiverRank,
  }));
}

// ---------------------------------------------------------------------------
// get_rosters
// ---------------------------------------------------------------------------

/** `asOfPeriod` asks ESPN for the roster as of that scoring period (its slots
 *  and lineupLocked flags). Omitted, ESPN answers for its current period.
 *  `periodId` only selects which period's stats are attached. */
export async function getRosters(p: LeagueParams, teamId?: number, periodId?: number, asOfPeriod?: number) {
  const data = await fetchLeague(p, ["mRoster", "mTeam"], asOfPeriod !== undefined ? { scoringPeriodId: asOfPeriod } : {});
  const teams = (data.teams || []).filter((t) => teamId === undefined || t.id === teamId);
  return teams.map((t) => ({
    teamId: t.id,
    teamName: t.name || `${t.location ?? ""} ${t.nickname ?? ""}`.trim(),
    players: (t.roster?.entries || []).map((e) =>
      normalizePlayer(p.sport, p.season, e.playerPoolEntry.player, {
        lineupSlotId: e.lineupSlotId,
        locked: e.playerPoolEntry.lineupLocked ?? false,
        teamId: t.id,
        periodId,
      }),
    ),
  }));
}

// ---------------------------------------------------------------------------
// get_free_agents
// ---------------------------------------------------------------------------

export interface FreeAgentParams {
  positionSlotId?: number;
  limit?: number;
  sortBy?: "owned" | "projection";
}

export async function getFreeAgents(p: LeagueParams, opts: FreeAgentParams = {}) {
  const limit = opts.limit ?? 60;
  const filter: Record<string, unknown> = {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      limit,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
    },
  };
  if (opts.positionSlotId !== undefined) {
    (filter.players as Record<string, unknown>).filterSlotIds = { value: [opts.positionSlotId] };
  }
  const data = await fetchLeague(
    p,
    ["kona_player_info"],
    { scoringPeriodId: 1 },
    { "X-Fantasy-Filter": JSON.stringify(filter) },
  );
  const players = ((data as unknown as { players?: Array<{ player: EspnPlayer; onTeamId?: number }> }).players ||
    []) as Array<{ player: EspnPlayer; onTeamId?: number }>;

  let normalized = players.map((x) =>
    normalizePlayer(p.sport, p.season, x.player, {
      percentOwned: x.player.ownership?.percentOwned,
    }),
  );

  if (opts.sortBy === "projection") {
    normalized = normalized.sort((a, b) => b.seasonProjection - a.seasonProjection);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// get_matchups
// ---------------------------------------------------------------------------

function summarizeMatchupTeam(t?: EspnMatchupTeamEntry) {
  if (!t) return undefined;
  return {
    teamId: t.teamId,
    totalPoints: t.totalPoints ?? 0,
    totalPointsLive: t.totalPointsLive,
    totalProjectedPoints: t.totalProjectedPoints,
    totalProjectedPointsLive: t.totalProjectedPointsLive,
    winProbability: t.winProbability,
  };
}

export async function getMatchups(p: LeagueParams, scoringPeriodId: number) {
  const data = await fetchLeague(p, ["mMatchup", "mMatchupScore"], { scoringPeriodId });
  const raw = (data as unknown as { schedule?: EspnMatchup[] }).schedule || [];
  return raw
    .filter((m) => m.matchupPeriodId === scoringPeriodId || !scoringPeriodId)
    .map((m) => ({
      matchupPeriodId: m.matchupPeriodId,
      home: summarizeMatchupTeam(m.home),
      away: summarizeMatchupTeam(m.away),
      winner: m.winner,
    }));
}

// ---------------------------------------------------------------------------
// get_boxscore
// ---------------------------------------------------------------------------

export async function getBoxscore(p: LeagueParams, scoringPeriodId: number) {
  const data = await fetchLeague(p, ["mBoxscore", "mMatchupScore"], { scoringPeriodId });
  const raw = (data as unknown as { schedule?: EspnBoxscore[] }).schedule || [];
  const shapeTeam = (team: EspnBoxscore["home"] | undefined) => {
    if (!team) return undefined;
    return {
      teamId: team.teamId,
      players: (team.rosterForCurrentScoringPeriod?.entries || []).map((e) =>
        normalizePlayer(p.sport, p.season, e.playerPoolEntry.player, {
          lineupSlotId: e.lineupSlotId,
          locked: e.playerPoolEntry.lineupLocked ?? false,
          teamId: team.teamId,
          periodId: scoringPeriodId,
        }),
      ),
    };
  };
  return raw
    .filter((m) => m.matchupPeriodId === scoringPeriodId)
    .map((m) => ({ home: shapeTeam(m.home), away: shapeTeam(m.away) }));
}

// ---------------------------------------------------------------------------
// player name resolution (for transactions, which only carry playerId)
// ---------------------------------------------------------------------------

async function resolvePlayerNames(p: LeagueParams, ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  const map = new Map<number, string>();
  if (unique.length === 0) return map;
  // No `limit` here: filterIds already bounds the result set exactly, and
  // ESPN's API rejects a `limit` that isn't paired with a `sort*` clause.
  const filter = { players: { filterIds: { value: unique } } };
  const data = await fetchLeague(p, ["kona_player_info"], {}, { "X-Fantasy-Filter": JSON.stringify(filter) });
  const players = ((data as unknown as { players?: Array<{ player: EspnPlayer }> }).players || []) as Array<{
    player: EspnPlayer;
  }>;
  for (const x of players) map.set(x.player.id, x.player.fullName);
  return map;
}

// ---------------------------------------------------------------------------
// get_transactions
// ---------------------------------------------------------------------------

export interface TransactionsPage {
  transactions: unknown[];
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
}

export async function getTransactions(
  p: LeagueParams,
  opts: { limit?: number; offset?: number; scoringPeriodId?: number } = {},
): Promise<TransactionsPage> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  // ESPN's mTransactions2 view returns only the current scoring period when no
  // scoringPeriodId is passed, so earlier periods silently disappeared as soon
  // as a period rolled over. Read every period from 1 through the current one
  // (or just the one asked for) and merge by transaction id.
  let periods: number[];
  if (opts.scoringPeriodId !== undefined) {
    periods = [opts.scoringPeriodId];
  } else {
    const current = (await getLeague(p)).currentScoringPeriod;
    periods = current ? Array.from({ length: Math.max(1, current) }, (_, i) => i + 1) : [];
  }
  const pages = periods.length
    ? await Promise.all(periods.map((sp) => fetchLeague(p, ["mTransactions2"], { scoringPeriodId: sp })))
    : [await fetchLeague(p, ["mTransactions2"])]; // no current period reported: fall back to ESPN's default
  const byId = new Map<string, EspnTransaction>();
  for (const d of pages)
    for (const t of (d as unknown as { transactions?: EspnTransaction[] }).transactions || []) byId.set(String(t.id), t);
  const all = [...byId.values()]
    .filter((t) => t.status === "EXECUTED")
    // most recent first — the typical "what happened lately" use case
    .sort((a, b) => (b.proposedDate ?? 0) - (a.proposedDate ?? 0));

  const page = all.slice(offset, offset + limit);
  const ids = page.flatMap((t) => (t.items || []).map((i) => i.playerId));
  const names = await resolvePlayerNames(p, ids);

  const transactions = page.map((t) => ({
    id: t.id,
    teamId: t.teamId,
    type: t.type,
    scoringPeriodId: t.scoringPeriodId,
    proposedDate: t.proposedDate ? new Date(t.proposedDate).toISOString() : undefined,
    items: (t.items || []).map((i) => ({
      type: i.type,
      playerId: i.playerId,
      playerName: names.get(i.playerId) ?? `#${i.playerId}`,
      fromTeamId: i.fromTeamId,
      toTeamId: i.toTeamId,
    })),
  }));

  return {
    transactions,
    total: all.length,
    count: transactions.length,
    offset,
    hasMore: offset + transactions.length < all.length,
  };
}

// ---------------------------------------------------------------------------
// get_pending
// ---------------------------------------------------------------------------

export async function getPending(p: LeagueParams) {
  const data = await fetchLeague(p, ["mPendingTransactions"]);
  const raw = (data as unknown as { pendingTransactions?: EspnPendingTransaction[] }).pendingTransactions || [];
  const ids = raw.flatMap((t) => (t.items || []).map((i) => i.playerId));
  const names = await resolvePlayerNames(p, ids);
  return raw.map((t) => ({
    id: t.id,
    teamId: t.teamId,
    type: t.type,
    status: t.status,
    scoringPeriodId: t.scoringPeriodId,
    bidAmount: t.bidAmount,
    items: (t.items || []).map((i) => ({
      type: i.type,
      playerId: i.playerId,
      playerName: names.get(i.playerId) ?? `#${i.playerId}`,
      fromTeamId: i.fromTeamId,
      toTeamId: i.toTeamId,
    })),
  }));
}

// ---------------------------------------------------------------------------
// get_player (by id or name search, searches rosters + free agent pool)
// ---------------------------------------------------------------------------

/** The X-Fantasy-Filter for a name search across the whole player pool
 *  (every status, rostered or not), most-owned first. */
export function buildNameSearchFilter(name: string) {
  return {
    players: {
      filterName: { value: name.trim() },
      limit: 50,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
    },
  };
}

/** Choose the best hit from a filterName answer: an exact full-name match
 *  first, else the first (most-owned) entry whose name contains the needle.
 *  The containment check guards against ESPN ignoring filterName and handing
 *  back the top of the pool, which would otherwise return a wrong player. */
export function pickNameMatch<T extends { player: { fullName: string } }>(pool: T[], name: string): T | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    pool.find((x) => x.player.fullName.toLowerCase() === needle) ??
    pool.find((x) => x.player.fullName.toLowerCase().includes(needle))
  );
}

export async function getPlayer(p: LeagueParams, opts: { id?: number; nameSearch?: string }) {
  if (opts.id !== undefined) {
    const filter = { players: { filterIds: { value: [opts.id] } } };
    const data = await fetchLeague(p, ["kona_player_info"], {}, { "X-Fantasy-Filter": JSON.stringify(filter) });
    const players = ((data as unknown as { players?: Array<{ player: EspnPlayer }> }).players || []) as Array<{
      player: EspnPlayer;
    }>;
    if (players.length === 0) return undefined;
    return normalizePlayer(p.sport, p.season, players[0].player);
  }

  if (opts.nameSearch) {
    const needle = opts.nameSearch.toLowerCase();
    const rosters = await getRosters(p);
    for (const r of rosters) {
      const hit = r.players.find((pl) => pl.name.toLowerCase().includes(needle));
      if (hit) return hit;
    }
    // Ask ESPN by name before scanning a slice: scanning only the 200
    // most-owned free agents made any low-owned player read as nonexistent.
    // kona_player_info honours filterName over the whole pool, but it matches
    // name prefixes only, so a mid-word needle still falls through to the
    // substring scan below.
    const filter = buildNameSearchFilter(opts.nameSearch);
    const data = await fetchLeague(p, ["kona_player_info"], {}, { "X-Fantasy-Filter": JSON.stringify(filter) });
    const pool = ((data as unknown as { players?: Array<{ player: EspnPlayer; onTeamId?: number }> }).players ||
      []) as Array<{ player: EspnPlayer; onTeamId?: number }>;
    const picked = pickNameMatch(pool, opts.nameSearch);
    if (picked) {
      return normalizePlayer(p.sport, p.season, picked.player, {
        percentOwned: picked.player.ownership?.percentOwned,
        teamId: picked.onTeamId ? picked.onTeamId : undefined,
      });
    }
    const freeAgents = await getFreeAgents(p, { limit: 200 });
    return freeAgents.find((pl) => pl.name.toLowerCase().includes(needle));
  }

  throw new Error("get_player requires either id or name_search");
}
