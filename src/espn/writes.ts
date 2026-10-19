import { logWrite, postTransaction, redactBody, redactResult, writesEnabled } from "./client.js";
import { requireCookies } from "../env.js";
import { IR_SLOT_ID, type Sport } from "./constants.js";
import { getLeague, getRosters, type LeagueParams, type NormalizedPlayer } from "./reads.js";
import { validateLineupMoves, type LineupMove, type LineupValidationResult } from "../lineup.js";

export interface WriteOutcome<T> {
  dryRun: boolean;
  wouldSend?: Record<string, unknown>;
  sent?: Record<string, unknown>;
  response?: { status: number; body: unknown };
  verification?: T;
  /** Non-empty only when an executed write's read-back still disagrees with what was sent after settling. */
  verifyMismatches?: string[];
  blockedReason?: string;
}

function memberId(): string {
  return requireCookies().swid;
}

async function currentScoringPeriod(p: LeagueParams): Promise<number> {
  const league = await getLeague(p);
  return league.currentScoringPeriod ?? 1;
}

async function teamRoster(p: LeagueParams, teamId: number, asOfPeriod?: number): Promise<NormalizedPlayer[]> {
  const rosters = await getRosters(p, teamId, undefined, asOfPeriod);
  if (rosters.length === 0) throw new Error(`No roster found for team ${teamId}.`);
  return rosters[0].players;
}

// ---------------------------------------------------------------------------
// read-back verification
// ---------------------------------------------------------------------------

/** Did the roster read back after a lineup write land where the moves sent it? */
export function lineupMismatches(roster: NormalizedPlayer[], moves: LineupMove[]): string[] {
  const bySlot = new Map(roster.map((pl) => [pl.id, pl.lineupSlotId]));
  const out: string[] = [];
  for (const m of moves) {
    if (!bySlot.has(m.playerId)) {
      out.push(`player ${m.playerId}: intended slot ${m.toSlot}, but the player is not on the roster read back`);
    } else if (bySlot.get(m.playerId) !== m.toSlot) {
      out.push(`player ${m.playerId}: intended slot ${m.toSlot}, roster read-back shows slot ${bySlot.get(m.playerId)}`);
    }
  }
  return out;
}

/** Minimal shape of one getPending() entry, just the fields the add/drop check needs. */
export interface PendingTxLike {
  teamId?: number;
  type?: string;
  items?: Array<{ type?: string; playerId?: number; toTeamId?: number }>;
}

/**
 * Did an add/drop take? A FREEAGENT add executes immediately, so the receipt
 * is the roster. A WAIVER claim waits for the waiver run, so the receipt is a
 * matching pending entry (or the roster, if it already cleared).
 */
export function addDropMismatches(
  opts: { type: "WAIVER" | "FREEAGENT"; teamId: number; addPlayerId: number; dropPlayerId?: number },
  roster: NormalizedPlayer[],
  pending: PendingTxLike[],
): string[] {
  const onRoster = new Set(roster.map((pl) => pl.id));
  const addLanded = onRoster.has(opts.addPlayerId);
  const dropLanded = opts.dropPlayerId === undefined || !onRoster.has(opts.dropPlayerId);
  if (opts.type === "FREEAGENT") {
    const out: string[] = [];
    if (!addLanded) out.push(`player ${opts.addPlayerId}: add did not land, not on the roster read back`);
    if (!dropLanded) out.push(`player ${opts.dropPlayerId}: drop did not land, still on the roster read back`);
    return out;
  }
  if (addLanded && dropLanded) return [];
  const pendingMatch = pending.some(
    (t) =>
      t.teamId === opts.teamId &&
      t.type === "WAIVER" &&
      (t.items || []).some((i) => i.type === "ADD" && i.playerId === opts.addPlayerId && i.toTeamId === opts.teamId),
  );
  return pendingMatch
    ? []
    : [`waiver claim for player ${opts.addPlayerId}: no matching pending entry and the roster read-back does not show it either`];
}

// ESPN's read side lags its write side: a roster read seconds (sometimes
// minutes) after an executed write can still show the old state, so a single
// immediate read-back reports a failure that did not happen. Re-read a few
// times, spaced out, before reporting a mismatch. A real failure never
// converges and is still reported; a lagging read stops being a false alarm.
export const SETTLE_DELAYS_MS = [0, 3000, 8000, 15000];

export async function settle<T>(
  read: () => Promise<T>,
  mismatches: (state: T) => string[],
  delaysMs: number[] = SETTLE_DELAYS_MS,
): Promise<{ state: T; mismatches: string[] }> {
  let state = await read();
  let m = mismatches(state);
  for (const delay of delaysMs.slice(1)) {
    if (m.length === 0) break;
    await new Promise((r) => setTimeout(r, delay));
    state = await read();
    m = mismatches(state);
  }
  return { state, mismatches: m };
}

// ---------------------------------------------------------------------------
// waiver_claim / add_free_agent (same payload shape, different `type`)
// ---------------------------------------------------------------------------

export function buildAddDropBody(opts: {
  type: "WAIVER" | "FREEAGENT";
  teamId: number;
  scoringPeriodId: number;
  addPlayerId: number;
  dropPlayerId?: number;
  bid?: number;
}): Record<string, unknown> {
  const items: Record<string, unknown>[] = [
    { playerId: opts.addPlayerId, type: "ADD", toTeamId: opts.teamId },
  ];
  if (opts.dropPlayerId !== undefined) {
    items.push({ playerId: opts.dropPlayerId, type: "DROP", fromTeamId: opts.teamId });
  }
  return {
    isLeagueManager: false,
    teamId: opts.teamId,
    type: opts.type,
    memberId: memberId(),
    scoringPeriodId: opts.scoringPeriodId,
    executionType: "EXECUTE",
    items,
    bidAmount: opts.type === "WAIVER" ? (opts.bid ?? null) : undefined,
  };
}

async function runAddDrop(
  toolName: string,
  args: unknown,
  p: LeagueParams,
  opts: {
    type: "WAIVER" | "FREEAGENT";
    teamId: number;
    addPlayerId: number;
    dropPlayerId?: number;
    bid?: number;
  },
  dryRun: boolean,
): Promise<WriteOutcome<{ transactions: unknown }>> {
  const scoringPeriodId = await currentScoringPeriod(p);
  const body = buildAddDropBody({ ...opts, scoringPeriodId });

  if (dryRun || !writesEnabled()) {
    return {
      dryRun: true,
      wouldSend: redactBody(body),
      blockedReason: !dryRun && !writesEnabled() ? "WRITES_ENABLED is false; treated as dry run." : undefined,
    };
  }

  const result = await postTransaction(p.sport, p.season, p.leagueId, body);
  const { getPending } = await import("./reads.js");
  const settled = await settle(
    async () => {
      const [pending, roster] = await Promise.all([getPending(p), teamRoster(p, opts.teamId)]);
      return { pending, roster };
    },
    (s) => addDropMismatches(opts, s.roster, s.pending),
  );
  const verification = { transactions: settled.state.pending };
  logWrite(toolName, args, body, result, verification);
  return {
    dryRun: false,
    sent: redactBody(body),
    response: redactResult(result),
    verification,
    verifyMismatches: settled.mismatches,
  };
}

export async function waiverClaim(
  p: LeagueParams,
  args: { teamId: number; addPlayerId: number; dropPlayerId?: number; bid?: number },
  dryRun: boolean,
): Promise<WriteOutcome<{ transactions: unknown }>> {
  return runAddDrop(
    "waiver_claim",
    { ...p, ...args, dryRun },
    p,
    { type: "WAIVER", teamId: args.teamId, addPlayerId: args.addPlayerId, dropPlayerId: args.dropPlayerId, bid: args.bid },
    dryRun,
  );
}

// A LOCKED PLAYER CANNOT BE DROPPED. Once a player's game for the current
// scoring period has started, ESPN refuses to release him until the next
// period, and says so only in its own UI. The API answers with an unrelated
// 409 ("TransactionType FREEAGENT may only contain one item for MoveType:
// ADD"), which reads like a malformed body. Refuse first, in plain words. A
// waiver claim is not refused: it resolves later, after the lock clears.
export function lockedDropReason(target: { name?: string; locked?: boolean } | undefined, sport: string): string | undefined {
  if (!target?.locked) return undefined;
  const when = sport === "ffl" ? "after the week ends (Tuesday)" : "from the next scoring period";
  return `${target.name ?? "that player"} is locked: his game this scoring period has started, and ESPN refuses to drop a locked player until the period ends. Drop him ${when}, or put him in a waiver_claim, which processes later.`;
}

export async function addFreeAgent(
  p: LeagueParams,
  args: { teamId: number; addPlayerId: number; dropPlayerId?: number },
  dryRun: boolean,
): Promise<WriteOutcome<{ transactions: unknown }>> {
  if (args.dropPlayerId !== undefined) {
    const dropTarget = (await teamRoster(p, args.teamId)).find((pl) => pl.id === args.dropPlayerId);
    const why = lockedDropReason(dropTarget, p.sport);
    if (why) return { dryRun, blockedReason: why };
  }

  return runAddDrop(
    "add_free_agent",
    { ...p, ...args, dryRun },
    p,
    { type: "FREEAGENT", teamId: args.teamId, addPlayerId: args.addPlayerId, dropPlayerId: args.dropPlayerId },
    dryRun,
  );
}

// ---------------------------------------------------------------------------
// cancel_claim
// ---------------------------------------------------------------------------

export async function cancelClaim(
  p: LeagueParams,
  args: { teamId: number; transactionId: string },
  dryRun: boolean,
): Promise<WriteOutcome<{ pending: unknown }>> {
  const scoringPeriodId = await currentScoringPeriod(p);
  const body: Record<string, unknown> = {
    isLeagueManager: false,
    teamId: args.teamId,
    type: "WAIVER",
    memberId: memberId(),
    scoringPeriodId,
    executionType: "CANCEL",
    relatedTransactionId: args.transactionId,
  };

  if (dryRun || !writesEnabled()) {
    return {
      dryRun: true,
      wouldSend: redactBody(body),
      blockedReason: !dryRun && !writesEnabled() ? "WRITES_ENABLED is false; treated as dry run." : undefined,
    };
  }

  const result = await postTransaction(p.sport, p.season, p.leagueId, body);
  const { getPending } = await import("./reads.js");
  const verification = { pending: await getPending(p) };
  logWrite("cancel_claim", { ...p, ...args }, body, result, verification);
  return { dryRun: false, sent: redactBody(body), response: redactResult(result), verification };
}

// ---------------------------------------------------------------------------
// set_lineup / move_to_ir / activate_from_ir
//
// Payload shape captured live on 2026-09-10 via the browser fetch/XHR
// interceptor (see README "Capturing the lineup-move payload") from a real
// bench<->FLEX swap: type ROSTER, one LINEUP item per player whose slot
// changed, each carrying its OWN prior slot as fromLineupSlotId — a two-way
// swap sends two items, not one.
// ---------------------------------------------------------------------------

export function buildLineupBody(opts: {
  teamId: number;
  scoringPeriodId: number;
  moves: LineupMove[];
  currentSlots: Map<number, number | undefined>;
}): Record<string, unknown> {
  return {
    isLeagueManager: false,
    teamId: opts.teamId,
    type: "ROSTER",
    memberId: memberId(),
    scoringPeriodId: opts.scoringPeriodId,
    executionType: "EXECUTE",
    items: opts.moves.map((m) => ({
      playerId: m.playerId,
      type: "LINEUP",
      fromLineupSlotId: opts.currentSlots.get(m.playerId) ?? -1,
      toLineupSlotId: m.toSlot,
    })),
  };
}

/**
 * The scoring period a lineup is written for. Omitted, it is ESPN's current
 * period. A daily league (basketball, baseball) can pass a later period to set
 * tomorrow's lineup tonight; with only the current period available, every
 * player whose game had already started today read as locked for tomorrow too.
 *
 * Refused: a past period (over and locked), anything after the league's final
 * period, a non-integer, and a league that reports no current period at all
 * (rather than silently assuming period 1).
 */
export function resolveLineupPeriod(
  requested: number | undefined,
  current: number | undefined | null,
  final: number | undefined | null,
  where: string,
): number {
  if (current === undefined || current === null)
    throw new Error(`${where} returned no status.latestScoringPeriod; refusing to build a lineup for an assumed period 1.`);
  if (requested === undefined) return current;
  if (!Number.isInteger(requested)) throw new Error(`scoring_period_id ${requested} is not a whole period.`);
  if (requested < current)
    throw new Error(`scoring_period_id ${requested} is before ESPN's current period ${current}; a past period is locked.`);
  if (final !== undefined && final !== null && requested > final)
    throw new Error(`scoring_period_id ${requested} is after the league's final period ${final}.`);
  return requested;
}

export async function setLineup(
  p: LeagueParams,
  args: { teamId: number; moves: LineupMove[]; scoringPeriodId?: number },
  dryRun: boolean,
): Promise<WriteOutcome<{ roster: unknown }> & { validation: LineupValidationResult }> {
  const league = await getLeague(p);
  const scoringPeriodId = resolveLineupPeriod(
    args.scoringPeriodId,
    league.currentScoringPeriod,
    league.finalScoringPeriod,
    `league ${p.leagueId} (${p.sport} ${p.season})`,
  );
  // ESPN answers mRoster per period, with that period's slots and lock flags.
  // Only ask for a specific period when the caller named one, so the default
  // path sends exactly the read it always did.
  const asOf = args.scoringPeriodId !== undefined ? scoringPeriodId : undefined;
  const roster = await teamRoster(p, args.teamId, asOf);
  const slotCounts = league.rosterSlotCounts ?? {};
  const validation = validateLineupMoves(p.sport, roster, args.moves, slotCounts);
  const currentSlots = new Map(roster.map((pl) => [pl.id, pl.lineupSlotId]));

  if (dryRun || !writesEnabled()) {
    const body = validation.valid
      ? buildLineupBody({ teamId: args.teamId, scoringPeriodId, moves: validation.accepted, currentSlots })
      : undefined;
    return {
      dryRun: true,
      validation,
      wouldSend: body ? redactBody(body) : undefined,
      blockedReason: !dryRun && !writesEnabled() ? "WRITES_ENABLED is false; treated as dry run." : undefined,
    };
  }

  if (!validation.valid) {
    return { dryRun: false, validation, blockedReason: "One or more moves failed validation; nothing was sent." };
  }

  const body = buildLineupBody({ teamId: args.teamId, scoringPeriodId, moves: validation.accepted, currentSlots });

  const result = await postTransaction(p.sport, p.season, p.leagueId, body);
  const settled = await settle(() => teamRoster(p, args.teamId, asOf), (r) => lineupMismatches(r, validation.accepted));
  const verification = { roster: settled.state };
  logWrite("set_lineup", { ...p, ...args }, body, result, verification);
  return {
    dryRun: false,
    validation,
    sent: redactBody(body),
    response: redactResult(result),
    verification,
    verifyMismatches: settled.mismatches,
  };
}

export async function moveToIr(
  p: LeagueParams,
  args: { teamId: number; playerId: number },
  dryRun: boolean,
): Promise<ReturnType<typeof setLineup>> {
  return setLineup(p, { teamId: args.teamId, moves: [{ playerId: args.playerId, toSlot: IR_SLOT_ID[p.sport] }] }, dryRun);
}

export async function activateFromIr(
  p: LeagueParams,
  args: { teamId: number; playerId: number; toSlot: number },
  dryRun: boolean,
): Promise<ReturnType<typeof setLineup>> {
  return setLineup(p, { teamId: args.teamId, moves: [{ playerId: args.playerId, toSlot: args.toSlot }] }, dryRun);
}
