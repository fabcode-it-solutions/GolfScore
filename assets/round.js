'use strict';

/* ===========================================================
   round.js — everything about an in-progress round: pulling
   state from Supabase, the realtime subscription, the
   scorecard tab (entering strokes), and the leaderboard tab
   (gross/net/stableford/skins/match play).

   Data model (see supabase_schema.sql):
   - rounds(id, code, course_name, hole_count, pars, modes,
            match_player_a, match_player_b, host_player_id,
            started, ended)
   - players(id, round_id, name, handicap)
   - scores(id, player_id, hole, strokes)

   Depends on: core.js (state, escapeHtml, showToast, showScreen),
   golf.js (Golf), lobby.js (goHome, enterRound is called from here
   but defined below — see note at populateModeTabs).
=========================================================== */

// ---------------------------------------------------------
// Mapping raw Supabase rows into the in-memory round shape
// ---------------------------------------------------------

// Builds the per-hole { "1": strokes, ... } object for one player.
function mapPlayerScores(scoreRows, playerId) {
  const scores = {};
  scoreRows
    .filter(s => s.player_id === playerId)
    .forEach(s => { scores[String(s.hole)] = s.strokes; });
  return scores;
}

// Builds the per-hole { "1": putts, ... } object for one player.
// Putts are optional, so holes without a recorded count are simply absent.
function mapPlayerPutts(scoreRows, playerId) {
  const putts = {};
  scoreRows
    .filter(s => s.player_id === playerId)
    .forEach(s => { if (s.putts != null) putts[String(s.hole)] = s.putts; });
  return putts;
}

// Turns raw player rows + score rows into the player objects the app
// uses (handicap coerced to a number, scores keyed by hole).
function mapPlayers(playerRows, scoreRows) {
  return playerRows.map(p => ({
    ...p,
    handicap: Number(p.handicap) || 0,
    team: p.team != null ? Number(p.team) : null, // tournament team number (1..8), or null
    isCaptain: p.is_captain === true,             // tournament captain flag
    scores: mapPlayerScores(scoreRows, p.id),
    putts: mapPlayerPutts(scoreRows, p.id),
  }));
}

// Turns a raw round row + already-mapped players into state.round.
// Both the RPC path and the direct-read path funnel through here, so
// this is the single place to touch when a round column is added.
function mapRoundRow(row, players) {
  return {
    id: row.id, code: row.code, courseName: row.course_name, holeCount: row.hole_count,
    pars: row.pars, modes: row.modes, strokeIndex: row.stroke_index || null,
    matchTeamA: row.match_team_a || null, matchTeamB: row.match_team_b || null,
    matchUseHandicap: row.match_use_handicap !== false,
    sidematchTeamC: row.sidematch_team_c || null, sidematchTeamD: row.sidematch_team_d || null,
    sidematchUseHandicap: row.sidematch_use_handicap !== false,
    nassauFormat: row.nassau_format || 'match',
    sixesPlayers: row.sixes_players || null,
    sixesFormat: row.sixes_format || 'match',
    sixesUseHandicap: row.sixes_use_handicap !== false,
    hostId: row.host_player_id, started: row.started, ended: row.ended,
    holeOffset: row.hole_offset || 0,
    betsEnabled: row.bets_enabled === true, stakes: row.stakes || {},
    inviteExpiresAt: row.invite_expires_at, inviteRevoked: row.invite_revoked === true,
    isTournament: row.is_tournament === true,
    teamCount: row.team_count != null ? Number(row.team_count) : null,
    tournamentMatches: row.tournament_matches || null,
    players,
  };
}

// ---------------------------------------------------------
// Loading a round's full state from Supabase
// ---------------------------------------------------------
async function loadRound(roundId) {
  if (!state.myPlayerId) {
    return state.round;
  }

  // Already a confirmed member — use real, RLS-protected reads.
  const { data: roundRow, error: roundErr } = await supabaseClient
    .from('rounds').select('*').eq('id', roundId).single();
  if (roundErr || !roundRow) {
    showToast('This round no longer exists');
    goHome();
    return null;
  }

  const { data: playerRows, error: playersErr } = await supabaseClient
    .from('players').select('*').eq('round_id', roundId).order('created_at', { ascending: true });
  if (playersErr) { showToast('Could not load players'); return null; }

  const playerIds = playerRows.map(p => p.id);
  let scoreRows = [];
  if (playerIds.length > 0) {
    const { data: sRows, error: scoresErr } = await supabaseClient
      .from('scores').select('*').in('player_id', playerIds);
    if (scoresErr) { showToast('Could not load scores'); return null; }
    scoreRows = sRows;
  }

  const players = mapPlayers(playerRows, scoreRows);
  state.round = mapRoundRow(roundRow, players);
  return state.round;
}
// ---------------------------------------------------------
// Realtime subscription
// ---------------------------------------------------------
function subscribeToRound(roundId) {
  if (state.realtimeChannel) {
    supabaseClient.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }

  const channel = supabaseClient
    .channel('round-' + roundId)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rounds', filter: `id=eq.${roundId}` },
      (payload) => {
        // Caught the moment the host cancels the round — everyone else
        // gets sent home with a heads-up, since there's no finished
        // leaderboard to show for a round that was cut short.
        if (payload.new && payload.new.cancelled === true) {
          handleRoundCancelledRemotely();
          return;
        }
        // Caught the moment the host ends the round — jump straight to
        // the final leaderboard instead of doing a normal reload, since
        // the round is about to be archived and deleted out from under us.
        if (payload.new && payload.new.ended === true && state.round && !state.round.ended) {
          enterFinalLeaderboard();
        } else {
          onRoundChanged(roundId);
        }
      })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rounds', filter: `id=eq.${roundId}` },
      () => onRoundChanged(roundId))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `round_id=eq.${roundId}` },
      () => onRoundChanged(roundId))
    // scores rows key on player_id (no round_id), so this subscription can't be
    // filtered server-side and receives EVERY score change app-wide. Filter by
    // the payload's player_id so we only reload when a player in THIS round is
    // affected — otherwise an unrelated round's score would reload us needlessly.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'scores' },
      (payload) => { if (scoreEventInThisRound(payload)) onRoundChanged(roundId); })
    .subscribe();

  state.realtimeChannel = channel;
}

// True when a realtime scores event belongs to a player in the current round.
// INSERT/UPDATE payloads carry the full new row (with player_id); a DELETE with
// default replica identity carries only the PK, so player_id is unknown — we
// return true there (rare; safe fallback to a reload rather than miss a change).
function scoreEventInThisRound(payload) {
  const pid = (payload && payload.new && payload.new.player_id)
    || (payload && payload.old && payload.old.player_id);
  if (!pid) return true;
  return !!(state.round && state.round.players && state.round.players.some(p => p.id === pid));
}

let reloadTimer = null;
function onRoundChanged(roundId) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    if (!state.myPlayerId) return; // not a confirmed member yet — nothing to refresh
    await loadRound(roundId);
    onRoundUpdate();
  }, 150);
}

function onRoundUpdate() {
  if (!state.round) return;
  const activeId = document.querySelector('.screen.active')?.id;
  if (activeId === 'screen-lobby') renderLobby();
  if (activeId === 'screen-round') {
    if (state.round.started === false) {
      // Host started it elsewhere, or we're still waiting — re-check.
    }
    renderRoundHeader();
    renderScoringSelector();
    renderScorecardTab();
    renderLeaderboardTab();
  }
  if (activeId === 'screen-lobby' && state.round.started) {
    enterRound();
  }
}

// ---------------------------------------------------------
// Entering the round proper
// ---------------------------------------------------------
function enterRound() {
  saveSession();
  state.scoringPlayerId = state.myPlayerId;
  renderScoringSelector();
  populateModeTabs();
  state.currentHole = 1;
  showScreen('screen-round');
  setTab('card');
  renderRoundHeader();
  renderScorecardTab();
  renderLeaderboardTab();
}

// Lets the host pick any player from a dropdown and enter scores on
// their behalf. Everyone else just sees a static "Entering for you"
// label, same as before.

// The players the current user is allowed to enter scores for:
// - Tournament: your own team if you're a captain, otherwise just yourself.
//   (The host is NOT a global editor in a tournament.)
// - Regular round: everyone if you're the host, otherwise just yourself.
function scoringCandidates() {
  const r = state.round;
  const me = myPlayer();
  if (r.isTournament) {
    if (me && me.isCaptain && me.team != null) {
      return r.players.filter(p => p.team === me.team);
    }
    return me ? [me] : [];
  }
  if (isHost()) return r.players;
  return me ? [me] : [];
}

function renderScoringSelector() {
  const label = document.getElementById('scoring-for-label');
  const select = document.getElementById('scoring-for-select');
  const candidates = scoringCandidates();

  // Only one player to score for → a static label, no dropdown.
  if (candidates.length <= 1) {
    const me = myPlayer();
    label.textContent = me ? `Entering for ${me.name}` : 'Entering for you';
    label.hidden = false;
    select.hidden = true;
    return;
  }

  // Keep the active pick within what you're allowed to score.
  if (!candidates.some(p => p.id === state.scoringPlayerId)) {
    state.scoringPlayerId = state.myPlayerId;
  }

  label.textContent = 'Scoring for';
  select.hidden = false;
  select.innerHTML = candidates.map(p =>
    `<option value="${p.id}" ${p.id === state.scoringPlayerId ? 'selected' : ''}>${escapeHtml(p.name)}${p.id === state.myPlayerId ? ' (you)' : ''}</option>`
  ).join('');
}

function populateModeTabs() {
  const modes = roundBoardModes(state.round);
  state.activeModeTab = modes[0];
  const row = document.getElementById('modetab-row');
  row.innerHTML = modes.map(m =>
    `<button class="modetab ${m === state.activeModeTab ? 'active' : ''}" data-mode="${m}">${MODE_NAMES[m] || m}</button>`
  ).join('');
  row.querySelectorAll('.modetab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeModeTab = btn.dataset.mode;
      row.querySelectorAll('.modetab').forEach(b => b.classList.toggle('active', b === btn));
      renderLeaderboardTab();
    });
  });
}

function renderRoundHeader() {
  const r = state.round;
  document.getElementById('round-course-name').textContent = r.courseName;
  document.getElementById('round-meta').textContent = r.ended
    ? `${r.holeCount} holes · Final results`
    : `${r.holeCount} holes · Thru ${Golf.groupThru(r.players, r.holeCount)}`;
  const hostControls = isHost() && !r.ended;
  document.getElementById('btn-cancel-round').hidden = !hostControls;
  document.getElementById('btn-edit-round').hidden = !hostControls;
  document.getElementById('btn-round-feedback').hidden = !r.ended;
  // With all four buttons showing, the footer divider is a full "+"; otherwise
  // (2 buttons) only the vertical line applies.
  document.querySelector('.round-footer-grid')?.classList.toggle('is-quad', hostControls);
}

// ---------------------------------------------------------
// Ending the round
// ---------------------------------------------------------

// Called on every client the moment rounds.ended flips to true —
// either right after the host's own end_round call, or via the
// realtime UPDATE everyone else receives. Switches to the leaderboard
// tab and stops listening for further changes, since the round is
// about to be archived and deleted.
function enterFinalLeaderboard() {
  if (state.realtimeChannel) {
    supabaseClient.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  state.round.ended = true;
  setTab('board');
  renderRoundHeader();
  renderScorecardTab();
  renderLeaderboardTab();
}

// Host-only: validates every player has a score for every hole, then
// ends the round. end_round() flips rounds.ended to true (which
// broadcasts to everyone over realtime) and archive_round() — called
// a couple seconds later, giving that broadcast time to land on every
// device — snapshots the round and deletes the live row.
async function endRound() {
  if (state.endingRound) return;
  const r = state.round;

  const missing = Golf.findMissingScores(r.players, r.holeCount);
  if (missing.length > 0) {
    const detail = missing
      .map(m => `${m.name} (hole${m.missingHoles.length > 1 ? 's' : ''} ${m.missingHoles.join(', ')})`)
      .join('; ');
    showToast(`Still missing scores — ${detail}`);
    return;
  }

  state.endingRound = true;
  const { error } = await supabaseClient.rpc('end_round', { p_round_id: r.id });
  if (error) {
    console.error(error);
    showToast('Could not end the round — check your connection');
    state.endingRound = false;
    return;
  }

  enterFinalLeaderboard();

  setTimeout(async () => {
    const { error: archiveErr } = await supabaseClient.rpc('archive_round', { p_round_id: r.id });
    if (archiveErr) console.error(archiveErr);
    state.endingRound = false;
  }, 2000);
}

// ---------------------------------------------------------
// Cancelling a round early (host-only) — reachable from the lobby,
// the live round screen, and the View Rounds > In Progress list.
// Unlike endRound(), this never checks for missing scores and works
// whether or not the round has started yet.
// ---------------------------------------------------------

// Fires on every OTHER connected client the instant the host cancels
// the round. There's no finished leaderboard to show, so this just
// unsubscribes and sends them home with a toast.
function handleRoundCancelledRemotely() {
  if (state.realtimeChannel) {
    supabaseClient.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  showToast('The host cancelled this round');
  goHome();
}

// Cancels a round by id. Works whether or not that round is the one
// currently loaded into state — callers from the resume list pass an
// id for a round that was never loaded on this device at all.
async function cancelRoundById(roundId) {
  const { error } = await supabaseClient.rpc('cancel_round', { p_round_id: roundId });
  if (error) {
    console.error(error);
    showToast('Could not cancel the round — check your connection');
    return false;
  }

  showToast('Round cancelled');

  // If we were actually inside this round, back out of it cleanly —
  // same cleanup goHome() already does (unsubscribe, clear session).
  if (state.roundId === roundId) {
    goHome();
  }

  return true;
}

// Confirmation modal plumbing, shared by the lobby, the live round
// screen, and the resume-rounds "In Progress" list.
let pendingCancelRoundId = null;

function promptCancelRound(roundId) {
  if (!roundId) return;
  pendingCancelRoundId = roundId;
  document.getElementById('cancel-round-confirm-modal').hidden = false;
}

function dismissCancelRoundPrompt() {
  pendingCancelRoundId = null;
  document.getElementById('cancel-round-confirm-modal').hidden = true;
}

async function confirmCancelRound() {
  const roundId = pendingCancelRoundId;
  document.getElementById('cancel-round-confirm-modal').hidden = true;
  pendingCancelRoundId = null;
  if (!roundId) return;

  const cancelled = await cancelRoundById(roundId);
  if (!cancelled) return;

  // If the "In Progress Rounds" tab is what's currently on screen,
  // refresh it so the cancelled round disappears from the list.
  const tab = document.getElementById('tab-inprogress-rounds');
  if (tab && !tab.hidden) {
    await loadInProgressRoundsTab();
  }
}

// ---------------------------------------------------------
// Tabs
// ---------------------------------------------------------
function setTab(tab) {
  state.activeTab = tab;
  // Scoped to the round screen so the friend-rounds tabs (which reuse
  // .tab / .tabbar for styling) are never toggled by this handler.
  document.querySelectorAll('#round-tabbar .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('#screen-round .tabpanel').forEach(p => p.classList.remove('active'));
  document.getElementById(tab === 'card' ? 'tab-card' : 'tab-board').classList.add('active');
  if (tab === 'board') renderLeaderboardTab();
}

