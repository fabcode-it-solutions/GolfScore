'use strict';

/* ===========================================================
   setup.js — the "new round" screen: player list, par grid,
   game mode selection, and creating the round in Supabase.
   Depends on: core.js (state, uid, escapeHtml/escapeAttr)
=========================================================== */

function renderParGrid() {
  const holeCount = Number(document.getElementById('hole-count').value);
  const grid = document.getElementById('par-grid');
  grid.innerHTML = '';
  // Back nine of an 18-hole course: holes are still stored as positions
  // 1..9 internally (data-hole, which the scoring logic depends on), but
  // we label them 10..18 so the grid matches the scorecard on the course.
  const labelOffset = state.selectedCourseNine === 'back' ? 9 : 0;
  for (let h = 1; h <= holeCount; h++) {
    const cell = document.createElement('div');
    cell.className = 'par-cell';
    cell.innerHTML = `
      <span class="par-cell-label">${h + labelOffset}</span>
      <span class="par-cell-sublabel">Par</span>
      <input type="number" class="par-input" data-hole="${h}" min="2" max="6" placeholder="4" inputmode="numeric">
      <span class="par-cell-sublabel">Hcp</span>
      <input type="number" class="hole-hcp-input" data-hole="${h}" min="1" max="${holeCount}" inputmode="numeric">
    `;
    grid.appendChild(cell);
  }
}

function renderSetupPlayerList() {
  const wrap = document.getElementById('player-list');
  wrap.innerHTML = '';
  state.setupPlayers.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    // In edit mode, players already saved to the round (existing) are locked:
    // their name/handicap can't be edited here and they can't be removed, so a
    // mid-round edit never disturbs someone who already has scores.
    const dis = p.existing ? 'disabled' : '';
    const removeBtn = p.existing
      ? ''
      : `<button class="player-row-remove" data-id="${p.id}" aria-label="Remove player">×</button>`;
    row.innerHTML = `
      <input type="text" value="${escapeAttr(p.name)}" placeholder="Player name" data-id="${p.id}" class="setup-name-input" ${dis}>
      <span class="hcp-label">HCP</span>
      <input type="number" value="${p.handicap}" data-id="${p.id}" class="hcp-input setup-hcp-input" inputmode="decimal" min="0" max="54" step="0.1" placeholder="0" ${dis}>
      ${removeBtn}
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('.setup-name-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const p = state.setupPlayers.find(x => x.id === e.target.dataset.id);
      if (p) p.name = e.target.value;
      renderMatchAssignList();
      renderSideMatchAssignList();
      renderSixesAssignList();
      renderTeamAssignList();
    });
  });
  wrap.querySelectorAll('.setup-hcp-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const p = state.setupPlayers.find(x => x.id === e.target.dataset.id);
      if (p) p.handicap = parseHandicap(e.target.value);
    });
    inp.addEventListener('blur', async e => {
      const isHostRow = state.setupPlayers[0] && state.setupPlayers[0].id === e.target.dataset.id;
      if (!isHostRow) return;

      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) return;

      const p = state.setupPlayers.find(x => x.id === e.target.dataset.id);
      if (!p) return;

      await supabaseClient
        .from('user_profiles')
        .update({ default_handicap: p.handicap })
        .eq('id', user.id);
    });
  });
  wrap.querySelectorAll('.player-row-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      state.setupPlayers = state.setupPlayers.filter(x => x.id !== e.target.dataset.id);
      renderSetupPlayerList();
      renderMatchAssignList();
      renderSideMatchAssignList();
      renderSixesAssignList();
      renderTeamAssignList();
    });
  });

  renderMatchAssignList();
  renderSideMatchAssignList();
  renderSixesAssignList();
  renderTeamAssignList();
}

// Builds the team-assignment list shown when "Match play" is checked.
// Each player gets a select: not in match / Team A / Team B. Re-renders
// preserve existing picks (matched by player id) so editing a name or
// adding another player doesn't wipe out assignments already made.
function renderMatchAssignList() {
  const wrap = document.getElementById('match-assign-list');
  if (!wrap) return;

  const previous = {};
  wrap.querySelectorAll('.match-assign-select').forEach(sel => {
    previous[sel.dataset.id] = sel.value;
  });

  wrap.innerHTML = '';
  state.setupPlayers.forEach(p => {
    const label = p.name || 'Unnamed player';
    const row = document.createElement('div');
    row.className = 'match-assign-row';
    row.innerHTML = `
      <span class="match-assign-name">${escapeHtml(label)}</span>
      <select class="match-assign-select" data-id="${p.id}">
        <option value="">Not in match</option>
        <option value="A">Team A</option>
        <option value="B">Team B</option>
      </select>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('.match-assign-select').forEach(sel => {
    if (previous[sel.dataset.id]) sel.value = previous[sel.dataset.id];
  });
}

// Reads the team selects into { teamA: [ids], teamB: [ids] }, only
// counting players who currently have a name entered.
function collectMatchAssignments() {
  const validIds = new Set(state.setupPlayers.filter(p => p.name.trim()).map(p => p.id));
  const teamA = [], teamB = [];
  document.querySelectorAll('.match-assign-select').forEach(sel => {
    if (!validIds.has(sel.dataset.id)) return;
    if (sel.value === 'A') teamA.push(sel.dataset.id);
    else if (sel.value === 'B') teamB.push(sel.dataset.id);
  });
  return { teamA, teamB };
}

// Side match is a separate head-to-head (Team C vs Team D) that runs alongside
// the main game — so it has its own assignment list, letting a player be on a
// main-match team AND in the side match. Mirrors renderMatchAssignList.
function renderSideMatchAssignList() {
  const wrap = document.getElementById('sidematch-assign-list');
  if (!wrap) return;

  const previous = {};
  wrap.querySelectorAll('.sidematch-assign-select').forEach(sel => {
    previous[sel.dataset.id] = sel.value;
  });

  wrap.innerHTML = '';
  state.setupPlayers.forEach(p => {
    const label = p.name || 'Unnamed player';
    const row = document.createElement('div');
    row.className = 'match-assign-row';
    row.innerHTML = `
      <span class="match-assign-name">${escapeHtml(label)}</span>
      <select class="sidematch-assign-select" data-id="${p.id}">
        <option value="">Not in side match</option>
        <option value="C">Team C</option>
        <option value="D">Team D</option>
      </select>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('.sidematch-assign-select').forEach(sel => {
    if (previous[sel.dataset.id]) sel.value = previous[sel.dataset.id];
  });
}

// Reads the side-match selects into { teamC: [ids], teamD: [ids] }.
function collectSideMatchAssignments() {
  const validIds = new Set(state.setupPlayers.filter(p => p.name.trim()).map(p => p.id));
  const teamC = [], teamD = [];
  document.querySelectorAll('.sidematch-assign-select').forEach(sel => {
    if (!validIds.has(sel.dataset.id)) return;
    if (sel.value === 'C') teamC.push(sel.dataset.id);
    else if (sel.value === 'D') teamD.push(sel.dataset.id);
  });
  return { teamC, teamD };
}

// Validates a side-match team pick; returns an error message, or '' if valid.
// (Disjointness is enforced by the single per-player select, but we guard anyway.)
function sideMatchError(teamC, teamD) {
  if (teamC.length === 0 || teamD.length === 0) return 'Assign a player to each side-match team';
  if (teamC.length > 3 || teamD.length > 3) return 'Side-match teams can have at most 3 players each';
  if (teamC.some(id => teamD.includes(id))) return 'A player can\'t be on both side-match teams';
  return '';
}

// Sixes needs exactly four players in a seat order (the rotation is fixed by
// seat). Each player gets a "seat 1-4 / not in" select. Mirrors the match
// assign list, preserving picks across re-renders.
function renderSixesAssignList() {
  const wrap = document.getElementById('sixes-assign-list');
  if (!wrap) return;

  const previous = {};
  wrap.querySelectorAll('.sixes-assign-select').forEach(sel => {
    previous[sel.dataset.id] = sel.value;
  });

  wrap.innerHTML = '';
  state.setupPlayers.forEach(p => {
    const label = p.name || 'Unnamed player';
    const row = document.createElement('div');
    row.className = 'match-assign-row';
    row.innerHTML = `
      <span class="match-assign-name">${escapeHtml(label)}</span>
      <select class="sixes-assign-select" data-id="${p.id}">
        <option value="">Not in sixes</option>
        <option value="1">Seat 1</option>
        <option value="2">Seat 2</option>
        <option value="3">Seat 3</option>
        <option value="4">Seat 4</option>
      </select>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('.sixes-assign-select').forEach(sel => {
    if (previous[sel.dataset.id]) sel.value = previous[sel.dataset.id];
  });
}

// Reads the sixes seat selects into an ordered [seat1, seat2, seat3, seat4]
// array of player ids. Returns { players, error } — error is '' when exactly
// four distinct seats (1-4) are filled by named players.
function collectSixesPlayers() {
  const validIds = new Set(state.setupPlayers.filter(p => p.name.trim()).map(p => p.id));
  const bySeat = {};
  let assigned = 0;
  document.querySelectorAll('.sixes-assign-select').forEach(sel => {
    if (!validIds.has(sel.dataset.id) || !sel.value) return;
    assigned += 1;
    if (bySeat[sel.value]) bySeat[sel.value] = 'DUP';
    else bySeat[sel.value] = sel.dataset.id;
  });
  const seats = ['1', '2', '3', '4'];
  if (assigned !== 4 || seats.some(s => !bySeat[s] || bySeat[s] === 'DUP')) {
    return { players: [], error: 'Sixes needs exactly four players, one in each seat (1-4)' };
  }
  return { players: seats.map(s => bySeat[s]), error: '' };
}

// ---------------------------------------------------------
// Tournament setup — team assignment and manual match pairings.
// A tournament reuses the whole setup screen; these helpers drive the
// tournament-only fields. Up to 16 players, split across a host-chosen
// number of teams (2-16); every player must be on a team.
// ---------------------------------------------------------
function tournamentTeamCount() {
  return state.setupTeamCount || 2;
}

const TEAM_COUNT_MIN = 2;
const TEAM_COUNT_MAX = 16;

// Clamps and applies a +/-1 change from the team-count stepper, then
// re-scopes the team/pairing selects and re-balances if auto-assign is on.
function setTeamCount(delta) {
  state.setupTeamCount = Math.max(TEAM_COUNT_MIN, Math.min(TEAM_COUNT_MAX, (state.setupTeamCount || 2) + delta));
  renderTeamCountStepper();
  renderTeamAssignList();
  renderTournamentMatchList();
  applyAutoAssign();
}

function renderTeamCountStepper() {
  const el = document.getElementById('team-count-number');
  if (el) el.textContent = String(state.setupTeamCount || 2);
  document.querySelector('.team-count-minus')?.toggleAttribute('disabled', (state.setupTeamCount || 2) <= TEAM_COUNT_MIN);
  document.querySelector('.team-count-plus')?.toggleAttribute('disabled', (state.setupTeamCount || 2) >= TEAM_COUNT_MAX);
}

function isAutoAssign() {
  return !!document.getElementById('auto-assign-teams')?.checked;
}

// Fills the team selects with a handicap-balanced auto-assignment (leaving them
// editable so the organizer can tweak). Runs only when the toggle is switched
// on or the team count changes while it's on — never on a plain re-render — so
// manual edits and typed handicaps aren't clobbered. Shows a hint instead when
// there aren't enough players to fill every team.
function applyAutoAssign() {
  const hint = document.getElementById('auto-assign-hint');
  if (!isAutoAssign()) { if (hint) hint.hidden = true; return; }

  const named = state.setupPlayers.filter(p => p.name.trim());
  const { assignments, teams } = Golf.balanceTeamsByHandicap(named, tournamentTeamCount());
  if (!teams) {
    if (hint) {
      hint.textContent = `Add at least ${tournamentTeamCount()} players to auto-assign into ${tournamentTeamCount()} teams.`;
      hint.hidden = false;
    }
    return;
  }
  if (hint) hint.hidden = true;
  document.querySelectorAll('.team-assign-select').forEach(sel => {
    const team = assignments[sel.dataset.id];
    sel.value = team ? String(team) : '';
  });
}

// Toggles the setup screen between normal-round and tournament presentation:
// which mode cards / config fields are available, the title and primary
// button text, and the team + pairing fields.
function syncTournamentUI() {
  const t = !!state.setupIsTournament;
  document.querySelectorAll('#screen-setup .tournament-only').forEach(el => { el.hidden = !t; });
  document.querySelectorAll('#screen-setup .regular-only').forEach(el => { el.hidden = t; });

  // Modes exclusive to the other context can't stay checked.
  document.querySelectorAll('#mode-grid .regular-only input[name="mode"]').forEach(cb => {
    if (t && cb.checked) { cb.checked = false; cb.closest('.mode-card').classList.remove('checked'); }
  });
  if (!t) {
    const bb = document.querySelector('#mode-grid input[value="bestball"]');
    if (bb && bb.checked) { bb.checked = false; bb.closest('.mode-card').classList.remove('checked'); }
  }

  if (!state.editingRoundId) {
    const title = document.querySelector('#screen-setup .topbar-title');
    if (title) title.textContent = t ? 'New tournament' : 'New round';
    const createBtn = document.getElementById('btn-create-round');
    if (createBtn) createBtn.textContent = t ? 'Create tournament & get code' : 'Create round & get code';
  }

  syncModeConfigFields();
  if (t) { renderTeamAssignList(); renderTournamentMatchList(); }
}

// Team-assignment list: each player gets a team select (1..N) and a captain
// checkbox. Preserves picks across re-renders by player id; a team pick above
// the current max (after lowering the team count) is dropped.
function renderTeamAssignList() {
  const wrap = document.getElementById('team-assign-list');
  if (!wrap) return;

  const prev = {};
  wrap.querySelectorAll('.team-assign-row').forEach(row => {
    prev[row.dataset.id] = {
      team: row.querySelector('.team-assign-select')?.value || '',
      captain: !!row.querySelector('.team-captain-toggle')?.checked,
    };
  });

  const count = tournamentTeamCount();
  const opts = ['<option value="">No team</option>']
    .concat(Array.from({ length: count }, (_, i) => `<option value="${i + 1}">Team ${i + 1}</option>`))
    .join('');

  wrap.innerHTML = '';
  state.setupPlayers.forEach(p => {
    const row = document.createElement('div');
    row.className = 'team-assign-row match-assign-row';
    row.dataset.id = p.id;
    row.innerHTML = `
      <span class="match-assign-name">${escapeHtml(p.name || 'Unnamed player')}</span>
      <span class="team-assign-controls">
        <select class="team-assign-select" data-id="${p.id}">${opts}</select>
        <label class="team-captain-label"><input type="checkbox" class="team-captain-toggle" data-id="${p.id}"> Captain</label>
      </span>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('.team-assign-row').forEach(row => {
    const p = prev[row.dataset.id];
    if (!p) return;
    if (p.team && Number(p.team) <= count) row.querySelector('.team-assign-select').value = p.team;
    row.querySelector('.team-captain-toggle').checked = p.captain;
  });
}

// Reads team assignments into { assignments: {id: {team, captain}}, error }.
// Enforces: ≤16 players, every named player on a team, and ≥2 teams used.
// Team sizes are not capped — the host's chosen team count determines how
// many teams exist; auto-assign (and manual picks) may leave teams uneven
// by design. Captains are optional (a team with none simply has no one who
// can enter teammates' scores).
function collectTeams() {
  const players = state.setupPlayers.filter(p => p.name.trim());
  if (players.length > 16) return { assignments: {}, error: 'A tournament can have at most 16 players' };
  const validIds = new Set(players.map(p => p.id));

  const assignments = {};
  const byTeam = {};
  let unassigned = 0;
  document.querySelectorAll('.team-assign-select').forEach(sel => {
    if (!validIds.has(sel.dataset.id)) return;
    const team = Number(sel.value) || 0;
    if (!team) { unassigned += 1; return; }
    const captain = !!document.querySelector(`.team-captain-toggle[data-id="${sel.dataset.id}"]`)?.checked;
    assignments[sel.dataset.id] = { team, captain };
    (byTeam[team] = byTeam[team] || []).push(sel.dataset.id);
  });

  if (unassigned > 0) return { assignments: {}, error: 'Every player must be assigned to a team' };
  const teamNos = Object.keys(byTeam);
  if (teamNos.length < 2) return { assignments: {}, error: 'A tournament needs at least two teams' };
  return { assignments, error: '' };
}

// Manual match pairings, held in state.tournamentPairings as [{a,b}] of team
// numbers. Each row is two team selects plus a remove button.
function renderTournamentMatchList() {
  const wrap = document.getElementById('tournament-match-list');
  if (!wrap) return;
  if (!Array.isArray(state.tournamentPairings)) state.tournamentPairings = [];
  const count = tournamentTeamCount();
  const teamOpts = (selected) => ['<option value="">Team…</option>']
    .concat(Array.from({ length: count }, (_, i) =>
      `<option value="${i + 1}" ${String(i + 1) === String(selected) ? 'selected' : ''}>Team ${i + 1}</option>`))
    .join('');

  wrap.innerHTML = state.tournamentPairings.map((pair, idx) => `
    <div class="tournament-match-row match-assign-row" data-idx="${idx}">
      <select class="pairing-select" data-idx="${idx}" data-side="a">${teamOpts(pair.a)}</select>
      <span class="pairing-vs">vs</span>
      <select class="pairing-select" data-idx="${idx}" data-side="b">${teamOpts(pair.b)}</select>
      <button type="button" class="player-row-remove pairing-remove" data-idx="${idx}" aria-label="Remove match">×</button>
    </div>
  `).join('');

  wrap.querySelectorAll('.pairing-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const p = state.tournamentPairings[Number(sel.dataset.idx)];
      if (p) p[sel.dataset.side] = sel.value ? Number(sel.value) : null;
    });
  });
  wrap.querySelectorAll('.pairing-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tournamentPairings.splice(Number(btn.dataset.idx), 1);
      renderTournamentMatchList();
    });
  });
}

function addTournamentPairing() {
  if (!Array.isArray(state.tournamentPairings)) state.tournamentPairings = [];
  state.tournamentPairings.push({ a: null, b: null });
  renderTournamentMatchList();
}

// Returns the completed pairings as [{a,b}] of team numbers, or an error.
// Ignores half-filled rows; rejects self-matches and teams with no players.
function collectTournamentMatches(usedTeams) {
  const pairings = (state.tournamentPairings || []).filter(p => p.a && p.b);
  for (const p of pairings) {
    if (p.a === p.b) return { matches: [], error: 'A match must be between two different teams' };
    if (usedTeams && (!usedTeams.has(p.a) || !usedTeams.has(p.b))) {
      return { matches: [], error: 'A pairing references a team with no players' };
    }
  }
  return { matches: pairings.map(p => ({ a: p.a, b: p.b })), error: '' };
}

// Shows/hides the per-mode config fields from the currently-checked mode boxes
// and relabels the shared team field. Match play and Nassau share one Team A/B
// assignment, so the team field shows when either is on. In a tournament the
// single-round config fields stay hidden; only the team field (always) and the
// match-pairing field (when match play is on) apply.
function syncModeConfigFields() {
  const grid = document.getElementById('mode-grid');
  const isOn = v => !!grid.querySelector(`input[value="${v}"]`)?.checked;

  if (state.setupIsTournament) {
    document.getElementById('match-players-field').hidden = true;
    document.getElementById('sidematch-players-field').hidden = true;
    document.getElementById('nassau-format-field').hidden = true;
    document.getElementById('sixes-field').hidden = true;
    document.getElementById('tournament-teams-field').hidden = false;
    document.getElementById('tournament-match-field').hidden = !isOn('match');
    return;
  }

  document.getElementById('tournament-teams-field').hidden = true;
  document.getElementById('tournament-match-field').hidden = true;

  const matchOn = isOn('match');
  const nassauOn = isOn('nassau');
  document.getElementById('match-players-field').hidden = !(matchOn || nassauOn);
  document.getElementById('sidematch-players-field').hidden = !isOn('sidematch');
  document.getElementById('nassau-format-field').hidden = !nassauOn;
  document.getElementById('sixes-field').hidden = !isOn('sixes');

  const label = document.getElementById('match-players-label');
  if (label) {
    label.textContent = (matchOn && nassauOn) ? 'Match play & Nassau: assign teams'
      : nassauOn ? 'Nassau: assign teams'
      : 'Match play: assign teams';
  }
}

async function resetSetupScreen(isTournament = false) {
  state.setupIsTournament = !!isTournament;
  state.tournamentPairings = [];
  state.setupTeamCount = 2;
  renderTeamCountStepper();
  const autoAssign = document.getElementById('auto-assign-teams');
  if (autoAssign) autoAssign.checked = false;
  document.getElementById('auto-assign-hint').hidden = true;
  document.getElementById('tournament-match-use-handicap').checked = true;

  document.getElementById('course-name').value = '';
  document.getElementById('hole-count').value = '18';
  document.querySelectorAll('#mode-grid input[name="mode"]').forEach(cb => {
    if (cb.value !== 'gross') cb.checked = false;
    cb.closest('.mode-card').classList.toggle('checked', cb.checked);
  });
  document.getElementById('match-players-field').hidden = true;
  document.getElementById('match-use-handicap').checked = true;
  document.getElementById('sidematch-players-field').hidden = true;
  document.getElementById('sidematch-use-handicap').checked = true;
  document.getElementById('nassau-format-field').hidden = true;
  const nassauMatchRadio = document.querySelector('#nassau-format input[value="match"]');
  if (nassauMatchRadio) nassauMatchRadio.checked = true;
  document.getElementById('sixes-field').hidden = true;
  document.getElementById('sixes-use-handicap').checked = true;
  const sixesMatchRadio = document.querySelector('#sixes-format input[value="match"]');
  if (sixesMatchRadio) sixesMatchRadio.checked = true;
  state.setupBetsEnabled = false;
  state.setupStakes = {};
  document.getElementById('bets-enabled').checked = false;
  document.getElementById('set-stakes-field').hidden = true;

  let hostName = '';
  let hostHandicap = 0;
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (user) {
    const { data: profile } = await supabaseClient
      .from('user_profiles')
      .select('display_name, default_handicap')
      .eq('id', user.id)
      .single();
    if (profile) {
      hostName = profile.display_name;
      hostHandicap = Number(profile.default_handicap) || 0;
    }
  }

  state.selectedCourseStrokeIndex = null;
  state.selectedFullCourse = null;
  state.selectedCourseNine = null;
  document.getElementById('nine-select-field').hidden = true;
  document.querySelectorAll('.nine-btn').forEach(b => b.classList.remove('selected'));
  await renderCourseSelectOptions();
  state.setupPlayers = [{ id: uid('p'), name: hostName, handicap: hostHandicap }];
  renderParGrid();
  renderSetupPlayerList();
  state.editingRoundId = null;
  applySetupMode('create');
  syncTournamentUI();
}

// Toggles the setup screen between "create a new round" and "edit an existing
// round" presentation. In edit mode the settings that would disturb scoring
// once a round is live — the course, hole count, and pars/handicaps — are
// locked, and the title/primary button reflect saving rather than creating.
function applySetupMode(mode) {
  const editing = mode === 'edit';

  const title = document.querySelector('#screen-setup .topbar-title');
  if (title) title.textContent = editing ? 'Edit round' : 'New round';
  const createBtn = document.getElementById('btn-create-round');
  if (createBtn) createBtn.textContent = editing ? 'Save changes' : 'Create round & get code';

  const lock = (el) => { if (el) el.disabled = editing; };
  lock(document.getElementById('setup-course-search'));
  lock(document.getElementById('btn-setup-course-search'));
  lock(document.getElementById('hole-count'));
  document.querySelectorAll('#par-grid .par-input, #par-grid .hole-hcp-input')
    .forEach(inp => { inp.disabled = editing; });

  const hint = document.getElementById('setup-locked-hint');
  if (hint) hint.hidden = !editing;
}

// Opens the setup screen pre-filled from the current live round so the host
// can change the safe settings (course name, modes, stakes, match teams, and
// add players) mid-round. Reached from the "Edit round" footer button.
async function openRoundEditor() {
  const r = state.round;
  if (!r) return;
  state.editingRoundId = state.roundId;
  state.setupIsTournament = !!r.isTournament;
  // Swap the mode cards / config fields to the right context up front, so the
  // prefill below targets the fields that are actually on screen.
  document.querySelectorAll('#screen-setup .tournament-only').forEach(el => { el.hidden = !r.isTournament; });
  document.querySelectorAll('#screen-setup .regular-only').forEach(el => { el.hidden = !!r.isTournament; });

  document.getElementById('course-name').value = r.courseName || '';
  document.getElementById('hole-count').value = String(r.holeCount || 18);
  state.selectedCourseNine = r.holeOffset === 9 ? 'back' : null;

  document.querySelectorAll('#mode-grid input[name="mode"]').forEach(cb => {
    const on = cb.value === 'gross' || (r.modes || []).includes(cb.value);
    cb.checked = on;
    cb.closest('.mode-card').classList.toggle('checked', on);
  });
  const matchOn = (r.modes || []).includes('match');
  const nassauOn = (r.modes || []).includes('nassau');
  document.getElementById('match-use-handicap').checked = r.matchUseHandicap !== false;
  const sideMatchOn = (r.modes || []).includes('sidematch');
  document.getElementById('sidematch-use-handicap').checked = r.sidematchUseHandicap !== false;
  const nassauFmtRadio = document.querySelector(`#nassau-format input[value="${r.nassauFormat === 'stroke' ? 'stroke' : 'match'}"]`);
  if (nassauFmtRadio) nassauFmtRadio.checked = true;
  const sixesOn = (r.modes || []).includes('sixes');
  const sixesFmtRadio = document.querySelector(`#sixes-format input[value="${r.sixesFormat === 'stroke' ? 'stroke' : 'match'}"]`);
  if (sixesFmtRadio) sixesFmtRadio.checked = true;
  document.getElementById('sixes-use-handicap').checked = r.sixesUseHandicap !== false;
  syncModeConfigFields();

  const hasStakes = r.stakes && Object.keys(r.stakes).some(k => r.stakes[k] > 0);
  state.setupBetsEnabled = !!(r.betsEnabled || hasStakes);
  state.setupStakes = { ...(r.stakes || {}) };
  document.getElementById('bets-enabled').checked = state.setupBetsEnabled;
  document.getElementById('set-stakes-field').hidden = !state.setupBetsEnabled;

  // Existing players keep their real db id and are flagged so they can't be
  // removed or renamed here (see renderSetupPlayerList).
  state.setupPlayers = r.players.map(p => ({
    id: p.id,
    name: p.name,
    handicap: p.handicap || 0,
    existing: true,
    hasScores: !!(p.scores && Object.keys(p.scores).some(k => p.scores[k] != null)),
  }));

  renderParGrid();
  document.querySelectorAll('#par-grid .par-input').forEach(inp => {
    const h = Number(inp.dataset.hole);
    if (r.pars && r.pars[h - 1] != null) inp.value = r.pars[h - 1];
  });
  document.querySelectorAll('#par-grid .hole-hcp-input').forEach(inp => {
    const h = Number(inp.dataset.hole);
    if (r.strokeIndex && r.strokeIndex[h - 1] != null) inp.value = r.strokeIndex[h - 1];
  });

  renderSetupPlayerList();

  if (matchOn || nassauOn) {
    const teamA = new Set(r.matchTeamA || []);
    const teamB = new Set(r.matchTeamB || []);
    document.querySelectorAll('.match-assign-select').forEach(sel => {
      if (teamA.has(sel.dataset.id)) sel.value = 'A';
      else if (teamB.has(sel.dataset.id)) sel.value = 'B';
    });
  }

  if (sideMatchOn) {
    const teamC = new Set(r.sidematchTeamC || []);
    const teamD = new Set(r.sidematchTeamD || []);
    document.querySelectorAll('.sidematch-assign-select').forEach(sel => {
      if (teamC.has(sel.dataset.id)) sel.value = 'C';
      else if (teamD.has(sel.dataset.id)) sel.value = 'D';
    });
  }

  if (sixesOn && Array.isArray(r.sixesPlayers)) {
    const seatOf = {};
    r.sixesPlayers.forEach((id, i) => { seatOf[id] = String(i + 1); });
    document.querySelectorAll('.sixes-assign-select').forEach(sel => {
      if (seatOf[sel.dataset.id]) sel.value = seatOf[sel.dataset.id];
    });
  }

  if (state.setupIsTournament) {
    state.setupTeamCount = r.teamCount || 2;
    renderTeamCountStepper();
    const autoAssign = document.getElementById('auto-assign-teams');
    if (autoAssign) autoAssign.checked = false;
    document.getElementById('auto-assign-hint').hidden = true;
    document.getElementById('tournament-match-use-handicap').checked = r.matchUseHandicap !== false;
    state.tournamentPairings = Array.isArray(r.tournamentMatches)
      ? r.tournamentMatches.map(m => ({ a: m.a, b: m.b }))
      : [];
    renderTeamAssignList();
    document.querySelectorAll('.team-assign-select').forEach(sel => {
      const p = r.players.find(pl => pl.id === sel.dataset.id);
      if (p && p.team != null) sel.value = String(p.team);
    });
    document.querySelectorAll('.team-captain-toggle').forEach(cb => {
      const p = r.players.find(pl => pl.id === cb.dataset.id);
      if (p && p.isCaptain) cb.checked = true;
    });
    renderTournamentMatchList();
  }

  applySetupMode('edit');
  showScreen('screen-setup');
}

// Persists the safe settings edited via openRoundEditor. Inserts any newly
// added players, then updates the round row — never touching hole_count, pars,
// stroke_index, or hole_offset, which stay fixed for a live round.
async function saveRoundEdits() {
  const roundId = state.editingRoundId;
  if (!roundId) return;

  const courseName = document.getElementById('course-name').value.trim() || 'Untitled round';
  const modes = collectModes();
  const betsEnabled = document.getElementById('bets-enabled').checked;
  const stakes = betsEnabled ? (state.setupStakes || {}) : {};

  if (state.setupIsTournament) {
    return saveTournamentRoundEdits(roundId, courseName, modes, betsEnabled, stakes);
  }

  // Match play and Nassau share one Team A/B assignment.
  const needsTeams = modes.includes('match') || modes.includes('nassau');
  const nassauFormat = modes.includes('nassau')
    ? (document.querySelector('#nassau-format input:checked')?.value || 'match')
    : null;
  let matchUseHandicap = true;
  let teamA = [], teamB = [];
  if (needsTeams) {
    ({ teamA, teamB } = collectMatchAssignments());
    if (teamA.length === 0 || teamB.length === 0) {
      showToast('Assign at least one player to each team (Team A and Team B)');
      return;
    }
    if (teamA.length > 3 || teamB.length > 3) {
      showToast('Teams can have at most 3 players each');
      return;
    }
    matchUseHandicap = document.getElementById('match-use-handicap').checked;
  }

  let sidematchUseHandicap = true;
  let teamC = [], teamD = [];
  if (modes.includes('sidematch')) {
    ({ teamC, teamD } = collectSideMatchAssignments());
    const err = sideMatchError(teamC, teamD);
    if (err) { showToast(err); return; }
    sidematchUseHandicap = document.getElementById('sidematch-use-handicap').checked;
  }

  let sixesPlayerIds = [], sixesFormat = null, sixesUseHandicap = true;
  if (modes.includes('sixes')) {
    if (Number(document.getElementById('hole-count').value) !== 18) {
      showToast('Sixes needs an 18-hole round');
      return;
    }
    const { players, error: sixesErr } = collectSixesPlayers();
    if (sixesErr) { showToast(sixesErr); return; }
    sixesPlayerIds = players;
    sixesFormat = document.querySelector('#sixes-format input:checked')?.value || 'match';
    sixesUseHandicap = document.getElementById('sixes-use-handicap').checked;
  }

  try {
    // Insert newly added players first, mapping their temp id to a real db id.
    const tempIdToDbId = {};
    const newPlayers = state.setupPlayers.filter(p => !p.existing && p.name.trim());
    if (newPlayers.length > 0) {
      const rows = newPlayers.map(p => {
        const dbId = crypto.randomUUID();
        tempIdToDbId[p.id] = dbId;
        return { id: dbId, round_id: roundId, name: p.name.trim(), handicap: p.handicap || 0, user_id: null };
      });
      const { error: insErr } = await supabaseClient.from('players').insert(rows);
      if (insErr) throw insErr;
    }

    const resolveId = id => tempIdToDbId[id] || id; // existing players keep their id
    const matchTeamA = needsTeams ? teamA.map(resolveId) : null;
    const matchTeamB = needsTeams ? teamB.map(resolveId) : null;
    const sidematchTeamC = modes.includes('sidematch') ? teamC.map(resolveId) : null;
    const sidematchTeamD = modes.includes('sidematch') ? teamD.map(resolveId) : null;
    const sixesPlayers = modes.includes('sixes') ? sixesPlayerIds.map(resolveId) : null;

    const { error: updErr } = await supabaseClient
      .from('rounds')
      .update({
        course_name: courseName,
        modes,
        stakes,
        bets_enabled: betsEnabled,
        match_team_a: matchTeamA && matchTeamA.length ? matchTeamA : null,
        match_team_b: matchTeamB && matchTeamB.length ? matchTeamB : null,
        match_use_handicap: matchUseHandicap,
        sidematch_team_c: sidematchTeamC && sidematchTeamC.length ? sidematchTeamC : null,
        sidematch_team_d: sidematchTeamD && sidematchTeamD.length ? sidematchTeamD : null,
        sidematch_use_handicap: sidematchUseHandicap,
        nassau_format: nassauFormat,
        sixes_players: sixesPlayers && sixesPlayers.length === 4 ? sixesPlayers : null,
        sixes_format: sixesFormat,
        sixes_use_handicap: sixesUseHandicap,
      })
      .eq('id', roundId);
    if (updErr) throw updErr;

    state.editingRoundId = null;
    await loadRound(roundId);
    showScreen('screen-round');
    onRoundUpdate();
    showToast('Round updated');
  } catch (e) {
    console.error(e);
    showToast('Could not save changes — check your connection');
  }
}

// Tournament variant of saveRoundEdits: revalidates teams + pairings, inserts
// any newly added players with their team/captain, updates existing players'
// team/captain, and writes the tournament round columns.
async function saveTournamentRoundEdits(roundId, courseName, modes, betsEnabled, stakes) {
  const teamRes = collectTeams();
  if (teamRes.error) { showToast(teamRes.error); return; }
  const teamCount = tournamentTeamCount();
  const usedTeams = new Set(Object.values(teamRes.assignments).map(a => a.team));
  const matchRes = collectTournamentMatches(usedTeams);
  if (matchRes.error) { showToast(matchRes.error); return; }
  if (modes.includes('match') && matchRes.matches.length === 0) {
    showToast('Add at least one match pairing, or turn off Match play');
    return;
  }
  const matchUseHandicap = document.getElementById('tournament-match-use-handicap').checked;

  try {
    const tempIdToDbId = {};
    const newPlayers = state.setupPlayers.filter(p => !p.existing && p.name.trim());
    if (newPlayers.length > 0) {
      const rows = newPlayers.map(p => {
        const dbId = crypto.randomUUID();
        tempIdToDbId[p.id] = dbId;
        const a = teamRes.assignments[p.id] || null;
        return {
          id: dbId, round_id: roundId, name: p.name.trim(), handicap: p.handicap || 0, user_id: null,
          team: a ? a.team : null, is_captain: !!(a && a.captain),
        };
      });
      const { error: insErr } = await supabaseClient.from('players').insert(rows);
      if (insErr) throw insErr;
    }

    // Update existing players' team/captain (small list — up to 16 rows).
    const existing = state.setupPlayers.filter(p => p.existing);
    for (const p of existing) {
      const a = teamRes.assignments[p.id] || null;
      const { error: upErr } = await supabaseClient
        .from('players')
        .update({ team: a ? a.team : null, is_captain: !!(a && a.captain) })
        .eq('id', p.id);
      if (upErr) throw upErr;
    }

    const { error: updErr } = await supabaseClient
      .from('rounds')
      .update({
        course_name: courseName,
        modes,
        stakes,
        bets_enabled: betsEnabled,
        team_count: teamCount,
        tournament_matches: matchRes.matches,
        match_use_handicap: matchUseHandicap,
      })
      .eq('id', roundId);
    if (updErr) throw updErr;

    state.editingRoundId = null;
    await loadRound(roundId);
    showScreen('screen-round');
    onRoundUpdate();
    showToast('Tournament updated');
  } catch (e) {
    console.error(e);
    showToast('Could not save changes — check your connection');
  }
}


function initializeSetupCourseSearch() {
  const searchInput = document.getElementById('setup-course-search');
  const resultsEl = document.getElementById('setup-course-search-results');
  if (!searchInput || !resultsEl || searchInput.dataset.initialized === 'true') return;

  searchInput.dataset.initialized = 'true';

  const runSetupCourseSearch = () => searchSetupCourseResults(searchInput.value);

  const searchBtn = document.getElementById('btn-setup-course-search');
  if (searchBtn) searchBtn.addEventListener('click', runSetupCourseSearch);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSetupCourseSearch();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.course-search-wrapper')) {
      hideSetupCourseSearchResults();
    }
  });
}

async function searchSetupCourseResults(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    hideSetupCourseSearchResults();
    showToast('Type at least 2 characters to search');
    return;
  }

  const localResults = await searchLocalCourses(trimmed);
  let apiResults = [];
  if (localResults.length < 5) {
    apiResults = filterCachedApiResults(await searchApiCourses(trimmed), localResults);
  }
  displaySetupCourseSearchResults(localResults, apiResults);
}

function displaySetupCourseSearchResults(localResults, apiResults) {
  const resultsEl = document.getElementById('setup-course-search-results');
  if (!resultsEl) return;

  resultsEl.innerHTML = '';

  // One flat list — local (saved) results first, then API results.
  // No labels, no visual distinction between the two sources.
  const combined = [
    ...localResults.map(course => ({ ...course, source: 'local' })),
    ...apiResults
  ];

  if (combined.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-result-empty';
    empty.textContent = 'No matches found.';
    resultsEl.appendChild(empty);

    const manualRow = document.createElement('div');
    manualRow.className = 'search-result-item manual';
    manualRow.textContent = 'Enter this course manually';
    manualRow.addEventListener('click', useSetupManualEntry);
    resultsEl.appendChild(manualRow);

    resultsEl.hidden = false;
    return;
  }

  combined.forEach(item => {
    const row = document.createElement('div');
    row.className = 'search-result-item';
    row.textContent = `${item.name || item.course_name || 'Course'}${item.location ? ` - ${item.location}` : ''}`;
    row.addEventListener('click', () => selectSetupCourseResult(item));
    resultsEl.appendChild(row);
  });

  resultsEl.hidden = false;
}

function hideSetupCourseSearchResults() {
  const resultsEl = document.getElementById('setup-course-search-results');
  if (resultsEl) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
  }
}

function useSetupManualEntry() {
  hideSetupCourseSearchResults();
  const searchInput = document.getElementById('setup-course-search');
  if (searchInput) searchInput.value = '';
  state.selectedFullCourse = null;
  state.selectedCourseNine = null;
  state.selectedCourseStrokeIndex = null;
  const nineField = document.getElementById('nine-select-field');
  if (nineField) nineField.hidden = true;
  document.querySelectorAll('.nine-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('course-name').value = '';
  renderParGrid();
  document.getElementById('course-name').focus();
}

async function selectSetupCourseResult(course) {
  hideSetupCourseSearchResults();
  if (!course) return;

  if (course.source === 'api') {
    await importSetupApiCourse(course);
    return;
  }

  document.getElementById('setup-course-search').value = '';
  applySelectedCourse(course);
}

async function findOrSaveApiCourse({
  name,
  location,
  holeCount,
  pars,
  strokeIndex,
  externalId,
  apiClubName,
  apiLocation,
  userId
}) {
  // First try to find an existing course by external_id
  if (externalId) {
    const { data: existing } = await supabaseClient
      .from('courses')
      .select('*')
      .eq('external_id', externalId)
      .maybeSingle();

    if (existing) {
      return existing;
    }
  }

  // Attempt to insert a new cached course
  const { data: inserted, error } = await supabaseClient
    .from('courses')
    .insert({
      name,
      location,
      hole_count: holeCount,
      pars,
      stroke_index: strokeIndex,
      source: 'api',
      external_id: externalId,
      api_club_name: apiClubName,
      api_location: apiLocation,
      user_id: userId
    })
    .select()
    .single();

  if (!error) {
    return inserted;
  }

  // Someone else may have inserted it first.
  if (error.code === '23505') {
    let query = supabaseClient
      .from('courses')
      .select('*');

    if (externalId) {
      query = query.or(
        `external_id.eq.${externalId},and(name.ilike.${name},location.ilike.${location})`
      );
    } else {
      query = query
        .ilike('name', name)
        .ilike('location', location);
    }

    const { data: existing } = await query.maybeSingle();

    if (existing) {
      return existing;
    }
  }

  console.error('Failed to cache imported course', error);

  return null;
}

async function importSetupApiCourse(course) {
  const searchInput = document.getElementById('setup-course-search');
  const originalValue = searchInput?.value || '';

  // Already imported by someone — reuse it instead of burning another
  // get-golf-course call.
  const cached = await findCachedApiCourse(course.external_id || course.id);
  if (cached) {
    hideSetupCourseSearchResults();
    if (searchInput) searchInput.value = '';
    state.myCourses = [
      ...(state.myCourses || []).filter(c => c.id !== cached.id),
      cached
    ];
    populateSetupCourseFields(cached);
    return;
  }

  if (searchInput) {
    searchInput.disabled = true;
    searchInput.value = 'Loading course details...';
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    showToast('You need to be logged in to import a course');
    if (searchInput) {
      searchInput.disabled = false;
      searchInput.value = originalValue;
    }
    return;
  }

  try {
    const { data, error } = await supabaseClient.functions.invoke('get-golf-course', {
      body: { courseId: course.external_id || course.id, userId: user.id }
    });

    if (error || data?.error) {
      console.error(error || data?.error);
      showToast('Could not import that course right now');
      if (searchInput) {
        searchInput.disabled = false;
        searchInput.value = originalValue;
      }
      return;
    }

    // setup.js — importSetupApiCourse
    const holes = Array.isArray(data.holes) ? data.holes : [];
    const name = data.course_name || course.name || '';
    const location =
      data.location?.city && data.location?.state
        ? `${data.location.city}, ${data.location.state}`
        : data.location?.city || data.location?.state || '';

    const importedCourse = {
      id: `api:${course.external_id || course.id}`,
      name,
      location,
      hole_count: data.hole_count || holes.length || 18,
      pars: holes.map(h => h.par),
      stroke_index: holes.map(h => h.handicap),
      source: 'api'
    };

    // Save to the shared course cache
    const savedCourse = await findOrSaveApiCourse({
      name,
      location,
      holeCount: importedCourse.hole_count,
      pars: importedCourse.pars,
      strokeIndex: importedCourse.stroke_index,
      externalId: course.external_id || course.id,
      apiClubName: data.club_name || null,
      apiLocation: data.location || null,
      userId: user.id
    });

    // Keep local cache in sync so future searches don't require another API call
    if (savedCourse) {
      state.myCourses = [
        ...(state.myCourses || []).filter(c => c.id !== savedCourse.id),
        savedCourse
      ];
    }

    populateSetupCourseFields(savedCourse || importedCourse);

    if (searchInput) {
      searchInput.disabled = false;
      searchInput.value = '';
    }

  } catch (err) {
    console.error('Failed to import course', err);
    showToast('Could not import that course right now');
    if (searchInput) {
      searchInput.disabled = false;
      searchInput.value = originalValue;
    }
  }
}

function populateSetupCourseFields(course) {
  const nineField = document.getElementById('nine-select-field');
  state.selectedFullCourse = course || null;
  state.selectedCourseNine = null;
  nineField.hidden = true;
  document.querySelectorAll('.nine-btn').forEach(b => b.classList.remove('selected'));

  if (!course) {
    state.selectedCourseStrokeIndex = null;
    return;
  }

  document.getElementById('course-name').value = course.name || '';
  const roundHoleCount = Number(document.getElementById('hole-count').value);

  if (roundHoleCount === 9 && course.hole_count === 18) {
    nineField.hidden = false;
    document.getElementById('par-grid').innerHTML = '';
    state.selectedCourseStrokeIndex = null;
    return;
  }

  document.getElementById('hole-count').value = String(course.hole_count || 18);
  applyCourseToGrid(course, null);
}

async function renderCourseSelectOptions() {
  // The manual-entry <select> was removed; saved courses are now reached
  // through the search field. We still load them into state so
  // applySelectedCourse() and the search-result handlers can find them.
  state.myCourses = await loadMyCourses();
}

function applySelectedCourse(courseOrId) {
  const course = (courseOrId && typeof courseOrId === 'object')
    ? courseOrId
    : (state.myCourses || []).find(c => c.id === courseOrId);
  const nineField = document.getElementById('nine-select-field');

  state.selectedFullCourse = course || null;
  state.selectedCourseNine = null;
  nineField.hidden = true;
  document.querySelectorAll('.nine-btn').forEach(b => b.classList.remove('selected'));

  if (!course) {
    state.selectedCourseStrokeIndex = null;
    return;
  }

  document.getElementById('course-name').value = course.name;

  const roundHoleCount = Number(document.getElementById('hole-count').value);

  // A 9-hole round against an 18-hole saved course needs the player to
  // pick which nine before we know which pars/stroke index to use.
  if (roundHoleCount === 9 && course.hole_count === 18) {
    nineField.hidden = false;
    document.getElementById('par-grid').innerHTML = '';
    state.selectedCourseStrokeIndex = null;
    return;
  }

  document.getElementById('hole-count').value = String(course.hole_count);
  applyCourseToGrid(course, null);
}

// Fills the par grid (and stroke index) from a saved course. `nine` is
// null for a full course, or 'front'/'back' when a 9-hole round is
// using one half of an 18-hole course.
function applyCourseToGrid(course, nine) {
  renderParGrid();

  let pars = course.pars;
  let strokeIndex = course.stroke_index;

  if (nine === 'front') {
    pars = course.pars.slice(0, 9);
    strokeIndex = strokeIndex ? strokeIndex.slice(0, 9) : null;
  } else if (nine === 'back') {
    pars = course.pars.slice(9, 18);
    strokeIndex = strokeIndex ? strokeIndex.slice(9, 18) : null;
  }

  document.querySelectorAll('.par-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    inp.value = pars[h];
  });

  document.querySelectorAll('.hole-hcp-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    inp.value = strokeIndex && strokeIndex[h] != null ? strokeIndex[h] : '';
  });

  state.selectedCourseStrokeIndex = strokeIndex ? Golf.toRelativeStrokeIndex(strokeIndex) : null;
}

function selectCourseNine(nine) {
  if (!state.selectedFullCourse) return;
  state.selectedCourseNine = nine;
  document.querySelectorAll('.nine-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.nine === nine);
  });
  const label = nine === 'front' ? 'Front 9' : 'Back 9';
  document.getElementById('course-name').value = `${state.selectedFullCourse.name} — ${label}`;
  applyCourseToGrid(state.selectedFullCourse, nine);
}

function collectPars() {
  const holeCount = Number(document.getElementById('hole-count').value);
  const pars = [];
  document.querySelectorAll('.par-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    pars[h] = Number(inp.value) || 4;
  });
  for (let i = 0; i < holeCount; i++) {
    if (!pars[i]) pars[i] = 4;
  }
  return pars;
}

// Reads the per-hole Hcp inputs. Returns { strokeIndex, partial }:
// strokeIndex is the relative stroke index when every hole has a
// value, otherwise null; partial flags a half-filled grid so the
// caller can warn that the values were skipped.
function collectStrokeIndex() {
  const holeCount = Number(document.getElementById('hole-count').value);
  const raw = new Array(holeCount).fill(null);
  document.querySelectorAll('.hole-hcp-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    const v = Number(inp.value);
    if (inp.value !== '' && v >= 1 && v <= holeCount) raw[h] = v;
  });
  const filled = raw.filter(v => v != null).length;
  return {
    strokeIndex: filled === holeCount ? Golf.toRelativeStrokeIndex(raw) : null,
    partial: filled > 0 && filled < holeCount
  };
}

function collectModes() {
  return Array.from(document.querySelectorAll('#mode-grid input[name="mode"]:checked')).map(cb => cb.value);
}

// Stakes screen — shared by setup (in-memory, pre-create) and the
// lobby (writes back to the round). Sublabels encode the settlement
// model for each mode.
const STAKE_ORDER = ['gross', 'net', 'stableford', 'bestball', 'skins', 'match', 'sidematch', 'nassau', 'sixes'];
const STAKE_META = {
  gross: { label: 'Gross', sub: 'Ante per player' },
  net: { label: 'Net', sub: 'Ante per player' },
  stableford: { label: 'Stableford', sub: 'Ante per player' },
  bestball: { label: 'Best Ball', sub: 'Ante per player' },
  skins: { label: 'Skins', sub: 'Per skin won' },
  match: { label: 'Match play', sub: 'Team A vs Team B' },
  sidematch: { label: 'Side Match', sub: 'Team C vs Team D' },
  nassau: { label: 'Nassau', sub: 'Nines (each) & total — 2 bets' },
  sixes: { label: 'Sixes', sub: 'Per 6-hole match' },
};

// In a tournament these bets settle by team, so the stakes screen shows a
// team-flavored sub-label and info text (still a per-person stake).
const TOURNAMENT_STAKE_SUB = {
  gross: 'Team pot — winner takes all',
  net: 'Team pot — winner takes all',
  stableford: 'Team pot — winner takes all',
  bestball: 'Team pot — winner takes all',
  match: 'Per player · team vs team',
};

// True when the stakes screen is being shown for a tournament (setup or lobby).
function isTournamentStakes() {
  return state.stakesContext === 'lobby'
    ? !!(state.round && state.round.isTournament)
    : !!state.setupIsTournament;
}

// Plain-language "what this bet is" for the info dialog on the stakes
// screen. Kept next to STAKE_META so the two stay in sync.
const BET_EXPLAINERS = {
  gross: {
    title: 'Gross: winner takes the pot',
    body: 'Everyone antes the same amount into one pot. Whoever posts the lowest total strokes for the round with no handicap applied takes the whole pot. If players tie for the low score, they split it evenly.',
  },
  net: {
    title: 'Net: winner takes the pot',
    body: "Everyone antes the same amount into one pot. Each player's handicap is subtracted from their strokes first, so players of different skill levels compete on even footing. Whoever has the lowest net total takes the whole pot, and ties split it evenly.",
  },
  stableford: {
    title: 'Stableford: winner takes the pot',
    body: 'Everyone antes into one pot. You earn points on each hole. More points are given for better scores, and whoever finishes with the most points wins the whole pot. Ties split evenly.',
  },
  skins: {
    title: 'Skins: win holes, get paid',
    body: 'Every hole is worth one skin. Win a hole outright and each of the other players pays you the skin value. Tie a hole and its skin carries to the next, so a single hole can be worth several stacked skins. Any skins still carrying at the end pay no one.',
  },
  match: {
    title: 'Match play: team vs team',
    body: 'The two sides play head-to-head, hole by hole. Whoever is ahead when the match can no longer be caught wins it. The losing side pays the match stake, split across the winning team. A tied (halved) match pays nothing.',
  },
  sidematch: {
    title: 'Side match: a second head-to-head',
    body: 'A separate match between Team C and Team D running alongside the main game. The losing side pays the stake, split across the winning team. A halved side match pays nothing.',
  },
  nassau: {
    title: 'Nassau: two bets',
    body: 'Two stakes. The nines stake rides on both the front nine and the back nine — each is won on its own, so that stake is at risk twice. The total stake rides once on the full eighteen. The losing side pays the relevant stake on each segment it loses; a tied segment pays nothing.',
  },
  sixes: {
    title: 'Sixes: a bet on every six',
    body: 'Partners rotate every six holes, and each six-hole match is its own bet. The losing pair pays the stake (split between them) on each six they lose, so the stake is at risk three times across the round. A tied six pays nothing.',
  },
};

// Tournament versions of the bet explainers — team pots for the stroke/best-ball
// modes, per-person team-vs-team for match play.
const TOURNAMENT_BET_EXPLAINERS = {
  gross: { title: 'Gross: team pot', body: 'Everyone antes the same amount. The team with the lowest combined gross takes the whole pot; teams that tie split it evenly.' },
  net: { title: 'Net: team pot', body: 'Everyone antes the same amount. The team with the lowest combined net (handicaps applied) takes the whole pot; ties split evenly.' },
  stableford: { title: 'Stableford: team pot', body: 'Everyone antes the same amount. The team with the most combined points takes the whole pot; ties split evenly.' },
  bestball: { title: 'Best ball: team pot', body: 'Everyone antes the same amount. Each team counts its best net score on every hole; the lowest best-ball total takes the whole pot, and ties split evenly.' },
  match: { title: 'Match play: team vs team', body: 'Each pairing is a head-to-head between two teams. The losing team pays the stake for each of its players, split among the winners. A halved match pays nothing.' },
};

function openBetInfo(mode) {
  const info = (isTournamentStakes() && TOURNAMENT_BET_EXPLAINERS[mode]) || BET_EXPLAINERS[mode];
  if (!info) return;
  document.getElementById('bet-info-title').textContent = info.title;
  document.getElementById('bet-info-body').textContent = info.body;
  document.getElementById('bet-info-modal').hidden = false;
}

function closeBetInfo() {
  document.getElementById('bet-info-modal').hidden = true;
}

function renderStakesScreen(modes, stakes) {
  const list = document.getElementById('stakes-list');
  const ordered = STAKE_ORDER.filter(m => modes.includes(m));
  if (!ordered.length) {
    list.innerHTML = '<p class="field-hint">Pick at least one game mode first, then set its stake here.</p>';
    return;
  }
  list.innerHTML = ordered.map(m => {
    const meta = STAKE_META[m];
    if (m === 'nassau') {
      const { nines, total } = Golf.nassauStakes(stakes || {});
      return `
      <div class="stakes-row">
        <div>
          <span class="stakes-row-name">Nassau · Nines</span>
          <button type="button" class="stakes-row-sub stakes-info-link" data-mode="nassau" aria-label="What Nassau means">Front &amp; back 9 — same bet each<span class="stakes-info-icon" aria-hidden="true">ⓘ</span></button>
        </div>
        <div class="stakes-amount">
          <span class="cur">$</span>
          <input type="number" class="stakes-input" data-mode="nassau" data-seg="nines" min="0" step="1" inputmode="numeric" placeholder="0" value="${nines || ''}">
        </div>
      </div>
      <div class="stakes-row">
        <div>
          <span class="stakes-row-name">Nassau · Total</span>
          <span class="stakes-row-sub">Full 18</span>
        </div>
        <div class="stakes-amount">
          <span class="cur">$</span>
          <input type="number" class="stakes-input" data-mode="nassau" data-seg="total" min="0" step="1" inputmode="numeric" placeholder="0" value="${total || ''}">
        </div>
      </div>`;
    }
    const val = stakes && stakes[m] != null ? stakes[m] : '';
    const sub = (isTournamentStakes() && TOURNAMENT_STAKE_SUB[m]) || meta.sub;
    return `
      <div class="stakes-row">
        <div>
          <span class="stakes-row-name">${meta.label}</span>
          <button type="button" class="stakes-row-sub stakes-info-link" data-mode="${m}" aria-label="What ${meta.label} means">${sub}<span class="stakes-info-icon" aria-hidden="true">ⓘ</span></button>
        </div>
        <div class="stakes-amount">
          <span class="cur">$</span>
          <input type="number" class="stakes-input" data-mode="${m}" min="0" step="1" inputmode="numeric" placeholder="0" value="${val}">
        </div>
      </div>`;
  }).join('');
}

function collectStakes() {
  const stakes = {};
  const nassau = {};
  document.querySelectorAll('#stakes-list .stakes-input').forEach(inp => {
    const v = Number(inp.value);
    const valid = inp.value !== '' && v > 0;
    if (inp.dataset.mode === 'nassau') {
      if (valid) nassau[inp.dataset.seg] = v;
    } else if (valid) {
      stakes[inp.dataset.mode] = v;
    }
  });
  if (nassau.nines || nassau.total) stakes.nassau = nassau;
  return stakes;
}

function openStakesScreen(context) {
  state.stakesContext = context;
  if (context === 'lobby') {
    const r = state.round;
    renderStakesScreen(r.modes || ['gross'], r.stakes || {});
  } else {
    renderStakesScreen(collectModes(), state.setupStakes || {});
  }
  showScreen('screen-stakes');
}

async function saveStakesScreen() {
  const stakes = collectStakes();
  if (state.stakesContext === 'lobby') {
    const { error } = await supabaseClient
      .from('rounds')
      .update({ stakes, bets_enabled: true })
      .eq('id', state.roundId);
    if (error) { console.error(error); showToast('Could not save stakes — try again'); return; }
    await loadRound(state.roundId);
    showScreen('screen-lobby');
    renderLobby();
    showToast('Stakes updated');
  } else {
    state.setupStakes = stakes;
    showScreen('screen-setup');
    showToast('Stakes saved');
  }
}

// ---------------------------------------------------------
// Round creation
// ---------------------------------------------------------
async function createRound() {
  const courseName = document.getElementById('course-name').value.trim() || 'Untitled round';
  const holeCount = Number(document.getElementById('hole-count').value);
  const pars = collectPars();
  const modes = collectModes();
  const { strokeIndex, partial: hcpPartial } = collectStrokeIndex();
  if (hcpPartial) showToast('Hole handicaps skipped — fill every hole or leave them all blank');
  const validPlayers = state.setupPlayers.filter(p => p.name.trim().length > 0);
  if (validPlayers.length === 0) {
    showToast('Add at least one player first');
    return;
  }

  // Tournament: teams (assigned by temp id) and optional manual match pairings
  // (by team number). These replace the single-round team assignments below.
  const isTournament = !!state.setupIsTournament;
  let teamAssignments = {}, teamCount = null, tournamentMatches = [], tournamentMatchUseHandicap = true;
  if (isTournament) {
    const t = collectTeams();
    if (t.error) { showToast(t.error); return; }
    teamAssignments = t.assignments;
    teamCount = tournamentTeamCount();
    const usedTeams = new Set(Object.values(teamAssignments).map(a => a.team));
    const m = collectTournamentMatches(usedTeams);
    if (m.error) { showToast(m.error); return; }
    tournamentMatches = m.matches;
    if (modes.includes('match') && tournamentMatches.length === 0) {
      showToast('Add at least one match pairing, or turn off Match play');
      return;
    }
    tournamentMatchUseHandicap = document.getElementById('tournament-match-use-handicap').checked;
  }

  // Match play and Nassau share one Team A/B assignment (single-round only —
  // a tournament uses its own team assignment above).
  const needsTeams = !isTournament && (modes.includes('match') || modes.includes('nassau'));
  const nassauFormat = (!isTournament && modes.includes('nassau'))
    ? (document.querySelector('#nassau-format input:checked')?.value || 'match')
    : null;
  let matchTeamATempIds = [], matchTeamBTempIds = [], matchUseHandicap = true;
  if (needsTeams) {
    const { teamA, teamB } = collectMatchAssignments();
    if (teamA.length === 0 || teamB.length === 0) {
      showToast('Assign at least one player to each team (Team A and Team B)');
      return;
    }
    if (teamA.length > 3 || teamB.length > 3) {
      showToast('Teams can have at most 3 players each');
      return;
    }
    matchTeamATempIds = teamA;
    matchTeamBTempIds = teamB;
    matchUseHandicap = document.getElementById('match-use-handicap').checked;
  }

  let sidematchTeamCTempIds = [], sidematchTeamDTempIds = [], sidematchUseHandicap = true;
  if (!isTournament && modes.includes('sidematch')) {
    const { teamC, teamD } = collectSideMatchAssignments();
    const err = sideMatchError(teamC, teamD);
    if (err) { showToast(err); return; }
    sidematchTeamCTempIds = teamC;
    sidematchTeamDTempIds = teamD;
    sidematchUseHandicap = document.getElementById('sidematch-use-handicap').checked;
  }

  let sixesTempIds = [], sixesFormat = null, sixesUseHandicap = true;
  if (!isTournament && modes.includes('sixes')) {
    if (holeCount !== 18) {
      showToast('Sixes needs an 18-hole round');
      return;
    }
    const { players, error: sixesErr } = collectSixesPlayers();
    if (sixesErr) { showToast(sixesErr); return; }
    sixesTempIds = players;
    sixesFormat = document.querySelector('#sixes-format input:checked')?.value || 'match';
    sixesUseHandicap = document.getElementById('sixes-use-handicap').checked;
  }

  const code = makeRoundCode();

  try {
    const { data: { user: currentUser } } = await supabaseClient.auth.getUser();
    if (!currentUser) throw new Error('No signed-in user found');

    const roundId = crypto.randomUUID();

    const { error: roundErr } = await supabaseClient
      .from('rounds')
      .insert({
        id: roundId,
        code,
        course_name: courseName,
        course_location: state.selectedFullCourse?.location || null,
        hole_count: holeCount,
        pars,
        modes,
        started: false,
        ended: false,
        host_user_id: currentUser.id,
        stroke_index: strokeIndex,
        hole_offset: state.selectedCourseNine === 'back' ? 9 : 0,
        bets_enabled: state.setupBetsEnabled === true,
        stakes: state.setupBetsEnabled ? (state.setupStakes || {}) : {},
        is_tournament: isTournament,
        team_count: teamCount,
      });

    if (roundErr) throw roundErr;

    // Insert the host's own row FIRST, on its own — this one doesn't
    // depend on the round being readable yet, just on user_id matching.
    const hostAssign = teamAssignments[validPlayers[0].id] || null;
    const hostRow = {
      id: crypto.randomUUID(),
      round_id: roundId,
      name: validPlayers[0].name.trim(),
      handicap: validPlayers[0].handicap || 0,
      user_id: currentUser.id,
      team: hostAssign ? hostAssign.team : null,
      is_captain: !!(hostAssign && hostAssign.captain),
    };

    // Maps each setup-screen player to their real database row id, so
    // match play team picks (collected by temp id) can be translated
    // to real player ids below.
    const tempIdToDbId = { [validPlayers[0].id]: hostRow.id };

    const { error: hostErr } = await supabaseClient.from('players').insert(hostRow);
    if (hostErr) throw hostErr;

    // Now insert any other players typed in at setup, as a SEPARATE
    // step — by now the host's row above is committed, so the
    // "host can pre-add a placeholder" check can actually see it.
    const otherPlayers = validPlayers.slice(1).map(p => {
      const dbId = crypto.randomUUID();
      tempIdToDbId[p.id] = dbId;
      const assign = teamAssignments[p.id] || null;
      return {
        id: dbId,
        round_id: roundId,
        name: p.name.trim(),
        handicap: p.handicap || 0,
        user_id: null,
        team: assign ? assign.team : null,
        is_captain: !!(assign && assign.captain),
      };
    });

    if (otherPlayers.length > 0) {
      const { error: othersErr } = await supabaseClient.from('players').insert(otherPlayers);
      if (othersErr) throw othersErr;
    }

    const hostId = hostRow.id;
    const matchTeamA = matchTeamATempIds.map(id => tempIdToDbId[id]).filter(Boolean);
    const matchTeamB = matchTeamBTempIds.map(id => tempIdToDbId[id]).filter(Boolean);
    const sidematchTeamC = sidematchTeamCTempIds.map(id => tempIdToDbId[id]).filter(Boolean);
    const sidematchTeamD = sidematchTeamDTempIds.map(id => tempIdToDbId[id]).filter(Boolean);
    const sixesPlayers = sixesTempIds.map(id => tempIdToDbId[id]).filter(Boolean);

    const { error: updateErr } = await supabaseClient
      .from('rounds')
      .update({
        host_player_id: hostId,
        match_team_a: matchTeamA.length ? matchTeamA : null,
        match_team_b: matchTeamB.length ? matchTeamB : null,
        match_use_handicap: isTournament ? tournamentMatchUseHandicap : matchUseHandicap,
        sidematch_team_c: sidematchTeamC.length ? sidematchTeamC : null,
        sidematch_team_d: sidematchTeamD.length ? sidematchTeamD : null,
        sidematch_use_handicap: sidematchUseHandicap,
        nassau_format: nassauFormat,
        sixes_players: sixesPlayers.length === 4 ? sixesPlayers : null,
        sixes_format: sixesFormat,
        sixes_use_handicap: sixesUseHandicap,
        tournament_matches: isTournament ? tournamentMatches : null,
      })
      .eq('id', roundId);

    if (updateErr) throw updateErr;

    state.roundId = roundId;
    state.roundCode = code;
    state.myPlayerId = hostId;
    saveSession();

    await loadRound(roundId);
    subscribeToRound(roundId);
    document.getElementById('lobby-code').textContent = code;
    document.getElementById('lobby-course-name').textContent = courseName;
    showScreen('screen-lobby');
    renderLobby();
  } catch (e) {
    console.error(e);
    showToast('Could not create round — check your connection and Supabase setup');
  }
}
