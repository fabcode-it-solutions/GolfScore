'use strict';

/* ===========================================================
   lobby.js — the pre-round lobby, joining by code, picking
   your identity, leaving a round, and resuming a session on
   page reload.
   Depends on: core.js (state, session helpers)
   Calls into: round.js (loadRound, subscribeToRound, enterRound)
=========================================================== */

function renderLobby() {
  const r = state.round;
  if (!r) return;
  document.getElementById('lobby-course-name').textContent = r.courseName;
  document.getElementById('lobby-code').textContent = r.code;

  document.getElementById('lobby-player-count').textContent = r.players.length;

  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';
  r.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const hostBadge = p.id === r.hostId ? '<span class="chip chip-host">Host</span>' : '';
    row.innerHTML = `
      <span class="player-chip-name">${escapeHtml(p.name)}</span>
      ${hostBadge}
      <span class="player-chip-hcp">HCP ${p.handicap}</span>
    `;
    list.appendChild(row);
  });

  document.getElementById('lobby-modes').innerHTML =
    (r.modes || ['gross']).map(m => `<span class="chip">${MODE_NAMES[m] || m}</span>`).join('');

  renderLobbyStakes();

  document.getElementById('btn-start-round').hidden = !isHost();
  document.getElementById('btn-revoke-invite').hidden = !isHost() || r.inviteRevoked ||
    (r.inviteExpiresAt && new Date(r.inviteExpiresAt) <= new Date());
  document.getElementById('btn-cancel-round-lobby').hidden = !isHost();

  if (r.started) enterRound();
}

async function revokeRoundInvite() {
  if (!state.roundId || !isHost()) return;
  if (!confirm('Stop accepting new players through this round link?')) return;

  const { error } = await supabaseClient.rpc('revoke_round_invite', {
    p_round_id: state.roundId,
  });
  if (error) {
    showToast('Could not stop new joins — try again');
    return;
  }
  await loadRound(state.roundId);
  renderLobby();
  showToast('New joins are disabled');
}

// Shows current stakes in the lobby. The host always sees this block
// (so they can add or edit stakes even if bets were left off at
// setup); everyone else sees it only once real stakes exist.
function renderLobbyStakes() {
  const r = state.round;
  const field = document.getElementById('lobby-stakes-field');
  const hasStakes = r.stakes && Object.keys(r.stakes).some(k => r.stakes[k] > 0);

  if (!((r.betsEnabled && hasStakes) || isHost())) { field.hidden = true; return; }
  field.hidden = false;

  const list = document.getElementById('lobby-stakes-list');
  if (hasStakes) {
    list.innerHTML = STAKE_ORDER.filter(m => r.stakes[m] > 0).map(m => {
      const unit = m === 'skins' ? '/skin' : '';
      return `<div class="lobby-stakes-row"><span>${MODE_NAMES[m] || m}</span><span class="lobby-stakes-amt">$${r.stakes[m]}${unit}</span></div>`;
    }).join('');
  } else {
    list.innerHTML = '<p class="field-hint">No stakes set yet.</p>';
  }

  const editBtn = document.getElementById('btn-edit-stakes');
  editBtn.hidden = !isHost();
  editBtn.textContent = hasStakes ? 'Edit stakes' : 'Add stakes';
}

async function addPlayerToRound(roundId) {
  const { data: { user } } = await supabaseClient.auth.getUser();

  let defaultName = '';
  let defaultHandicap = 0;
  if (user) {
    const { data: profile } = await supabaseClient
      .from('user_profiles')
      .select('display_name, default_handicap')
      .eq('id', user.id)
      .single();
    if (profile) {
      defaultName = profile.display_name;
      defaultHandicap = Number(profile.default_handicap) || 0;
    }
  }

  const name = prompt('Your name?', defaultName);
  if (!name || !name.trim()) return null;

  const hcpRaw = prompt('Handicap? (e.g. 10.2) — edit if it has changed', defaultHandicap);
  const handicap = parseHandicap(hcpRaw);

  if (user && handicap !== defaultHandicap) {
    await supabaseClient
      .from('user_profiles')
      .update({ default_handicap: handicap })
      .eq('id', user.id);
  }

  const { data, error } = await supabaseClient.rpc('join_round', {
    p_round_code: state.roundCode,
    p_name: name.trim(),
    p_handicap: handicap,
  });

  if (error) {
    showToast('Could not add player — check your connection');
    return null;
  }
  await loadRound(roundId);
  return data.id;
}

// ---------------------------------------------------------
// Join flow
// ---------------------------------------------------------
async function joinRound(code) {
  code = code.trim().toUpperCase();
  if (!code) return;

  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      showToast('Please sign in before joining a round');
      return;
    }

    const { data: roundRows, error } = await supabaseClient.rpc('find_round_by_code', { p_code: code });
    const roundRow = roundRows && roundRows[0];

    if (error || !roundRow || !roundRow.joinable) {
      const { data: archived } = await supabaseClient.rpc('round_was_archived', { p_code: code });
      showToast(archived ? 'This round has ended' : 'No round found with that code');
      return;
    }

    state.roundId = roundRow.id;
    state.roundCode = code;
    state.round = {
      id: roundRow.id,
      code,
      courseName: roundRow.course_name,
      players: [],
    };

    document.getElementById('identify-course-name').textContent = roundRow.course_name;
    renderIdentifyList(state.round);
    showScreen('screen-identify');
  } catch (e) {
    console.error(e);
    showToast('Could not reach the round — check your connection');
  }
}

async function renderIdentifyList(round) {
  const list = document.getElementById('identify-player-list');
  list.innerHTML = '';

  if (!round.players || round.players.length === 0) {
    list.innerHTML = '<p class="field-hint">Join this round by adding yourself below.</p>';
    return;
  }

  // Who we are on this device — so a returning player whose row is already
  // claimed *by them* (new device, cleared local session) can still tap
  // their own name to rejoin. selectIdentity already skips the claim RPC
  // when the row's user_id matches the current user, so this is safe.
  const { data: { user: currentUser } } = await supabaseClient.auth.getUser();

  round.players.forEach(p => {
    const row = document.createElement('div');
    const claimedByOther = !!p.user_id && p.user_id !== currentUser?.id;
    const claimedByMe = !!p.user_id && p.user_id === currentUser?.id;
    row.className = 'player-row';
    const rightLabel = claimedByOther
      ? 'Already joined'
      : claimedByMe
        ? 'Tap to rejoin'
        : 'HCP ' + p.handicap;
    row.innerHTML = `
      <span class="player-chip-name">${escapeHtml(p.name)}</span>
      <span class="player-chip-hcp">${rightLabel}</span>
    `;
    if (!claimedByOther) {
      row.addEventListener('click', () => selectIdentity(p.id));
    }
    list.appendChild(row);
  });
}

async function selectIdentity(playerId) {
  const player = state.round.players.find(p => p.id === playerId);
  if (!player) return;

  const { data: { user: currentUser } } = await supabaseClient.auth.getUser();

  if (player.user_id && player.user_id !== currentUser.id) {
    showToast('That name is already taken — pick another or add yourself');
    return;
  }

  if (!player.user_id) {
    const { data: claimedRows, error } = await supabaseClient.rpc('claim_player', {
      p_player_id: playerId,
      p_round_code: state.roundCode,
    });

    if (error || !claimedRows || claimedRows.length === 0) {
      showToast('Someone else just claimed that name — pick another or add yourself');
      await loadRound(state.roundId);
      renderIdentifyList(state.round);
      return;
    }
  }

  state.myPlayerId = playerId;
  saveSession();
  await loadRound(state.roundId);
  if (state.round && state.round.started) {
    enterRound();
  } else {
    showScreen('screen-lobby');
    renderLobby();
  }
}
// ---------------------------------------------------------
// Navigation / leaving
// ---------------------------------------------------------
function goHome() {
  if (state.realtimeChannel) {
    supabaseClient.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  state.roundId = null;
  state.roundCode = null;
  state.round = null;
  state.myPlayerId = null;
  state.scoringPlayerId = null;
  clearSession();
  showScreen('screen-home');
}

// ---------------------------------------------------------
// Resuming a session on page reload
// ---------------------------------------------------------
async function resumeSession(session) {
  try {
    const validated = await validateStoredSession(session);
    if (!validated) {
      clearSession();
      resetSetupScreen();
      showScreen('screen-home');
      return;
    }

    const { data: roundRow, error } = await supabaseClient
      .from('rounds')
      .select('*')
      .eq('code', validated.roundCode)
      .single();

    if (error || !roundRow) {
      const { data: archived } = await supabaseClient.rpc('round_was_archived', { p_code: validated.roundCode });
      if (archived) showToast('This round has ended');
      clearSession();
      resetSetupScreen();
      showScreen('screen-home');
      return;
    }

    state.roundId = roundRow.id;
    state.roundCode = validated.roundCode;
    state.myPlayerId = validated.myPlayerId;
    await loadRound(roundRow.id);
    subscribeToRound(roundRow.id);

    if (state.round.started) {
      enterRound();
    } else {
      document.getElementById('lobby-course-name').textContent = state.round.courseName;
      document.getElementById('lobby-code').textContent = state.round.code;
      showScreen('screen-lobby');
      renderLobby();
    }
  } catch (e) {
    console.error(e);
    clearSession();
    resetSetupScreen();
    showScreen('screen-home');
  }
}
