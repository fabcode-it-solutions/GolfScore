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
  module.exports = Golf;
}
