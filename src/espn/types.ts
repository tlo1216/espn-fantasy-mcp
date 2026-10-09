/** Minimal shapes for the ESPN v3 fantasy JSON fields this server actually reads. */

export interface EspnStat {
  statSourceId: number; // 1 = projection, 0 = actual
  scoringPeriodId: number; // 0 = season total, N = period N
  seasonId: number;
  appliedTotal?: number;
}

export interface EspnPlayer {
  id: number;
  fullName: string;
  defaultPositionId: number;
  proTeamId: number;
  eligibleSlots: number[];
  injuryStatus?: string;
  injured?: boolean;
  stats?: EspnStat[];
  ownership?: { percentOwned?: number };
}

export interface EspnPlayerPoolEntry {
  player: EspnPlayer;
  onTeamId?: number;
  lineupLocked?: boolean;
  rosterLocked?: boolean;
  tradeLocked?: boolean;
  status?: string; // e.g. WAIVERS, FREEAGENT, ONTEAM
}

export interface EspnRosterEntry {
  playerId: number;
  lineupSlotId: number;
  acquisitionType?: string;
  playerPoolEntry: EspnPlayerPoolEntry;
}

export interface EspnTeamRoster {
  entries: EspnRosterEntry[];
}

export interface EspnTeam {
  id: number;
  abbrev?: string;
  location?: string;
  nickname?: string;
  name?: string;
  owners?: string[];
  waiverRank?: number;
  record?: {
    overall?: { wins: number; losses: number; ties: number };
  };
  roster?: EspnTeamRoster;
}

export interface EspnRosterSettings {
  lineupSlotCounts: Record<string, number>; // slotId (as string) -> count
}

export interface EspnAcquisitionSettings {
  acquisitionType: string;
  waiverOrderReset: boolean;
  waiverHours: number;
  waiverProcessDays?: string[];
  waiverProcessHour?: number;
  acquisitionLimit?: number;
}

export interface EspnScheduleSettings {
  playoffTeamCount: number;
  matchupPeriodCount?: number;
}

export interface EspnTradeSettings {
  deadlineDate: number;
  vetoVotesRequired: number;
}

export interface EspnDraftSettings {
  keeperCount?: number;
}

export interface EspnSettings {
  name?: string;
  rosterSettings: EspnRosterSettings;
  acquisitionSettings: EspnAcquisitionSettings;
  scheduleSettings: EspnScheduleSettings;
  tradeSettings: EspnTradeSettings;
  draftSettings: EspnDraftSettings;
  scoringSettings?: { scoringItems?: Array<{ statId: number; points?: number }> };
}

export interface EspnStatus {
  currentMatchupPeriod: number;
  latestScoringPeriod: number;
  finalScoringPeriod?: number;
}

export interface EspnLeagueResponse {
  id: number;
  seasonId: number;
  teams?: EspnTeam[];
  settings?: EspnSettings;
  status?: EspnStatus;
}

export interface EspnPendingTransactionItem {
  playerId: number;
  type: string; // ADD, DROP, LINEUP, ...
  fromTeamId?: number;
  toTeamId?: number;
}

export interface EspnPendingTransaction {
  id: string;
  teamId: number;
  type: string; // WAIVER, TRADE_PROPOSAL, ...
  status: string;
  scoringPeriodId?: number;
  bidAmount?: number | null;
  items: EspnPendingTransactionItem[];
}

export interface EspnTransaction {
  id: string;
  teamId?: number;
  type: string;
  status: string;
  scoringPeriodId?: number;
  proposedDate?: number;
  items: EspnPendingTransactionItem[];
}

export interface EspnMatchupTeamEntry {
  teamId: number;
  totalPoints?: number;
  totalPointsLive?: number;
  totalProjectedPoints?: number;
  totalProjectedPointsLive?: number;
  winProbability?: number;
}

export interface EspnMatchup {
  matchupPeriodId: number;
  home: EspnMatchupTeamEntry;
  away?: EspnMatchupTeamEntry;
  winner?: string;
}

export interface EspnBoxscorePlayer {
  playerId: number;
  lineupSlotId: number;
  playerPoolEntry: EspnPlayerPoolEntry;
}

export interface EspnBoxscoreTeam {
  teamId: number;
  rosterForCurrentScoringPeriod?: { entries: EspnBoxscorePlayer[] };
}

export interface EspnBoxscore {
  matchupPeriodId: number;
  home: EspnBoxscoreTeam;
  away?: EspnBoxscoreTeam;
}
