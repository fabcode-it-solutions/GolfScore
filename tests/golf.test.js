import { describe, it, expect } from 'vitest';
import Golf from '../assets/golf.js';
describe('allocateStrokes', () => {
  it('gives one stroke to the hardest N holes for a standard handicap', () => {
    const strokes = Golf.allocateStrokes(10, 18);
    expect(strokes).toHaveLength(18);
    expect(strokes.slice(0, 10)).toEqual(new Array(10).fill(1));
    expect(strokes.slice(10)).toEqual(new Array(8).fill(0));
    expect(strokes.reduce((a, b) => a + b, 0)).toBe(10);
  });

  describe('toRelativeStrokeIndex', () => {
  it('re-ranks a 9-hole subset of an 18-hole stroke index to 1-9', () => {
    const backNine = [2, 14, 6, 18, 4, 16, 8, 12, 10];
    expect(Golf.toRelativeStrokeIndex(backNine)).toEqual([1, 7, 3, 9, 2, 8, 4, 6, 5]);
  });

  it('leaves an already-dense 1-9 ranking unchanged', () => {
    expect(Golf.toRelativeStrokeIndex([3, 1, 2, 5, 4, 9, 7, 8, 6])).toEqual([3, 1, 2, 5, 4, 9, 7, 8, 6]);
  });
});

  it('gives a second stroke on the hardest holes once handicap exceeds hole count', () => {
    const strokes = Golf.allocateStrokes(20, 18);
    expect(strokes[0]).toBe(2);
    expect(strokes[1]).toBe(2);
    expect(strokes.slice(2)).toEqual(new Array(16).fill(1));
    expect(strokes.reduce((a, b) => a + b, 0)).toBe(20);
  });

  it('respects a custom stroke index instead of hole order', () => {
    const strokeIndex = [3, 2, 1]; // hole 3 is hardest, hole 1 is easiest
    const strokes = Golf.allocateStrokes(1, 3, strokeIndex);
    expect(strokes).toEqual([0, 0, 1]);
  });
});

describe('netHoleScore', () => {
  it('returns null when no score has been entered', () => {
    expect(Golf.netHoleScore(null, 1)).toBeNull();
  });

  it('subtracts strokes received from the gross score', () => {
    expect(Golf.netHoleScore(5, 1)).toBe(4);
    expect(Golf.netHoleScore(4, 0)).toBe(4);
    expect(Golf.netHoleScore(6, 2)).toBe(4);
  });
});

describe('stablefordPoints', () => {
  it('returns null when there is no net score yet', () => {
    expect(Golf.stablefordPoints(null, 4)).toBeNull();
  });

  it('scores common results on the standard points scale', () => {
    const par = 4;
    expect(Golf.stablefordPoints(par - 3, par)).toBe(6); // albatross+
    expect(Golf.stablefordPoints(par - 2, par)).toBe(5); // eagle
    expect(Golf.stablefordPoints(par - 1, par)).toBe(4); // birdie
    expect(Golf.stablefordPoints(par, par)).toBe(3);     // par
    expect(Golf.stablefordPoints(par + 1, par)).toBe(2); // bogey
    expect(Golf.stablefordPoints(par + 2, par)).toBe(1); // double bogey
    expect(Golf.stablefordPoints(par + 3, par)).toBe(0); // triple+
  });
});

describe('summarizePlayer', () => {
  it('totals gross, net, and Stableford correctly for a 9-hole sample round', () => {
    const player = { id: 'p1', name: 'Hunter', handicap: 5 };
    const pars = [4, 4, 3, 5, 4, 4, 3, 5, 4];
    // handicap 5, default stroke index: holes 1-5 get a stroke, 6-9 don't
    const scores = { 1: 5, 2: 4, 3: 4, 4: 7, 5: 5, 6: 5, 7: 3, 8: 6, 9: 5 };

    const summary = Golf.summarizePlayer(player, scores, pars, null, 9);

    expect(summary.thru).toBe(9);
    expect(summary.grossTotal).toBe(44);
    expect(summary.netTotal).toBe(39);
    expect(summary.stablefordTotal).toBe(24);
    expect(summary.toParGross).toBe(8);
    expect(summary.toParNet).toBe(3);
  });

  it('only counts holes that have actually been played', () => {
    const player = { id: 'p2', name: 'Partial', handicap: 0 };
    const pars = [4, 4, 4];
    const scores = { 1: 4 }; // holes 2 and 3 not entered yet
    const summary = Golf.summarizePlayer(player, scores, pars, null, 3);

    expect(summary.thru).toBe(1);
    expect(summary.grossTotal).toBe(4);
    expect(summary.parPlayedTotal).toBe(4);
  });
});

describe('rankPlayers', () => {
  const summaries = [
    { playerId: 'a', name: 'Alice', thru: 9, toParGross: 2, toParNet: -1, stablefordTotal: 30 },
    { playerId: 'b', name: 'Bob', thru: 9, toParGross: -3, toParNet: 1, stablefordTotal: 25 },
    { playerId: 'c', name: 'Cara', thru: 0, toParGross: 0, toParNet: 0, stablefordTotal: 0 },
  ];

  it('ranks gross mode lowest-to-par first, with non-starters last', () => {
    const ranked = Golf.rankPlayers(summaries, 'gross');
    expect(ranked.map(r => r.playerId)).toEqual(['b', 'a', 'c']);
    expect(ranked[0].rank).toBe(1);
    expect(ranked.find(r => r.playerId === 'c').rank).toBeNull();
  });

  it('ranks net mode by net-to-par', () => {
    const ranked = Golf.rankPlayers(summaries, 'net');
    expect(ranked.map(r => r.playerId)).toEqual(['a', 'b', 'c']);
  });

  it('ranks Stableford mode highest points first', () => {
    const ranked = Golf.rankPlayers(summaries, 'stableford');
    expect(ranked.map(r => r.playerId)).toEqual(['a', 'b', 'c']);
  });

  it('gives tied players the same rank', () => {
    const tied = [
      { playerId: 'x', name: 'X', thru: 9, toParGross: 0, toParNet: 0, stablefordTotal: 20 },
      { playerId: 'y', name: 'Y', thru: 9, toParGross: 0, toParNet: 0, stablefordTotal: 20 },
      { playerId: 'z', name: 'Z', thru: 9, toParGross: 1, toParNet: 1, stablefordTotal: 18 },
    ];
    const ranked = Golf.rankPlayers(tied, 'gross');
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(1);
    expect(ranked[2].rank).toBe(3);
  });
});

describe('computeSkins', () => {
  it('awards the pot to the lowest net score, carrying ties to the next hole', () => {
    const pars = [4, 4, 4];
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 5, 3: 3 }, pars, null, 3);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 5, 2: 5, 3: 4 }, pars, null, 3);

    const { skinsByPlayer, log, carry } = Golf.computeSkins([a, b], 3);

    // Hole 1: Alice wins (1). Hole 2: tied, skin carries. Hole 3: Alice
    // wins the carried pot (1 + 1 = 2), ending with 3 total.
    expect(skinsByPlayer.a).toBe(3);
    expect(skinsByPlayer.b).toBe(0);
    expect(log[1].winnerId).toBeNull(); // hole 2 tied, pot carried
    expect(log[2].value).toBe(2);       // hole 3 paid out the carried pot
    expect(carry).toBe(0);
  });
  it('marks a hole pending when not everyone has entered a score yet', () => {
    const pars = [4, 4];
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 5 }, pars, null, 2);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 4 }, pars, null, 2);

    const { skinsByPlayer, log } = Golf.computeSkins([a, b], 2);

    expect(log[0].pending).toBe(false); // hole 1: both in, tied
    expect(log[1].pending).toBe(true);  // hole 2: still waiting on Bob
    expect(skinsByPlayer.a).toBe(0);
    expect(skinsByPlayer.b).toBe(0);
  });

  it('accumulates a multi-hole carry and pays the full pot to the next winner', () => {
    const pars = [4, 4, 4, 4];
    // Holes 1 and 2 tie; hole 3 Alice wins outright and takes 1+1+1 = 3.
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 4, 3: 3, 4: 5 }, pars, null, 4);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 4, 2: 4, 3: 4, 4: 4 }, pars, null, 4);

    const { skinsByPlayer, log, carry } = Golf.computeSkins([a, b], 4);

    expect(log[2].value).toBe(3);    // hole 3 pays the two carried skins plus its own
    expect(skinsByPlayer.a).toBe(3); // hole 4 goes to Bob
    expect(skinsByPlayer.b).toBe(1);
    expect(carry).toBe(0);
  });

  it('reports skins left in the pot when the final hole is tied', () => {
    const pars = [4, 4];
    // Both holes tie, so the pot ends unclaimed.
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 4 }, pars, null, 2);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 4, 2: 4 }, pars, null, 2);

    const { skinsByPlayer, carry } = Golf.computeSkins([a, b], 2);

    expect(skinsByPlayer.a).toBe(0);
    expect(skinsByPlayer.b).toBe(0);
    expect(carry).toBe(2); // both holes rolled forward with no winner
  });
});

describe('computeMatchPlay', () => {
  it('declares the match decided early once it is out of reach', () => {
    const pars = [4, 4, 4, 4];
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 3, 2: 3, 3: 3 }, pars, null, 4);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 5, 2: 5, 3: 5 }, pars, null, 4);

    const result = Golf.computeMatchPlay(a, b, 4);

    expect(result.decided).toBe(true);
    expect(result.winner).toBe('A');
    expect(result.thru).toBe(3);
    expect(result.margin).toBe(3);
    expect(result.remaining).toBe(1); // "3 and 1" in golf terms
  });

  it('reports an undecided, all-square match when every hole is halved', () => {
    const pars = [4, 4];
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 4 }, pars, null, 2);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 4, 2: 4 }, pars, null, 2);

    const result = Golf.computeMatchPlay(a, b, 2);

    expect(result.decided).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.diff).toBe(0);
  });
});

describe('computeMatchPlay — teams and best ball', () => {
  const pars = [4, 4, 4, 4];

  it('uses best-ball net score per hole for a 2v2 match', () => {
    const alice = Golf.summarizePlayer({ id: 'alice', name: 'Alice', handicap: 0 }, { 1: 3, 2: 3, 3: 5, 4: 5 }, pars, null, 4);
    const andy = Golf.summarizePlayer({ id: 'andy', name: 'Andy', handicap: 0 }, { 1: 5, 2: 5, 3: 3, 4: 3 }, pars, null, 4);
    const beth = Golf.summarizePlayer({ id: 'beth', name: 'Beth', handicap: 0 }, { 1: 4, 2: 4, 3: 4, 4: 4 }, pars, null, 4);
    const bob = Golf.summarizePlayer({ id: 'bob', name: 'Bob', handicap: 0 }, { 1: 4, 2: 4, 3: 4, 4: 4 }, pars, null, 4);

    // Team A's best ball is a 3 every hole (someone always beats par);
    // Team B is always 4. Team A should win comfortably.
    const result = Golf.computeMatchPlay([alice, andy], [beth, bob], 4);

    expect(result.thru).toBe(3);
    expect(result.decided).toBe(true);
    expect(result.winner).toBe('A');
    expect(result.margin).toBe(3);
    expect(result.remaining).toBe(1); // "3 and 1"
  });

  it('supports a 1v2 match (one player against a two-player team)', () => {
    const carl = Golf.summarizePlayer({ id: 'carl', name: 'Carl', handicap: 0 }, { 1: 4, 2: 4, 3: 4, 4: 4 }, pars, null, 4);
    const dana = Golf.summarizePlayer({ id: 'dana', name: 'Dana', handicap: 0 }, { 1: 5, 2: 5, 3: 5, 4: 5 }, pars, null, 4);
    const eli = Golf.summarizePlayer({ id: 'eli', name: 'Eli', handicap: 0 }, { 1: 5, 2: 3, 3: 5, 4: 5 }, pars, null, 4);

    const result = Golf.computeMatchPlay([carl], [dana, eli], 4);

    expect(result.thru).toBe(4);
    expect(result.diff).toBe(2); // Carl wins holes 1,3,4; the team wins hole 2 via Eli's birdie
    expect(result.winner).toBe('A');
  });

  it('compares gross instead of net when useHandicap is false', () => {
    const big = Golf.summarizePlayer({ id: 'big', name: 'Big', handicap: 10 }, { 1: 6 }, [4], [1], 1);
    const small = Golf.summarizePlayer({ id: 'small', name: 'Small', handicap: 0 }, { 1: 5 }, [4], [1], 1);

    const netResult = Golf.computeMatchPlay([big], [small], 1, true);
    expect(netResult.log[0].result).toBe('A'); // Big's handicap strokes bring his net to 4, beating Small's net of 5

    const grossResult = Golf.computeMatchPlay([big], [small], 1, false);
    expect(grossResult.log[0].result).toBe('B'); // On raw strokes, Small's 5 beats Big's 6
  });
});

// Nassau's three sub-competitions are scored over hole windows.
describe('computeMatchPlayRange / computeStrokeRange', () => {
  const pars = Array(18).fill(4);
  // A wins the front (holes 1-2), B wins the back (holes 10-11), rest halved.
  const aScores = { 1: 3, 2: 3, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 4, 11: 4, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4 };
  const bScores = { 1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 3, 11: 3, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4 };
  const A = Golf.summarizePlayer({ id: 'a', name: 'A', handicap: 0 }, aScores, pars, null, 18);
  const B = Golf.summarizePlayer({ id: 'b', name: 'B', handicap: 0 }, bScores, pars, null, 18);

  it('scores the front nine, back nine, and full 18 as separate matches', () => {
    const front = Golf.computeMatchPlayRange([A], [B], 1, 9);
    expect(front.winner).toBe('A');
    expect(front.margin).toBe(2);
    expect(front.thru).toBe(8); // 2 up with 1 to play → clinched "2 and 1" at hole 8
    expect(front.decided).toBe(true);
    expect(front.remaining).toBe(1);

    const back = Golf.computeMatchPlayRange([A], [B], 10, 18);
    expect(back.winner).toBe('B');
    expect(back.margin).toBe(2);

    const total = Golf.computeMatchPlayRange([A], [B], 1, 18);
    expect(total.winner).toBe(null); // 2 up front, 2 down back → all square
    expect(total.diff).toBe(0);
    expect(total.thru).toBe(18);
  });

  it('reports "remaining" relative to the segment (early-decided within a nine)', () => {
    const runaway = Golf.summarizePlayer({ id: 'c', name: 'C', handicap: 0 }, { 1: 3, 2: 3, 3: 3, 4: 3, 5: 3 }, pars, null, 18);
    const seg = Golf.computeMatchPlayRange([runaway], [B], 1, 9);
    expect(seg.decided).toBe(true);
    expect(seg.margin).toBe(5);
    expect(seg.remaining).toBe(4); // "5 and 4" within the front nine
    expect(seg.thru).toBe(5);
  });

  it('computeMatchPlay is the full-round window', () => {
    const viaRange = Golf.computeMatchPlayRange([A], [B], 1, 18);
    const viaFull = Golf.computeMatchPlay([A], [B], 18);
    expect(viaFull).toEqual(viaRange);
  });

  it('sums best-ball stroke totals per window, lower total leading', () => {
    const front = Golf.computeStrokeRange([A], [B], 1, 9);
    expect(front.teamATotal).toBe(34); // 3+3+4*7
    expect(front.teamBTotal).toBe(36);
    expect(front.leader).toBe('A');
    expect(front.diff).toBe(2);

    const back = Golf.computeStrokeRange([A], [B], 10, 18);
    expect(back.leader).toBe('B');
    expect(back.diff).toBe(2);

    const total = Golf.computeStrokeRange([A], [B], 1, 18);
    expect(total.teamATotal).toBe(70);
    expect(total.teamBTotal).toBe(70);
    expect(total.leader).toBe(null);
  });

  it('stops at the first hole a side has not completed', () => {
    const partial = Golf.summarizePlayer({ id: 'd', name: 'D', handicap: 0 }, { 1: 4, 2: 4 }, pars, null, 18);
    const seg = Golf.computeStrokeRange([A], [partial], 1, 9);
    expect(seg.thru).toBe(2);
    const backSeg = Golf.computeMatchPlayRange([A], [partial], 10, 18);
    expect(backSeg.thru).toBe(0); // nobody has a back-nine score
  });
});

describe('sixesSegments', () => {
  it('rotates all four partnerships across three 6-hole windows', () => {
    const segs = Golf.sixesSegments();
    expect(segs.map(s => [s.from, s.to])).toEqual([[1, 6], [7, 12], [13, 18]]);
    expect(segs.map(s => [s.teamX, s.teamY])).toEqual([
      [[0, 1], [2, 3]],
      [[0, 2], [1, 3]],
      [[0, 3], [1, 2]],
    ]);
    // Every player (seat) partners each of the other three exactly once.
    const partners = { 0: new Set(), 1: new Set(), 2: new Set(), 3: new Set() };
    segs.forEach(({ teamX, teamY }) => {
      [teamX, teamY].forEach(([a, b]) => { partners[a].add(b); partners[b].add(a); });
    });
    expect(partners[0]).toEqual(new Set([1, 2, 3]));
    expect(partners[1]).toEqual(new Set([0, 2, 3]));
    expect(partners[2]).toEqual(new Set([0, 1, 3]));
    expect(partners[3]).toEqual(new Set([0, 1, 2]));
  });
});

describe('matchRunning', () => {
  it('accumulates the running differential after each hole', () => {
    const log = [
      { hole: 1, result: 'A' },
      { hole: 2, result: 'A' },
      { hole: 3, result: 'halved' },
      { hole: 4, result: 'B' },
    ];
    expect(Golf.matchRunning(log)).toEqual([
      { hole: 1, cum: 1 }, // A 1up
      { hole: 2, cum: 2 }, // A 2up
      { hole: 3, cum: 2 }, // halved — no change
      { hole: 4, cum: 1 }, // A back to 1up
    ]);
  });

  it('goes negative when Team B is ahead and returns to square', () => {
    const log = [
      { hole: 1, result: 'B' },
      { hole: 2, result: 'B' },
      { hole: 3, result: 'A' },
      { hole: 4, result: 'A' },
    ];
    expect(Golf.matchRunning(log).map(e => e.cum)).toEqual([-1, -2, -1, 0]);
  });

  it('returns an empty array for an empty or missing log', () => {
    expect(Golf.matchRunning([])).toEqual([]);
    expect(Golf.matchRunning(undefined)).toEqual([]);
  });
});

describe('formatToPar', () => {
  it('formats even, over, and under par correctly', () => {
    expect(Golf.formatToPar(0)).toBe('E');
    expect(Golf.formatToPar(3)).toBe('+3');
    expect(Golf.formatToPar(-2)).toBe('-2');
  });
});

describe('findMissingScores', () => {
  it('returns an empty array when everyone has a score for every hole', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4, 2: 5, 3: 3 } },
      { name: 'Bob', scores: { 1: 5, 2: 4, 3: 4 } },
    ];
    expect(Golf.findMissingScores(players, 3)).toEqual([]);
  });

  it('lists the specific holes a player is missing', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4, 2: 5, 3: 3 } },
      { name: 'Bob', scores: { 1: 5 } }, // missing holes 2 and 3
    ];
    const missing = Golf.findMissingScores(players, 3);
    expect(missing).toEqual([{ name: 'Bob', missingHoles: [2, 3] }]);
  });

  it('reports every incomplete player, not just the first one found', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4 } },        // missing hole 2
      { name: 'Bob', scores: { 1: 5 } },          // missing hole 2
      { name: 'Cara', scores: { 1: 4, 2: 4 } },   // complete
    ];
    const missing = Golf.findMissingScores(players, 2);
    expect(missing.map(m => m.name)).toEqual(['Alice', 'Bob']);
  });

  it('treats a player with no scores object at all as fully missing', () => {
    const players = [{ name: 'NewGuy' }];
    const missing = Golf.findMissingScores(players, 2);
    expect(missing).toEqual([{ name: 'NewGuy', missingHoles: [1, 2] }]);
  });
});

describe('groupThru', () => {
  it('returns the highest hole every player has completed', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4, 2: 5, 3: 3 } },
      { name: 'Bob', scores: { 1: 5, 2: 4, 3: 4 } },
    ];
    expect(Golf.groupThru(players, 18)).toBe(3);
  });

  it('is limited by the player who has completed the fewest holes', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4, 2: 5, 3: 3 } },
      { name: 'Bob', scores: { 1: 5, 2: 4 } }, // only thru 2
    ];
    expect(Golf.groupThru(players, 18)).toBe(2);
  });

  it('stops at the first hole not everyone has, even if a later hole is filled', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4, 2: 5, 3: 3 } },
      { name: 'Bob', scores: { 1: 5, 3: 4 } }, // missing hole 2
    ];
    expect(Golf.groupThru(players, 18)).toBe(1);
  });

  it('returns 0 when nobody has completed hole 1 for everyone', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4 } },
      { name: 'Bob', scores: {} },
    ];
    expect(Golf.groupThru(players, 18)).toBe(0);
  });

  it('returns 0 for an empty player list', () => {
    expect(Golf.groupThru([], 18)).toBe(0);
  });
});

describe('computeMoney', () => {
  const pars = [4, 4, 4];
  const player = (id, scores, handicap = 0) =>
    Golf.summarizePlayer({ id, name: id, handicap }, scores, pars, null, 3);

  it('gross ante pot: winner takes all, everyone else is down their ante', () => {
    const a = player('a', { 1: 4, 2: 4, 3: 4 });
    const b = player('b', { 1: 5, 2: 5, 3: 5 });
    const { byMode, byPlayer } = Golf.computeMoney([a, b], {
      modes: ['gross'], stakes: { gross: 5 }, holeCount: 3,
    });
    expect(byMode.gross.a).toBe(5);
    expect(byMode.gross.b).toBe(-5);
    expect(byPlayer.a + byPlayer.b).toBe(0);
  });

  it('splits the pot among tied winners', () => {
    const a = player('a', { 1: 4, 2: 4, 3: 4 });
    const b = player('b', { 1: 4, 2: 4, 3: 4 });
    const c = player('c', { 1: 5, 2: 5, 3: 5 });
    const { byPlayer } = Golf.computeMoney([a, b, c], {
      modes: ['gross'], stakes: { gross: 10 }, holeCount: 3,
    });
    expect(byPlayer.a).toBe(5);  // pot 30 / 2 winners = 15, minus 10 ante
    expect(byPlayer.b).toBe(5);
    expect(byPlayer.c).toBe(-10);
  });

  it('skins: every other player pays the winner per skin, zero-sum', () => {
    const a = player('a', { 1: 4, 2: 5, 3: 3 }); // wins hole 1, then the carried pot on 3
    const b = player('b', { 1: 5, 2: 5, 3: 4 });
    const { byPlayer } = Golf.computeMoney([a, b], {
      modes: ['skins'], stakes: { skins: 2 }, holeCount: 3,
    });
    expect(byPlayer.a).toBe(6);  // 3 skins × $2 from Bob
    expect(byPlayer.b).toBe(-6);
  });

  it('match play: losing side pays the team pot', () => {
    const a = player('a', { 1: 3, 2: 3, 3: 3 });
    const b = player('b', { 1: 5, 2: 5, 3: 5 });
    const { byPlayer } = Golf.computeMoney([a, b], {
      modes: ['match'], stakes: { match: 20 }, holeCount: 3,
      matchTeamA: ['a'], matchTeamB: ['b'],
    });
    expect(byPlayer.a).toBe(20);
    expect(byPlayer.b).toBe(-20);
  });

  it('sums multiple bets and returns a balanced settle-up', () => {
    const a = player('a', { 1: 4, 2: 4, 3: 4 });
    const b = player('b', { 1: 5, 2: 5, 3: 5 });
    const { byPlayer, transactions } = Golf.computeMoney([a, b], {
      modes: ['gross', 'skins'], stakes: { gross: 5, skins: 2 }, holeCount: 3,
    });
    expect(byPlayer.a).toBe(11); // +5 gross, +6 skins
    expect(byPlayer.b).toBe(-11);
    expect(transactions).toEqual([{ from: 'b', to: 'a', amount: 11 }]);
  });

  it('moves no money for a mode with no stake set', () => {
    const a = player('a', { 1: 4, 2: 4, 3: 4 });
    const b = player('b', { 1: 5, 2: 5, 3: 5 });
    const { byMode, byPlayer } = Golf.computeMoney([a, b], {
      modes: ['gross'], stakes: {}, holeCount: 3,
    });
    expect(byMode.gross).toBeUndefined();
    expect(byPlayer.a).toBe(0);
    expect(byPlayer.b).toBe(0);
  });
});

describe('computeMoney — Side Match / Nassau / Sixes', () => {
  const pars18 = Array(18).fill(4);
  const p = (id, scores, hcp = 0) => Golf.summarizePlayer({ id, name: id, handicap: hcp }, scores, pars18, null, 18);
  const flat = v => { const o = {}; for (let h = 1; h <= 18; h++) o[h] = v; return o; };

  it('side match: losing side pays the stake (Team C vs Team D)', () => {
    const c = p('c', flat(4)); const d = p('d', flat(5));
    const { byPlayer } = Golf.computeMoney([c, d], {
      modes: ['sidematch'], stakes: { sidematch: 10 }, holeCount: 18,
      sidematchTeamC: ['c'], sidematchTeamD: ['d'], sidematchUseHandicap: false,
    });
    expect(byPlayer.c).toBe(10);
    expect(byPlayer.d).toBe(-10);
  });

  it('nassau (legacy single stake): A wins front & total, back halved pays nothing', () => {
    const a = flat(4), b = flat(4);
    a[1] = 3; a[2] = 3; // A wins the front (and thus the total); back all square
    const A = p('a', a), B = p('b', b);
    const { byMode, byPlayer } = Golf.computeMoney([A, B], {
      modes: ['nassau'], stakes: { nassau: 5 }, holeCount: 18,
      matchTeamA: ['a'], matchTeamB: ['b'], matchUseHandicap: false, nassauFormat: 'match',
    });
    // Legacy number applies the same stake to all three segments.
    expect(byPlayer.a).toBe(10); // front + total; back halved
    expect(byPlayer.b).toBe(-10);
    expect(byMode.nassau.a).toBe(10);
  });

  it('nassau (two stakes): nines rides on front & back, total rides once', () => {
    const a = flat(4), b = flat(4);
    a[1] = 3; a[2] = 3;    // A wins the front nine
    b[10] = 3; b[11] = 3;  // B wins the back nine → total is all square
    const A = p('a', a), B = p('b', b);
    const { byMode, byPlayer } = Golf.computeMoney([A, B], {
      modes: ['nassau'], stakes: { nassau: { nines: 5, total: 10 } }, holeCount: 18,
      matchTeamA: ['a'], matchTeamB: ['b'], matchUseHandicap: false, nassauFormat: 'match',
    });
    // A +5 (won front nine), -5 (lost back nine), total halved → net 0.
    expect(byPlayer.a).toBe(0);
    expect(byPlayer.b).toBe(0);
    expect(byMode.nassau).toBeUndefined(); // nothing moved net across the two
  });

  it('nassau (two stakes): a zero nines stake settles only the full 18', () => {
    const a = flat(4), b = flat(4);
    a[1] = 3; a[3] = 3; // A wins the front by 2
    b[10] = 3;          // B wins the back by 1 → A still wins the total by 1
    const A = p('a', a), B = p('b', b);
    const { byMode, byPlayer } = Golf.computeMoney([A, B], {
      modes: ['nassau'], stakes: { nassau: { nines: 0, total: 10 } }, holeCount: 18,
      matchTeamA: ['a'], matchTeamB: ['b'], matchUseHandicap: false, nassauFormat: 'match',
    });
    // nines stake is 0 → front and back pay nothing; only the 18 settles.
    expect(byMode.nassau.a).toBe(10);
    expect(byPlayer.a).toBe(10);
    expect(byPlayer.b).toBe(-10);
  });

  it('sixes: the stake rides on each rotating six, zero-sum across the four', () => {
    const a = flat(4), b = flat(4), c = flat(4), d = flat(4);
    for (let h = 1; h <= 6; h++) a[h] = 3;   // seg1 (a&b vs c&d): a&b win
    for (let h = 7; h <= 12; h++) d[h] = 3;  // seg2 (a&c vs b&d): b&d win
    const A = p('a', a), B = p('b', b), C = p('c', c), D = p('d', d);
    const { byPlayer } = Golf.computeMoney([A, B, C, D], {
      modes: ['sixes'], stakes: { sixes: 6 }, holeCount: 18,
      sixesPlayers: ['a', 'b', 'c', 'd'], sixesFormat: 'match', sixesUseHandicap: false,
    });
    expect(byPlayer.a).toBe(0);   // +3 seg1, -3 seg2
    expect(byPlayer.b).toBe(6);   // +3 seg1, +3 seg2
    expect(byPlayer.c).toBe(-6);  // -3 seg1, -3 seg2
    expect(byPlayer.d).toBe(0);   // -3 seg1, +3 seg2 (seg3 halved)
    expect(byPlayer.a + byPlayer.b + byPlayer.c + byPlayer.d).toBe(0);
  });
});

// Tournament team standings: gross/net/stableford sum members; best ball takes
// the best net per hole. tournamentTeams groups players by their team number.
describe('tournamentTeams / computeTeamStandings', () => {
  const pars = Array(18).fill(4);
  const mk = (id, over, hcp = 0) => {
    const s = {}; for (let h = 1; h <= 18; h++) s[h] = 4; Object.assign(s, over);
    return Golf.summarizePlayer({ id, name: id, handicap: hcp }, s, pars, null, 18);
  };

  it('groups players by team number, skipping the unassigned', () => {
    const teams = Golf.tournamentTeams([
      { id: 'a', team: 1 }, { id: 'b', team: 1 }, { id: 'c', team: 2 }, { id: 'd', team: null },
    ]);
    expect(teams).toEqual({ 1: ['a', 'b'], 2: ['c'] });
  });

  it('gross: team to-par is the sum of members, lower ranks first', () => {
    // Team 1 both even par (0); Team 2 one player +4, one even → +4.
    const A = mk('a', {}), B = mk('b', {});
    const C = mk('c', { 1: 8 }), D = mk('d', {});
    const teams = { 1: ['a', 'b'], 2: ['c', 'd'] };
    const rows = Golf.computeTeamStandings([A, B, C, D], teams, 'gross', { pars, holeCount: 18 });
    expect(rows[0].team).toBe(1);
    expect(rows[0].toPar).toBe(0);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].team).toBe(2);
    expect(rows[1].toPar).toBe(4);
    expect(rows[1].rank).toBe(2);
  });

  it('stableford: team points are summed, higher ranks first', () => {
    const A = mk('a', { 1: 2 }), B = mk('b', {});   // A has a birdie → more points
    const C = mk('c', {}), D = mk('d', {});
    const rows = Golf.computeTeamStandings([A, B, C, D], { 1: ['a', 'b'], 2: ['c', 'd'] }, 'stableford', { pars, holeCount: 18 });
    expect(rows[0].team).toBe(1);
    expect(rows[0].points).toBeGreaterThan(rows[1].points);
  });

  it('bestball: best net per hole counts for the team', () => {
    // Team 1: on hole 1, a=3 b=5 → best 3; elsewhere both 4. Best-ball gross = 3 + 4*17 = 71 (par 72 → -1).
    const A = mk('a', { 1: 3 }), B = mk('b', { 1: 5 });
    const C = mk('c', {}), D = mk('d', {});
    const rows = Golf.computeTeamStandings([A, B, C, D], { 1: ['a', 'b'], 2: ['c', 'd'] }, 'bestball', { pars, holeCount: 18, useHandicap: false });
    const t1 = rows.find(r => r.team === 1);
    const t2 = rows.find(r => r.team === 2);
    expect(t1.total).toBe(71);
    expect(t1.toPar).toBe(-1);
    expect(t2.toPar).toBe(0);
    expect(rows[0].team).toBe(1); // -1 beats even
  });

  it('lists a team with no posted scores last, unranked', () => {
    const A = mk('a', {}), B = mk('b', {});
    // Team 2 has not started at all.
    const C = Golf.summarizePlayer({ id: 'c', name: 'c', handicap: 0 }, {}, pars, null, 18);
    const D = Golf.summarizePlayer({ id: 'd', name: 'd', handicap: 0 }, {}, pars, null, 18);
    const rows = Golf.computeTeamStandings([A, B, C, D], { 1: ['a', 'b'], 2: ['c', 'd'] }, 'gross', { pars, holeCount: 18 });
    expect(rows[0].team).toBe(1);
    expect(rows[1].team).toBe(2);
    expect(rows[1].rank).toBe(null);
  });
});

// Tournament money: stroke/best-ball modes are a team ante pot (winning team
// takes all); match play settles team-vs-team, per person. computeMoney returns
// per-player nets plus team aggregation and a team-vs-team settle-up.
describe('computeMoney — tournament', () => {
  const pars = Array(18).fill(4);
  const mk = (id, over) => {
    const s = {}; for (let h = 1; h <= 18; h++) s[h] = 4; Object.assign(s, over);
    return Golf.summarizePlayer({ id, name: id, handicap: 0 }, s, pars, null, 18);
  };
  const players = [
    { id: 'a', team: 1 }, { id: 'b', team: 1 }, { id: 'c', team: 2 }, { id: 'd', team: 2 },
  ];

  it('gross ante pot: the winning team takes the whole pot', () => {
    const A = mk('a', { 1: 3 }), B = mk('b', {}), C = mk('c', {}), D = mk('d', {}); // team 1 has a birdie
    const { byPlayer, byTeam, teamTransactions } = Golf.computeMoney([A, B, C, D], {
      isTournament: true, players, modes: ['gross'], stakes: { gross: 5 }, holeCount: 18, pars,
    });
    expect(byPlayer.a).toBe(5);   // pot 4×5=20, split by 2 winners = 10 each, minus 5 ante
    expect(byPlayer.b).toBe(5);
    expect(byPlayer.c).toBe(-5);
    expect(byPlayer.d).toBe(-5);
    expect(byTeam[1]).toBe(10);
    expect(byTeam[2]).toBe(-10);
    expect(teamTransactions).toEqual([{ from: '2', to: '1', amount: 10 }]);
  });

  it('a tie for the pot nets out to zero', () => {
    const A = mk('a', {}), B = mk('b', {}), C = mk('c', {}), D = mk('d', {}); // all even → teams tie
    const { byPlayer, teamTransactions } = Golf.computeMoney([A, B, C, D], {
      isTournament: true, players, modes: ['gross'], stakes: { gross: 5 }, holeCount: 18, pars,
    });
    // Pot split across all four winners → each gets its ante back.
    expect(byPlayer.a).toBe(0);
    expect(byPlayer.c).toBe(0);
    expect(teamTransactions).toEqual([]);
  });

  it('match play settles team-vs-team, per person', () => {
    const A = mk('a', { 1: 3, 2: 3 }), B = mk('b', {}), C = mk('c', {}), D = mk('d', {}); // team 1 wins the match
    const { byPlayer, byTeam, teamTransactions } = Golf.computeMoney([A, B, C, D], {
      isTournament: true, players, modes: ['match'], stakes: { match: 10 }, holeCount: 18,
      matchUseHandicap: false, tournamentMatches: [{ a: 1, b: 2 }], pars,
    });
    expect(byPlayer.a).toBe(10);  // each loser pays 10; winners split 2×10 = +10 each
    expect(byPlayer.b).toBe(10);
    expect(byPlayer.c).toBe(-10);
    expect(byPlayer.d).toBe(-10);
    expect(byTeam[1]).toBe(20);
    expect(byTeam[2]).toBe(-20);
    expect(teamTransactions).toEqual([{ from: '2', to: '1', amount: 20 }]);
  });
});

// Auto-assign: distribute players into exactly `numTeams` teams with
// near-equal team handicap totals; counts that don't divide evenly leave
// some teams one player short.
describe('balanceTeamsByHandicap', () => {
  // Sum each team's handicaps from an { id: teamNo } assignment.
  const teamSums = (players, assignments) => {
    const sums = {};
    players.forEach(p => { const t = assignments[p.id]; if (t) sums[t] = (sums[t] || 0) + p.handicap; });
    return sums;
  };
  const sizes = (assignments) => {
    const c = {};
    Object.values(assignments).forEach(t => { c[t] = (c[t] || 0) + 1; });
    return c;
  };

  it('2 teams: balances team totals on an even count', () => {
    const players = [{ id: 'a', handicap: 0 }, { id: 'b', handicap: 2 }, { id: 'c', handicap: 4 }, { id: 'd', handicap: 6 }];
    const { assignments, teams } = Golf.balanceTeamsByHandicap(players, 2);
    expect(teams).toBe(2);
    const sums = Object.values(teamSums(players, assignments));
    expect(Math.max(...sums) - Math.min(...sums)).toBe(0); // 6 and 6
    expect(Object.values(sizes(assignments))).toEqual([2, 2]);
  });

  it('2 teams from 8 players: balances team totals', () => {
    const players = Array.from({ length: 8 }, (_, i) => ({ id: 'p' + i, handicap: i }));
    const { assignments, teams } = Golf.balanceTeamsByHandicap(players, 2);
    expect(teams).toBe(2);
    const sums = Object.values(teamSums(players, assignments));
    expect(Math.max(...sums) - Math.min(...sums)).toBe(0); // 14 and 14
    expect(Object.values(sizes(assignments))).toEqual([4, 4]);
  });

  it('odd count: assigns everyone with team sizes differing by at most one', () => {
    const players = [0, 2, 4, 6, 8].map((h, i) => ({ id: 'p' + i, handicap: h }));
    const { assignments, teams } = Golf.balanceTeamsByHandicap(players, 3);
    expect(teams).toBe(3);
    expect(Object.keys(assignments).length).toBe(5); // everyone assigned
    const sz = Object.values(sizes(assignments));
    expect(Math.max(...sz)).toBe(2);
    expect(Math.min(...sz)).toBe(1);
  });

  it('returns teams: 0 when the requested team count can\'t be satisfied', () => {
    // Not enough players for the requested team count in either case.
    expect(Golf.balanceTeamsByHandicap([{ id: 'a', handicap: 3 }, { id: 'b', handicap: 5 }], 4).teams).toBe(0);
    expect(Golf.balanceTeamsByHandicap([{ id: 'a', handicap: 3 }], 2).teams).toBe(0);
  });

  it('3 teams from 10 players: splits as evenly as possible', () => {
    const players = Array.from({ length: 10 }, (_, i) => ({ id: 'p' + i, handicap: i }));
    const { assignments, teams } = Golf.balanceTeamsByHandicap(players, 3);
    expect(teams).toBe(3);
    expect(Object.keys(assignments).length).toBe(10);
    const sz = Object.values(sizes(assignments)).sort((a, b) => b - a);
    expect(sz).toEqual([4, 3, 3]);
  });

  it('5 teams from 16 players: splits evenly with no leftovers', () => {
    const players = Array.from({ length: 16 }, (_, i) => ({ id: 'p' + i, handicap: i }));
    const { assignments, teams } = Golf.balanceTeamsByHandicap(players, 5);
    expect(teams).toBe(5);
    expect(Object.keys(assignments).length).toBe(16);
    const sz = Object.values(sizes(assignments)).sort((a, b) => b - a);
    expect(sz).toEqual([4, 3, 3, 3, 3]); // 16 = 4+3+3+3+3
  });
});
