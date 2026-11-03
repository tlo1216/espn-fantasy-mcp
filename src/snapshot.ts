import { getJson, leaguePath } from "./espn/client.js";
import { safeIso } from "./espn/dates.js";
import type { Sport } from "./espn/constants.js";
import type {
  EspnLeagueResponse,
  EspnPlayer,
  EspnPendingTransaction,
} from "./espn/types.js";

/**
 * Ports tools/snapshot-fetch.js (and its cookie-based sibling
 * espn-cookie-fetch.mjs) from tlo1216/frontoffice-manager line-for-line, so
 * this tool's output diffs cleanly against an existing league-snapshot.txt
 * with tools/diff-snapshot.mjs. Format:
 *   teamId|playerId|name|injury|seasonProj   (roster rows)
 *   FA|playerId|name|injury|seasonProj|pctOwned   (free agent rows)
 *   SETTINGS|...
 *   WAIVERORDER|...
 * plus a PEND: line and SNAPSTART/SNAPEND markers.
 */

export interface SnapshotParams {
  sport: Sport;
  season: number;
  leagueId: string;
}

function seasonProjection(player: EspnPlayer, season: number): number {
  const stat = (player.stats || []).find(
    (s) => s.statSourceId === 1 && s.scoringPeriodId === 0 && s.seasonId === season,
  );
  return stat?.appliedTotal !== undefined ? Math.round(stat.appliedTotal) : 0;
}

export async function buildSnapshot(p: SnapshotParams): Promise<string> {
  const base = (view: string, extra = "") =>
    leaguePath(p.sport, p.season, p.leagueId, `?view=${view}${extra}`);

  const [R, M, S, P, FA] = await Promise.all([
    getJson(base("mRoster")) as Promise<EspnLeagueResponse>,
    getJson(base("mTeam")) as Promise<EspnLeagueResponse>,
    getJson(base("mSettings")) as Promise<EspnLeagueResponse>,
    getJson(base("mPendingTransactions")) as Promise<{ pendingTransactions?: EspnPendingTransaction[] }>,
    getJson(base("kona_player_info", "&scoringPeriodId=1"), {
      "X-Fantasy-Filter": JSON.stringify({
        players: {
          filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
          limit: 60,
          sortPercOwned: { sortPriority: 1, sortAsc: false },
        },
      }),
    }) as Promise<{ players?: Array<{ player: EspnPlayer }> }>,
  ]);

  return formatSnapshot(p.season, R, M, S, P, FA);
}

/** Pure formatting step, split out from buildSnapshot so it can be unit tested without network access. */
export function formatSnapshot(
  season: number,
  R: EspnLeagueResponse,
  M: EspnLeagueResponse,
  S: EspnLeagueResponse,
  P: { pendingTransactions?: EspnPendingTransaction[] },
  FA: { players?: Array<{ player: EspnPlayer }> },
): string {
  const lines: string[] = [
    `# League snapshot ${new Date().toLocaleString()}. Format: teamId|playerId|name|injury|seasonProj ; FA rows add |pctOwned`,
  ];

  for (const t of R.teams || []) {
    for (const e of t.roster?.entries || []) {
      const player = e.playerPoolEntry.player;
      lines.push([t.id, player.id, player.fullName, player.injuryStatus ?? "", seasonProjection(player, season)].join("|"));
    }
  }

  for (const x of FA.players || []) {
    const player = x.player;
    lines.push(
      [
        "FA",
        player.id,
        player.fullName,
        player.injuryStatus ?? "",
        seasonProjection(player, season),
        Math.round(player.ownership?.percentOwned ?? 0),
      ].join("|"),
    );
  }

  const settings = S.settings;
  const a = settings?.acquisitionSettings;
  const sc = settings?.scheduleSettings;
  const tr = settings?.tradeSettings;
  if (a && sc && tr && settings?.draftSettings) {
    lines.push(
      [
        "SETTINGS",
        `acquisitionType=${a.acquisitionType}`,
        `waiverOrderReset=${a.waiverOrderReset}`,
        `waiverHours=${a.waiverHours}`,
        `processDays=${(a.waiverProcessDays || []).map((d) => d.slice(0, 3)).join(",")}`,
        `processHour=${a.waiverProcessHour}`,
        `tradeDeadline=${(safeIso(tr.deadlineDate) ?? "").slice(0, 16).replace("T", " ")}`,
        `vetoVotes=${tr.vetoVotesRequired}`,
        `playoffTeams=${sc.playoffTeamCount}`,
        `keepers=${settings.draftSettings.keeperCount ?? 0}`,
      ].join("|"),
    );
  }

  lines.push(`WAIVERORDER|${(M.teams || []).map((t) => `${t.id}:${t.waiverRank ?? ""}`).join("|")}`);

  const pend = (P.pendingTransactions || []).map(
    (x) => `${x.teamId} ${x.type} ${x.status} ${(x.items || []).map((i) => `${i.type}:${i.playerId}`).join(" ")}`,
  );

  return `PEND:${JSON.stringify(pend)}\nSNAPSTART\n${lines.join("\n")}\nSNAPEND\n`;
}
