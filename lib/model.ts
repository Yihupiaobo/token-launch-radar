// Peer-Multiple Radar (model v2): one sealed snapshot in, one ranked board out.
//
// Why this model beats a flat TVL multiple: protocols that already trade tell us what the
// market actually pays for a dollar of TVL in each category. A lending market and a DEX do
// not clear at the same price, so a single multiple misprices both. This model therefore
// derives every implied value from the snapshot's own live-token protocols:
//
//   peerMultiple(category) = median(mcap_usd / tvl_usd) over live protocols in the same
//                            category (at least MIN_PEERS of them, else the global median),
//                            clamped to [MULTIPLE_FLOOR, MULTIPLE_CAP]
//   base        = tvl_usd x peerMultiple
//   growthMult  = 1 + clamp(change_7d, -50, 100) / 100 x GROWTH_WEIGHT
//   maturityMult= 0.65 + 0.35 x min(age_days, 1095) / 1095   (unknown age counts as 300d)
//   breadthMult = 1 + 0.03 x min(chains - 1, 4)               (multi-chain reach, max +12%)
//   implied     = max(1, round(base x growthMult x maturityMult x breadthMult))
//
// Every factor is printed on the dashboard for every row, so a reader can recompute any
// implied value by hand from the snapshot. No protocol name is ever special-cased.
//
// The board is the whole pre-token field, not a top-N slice: every watchlist slug, plus
// every other protocol below the watchlist's $50M floor that records no token and is not an
// exchange, an exchange's own product, a versioned pool of another protocol, or a wrapped /
// staked product of a token that already trades. The floor matters: above it, a protocol
// that records no token yet is off the watchlist precisely because it is a bridge, staking
// or wrapped product of something that already trades (WBTC, USDT0 and their kin), so the
// radar never promotes one of those to a launch candidate by ranking it from below.
// Live-token protocols are never ranked; they are listed separately as the peer set.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated on the dashboard so the arithmetic is auditable. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_step: number;
  breadth_max_extra_chains: number;
  multiple_floor: number;
  multiple_cap: number;
  min_peers: number;
  community_share: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.45,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.65,
  maturity_range: 0.35,
  maturity_days: 1095,
  unknown_age_days: 300,
  breadth_step: 0.03,
  breadth_max_extra_chains: 4,
  multiple_floor: 0.04,
  multiple_cap: 1.2,
  min_peers: 3,
  community_share: 0.1,
};

/** The model's version label: the dashboard names it and the board carries it. */
export const MODEL_VERSION = 'peer-multiple-radar-2';

/** How many live-token peer protocols the dashboard's peer table carries, by market cap. */
export const LIVE_ROWS = 36;

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when a date is absent. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_OR_STAKED = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a pre-token protocol below the floor belongs on the radar as an early find:
 * not an exchange or an exchange's own product, not a versioned pool of another protocol,
 * and not a wrapped or staked product of a token that already trades.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    p.category !== 'CEX' &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_OR_STAKED.test(p.name) &&
    !EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))
  );
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One category's peer multiple, and how many live peers priced it. */
export interface PeerMultiple {
  multiple: number;
  peers: number;
  scope: 'category' | 'global';
}

/**
 * The peer multiples the snapshot itself implies: for each category, the median
 * market-cap-to-TVL ratio of its live-token protocols. Categories with fewer than
 * MODEL.min_peers live peers fall back to the global median over every live protocol.
 */
export function peerMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): Map<string, PeerMultiple> {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(ratio);
    byCategory.set(key, list);
  }
  const globalMedian = all.length > 0 ? median(all) : model.multiple_floor;
  const clamp = (n: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, n));
  const out = new Map<string, PeerMultiple>();
  for (const [category, ratios] of byCategory) {
    if (ratios.length >= model.min_peers) {
      out.set(category, { multiple: clamp(median(ratios)), peers: ratios.length, scope: 'category' });
    } else {
      out.set(category, { multiple: clamp(globalMedian), peers: all.length, scope: 'global' });
    }
  }
  out.set('*', { multiple: clamp(globalMedian), peers: all.length, scope: 'global' });
  return out;
}

/** The peer multiple one protocol is priced with. */
export function peerFor(p: SnapshotProtocol, peers: Map<string, PeerMultiple>): PeerMultiple {
  return peers.get(p.category ?? 'Uncategorised') ?? peers.get('*')!;
}

/** The full factor breakdown of one protocol's implied value. */
export interface ValueBreakdown {
  implied: number;
  peerMultiple: number;
  peerCount: number;
  peerScope: 'category' | 'global';
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
  communityPoolUsd: number;
  confidence: 'A' | 'B' | 'C';
}

/**
 * One protocol's implied value and every factor behind it. The community pool is a labelled
 * scenario only: if the protocol one day allocates MODEL.community_share of its implied
 * value to its community, that pool is what early farmers would share between them.
 */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  peers: Map<string, PeerMultiple>,
  model: ModelConstants = MODEL,
): ValueBreakdown {
  const age = ageDays(asOf, protocol.listed_at);
  const peer = peerFor(protocol, peers);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.breadth_max_extra_chains);
  const breadthMult = 1 + model.breadth_step * extraChains;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * peer.multiple * growthMult * maturityMult * breadthMult));
  return {
    implied,
    peerMultiple: peer.multiple,
    peerCount: peer.peers,
    peerScope: peer.scope,
    growthPct,
    growthMult,
    maturityMult,
    breadthMult,
    age,
    communityPoolUsd: Math.round(implied * model.community_share),
    confidence: confidenceOf(protocol, age, peer),
  };
}

/**
 * A confidence grade for the estimate itself, from evidence quality alone: balance-sheet
 * size, a known track record, a peer group that actually priced the category, and a
 * seven-day move that is signal rather than a spike.
 */
export function confidenceOf(p: SnapshotProtocol, age: number | null, peer: PeerMultiple): 'A' | 'B' | 'C' {
  let score = 0;
  if (p.tvl_usd >= 100_000_000) score += 2;
  else if (p.tvl_usd >= 25_000_000) score += 1;
  if (age !== null && age >= 365) score += 2;
  else if (age !== null && age >= 120) score += 1;
  if (peer.scope === 'category' && peer.peers >= 5) score += 1;
  if (p.change_7d !== null && Math.abs(p.change_7d) <= 25) score += 1;
  if (score >= 5) return 'A';
  if (score >= 3) return 'B';
  return 'C';
}

/** One row of board.json: the ranked board's row, with the model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  peer_multiple: number;
  peer_count: number;
  peer_scope: 'category' | 'global';
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  community_pool_usd: number;
  confidence: 'A' | 'B' | 'C';
  farm_steps: string[];
}

/** The dashboard's view of one row: the board row plus nothing it cannot recompute. */
export type RadarRow = BoardRow;

/** A live-token protocol: it already trades, so it is a pricing peer, never a ranked row. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number | null;
}

/** Everything the dashboard needs: the board, the peer set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_tvl_usd: number;
  total_implied_usd: number;
  total_community_pool_usd: number;
  categories: string[];
  chains: string[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, scaled to the protocol's own size. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 300;
  if (p.tvl_usd >= 250_000_000) return 200;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core farming action, in words a farmer can follow on day one. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of USDC as collateral in ${name} on ${chain}, then borrow no more than 40% against it so the health factor stays safely above liquidation`;
  if (c.includes('dex') || c.includes('liquidity'))
    return `Add $${capital} of two-sided liquidity to ${name}'s highest-volume pool on ${chain}, split evenly between the pair's two assets`;
  if (c.includes('bridge') || c.includes('chain'))
    return `Bridge $${capital} of USDC from Ethereum to ${chain} through ${name}, then make one real transfer or swap on the far side so both legs count as activity`;
  if (c.includes('staking') || c.includes('restak'))
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the liquid receipt token in the same wallet`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position, half long and half short, so the volume counts without directional risk`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield'))
    return `Deposit $${capital} into the largest ${name} vault on ${chain} and keep the vault shares untouched in the farming wallet`;
  if (c.includes('rwa'))
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} with USDC and hold it; real-world-asset vaults usually credit holders, not traders`;
  if (c.includes('basis'))
    return `Open a $${capital} delta-neutral basis position through ${name} on ${chain}: long the spot asset, short the same size on its perpetual market`;
  if (c.includes('prediction'))
    return `Fund $${capital} on ${name} and take one position in its most liquid market on ${chain}, sized so a total loss stays affordable`;
  if (c.includes('insurance'))
    return `Buy $${capital} of protocol cover from ${name} on ${chain} for the longest term offered and keep the policy NFT in the wallet`;
  return `Deposit $${capital} of USDC into ${name}'s main product on ${chain} and keep the position open and untouched`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page weekly.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, derived from
 * the protocol's own record (category, chains, TVL, age) and never from a list of names.
 * The plan ends with the discipline that actually protects a farmer: verify before claiming,
 * and keep a log that makes the position repeatable or unwindable.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 300 ? 10 : capital >= 100 ? 6 : 3;
  const steps: Array<[string, string, string]> = [
    [
      `Set up one fresh wallet for ${p.name} alone, fund it from your main wallet, and store its seed phrase offline; one wallet per protocol keeps points and snapshots attributable`,
      'under $3 of gas for the funding transfer',
      '10 minutes',
    ],
    [
      actionFor(p, capital, chain),
      `$${capital} of capital plus about $${gas} of gas`,
      '20 minutes to set up',
    ],
    [
      `Repeat one qualifying action every week on the same weekday: a deposit top-up, a borrow-and-repay cycle, a swap or a vote inside ${p.name}, so the wallet shows a streak rather than a single visit`,
      'about $2 of gas a week',
      '10 minutes a week',
    ],
    [
      `Hold the core position for at least ${hold} days without withdrawing below half, so the wallet appears in more than one weekly balance snapshot`,
      `the $${capital} stays deployed for the full ${hold} days`,
      `${hold} days`,
    ],
    [
      `Once a month, open ${p.name}'s own points, rewards or governance page from inside its app and record the balance it shows for your wallet; never follow a claim link from social media or a search ad`,
      'no fee to check, and never pay anyone to claim for you',
      '10 minutes a month',
    ],
    [
      `Keep a farm log for ${p.name}: wallet address, every transaction hash, dates, amounts and the running gas total, so the position can be repeated, proved or unwound without guesswork`,
      'nothing but the log itself',
      '5 minutes after each action',
    ],
    [
      `Exit in stages when a token or points conversion is announced: claim only through the protocol's own app, sell no more than a third in the first week, and move the rest back to your main wallet`,
      'normal withdrawal gas, about $5 at most chains\' typical fees',
      '30 minutes at claim time',
    ],
  ];
  return steps.map(([text, cost, time]) => stepText(text, cost, time));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const peers = peerMultiples(snapshot, model);
  const watchlist = new Set(snapshot.watchlist);
  // The watchlist is the floor: every slug on it, whatever its size. Below the floor, the
  // early radar adds every rankable pre-token protocol; above the floor, a pre-token
  // protocol the watchlist left out stays out, for the reasons the header gives.
  const chosen = snapshot.protocols.filter(
    (p) => watchlist.has(p.slug) || (p.tvl_usd < snapshot.floor_usd && isRankable(p)),
  );
  const scored = chosen.map((p) => ({ p, value: impliedValue(p, snapshot.as_of, peers, model) }));
  scored.sort(
    (a, b) => b.value.implied - a.value.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    on_watchlist: watchlist.has(s.p.slug),
    age_days: s.value.age,
    implied_value_usd: s.value.implied,
    peer_multiple: round4(s.value.peerMultiple),
    peer_count: s.value.peerCount,
    peer_scope: s.value.peerScope,
    growth_multiplier: round4(s.value.growthMult),
    maturity_multiplier: round4(s.value.maturityMult),
    breadth_multiplier: round4(s.value.breadthMult),
    community_pool_usd: s.value.communityPoolUsd,
    confidence: s.value.confidence,
    farm_steps: farmSteps(s.p, s.value.age),
  }));
}

/** The live-token protocols, by market cap: the peer set that priced the board. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    total_tvl_usd: board.reduce((sum, r) => sum + r.tvl_usd, 0),
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    total_community_pool_usd: board.reduce((sum, r) => sum + r.community_pool_usd, 0),
    categories: [...new Set(board.map((r) => r.category ?? 'Uncategorised'))].sort(),
    chains: [...new Set(board.flatMap((r) => r.chains))].sort(),
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
