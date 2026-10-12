'use strict';

/* ===========================================================
   leaderboard.js — the leaderboard (output) tab: building
   per-player summaries and rendering the gross/net/stableford
   boards plus the skins and match-play boards.

   Split out of round.js. All functions stay global; loads
   after round.js. See index.html for load order.
   Depends on: core.js (state, escapeHtml), golf.js (Golf.*).
=========================================================== */

function buildSummaries() {
  const r = state.round;
  return r.players.map(p =>
    Golf.summarizePlayer(p, p.scores || {}, r.pars, r.strokeIndex, r.holeCount)
  );
}

// Total recorded putts for a player across every hole. Holes with no putt
// count recorded are simply skipped. Used on the gross board.
function playerPuttsTotal(playerId) {
  const p = (state.round.players || []).find(pl => pl.id === playerId);
  if (!p || !p.putts) return 0;
  return Object.keys(p.putts).reduce((sum, hole) => {
    const hasScore = p.scores && p.scores[hole] != null;
    return sum + (hasScore ? (Number(p.putts[hole]) || 0) : 0);
  }, 0);
}

function renderLeaderboardTab() {
  const r = state.round;
  if (!r) return;
  const mode = state.activeModeTab || (r.modes && r.modes[0]) || 'gross';
  const summaries = buildSummaries();

  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');

  if (summaries.every(s => s.thru === 0)) {
    metaEl.textContent = 'No scores posted yet.';
    boardEl.innerHTML = '<div class="lb-empty">Scores will appear here as players start entering them.</div>';
    return;
  }

  // Tournament boards: team standings + individual for the stroke/best-ball
  // modes, and per-pairing cards for match play. Money falls through to the
  // shared money board (team-mode settlement is a later phase).
  if (r.isTournament) {
    if (mode === 'match') { renderTournamentMatchBoard(summaries, r); return; }
    if (mode === 'money') { renderMoneyBoard(summaries, r); return; }
    renderTeamBoard(summaries, r, mode);
    return;
  }

  if (mode === 'skins') {
    renderSkinsBoard(summaries, r);
    return;
  }
  if (mode === 'match') {
    renderMatchBoard(summaries, r);
    return;
  }
  if (mode === 'sidematch') {
    renderSideMatchBoard(summaries, r);
    return;
  }
  if (mode === 'nassau') {
    renderNassauBoard(summaries, r);
    return;
  }
  if (mode === 'sixes') {
    renderSixesBoard(summaries, r);
    return;
  }
  if (mode === 'money') {
    renderMoneyBoard(summaries, r);
    return;
  }

  metaEl.textContent = mode === 'stableford'
    ? 'Points scored per hole, summed. Higher is better.'
    : 'Total score relative to par. Lower is better.';

  boardEl.innerHTML = individualRowsHtml(summaries, mode);
}

// The per-player rows for a gross/net/stableford board, as an HTML string.
// Shared by the normal leaderboard and the tournament team board's lower
// "individual" section. Best ball ranks individuals by their net score.
function individualRowsHtml(summaries, mode) {
  const indivMode = mode === 'bestball' ? 'net' : mode;
  const ranked = Golf.rankPlayers(summaries, indivMode);
  return ranked.map(s => {
    let scoreText, scoreClass = '';
    if (indivMode === 'stableford') {
      scoreText = s.thru > 0 ? s.stablefordTotal : '–';
    } else {
      const toPar = indivMode === 'net' ? s.toParNet : s.toParGross;
      scoreText = s.thru > 0 ? Golf.formatToPar(toPar) : '–';
      scoreClass = toPar < 0 ? 'neg' : (toPar > 0 ? 'pos' : '');
    }
    const detail = indivMode === 'net' ? `${s.netTotal} net` : (indivMode === 'stableford' ? `${s.grossTotal} gross` : `HCP ${s.handicap}`);
    return `
      <div class="lb-row${s.rank === 1 ? ' leader' : ''}">
        <span class="lb-rank">${s.rank || '–'}</span>
        <span class="lb-name-wrap">
          <span class="lb-name">${escapeHtml(s.name)}</span>
          <span class="lb-thru">${s.thru > 0 ? 'thru ' + s.thru + (indivMode === 'gross' ? ' · ' + playerPuttsTotal(s.playerId) + ' putts' : '') : 'not started'}</span>
        </span>
        <span class="lb-detail">${s.thru > 0 ? detail : ''}</span>
        <span class="lb-score ${scoreClass}">${scoreText}</span>
      </div>`;
  }).join('');
}

// Tournament team standings (top) + the individual leaderboard (below) for
// gross / net / stableford / best ball. Uses Golf.computeTeamStandings.
function renderTeamBoard(summaries, r, mode) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');
  const teams = Golf.tournamentTeams(r.players);

  if (Object.keys(teams).length === 0) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Assign players to teams to see standings.</div>';
    return;
  }

  const standings = Golf.computeTeamStandings(summaries, teams, mode, {
    pars: r.pars, holeCount: r.holeCount, useHandicap: true,
  });

  metaEl.textContent = mode === 'stableford'
    ? 'Team standings — combined points. Higher is better. Provisional until all scores are in.'
    : mode === 'bestball'
      ? 'Team standings — best net per hole counts. Lower is better. Provisional until all scores are in.'
      : 'Team standings — combined score to par. Lower is better. Provisional until all scores are in.';

  const nameById = {};
  summaries.forEach(s => { nameById[s.playerId] = s.name; });

  const teamRows = standings.map(t => {
    const members = t.memberIds.map(id => nameById[id] || '?').join(' & ');
    let scoreText, scoreClass = '';
    if (mode === 'stableford') {
      scoreText = t.anyStarted ? t.points : '–';
    } else {
      scoreText = t.anyStarted ? Golf.formatToPar(t.toPar) : '–';
      scoreClass = t.toPar < 0 ? 'neg' : (t.toPar > 0 ? 'pos' : '');
    }
    return `
      <div class="lb-row${t.rank === 1 ? ' leader' : ''}">
        <span class="lb-rank">${t.rank || '–'}</span>
        <span class="lb-name-wrap">
          <span class="lb-name">Team ${t.team}</span>
          <span class="lb-thru">${escapeHtml(members)}${t.anyStarted ? ' · thru ' + t.thru : ''}</span>
        </span>
        <span class="lb-detail"></span>
        <span class="lb-score ${scoreClass}">${scoreText}</span>
      </div>`;
  }).join('');

  boardEl.innerHTML =
    `<div class="board-subhead">Teams</div>${teamRows}` +
    `<div class="board-subhead">Individual</div>${individualRowsHtml(summaries, mode)}`;
}

// Tournament match play: one card per manual pairing (Team X vs Team Y),
// each scored like a single-round match with the hole-by-hole strip.
function renderTournamentMatchBoard(summaries, r) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');
  const matches = Array.isArray(r.tournamentMatches) ? r.tournamentMatches : [];

  if (matches.length === 0) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">No match pairings were set for this tournament.</div>';
    return;
  }

  const teams = Golf.tournamentTeams(r.players);
  metaEl.textContent = r.matchUseHandicap
    ? 'Each match is head-to-head, best-ball net score per hole.'
    : 'Each match is head-to-head, best-ball gross score per hole.';

  boardEl.innerHTML = matches.map(pair => {
    const aSum = (teams[pair.a] || []).map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
    const bSum = (teams[pair.b] || []).map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
    const aName = `Team ${pair.a}`, bName = `Team ${pair.b}`;
    if (!aSum.length || !bSum.length) {
      return `<div class="match-card"><p class="match-vs">${aName} vs ${bName}</p><p class="match-status">Waiting on rosters</p></div>`;
    }
    const m = Golf.computeMatchPlay(aSum, bSum, r.holeCount, r.matchUseHandicap);
    const aInit = aSum.map(s => initials(s.name)).join('/');
    const bInit = bSum.map(s => initials(s.name)).join('/');

    let statusText;
    if (m.thru === 0) statusText = 'Not started';
    else if (m.diff === 0) statusText = 'All square';
    else {
      const leaderName = m.diff > 0 ? aName : bName;
      statusText = m.decided && m.thru < r.holeCount
        ? `${leaderName} wins ${m.margin}&${m.remaining}`
        : `${leaderName} ${m.margin} up`;
    }
    const roster = `${aSum.map(s => s.name).join(' & ')} vs ${bSum.map(s => s.name).join(' & ')}`;
    return `
      <div class="match-card">
        <p class="match-vs">${aName} vs ${bName}</p>
        <p class="match-status">${statusText}</p>
        <p class="match-thru">${escapeHtml(roster)} · thru ${m.thru} of ${r.holeCount}</p>
      </div>
    ` + matchStripHtml(m.log, r.holeCount, r.holeOffset, aName, bName, aInit, bInit);
  }).join('');
}

function renderMoneyBoard(summaries, r) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');

  const { byMode, byPlayer, transactions, byTeam, teamTransactions } = Golf.computeMoney(summaries, {
    modes: r.modes,
    stakes: r.stakes,
    holeCount: r.holeCount,
    matchTeamA: r.matchTeamA,
    matchTeamB: r.matchTeamB,
    matchUseHandicap: r.matchUseHandicap,
    sidematchTeamC: r.sidematchTeamC,
    sidematchTeamD: r.sidematchTeamD,
    sidematchUseHandicap: r.sidematchUseHandicap,
    nassauFormat: r.nassauFormat,
    sixesPlayers: r.sixesPlayers,
    sixesFormat: r.sixesFormat,
    sixesUseHandicap: r.sixesUseHandicap,
    isTournament: r.isTournament,
    players: r.players,
    tournamentMatches: r.tournamentMatches,
    pars: r.pars,
  });

  const nameById = {};
  summaries.forEach(s => { nameById[s.playerId] = s.name; });

  // Tournament: team money on top (team net rows + team-vs-team settle-up),
  // then the per-player settle-up, then the per-mode breakdown.
  if (r.isTournament) {
    metaEl.textContent = 'Team money across every bet. Provisional until all scores are in.';
    const teamRows = Object.entries(byTeam || {})
      .map(([team, net]) => ({ team, net }))
      .sort((a, b) => b.net - a.net)
      .map((t, i) => {
        const cls = t.net > 0 ? 'money-up' : (t.net < 0 ? 'money-down' : '');
        return `
          <div class="lb-row${i === 0 && t.net > 0 ? ' leader' : ''}">
            <span class="lb-rank">${i + 1}</span>
            <span class="lb-name-wrap"><span class="lb-name">Team ${escapeHtml(t.team)}</span></span>
            <span class="lb-detail"></span>
            <span class="lb-score ${cls}">${Golf.formatMoney(t.net)}</span>
          </div>`;
      }).join('');
    boardEl.innerHTML = teamRows;
    boardEl.insertAdjacentHTML('beforeend', teamSettleHtml(teamTransactions));
    boardEl.insertAdjacentHTML('beforeend', moneySettleHtml(transactions, nameById, 'Player settle up'));
    boardEl.insertAdjacentHTML('beforeend', moneyBreakdownHtml(byMode, r.stakes, nameById, true));
    return;
  }

  metaEl.textContent = 'Net across every bet this round. Provisional until all scores are in.';

  const rows = Object.entries(byPlayer)
    .map(([id, net]) => ({ id, net, name: nameById[id] || '?' }))
    .sort((a, b) => b.net - a.net);

  boardEl.innerHTML = '';
  rows.forEach((p, i) => {
    const cls = p.net > 0 ? 'money-up' : (p.net < 0 ? 'money-down' : '');
    const row = document.createElement('div');
    row.className = 'lb-row' + (i === 0 && p.net > 0 ? ' leader' : '');
    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name-wrap"><span class="lb-name">${escapeHtml(p.name)}</span></span>
      <span class="lb-detail"></span>
      <span class="lb-score ${cls}">${Golf.formatMoney(p.net)}</span>
    `;
    boardEl.appendChild(row);
  });

  boardEl.insertAdjacentHTML('beforeend', moneySettleHtml(transactions, nameById));
  boardEl.insertAdjacentHTML('beforeend', moneyBreakdownHtml(byMode, r.stakes, nameById));
}

// Team-vs-team settle-up for a tournament: "Team 1 → Team 2 $20".
function teamSettleHtml(teamTransactions) {
  if (!teamTransactions || !teamTransactions.length) {
    return '<div class="money-settle"><div class="money-settle-title">Team settle up</div><div class="money-settle-empty">All square — nothing owed between teams yet.</div></div>';
  }
  const rows = teamTransactions.map(t => {
    const amt = Number.isInteger(t.amount) ? t.amount : t.amount.toFixed(2);
    return `<div class="money-settle-row"><span>Team ${escapeHtml(t.from)}</span><i class="money-arrow">→</i><span>Team ${escapeHtml(t.to)}</span><span class="money-settle-amt">$${amt}</span></div>`;
  }).join('');
  return `<div class="money-settle"><div class="money-settle-title">Team settle up</div>${rows}</div>`;
}

// Per-mode explainer under the Money board: the rule for each bet that
// moved money (the "why") plus each player's net within it (the "how").
function moneyBreakdownHtml(byMode, stakes, nameById, isTournament = false) {
  const modes = STAKE_ORDER.filter(m => byMode[m]);
  if (!modes.length) return '';

  const ruleFor = (m) => {
    const s = stakes && stakes[m] != null ? stakes[m] : '';
    if (isTournament) {
      switch (m) {
        case 'gross': return `Everyone antes $${s}. The team with the lowest combined gross takes the pot.`;
        case 'net': return `Everyone antes $${s}. The team with the lowest combined net takes the pot.`;
        case 'stableford': return `Everyone antes $${s}. The team with the most combined points takes the pot.`;
        case 'bestball': return `Everyone antes $${s}. Lowest team best-ball total takes the pot.`;
        case 'match': return `Each pairing: the losing team pays $${s} per player, split among the winners.`;
        default: return '';
      }
    }
    switch (m) {
      case 'gross': return `Everyone antes $${s}. Lowest gross takes the whole pot.`;
      case 'net': return `Everyone antes $${s}. Lowest net takes the whole pot.`;
      case 'stableford': return `Everyone antes $${s}. Most points takes the whole pot.`;
      case 'skins': return `Each skin is worth $${s}, paid to its winner by every other player. Tied holes carry to the next.`;
      case 'match': return `The losing side pays $${s}, split across the winning team.`;
      case 'sidematch': return `Team C vs Team D — the losing side pays $${s}, split across the winning team.`;
      case 'nassau': {
        const { nines, total } = Golf.nassauStakes(stakes);
        return `Front and back each pay $${nines} to the nine's winner; the full 18 pays $${total}. Halved segments pay nothing.`;
      }
      case 'sixes': return `Each six-hole match pays $${s} to the winning pair; partners rotate every six.`;
      default: return '';
    }
  };

  const blocks = modes.map(m => {
    const nets = byMode[m];
    const chips = Object.entries(nets)
      .filter(([, v]) => Math.abs(v) > 0.005)
      .sort((a, b) => b[1] - a[1])
      .map(([id, v]) => {
        const dir = v > 0 ? 'money-chip-up' : 'money-chip-down';
        return `<span class="money-chip ${dir}">${escapeHtml(nameById[id] || '?')} <b>${Golf.formatMoney(v)}</b></span>`;
      })
      .join('');
    return `
      <div class="money-mode">
        <div class="money-mode-head">${escapeHtml(MODE_NAMES[m] || m)}</div>
        <div class="money-mode-rule">${ruleFor(m)}</div>
        <div class="money-mode-nets">${chips}</div>
      </div>`;
  }).join('');

  return `<div class="money-breakdown"><div class="money-settle-title">How it breaks down</div>${blocks}</div>`;
}

function moneySettleHtml(transactions, nameById, title = 'Settle up') {
  if (!transactions || !transactions.length) {
    return `<div class="money-settle"><div class="money-settle-title">${escapeHtml(title)}</div><div class="money-settle-empty">All square — nothing owed yet.</div></div>`;
  }
  const rows = transactions.map(t => {
    const amt = Number.isInteger(t.amount) ? t.amount : t.amount.toFixed(2);
    return `<div class="money-settle-row"><span>${escapeHtml(nameById[t.from] || '?')}</span><i class="money-arrow">→</i><span>${escapeHtml(nameById[t.to] || '?')}</span><span class="money-settle-amt">$${amt}</span></div>`;
  }).join('');
  return `<div class="money-settle"><div class="money-settle-title">${escapeHtml(title)}</div>${rows}</div>`;
}

function renderSkinsBoard(summaries, r) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');
  const { skinsByPlayer, log, carry } = Golf.computeSkins(summaries, r.holeCount);
  const pendingCount = log.filter(l => l.pending).length;

  if (pendingCount > 0) {
    metaEl.textContent = `Skins won so far. Ties carry to the next hole. ${pendingCount} hole(s) still waiting on everyone's score.`;
  } else if (carry > 0) {
    metaEl.textContent = `Skins won. Ties carry to the next hole. ${carry} skin(s) still in the pot, unclaimed.`;
  } else {
    metaEl.textContent = 'Skins won. Lowest net on a hole takes the pot; ties carry to the next hole.';
  }

  const ranked = Object.entries(skinsByPlayer)
    .map(([playerId, count]) => ({ playerId, count, name: summaries.find(s => s.playerId === playerId)?.name || '?' }))
    .sort((a, b) => b.count - a.count);

  boardEl.innerHTML = '';
  ranked.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (i === 0 && p.count > 0 ? ' leader' : '');
    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name-wrap"><span class="lb-name">${escapeHtml(p.name)}</span></span>
      <span class="lb-detail"></span>
      <span class="lb-score">${p.count}</span>
    `;
    boardEl.appendChild(row);
  });

  boardEl.insertAdjacentHTML('beforeend', skinsStripHtml(log, summaries, r.holeOffset));
}

// Builds the hole-by-hole skins strip: one cell per hole. Green cells are
// holes won outright (main number is the pot that landed, sub is the
// winner); sand cells are ties where the pot rolled forward (main number
// is the skins now riding); dashed cells are holes still pending. Shared
// by the live leaderboard and the history detail view — defined here
// because leaderboard.js loads before history.js.
function skinsStripHtml(log, summaries, holeOffset) {
  const nameById = {};
  summaries.forEach(s => { nameById[s.playerId] = s.name; });
  const off = holeOffset || 0;

  const cells = log.map(entry => {
    const num = entry.hole + off;
    if (entry.pending) {
      return `<div class="skins-cell pending"><span class="skins-cell-num">${num}</span><span class="skins-cell-main">·</span></div>`;
    }
    if (entry.winnerId) {
      const who = escapeHtml(initials(nameById[entry.winnerId]));
      return `<div class="skins-cell won"><span class="skins-cell-num">${num}</span><span class="skins-cell-main">${entry.value}</span><span class="skins-cell-sub">${who}</span></div>`;
    }
    // Tied — the pot (what carried in, plus this hole) rolls forward.
    const rolling = (entry.carriedIn || 0) + 1;
    return `<div class="skins-cell carry"><span class="skins-cell-num">${num}</span><span class="skins-cell-main">${rolling}</span><span class="skins-cell-sub">carry</span></div>`;
  }).join('');

  return `<div class="skins-strip-wrap"><p class="skins-strip-label">Hole by hole</p><div class="skins-strip">${cells}</div></div>`;
}

// The match-play equivalent of the skins strip: one cell per hole showing the
// running match status *after* that hole (e.g. Team A 2 up). Colour marks who
// leads at that point — Team A (green), Team B (red), all-square (neutral) —
// and the legend maps those colours to the full team names. Holes not yet
// played by both teams render as dashed pending cells.
function matchStripHtml(log, holeCount, holeOffset, teamAName, teamBName, teamAInit, teamBInit) {
  const off = holeOffset || 0;
  const cumByHole = {};
  Golf.matchRunning(log).forEach(e => { cumByHole[e.hole] = e.cum; });

  const cells = [];
  for (let h = 1; h <= holeCount; h++) {
    const num = h + off;
    if (!(h in cumByHole)) {
      cells.push(`<div class="skins-cell match-cell pending"><span class="skins-cell-num">${num}</span><span class="skins-cell-main">·</span></div>`);
      continue;
    }
    const cum = cumByHole[h];
    if (cum > 0) {
      cells.push(`<div class="skins-cell match-cell team-a"><span class="skins-cell-num">${num}</span><span class="skins-cell-main">${cum}</span><span class="skins-cell-sub">${escapeHtml(teamAInit)}</span></div>`);
    } else if (cum < 0) {
      cells.push(`<div class="skins-cell match-cell team-b"><span class="skins-cell-num">${num}</span><span class="skins-cell-main">${Math.abs(cum)}</span><span class="skins-cell-sub">${escapeHtml(teamBInit)}</span></div>`);
    } else {
      cells.push(`<div class="skins-cell match-cell square"><span class="skins-cell-num">${num}</span><span class="skins-cell-main">AS</span></div>`);
    }
  }

  const legend = `<div class="match-legend">` +
    `<span class="match-legend-item"><span class="match-swatch team-a"></span>${escapeHtml(teamAName)}</span>` +
    `<span class="match-legend-item"><span class="match-swatch team-b"></span>${escapeHtml(teamBName)}</span>` +
    `</div>`;

  return `<div class="skins-strip-wrap"><p class="skins-strip-label">Hole by hole</p>${legend}<div class="skins-strip">${cells.join('')}</div></div>`;
}

function renderMatchBoard(summaries, r) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');

  if (!r.matchTeamA || !r.matchTeamB || r.matchTeamA.length === 0 || r.matchTeamB.length === 0) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Match play needs teams selected at setup.</div>';
    return;
  }

  const teamASummaries = r.matchTeamA.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  const teamBSummaries = r.matchTeamB.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  if (teamASummaries.length === 0 || teamBSummaries.length === 0) return;

  const m = Golf.computeMatchPlay(teamASummaries, teamBSummaries, r.holeCount, r.matchUseHandicap);
  const teamAName = teamASummaries.map(s => s.name).join(' & ');
  const teamBName = teamBSummaries.map(s => s.name).join(' & ');
  const teamAInit = teamASummaries.map(s => initials(s.name)).join('/');
  const teamBInit = teamBSummaries.map(s => initials(s.name)).join('/');

  metaEl.textContent = r.matchUseHandicap
    ? 'Head-to-head, best-ball net score per hole.'
    : 'Head-to-head, best-ball gross score per hole.';

  let statusText;
  if (m.thru === 0) {
    statusText = 'Not started';
  } else if (m.diff === 0) {
    statusText = 'All square';
  } else {
    const leaderName = m.diff > 0 ? teamAName : teamBName;
    statusText = m.decided && m.thru < r.holeCount
      ? `${leaderName} wins ${m.margin}&${m.remaining}`
      : `${leaderName} ${m.margin} up`;
  }

  boardEl.innerHTML = `
    <div class="match-card">
      <p class="match-vs">${escapeHtml(teamAName)} vs ${escapeHtml(teamBName)}</p>
      <p class="match-status">${statusText}</p>
      <p class="match-thru">thru ${m.thru} of ${r.holeCount}</p>
    </div>
  ` + matchStripHtml(m.log, r.holeCount, r.holeOffset, teamAName, teamBName, teamAInit, teamBInit);
}

// The side match — a separate head-to-head (Team C vs Team D) running alongside
// the main game. Mirrors renderMatchBoard using the sidematch fields; reuses the
// same match engine and hole-by-hole strip.
function renderSideMatchBoard(summaries, r) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');

  if (!r.sidematchTeamC || !r.sidematchTeamD || r.sidematchTeamC.length === 0 || r.sidematchTeamD.length === 0) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Side match needs teams selected at setup.</div>';
    return;
  }

  const teamCSummaries = r.sidematchTeamC.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  const teamDSummaries = r.sidematchTeamD.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  if (teamCSummaries.length === 0 || teamDSummaries.length === 0) return;

  const m = Golf.computeMatchPlay(teamCSummaries, teamDSummaries, r.holeCount, r.sidematchUseHandicap);
  const teamCName = teamCSummaries.map(s => s.name).join(' & ');
  const teamDName = teamDSummaries.map(s => s.name).join(' & ');
  const teamCInit = teamCSummaries.map(s => initials(s.name)).join('/');
  const teamDInit = teamDSummaries.map(s => initials(s.name)).join('/');

  metaEl.textContent = r.sidematchUseHandicap
    ? 'Side match — head-to-head, best-ball net score per hole.'
    : 'Side match — head-to-head, best-ball gross score per hole.';

  let statusText;
  if (m.thru === 0) {
    statusText = 'Not started';
  } else if (m.diff === 0) {
    statusText = 'All square';
  } else {
    const leaderName = m.diff > 0 ? teamCName : teamDName;
    statusText = m.decided && m.thru < r.holeCount
      ? `${leaderName} wins ${m.margin}&${m.remaining}`
      : `${leaderName} ${m.margin} up`;
  }

  boardEl.innerHTML = `
    <div class="match-card">
      <p class="match-vs">${escapeHtml(teamCName)} vs ${escapeHtml(teamDName)}</p>
      <p class="match-status">${statusText}</p>
      <p class="match-thru">thru ${m.thru} of ${r.holeCount}</p>
    </div>
  ` + matchStripHtml(m.log, r.holeCount, r.holeOffset, teamCName, teamDName, teamCInit, teamDInit);
}

// Match-play status line shared by the Nassau segments (mirrors renderMatchBoard).
function matchSegmentStatus(m, aName, bName, segLength) {
  if (m.thru === 0) return 'Not started';
  if (m.diff === 0) return 'All square';
  const leader = m.diff > 0 ? aName : bName;
  return (m.decided && m.thru < segLength)
    ? `${leader} wins ${m.margin}&${m.remaining}`
    : `${leader} ${m.margin} up`;
}

// Nassau: three head-to-head competitions — front 9, back 9, and full 18 — over
// the shared Team A/B, each scored as match or stroke play per r.nassauFormat.
function renderNassauBoard(summaries, r) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');

  if (!r.matchTeamA || !r.matchTeamB || r.matchTeamA.length === 0 || r.matchTeamB.length === 0) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Nassau needs Team A and Team B selected at setup.</div>';
    return;
  }
  if (r.holeCount <= 9) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Nassau needs an 18-hole round.</div>';
    return;
  }

  const teamA = r.matchTeamA.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  const teamB = r.matchTeamB.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  if (!teamA.length || !teamB.length) return;

  const aName = teamA.map(s => s.name).join(' & ');
  const bName = teamB.map(s => s.name).join(' & ');
  const useHc = r.matchUseHandicap;
  const stroke = r.nassauFormat === 'stroke';

  metaEl.textContent = `${stroke ? 'Stroke' : 'Match'} play · best-ball ${useHc ? 'net' : 'gross'} · front, back & total.`;

  const segments = [
    { label: 'Front 9', from: 1, to: 9 },
    { label: 'Back 9', from: 10, to: 18 },
    { label: 'Total', from: 1, to: 18 },
  ];

  const rows = segments.map(seg => {
    let result, sub = '';
    if (stroke) {
      const s = Golf.computeStrokeRange(teamA, teamB, seg.from, seg.to, useHc);
      if (s.thru === 0) result = 'Not started';
      else if (s.leader === null) result = 'All square';
      else result = `${s.leader === 'A' ? aName : bName} by ${s.diff}`;
      if (s.thru > 0) sub = `${s.teamATotal}–${s.teamBTotal}`;
    } else {
      const m = Golf.computeMatchPlayRange(teamA, teamB, seg.from, seg.to, useHc);
      result = matchSegmentStatus(m, aName, bName, seg.to - seg.from + 1);
      if (m.thru > 0) sub = `thru ${m.thru}`;
    }
    return `<div class="nassau-row">
      <span class="nassau-seg">${seg.label}</span>
      <span class="nassau-result">${escapeHtml(result)}</span>
      <span class="nassau-sub">${escapeHtml(sub)}</span>
    </div>`;
  }).join('');

  boardEl.innerHTML = `
    <div class="match-card nassau-card">
      <p class="match-vs">${escapeHtml(aName)} vs ${escapeHtml(bName)}</p>
      <div class="nassau-rows">${rows}</div>
    </div>`;
}

// Sixes: four players, three 6-hole matches, partners rotating each six. Each
// segment's result is a match (X&Y / X up) or stroke (X by N) contest between
// the two rotating pairs, per r.sixesFormat.
function renderSixesBoard(summaries, r) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');

  if (!Array.isArray(r.sixesPlayers) || r.sixesPlayers.length !== 4) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Sixes needs four players seated at setup.</div>';
    return;
  }
  if (r.holeCount <= 9) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Sixes needs an 18-hole round.</div>';
    return;
  }

  const seats = r.sixesPlayers.map(id => summaries.find(s => s.playerId === id) || null);
  if (seats.some(s => !s)) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Sixes players weren\'t found in this round.</div>';
    return;
  }

  const useHc = r.sixesUseHandicap;
  const stroke = r.sixesFormat === 'stroke';
  metaEl.textContent = `${stroke ? 'Stroke' : 'Match'} play · best-ball ${useHc ? 'net' : 'gross'} · partners rotate every six.`;

  const pairName = idxs => idxs.map(i => seats[i].name).join(' & ');

  const blocks = Golf.sixesSegments().map(seg => {
    const teamX = seg.teamX.map(i => seats[i]);
    const teamY = seg.teamY.map(i => seats[i]);
    let result;
    if (stroke) {
      const s = Golf.computeStrokeRange(teamX, teamY, seg.from, seg.to, useHc);
      if (s.thru === 0) result = 'Not started';
      else if (s.leader === null) result = `All square (${s.teamATotal}–${s.teamBTotal})`;
      else result = `${s.leader === 'A' ? pairName(seg.teamX) : pairName(seg.teamY)} by ${s.diff} (${s.teamATotal}–${s.teamBTotal})`;
    } else {
      const m = Golf.computeMatchPlayRange(teamX, teamY, seg.from, seg.to, useHc);
      result = matchSegmentStatus(m, pairName(seg.teamX), pairName(seg.teamY), seg.to - seg.from + 1);
    }
    return `<div class="sixes-seg">
      <p class="sixes-seg-label">${seg.label}</p>
      <p class="sixes-pairing">${escapeHtml(pairName(seg.teamX))} <span class="sixes-vs">vs</span> ${escapeHtml(pairName(seg.teamY))}</p>
      <p class="sixes-result">${escapeHtml(result)}</p>
    </div>`;
  }).join('');

  boardEl.innerHTML = `<div class="match-card nassau-card sixes-card">${blocks}</div>`;
}
