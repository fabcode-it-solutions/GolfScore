'use strict';

/* ===========================================================
   history.js — the round-history screen: lists the signed-in
   user's completed rounds (newest first) with their own
   gross-to-par for each.

   Rows come from completed_rounds; its RLS SELECT policy
   (auth.uid() = ANY participant_user_ids) already scopes the
   result to rounds this user played in. Gross-to-par is computed
   with Golf.summarizePlayer — the same engine the live
   leaderboard uses — so history matches what players saw.

   Loads after leaderboard.js, before app.js. Functions stay
   global. Depends on: core.js (escapeHtml, showScreen),
   golf.js (Golf.*), Supabase client.
=========================================================== */

async function openRoundHistory() {
  showScreen('screen-history');
  await setViewRoundsTab('completed');
}

// Switches between the "Completed Rounds" and "In Progress Rounds" tabs
// on the View Rounds screen, loading whichever tab it lands on.
// loadInProgressRoundsTab() lives in resume.js, which already owns the
// in-progress-rounds query and the resume flow it reuses here.
async function setViewRoundsTab(tab) {
  state.activeViewRoundsTab = tab;
  document.querySelectorAll('#view-rounds-tab-row .modetab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.viewRoundsTab === tab)
  );
  document.getElementById('tab-completed-rounds').hidden = tab !== 'completed';
  document.getElementById('tab-inprogress-rounds').hidden = tab !== 'inprogress';

  if (tab === 'completed') {
    await loadRoundHistory();
  } else {
    await loadInProgressRoundsTab();
  }
}

async function loadRoundHistory() {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="history-empty">Loading your rounds…</div>';

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    listEl.innerHTML = '<div class="history-empty">Log in to see your round history.</div>';
    return;
  }

  const { data: rows, error } = await supabaseClient
    .from('completed_rounds')
    .select('*')
    .order('ended_at', { ascending: false });

  if (error) {
    console.error(error);
    listEl.innerHTML = '<div class="history-empty">Could not load your rounds — check your connection.</div>';
    return;
  }

  if (!rows || rows.length === 0) {
    listEl.innerHTML = "<div class=\"history-empty\">No completed rounds yet. Finish a round and it'll show up here.</div>";
    return;
  }

  listEl.innerHTML = '';
  rows.forEach(row => {
    const card = buildHistoryCard(row, user.id);
    if (card) listEl.appendChild(card);
  });
}

// One card per completed round, showing one player's line
// (name + gross + to-par). `lineUserId` picks whose line to show —
// the signed-in user for their own history, or the friend on the
// friend-rounds screen. `detailUserId` is who gets the "(you)" marker
// in the detail view (always the signed-in user); it defaults to
// lineUserId so existing callers are unchanged. Everything needed is
// inside the snapshot, so no extra queries.
function buildHistoryCard(row, lineUserId, detailUserId = lineUserId) {
  const snap = row.round_snapshot || {};
  const players = row.players_snapshot || [];
  const scores = row.scores_snapshot || [];
  const isCancelled = row.status === 'cancelled';

  const mePlayer = players.find(p => p.user_id === lineUserId);
  const holeCount = snap.hole_count || (snap.pars ? snap.pars.length : 18);

  let playerLine = '';
  let scoreHtml = '';

  if (mePlayer) {
    // Golf.summarizePlayer expects a holeNumber(string) -> gross map.
    const scoreMap = {};
    scores.forEach(s => {
      if (s.player_id === mePlayer.id) scoreMap[String(s.hole)] = s.strokes;
    });

    const summary = Golf.summarizePlayer(
      mePlayer, scoreMap, snap.pars || [], snap.stroke_index || null, holeCount
    );

    const toParClass = summary.toParGross < 0 ? 'neg' : (summary.toParGross > 0 ? 'pos' : '');
    playerLine = `<span class="history-card-player">${escapeHtml(mePlayer.name)}</span>`;
    scoreHtml = isCancelled
      ? `<div class="history-card-score"><span class="history-card-cancelled-badge">Cancelled</span></div>`
      : `
      <div class="history-card-score">
        <span class="history-card-gross">${summary.grossTotal}</span>
        <span class="history-card-topar ${toParClass}">${Golf.formatToPar(summary.toParGross)}</span>
      </div>`;
  }

  const card = document.createElement('div');
  card.className = 'history-card';
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.innerHTML = `
    <div class="history-card-main">
      <span class="history-card-course">${escapeHtml(row.course_name || snap.course_name || 'Round')}</span>
      <span class="history-card-meta">${formatHistoryDate(row.ended_at)} · ${holeCount} holes${isCancelled ? ' · Cancelled' : ''}</span>
      ${playerLine}
    </div>
    ${scoreHtml}
    <span class="history-card-chevron" aria-hidden="true">›</span>
  `;
  card.addEventListener('click', () => openHistoryDetail(row, detailUserId));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHistoryDetail(row, detailUserId); }
  });
  return card;
}

// "Jun 29, 2026" — empty string on a missing/bad date.
function formatHistoryDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ===========================================================
// Round detail — read-only view of one completed round, showing
// every player's result for each mode the round used. Reconstructs
// a round object from the snapshot and reuses the same Golf.*
// scoring the live leaderboard uses, so results are identical.
// ===========================================================

let historyDetailRound = null;
let historyDetailUserId = null;

function openHistoryDetail(row, userId) {
  historyDetailRound = reconstructRound(row);
  historyDetailUserId = userId;
  showScreen('screen-history-detail');
  renderHistoryDetail();
  renderHistoryScorecard(historyDetailRound);
}

// Rebuilds the round into the shape the scoring engine expects
// (camelCase fields, per-player score maps), mirroring mapRoundRow.
function reconstructRound(row) {
  const snap = row.round_snapshot || {};
  const playersSnap = row.players_snapshot || [];
  const scoresSnap = row.scores_snapshot || [];

  const scoresByPlayer = {};
  const puttsByPlayer = {};
  playersSnap.forEach(p => { scoresByPlayer[p.id] = {}; puttsByPlayer[p.id] = {}; });
  scoresSnap.forEach(s => {
    if (!scoresByPlayer[s.player_id]) scoresByPlayer[s.player_id] = {};
    scoresByPlayer[s.player_id][String(s.hole)] = s.strokes;
    if (s.putts != null) {
      if (!puttsByPlayer[s.player_id]) puttsByPlayer[s.player_id] = {};
      puttsByPlayer[s.player_id][String(s.hole)] = s.putts;
    }
  });

  const players = playersSnap.map(p => ({
    id: p.id,
    name: p.name,
    handicap: p.handicap || 0,
    user_id: p.user_id,
    team: p.team != null ? Number(p.team) : null,
    isCaptain: p.is_captain === true,
    scores: scoresByPlayer[p.id] || {},
    putts: puttsByPlayer[p.id] || {},
  }));

  return {
    courseName: row.course_name || snap.course_name || 'Round',
    holeCount: snap.hole_count || (snap.pars ? snap.pars.length : 18),
    holeOffset: snap.hole_offset || 0,
    pars: snap.pars || [],
    strokeIndex: snap.stroke_index || null,
    modes: (snap.modes && snap.modes.length) ? snap.modes : ['gross'],
    matchTeamA: snap.match_team_a || null,
    matchTeamB: snap.match_team_b || null,
    matchUseHandicap: snap.match_use_handicap !== false,
    sidematchTeamC: snap.sidematch_team_c || null,
    sidematchTeamD: snap.sidematch_team_d || null,
    sidematchUseHandicap: snap.sidematch_use_handicap !== false,
    nassauFormat: snap.nassau_format || 'match',
    sixesPlayers: snap.sixes_players || null,
    sixesFormat: snap.sixes_format || 'match',
    sixesUseHandicap: snap.sixes_use_handicap !== false,
    betsEnabled: snap.bets_enabled === true,
    stakes: snap.stakes || {},
    isTournament: snap.is_tournament === true,
    teamCount: snap.team_count != null ? Number(snap.team_count) : null,
    tournamentMatches: snap.tournament_matches || null,
    status: row.status || 'completed',
    players,
    endedAt: row.ended_at,
  };
}

function renderHistoryDetail() {
  const round = historyDetailRound;
  if (!round) return;

  document.getElementById('history-detail-course').textContent = round.courseName;
  document.getElementById('history-detail-meta').textContent =
    `${formatHistoryDate(round.endedAt)} · ${round.holeCount} holes${round.status === 'cancelled' ? ' · Cancelled' : ''}`;

  const modes = roundBoardModes(round);
  const activeMode = modes[0];
  const tabRow = document.getElementById('history-mode-row');
  tabRow.innerHTML = modes.map(m =>
    `<button class="modetab ${m === activeMode ? 'active' : ''}" data-mode="${m}">${MODE_NAMES[m] || m}</button>`
  ).join('');
  tabRow.querySelectorAll('.modetab').forEach(btn => {
    btn.addEventListener('click', () => {
      tabRow.querySelectorAll('.modetab').forEach(b => b.classList.toggle('active', b === btn));
      renderHistoryDetailBoard(btn.dataset.mode);
    });
  });

  renderHistoryDetailBoard(activeMode);
}

function historyDetailSummaries(round) {
  return round.players.map(p =>
    Golf.summarizePlayer(p, p.scores || {}, round.pars, round.strokeIndex, round.holeCount)
  );
}

function isDetailMe(round, playerId) {
  if (!historyDetailUserId) return false;
  const p = round.players.find(pl => pl.id === playerId);
  return p && p.user_id === historyDetailUserId;
}

function renderHistoryDetailBoard(mode) {
  const round = historyDetailRound;
  const summaries = historyDetailSummaries(round);
  const metaEl = document.getElementById('history-detail-meta-line');
  const boardEl = document.getElementById('history-detail-board');

  if (round.isTournament) {
    if (mode === 'match') return renderHistoryDetailTournamentMatch(summaries, round, metaEl, boardEl);
    if (mode === 'money') return renderHistoryDetailMoney(summaries, round, metaEl, boardEl);
    return renderHistoryDetailTeam(summaries, round, mode, metaEl, boardEl);
  }

  if (mode === 'skins') return renderHistoryDetailSkins(summaries, round, metaEl, boardEl);
  if (mode === 'match') return renderHistoryDetailMatch(summaries, round, metaEl, boardEl);
  if (mode === 'sidematch') return renderHistoryDetailSideMatch(summaries, round, metaEl, boardEl);
  if (mode === 'nassau') return renderHistoryDetailNassau(summaries, round, metaEl, boardEl);
  if (mode === 'sixes') return renderHistoryDetailSixes(summaries, round, metaEl, boardEl);
  if (mode === 'money') return renderHistoryDetailMoney(summaries, round, metaEl, boardEl);

  metaEl.textContent = mode === 'stableford'
    ? 'Points scored per hole, summed. Higher is better.'
    : 'Total score relative to par. Lower is better.';

  const ranked = Golf.rankPlayers(summaries, mode);
  boardEl.innerHTML = '';
  ranked.forEach(s => {
    const meMark = isDetailMe(round, s.playerId) ? ' (you)' : '';
    let scoreText, scoreClass = '';
    if (mode === 'stableford') {
      scoreText = s.stablefordTotal;
    } else {
      const toPar = mode === 'net' ? s.toParNet : s.toParGross;
      scoreText = Golf.formatToPar(toPar);
      scoreClass = toPar < 0 ? 'neg' : (toPar > 0 ? 'pos' : '');
    }
    const detail = mode === 'net'
      ? `${s.netTotal} net`
      : (mode === 'stableford' ? `${s.grossTotal} gross` : `HCP ${s.handicap}`);

    const rowEl = document.createElement('div');
    rowEl.className = 'lb-row' + (s.rank === 1 ? ' leader' : '');
    rowEl.innerHTML = `
      <span class="lb-rank">${s.rank || '–'}</span>
      <span class="lb-name-wrap">
        <span class="lb-name">${escapeHtml(s.name)}${meMark}</span>
      </span>
      <span class="lb-detail">${detail}</span>
      <span class="lb-score ${scoreClass}">${scoreText}</span>
    `;
    boardEl.appendChild(rowEl);
  });
}

// Tournament team standings + individual leaderboard, history detail view.
// Mirrors the live renderTeamBoard, adding the "(you)" mark on individuals.
function renderHistoryDetailTeam(summaries, round, mode, metaEl, boardEl) {
  const teams = Golf.tournamentTeams(round.players);
  if (Object.keys(teams).length === 0) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">This tournament had no teams assigned.</div>';
    return;
  }
  const standings = Golf.computeTeamStandings(summaries, teams, mode, {
    pars: round.pars, holeCount: round.holeCount, useHandicap: true,
  });

  metaEl.textContent = mode === 'stableford'
    ? 'Team standings — combined points. Higher is better.'
    : mode === 'bestball'
      ? 'Team standings — best net per hole counts. Lower is better.'
      : 'Team standings — combined score to par. Lower is better.';

  const nameById = {};
  summaries.forEach(s => { nameById[s.playerId] = s.name; });

  const teamRows = standings.map(t => {
    const members = t.memberIds.map(id => nameById[id] || '?').join(' & ');
    let scoreText, scoreClass = '';
    if (mode === 'stableford') {
      scoreText = t.points;
    } else {
      scoreText = Golf.formatToPar(t.toPar);
      scoreClass = t.toPar < 0 ? 'neg' : (t.toPar > 0 ? 'pos' : '');
    }
    return `
      <div class="lb-row${t.rank === 1 ? ' leader' : ''}">
        <span class="lb-rank">${t.rank || '–'}</span>
        <span class="lb-name-wrap">
          <span class="lb-name">Team ${t.team}</span>
          <span class="lb-thru">${escapeHtml(members)}</span>
        </span>
        <span class="lb-detail"></span>
        <span class="lb-score ${scoreClass}">${scoreText}</span>
      </div>`;
  }).join('');

  const indivMode = mode === 'bestball' ? 'net' : mode;
  const ranked = Golf.rankPlayers(summaries, indivMode);
  const indivRows = ranked.map(s => {
    const meMark = isDetailMe(round, s.playerId) ? ' (you)' : '';
    let scoreText, scoreClass = '';
    if (indivMode === 'stableford') {
      scoreText = s.stablefordTotal;
    } else {
      const toPar = indivMode === 'net' ? s.toParNet : s.toParGross;
      scoreText = Golf.formatToPar(toPar);
      scoreClass = toPar < 0 ? 'neg' : (toPar > 0 ? 'pos' : '');
    }
    const detail = indivMode === 'net' ? `${s.netTotal} net` : (indivMode === 'stableford' ? `${s.grossTotal} gross` : `HCP ${s.handicap}`);
    return `
      <div class="lb-row${s.rank === 1 ? ' leader' : ''}">
        <span class="lb-rank">${s.rank || '–'}</span>
        <span class="lb-name-wrap"><span class="lb-name">${escapeHtml(s.name)}${meMark}</span></span>
        <span class="lb-detail">${detail}</span>
        <span class="lb-score ${scoreClass}">${scoreText}</span>
      </div>`;
  }).join('');

  boardEl.innerHTML =
    `<div class="board-subhead">Teams</div>${teamRows}` +
    `<div class="board-subhead">Individual</div>${indivRows}`;
}

// Tournament match play, history detail view: one result card per pairing.
function renderHistoryDetailTournamentMatch(summaries, round, metaEl, boardEl) {
  const matches = Array.isArray(round.tournamentMatches) ? round.tournamentMatches : [];
  if (!matches.length) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">This tournament had no match pairings.</div>';
    return;
  }
  const teams = Golf.tournamentTeams(round.players);
  metaEl.textContent = round.matchUseHandicap
    ? 'Head-to-head, best-ball net score per hole.'
    : 'Head-to-head, best-ball gross score per hole.';

  boardEl.innerHTML = matches.map(pair => {
    const aSum = (teams[pair.a] || []).map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
    const bSum = (teams[pair.b] || []).map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
    const aName = `Team ${pair.a}`, bName = `Team ${pair.b}`;
    if (!aSum.length || !bSum.length) {
      return `<div class="history-match-result"><div class="history-match-teams"><span class="history-match-team">${aName}</span><span class="history-match-vs">vs</span><span class="history-match-team">${bName}</span></div><div class="history-match-outcome">Rosters incomplete</div></div>`;
    }
    const m = Golf.computeMatchPlay(aSum, bSum, round.holeCount, round.matchUseHandicap);
    let resultText;
    if (m.diff === 0) {
      resultText = 'Match halved — all square';
    } else {
      const winnerName = m.diff > 0 ? aName : bName;
      resultText = m.remaining > 0 ? `${winnerName} won ${m.margin}&${m.remaining}` : `${winnerName} won ${m.margin} up`;
    }
    const roster = `${aSum.map(s => s.name).join(' & ')} vs ${bSum.map(s => s.name).join(' & ')}`;
    return `
      <div class="history-match-result">
        <div class="history-match-teams">
          <span class="history-match-team">${aName}</span>
          <span class="history-match-vs">vs</span>
          <span class="history-match-team">${bName}</span>
        </div>
        <div class="history-match-outcome">${escapeHtml(resultText)}</div>
        <div class="history-match-roster">${escapeHtml(roster)}</div>
      </div>`;
  }).join('');
}

function renderHistoryDetailMoney(summaries, round, metaEl, boardEl) {
  const { byMode, byPlayer, transactions, byTeam, teamTransactions } = Golf.computeMoney(summaries, {
    modes: round.modes,
    stakes: round.stakes,
    holeCount: round.holeCount,
    matchTeamA: round.matchTeamA,
    matchTeamB: round.matchTeamB,
    matchUseHandicap: round.matchUseHandicap,
    sidematchTeamC: round.sidematchTeamC,
    sidematchTeamD: round.sidematchTeamD,
    sidematchUseHandicap: round.sidematchUseHandicap,
    nassauFormat: round.nassauFormat,
    sixesPlayers: round.sixesPlayers,
    sixesFormat: round.sixesFormat,
    sixesUseHandicap: round.sixesUseHandicap,
    isTournament: round.isTournament,
    players: round.players,
    tournamentMatches: round.tournamentMatches,
    pars: round.pars,
  });
  metaEl.textContent = 'Final money across every bet this round.';

  const nameById = {};
  summaries.forEach(s => { nameById[s.playerId] = s.name; });

  // Tournament: team money on top, then per-player settle-up and breakdown.
  if (round.isTournament) {
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
    boardEl.insertAdjacentHTML('beforeend', moneyBreakdownHtml(byMode, round.stakes, nameById, true));
    return;
  }

  const rows = Object.entries(byPlayer)
    .map(([id, net]) => ({ id, net, name: nameById[id] || '?' }))
    .sort((a, b) => b.net - a.net);

  boardEl.innerHTML = '';
  rows.forEach((p, i) => {
    const cls = p.net > 0 ? 'money-up' : (p.net < 0 ? 'money-down' : '');
    const meMark = isDetailMe(round, p.id) ? ' (you)' : '';
    const row = document.createElement('div');
    row.className = 'lb-row' + (i === 0 && p.net > 0 ? ' leader' : '');
    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name-wrap"><span class="lb-name">${escapeHtml(p.name)}${meMark}</span></span>
      <span class="lb-detail"></span>
      <span class="lb-score ${cls}">${Golf.formatMoney(p.net)}</span>
    `;
    boardEl.appendChild(row);
  });

  boardEl.insertAdjacentHTML('beforeend', moneySettleHtml(transactions, nameById));
  boardEl.insertAdjacentHTML('beforeend', moneyBreakdownHtml(byMode, round.stakes, nameById));
}

function renderHistoryDetailSkins(summaries, round, metaEl, boardEl) {
  const { skinsByPlayer, carry, log } = Golf.computeSkins(summaries, round.holeCount);
  metaEl.textContent = carry > 0
    ? `Skins won. Ties carry to the next hole. ${carry} skin(s) went unclaimed.`
    : 'Skins won. Lowest net on a hole takes the pot; ties carry to the next hole.';

  const ranked = Object.entries(skinsByPlayer)
    .map(([playerId, count]) => ({
      playerId, count,
      name: summaries.find(s => s.playerId === playerId)?.name || '?',
    }))
    .sort((a, b) => b.count - a.count);

  boardEl.innerHTML = '';
  ranked.forEach((p, i) => {
    const meMark = isDetailMe(round, p.playerId) ? ' (you)' : '';
    const rowEl = document.createElement('div');
    rowEl.className = 'lb-row' + (i === 0 && p.count > 0 ? ' leader' : '');
    rowEl.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name-wrap"><span class="lb-name">${escapeHtml(p.name)}${meMark}</span></span>
      <span class="lb-detail"></span>
      <span class="lb-score">${p.count}</span>
    `;
    boardEl.appendChild(rowEl);
  });

  boardEl.insertAdjacentHTML('beforeend', skinsStripHtml(log, summaries, round.holeOffset));
}

function renderHistoryDetailMatch(summaries, round, metaEl, boardEl) {
  if (!round.matchTeamA || !round.matchTeamB || !round.matchTeamA.length || !round.matchTeamB.length) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">This round didn\'t have match play teams set.</div>';
    return;
  }

  const teamA = round.matchTeamA.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  const teamB = round.matchTeamB.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  if (!teamA.length || !teamB.length) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Match play players weren\'t found in this round.</div>';
    return;
  }

  const m = Golf.computeMatchPlay(teamA, teamB, round.holeCount, round.matchUseHandicap);
  const teamAName = teamA.map(s => s.name).join(' & ');
  const teamBName = teamB.map(s => s.name).join(' & ');

  metaEl.textContent = round.matchUseHandicap
    ? 'Head-to-head, best-ball net score per hole.'
    : 'Head-to-head, best-ball gross score per hole.';

  let resultText;
  if (m.diff === 0) {
    resultText = 'Match halved — all square';
  } else {
    const winnerName = m.diff > 0 ? teamAName : teamBName;
    resultText = m.remaining > 0
      ? `${winnerName} won ${m.margin}&${m.remaining}`
      : `${winnerName} won ${m.margin} up`;
  }

  boardEl.innerHTML = `
    <div class="history-match-result">
      <div class="history-match-teams">
        <span class="history-match-team">${escapeHtml(teamAName)}</span>
        <span class="history-match-vs">vs</span>
        <span class="history-match-team">${escapeHtml(teamBName)}</span>
      </div>
      <div class="history-match-outcome">${escapeHtml(resultText)}</div>
    </div>
  `;
}

function renderHistoryDetailSideMatch(summaries, round, metaEl, boardEl) {
  if (!round.sidematchTeamC || !round.sidematchTeamD || !round.sidematchTeamC.length || !round.sidematchTeamD.length) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">This round didn\'t have a side match set.</div>';
    return;
  }

  const teamC = round.sidematchTeamC.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  const teamD = round.sidematchTeamD.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  if (!teamC.length || !teamD.length) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Side match players weren\'t found in this round.</div>';
    return;
  }

  const m = Golf.computeMatchPlay(teamC, teamD, round.holeCount, round.sidematchUseHandicap);
  const teamCName = teamC.map(s => s.name).join(' & ');
  const teamDName = teamD.map(s => s.name).join(' & ');

  metaEl.textContent = round.sidematchUseHandicap
    ? 'Side match — head-to-head, best-ball net score per hole.'
    : 'Side match — head-to-head, best-ball gross score per hole.';

  let resultText;
  if (m.diff === 0) {
    resultText = 'Side match halved — all square';
  } else {
    const winnerName = m.diff > 0 ? teamCName : teamDName;
    resultText = m.remaining > 0
      ? `${winnerName} won ${m.margin}&${m.remaining}`
      : `${winnerName} won ${m.margin} up`;
  }

  boardEl.innerHTML = `
    <div class="history-match-result">
      <div class="history-match-teams">
        <span class="history-match-team">${escapeHtml(teamCName)}</span>
        <span class="history-match-vs">vs</span>
        <span class="history-match-team">${escapeHtml(teamDName)}</span>
      </div>
      <div class="history-match-outcome">${escapeHtml(resultText)}</div>
    </div>
  `;
}

function renderHistoryDetailNassau(summaries, round, metaEl, boardEl) {
  if (!round.matchTeamA || !round.matchTeamB || !round.matchTeamA.length || !round.matchTeamB.length) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">This round didn\'t have Nassau teams set.</div>';
    return;
  }
  const teamA = round.matchTeamA.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  const teamB = round.matchTeamB.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  if (!teamA.length || !teamB.length) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Nassau players weren\'t found in this round.</div>';
    return;
  }

  const aName = teamA.map(s => s.name).join(' & ');
  const bName = teamB.map(s => s.name).join(' & ');
  const useHc = round.matchUseHandicap;
  const stroke = round.nassauFormat === 'stroke';
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
      result = s.thru === 0 ? 'Not played' : (s.leader === null ? 'All square' : `${s.leader === 'A' ? aName : bName} by ${s.diff}`);
      if (s.thru > 0) sub = `${s.teamATotal}–${s.teamBTotal}`;
    } else {
      const m = Golf.computeMatchPlayRange(teamA, teamB, seg.from, seg.to, useHc);
      result = matchSegmentStatus(m, aName, bName, seg.to - seg.from + 1);
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

function renderHistoryDetailSixes(summaries, round, metaEl, boardEl) {
  if (!Array.isArray(round.sixesPlayers) || round.sixesPlayers.length !== 4) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">This round didn\'t have Sixes set.</div>';
    return;
  }
  const seats = round.sixesPlayers.map(id => summaries.find(s => s.playerId === id) || null);
  if (seats.some(s => !s)) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Sixes players weren\'t found in this round.</div>';
    return;
  }

  const useHc = round.sixesUseHandicap;
  const stroke = round.sixesFormat === 'stroke';
  metaEl.textContent = `${stroke ? 'Stroke' : 'Match'} play · best-ball ${useHc ? 'net' : 'gross'} · partners rotate every six.`;
  const pairName = idxs => idxs.map(i => seats[i].name).join(' & ');

  const blocks = Golf.sixesSegments().map(seg => {
    const teamX = seg.teamX.map(i => seats[i]);
    const teamY = seg.teamY.map(i => seats[i]);
    let result;
    if (stroke) {
      const s = Golf.computeStrokeRange(teamX, teamY, seg.from, seg.to, useHc);
      result = s.thru === 0 ? 'Not played'
        : s.leader === null ? `All square (${s.teamATotal}–${s.teamBTotal})`
        : `${s.leader === 'A' ? pairName(seg.teamX) : pairName(seg.teamY)} by ${s.diff} (${s.teamATotal}–${s.teamBTotal})`;
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

// ===========================================================
// Read-only scorecard grid: holes down the rows, players across
// the columns. The hole column is frozen so extra players scroll
// sideways. Scores are colored vs par (circle under, square over).
// ===========================================================

function firstName(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/)[0];
}

// One score cell, marked by result relative to par.
function scoreCell(gross, par, isMe, putts) {
  const meCls = isMe ? ' sc-me' : '';
  if (gross == null) return `<td class="sc-score${meCls}">–</td>`;
  const diff = Number(gross) - par;
  let mark = '';
  if (diff <= -2) mark = ' sc-eagle';
  else if (diff === -1) mark = ' sc-birdie';
  else if (diff === 1) mark = ' sc-bogey';
  else if (diff >= 2) mark = ' sc-double';
  const puttTag = putts != null ? `<span class="sc-putt">${putts}</span>` : '';
  return `<td class="sc-score${meCls}"><span class="sc-mark${mark}">${gross}</span>${puttTag}</td>`;
}

function renderHistoryScorecard(round) {
  const wrap = document.getElementById('history-scorecard');
  if (!wrap) return;
  const pars = round.pars || [];
  const hc = round.holeCount;
  const offset = round.holeOffset || 0;
  const players = round.players;
  const meId = historyDetailUserId;

  const isMe = (p) => !!(meId && p.user_id === meId);

  // Header: corner + one column per player.
  let head = '<th class="sc-rowhead sc-corner">Hole</th>';
  players.forEach(p => {
    head += `<th class="sc-playercol${isMe(p) ? ' sc-me' : ''}" title="${escapeAttr(p.name)}">${escapeHtml(firstName(p.name))}</th>`;
  });

  const rows = [];

  const holeRow = (h) => {
    const par = pars[h - 1] || 4;
    let cells = `<th class="sc-rowhead"><span class="sc-holenum">${h + offset}</span><span class="sc-holepar">par ${par}</span></th>`;
    players.forEach(p => { cells += scoreCell(p.scores[String(h)], par, isMe(p), p.putts ? p.putts[String(h)] : null); });
    rows.push(`<tr>${cells}</tr>`);
  };

  const sumRow = (label, from, to) => {
    let parSum = 0;
    for (let h = from; h <= to; h++) parSum += (pars[h - 1] || 4);
    let cells = `<th class="sc-rowhead"><span class="sc-holenum">${label}</span><span class="sc-holepar">par ${parSum}</span></th>`;
    players.forEach(p => {
      let total = 0, any = false, puttTotal = 0, anyPutt = false;
      for (let h = from; h <= to; h++) {
        const g = p.scores[String(h)];
        if (g != null) { total += Number(g); any = true; }
        const pt = p.putts ? p.putts[String(h)] : null;
        if (pt != null) { puttTotal += Number(pt); anyPutt = true; }
      }
      const puttTag = anyPutt ? `<span class="sc-putt">${puttTotal}</span>` : '';
      cells += `<td class="sc-sub${isMe(p) ? ' sc-me' : ''}">${any ? total : '–'}${puttTag}</td>`;
    });
    rows.push(`<tr class="sc-subrow">${cells}</tr>`);
  };

  if (hc > 9) {
    for (let h = 1; h <= 9; h++) holeRow(h);
    sumRow('OUT', 1, 9);
    for (let h = 10; h <= hc; h++) holeRow(h);
    sumRow('IN', 10, hc);
    sumRow('TOTAL', 1, hc);
  } else {
    for (let h = 1; h <= hc; h++) holeRow(h);
    sumRow('TOTAL', 1, hc);
  }

  wrap.innerHTML = `
    <h3 class="history-scorecard-title">Scorecard</h3>
    <div class="scorecard-scroll">
      <table class="scorecard-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>
    <p class="scorecard-key">Gross strokes · <span class="sc-putt">putts</span> · ○ under par · □ over par</p>
  `;
}
