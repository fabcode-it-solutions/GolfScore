'use strict';

/* ===========================================================
   core.js — shared state, session helpers, small utilities.

   Every other file in this app (auth.js, setup.js, lobby.js,
   round.js, app.js) reads or writes the `state` object defined
   here, so this file must load BEFORE all of them. It depends
   on nothing itself, so it loads right after golf.js.
=========================================================== */

const state = {
  roundId: null,
  roundCode: null,
  round: null,
  myPlayerId: null,
  scoringPlayerId: null, // who the scorecard tab is entering for — yourself, unless the host switched it
  currentHole: 1,
  activeTab: 'card',
  activeModeTab: null,
  activeViewRoundsTab: 'completed', // 'completed' or 'inprogress' — which tab is showing on the View Rounds screen
  setupPlayers: [],
  setupIsTournament: false,         // whether the setup screen is building a tournament (teams, up to 16 players)
  setupTeamCount: 2,                 // number of teams chosen on the tournament setup screen's team-count stepper
  setupBetsEnabled: false,          // whether the setup screen's Bets toggle is on
  setupStakes: {},                  // { mode: dollars } entered on the stakes screen before a round exists
  stakesContext: 'setup',           // 'setup' or 'lobby' — where the stakes screen was opened from
  myCourses: [],                    // saved course library, loaded when the setup screen opens
  selectedCourseStrokeIndex: null,  // handicap-ranking array from a selected saved course, or null for manual/hole-order default
  editingCourseId: null,            // set while the upload screen is editing an existing course, instead of creating a new one
  realtimeChannel: null,
  endingRound: false, // guards against double-tapping "End Round" while the RPC calls are in flight
  authMode: 'login',     // 'login' or 'signup'
  pendingJoinCode: null, // round code from a ?code= deep link, applied after auth
  pendingVerifyEmail: null, // email awaiting verification, for the resend button
  pendingSignupName: null,  // name captured at signup, written to profile on first real login
  pendingResumeRounds: [], // NEW: rounds shown on the resume-round screen
};

const LS_KEY = 'fairwaylive_session';
const PENDING_JOIN_KEY = 'fairwaylive_pending_join';
const PENDING_PROFILE_KEY = 'fairwaylive_pending_profile';

// Display labels for each game mode, keyed by the value stored in
// rounds.modes. Shared by the lobby chips and the leaderboard mode
// tabs so the labels only need updating in one place.
const MODE_NAMES = { gross: 'Gross', net: 'Net', stableford: 'Stableford', skins: 'Skins', match: 'Match play', sidematch: 'Side Match', nassau: 'Nassau', sixes: 'Sixes', bestball: 'Best Ball', money: 'Money' };

// Leaderboard tabs for a round: its game modes, plus a synthetic
// "money" tab when bets are on with at least one real stake.
function roundBoardModes(r) {
  const base = (r.modes && r.modes.length) ? r.modes.slice() : ['gross'];
  const hasStakes = r.betsEnabled && r.stakes && Object.keys(r.stakes).some(k => r.stakes[k] > 0);
  if (hasStakes && !base.includes('money')) base.push('money');
  return base;
}

// ---------------------------------------------------------
// Utilities
// ---------------------------------------------------------
function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

function makeRoundCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let code = '';
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  for (const byte of randomBytes) code += chars[byte % chars.length];
  return code;
}

// Builds a shareable ?code= link from the current page URL, stripping
// any other query params or hash (e.g. leftover ?code= from a deep
// link, or a password-recovery hash) so the link is always clean.
function makeJoinLink(code) {
  const url = new URL(window.location.href);
  url.search = '?code=' + code;
  url.hash = '';
  return url.toString();
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2200);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function saveSession() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      roundCode: state.roundCode,
      myPlayerId: state.myPlayerId,
    }));
  } catch (e) { /* storage unavailable, ignore */ }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearSession() {
  try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
}

async function validateStoredSession(session) {
  if (!session || !session.roundCode || !session.myPlayerId) {
    return null;
  }

  const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
  if (userError || !user || user.is_anonymous) {
    return null;
  }

  const { data: playerRow, error: playerError } = await supabaseClient
    .from('players')
    .select('id, round_id, user_id')
    .eq('id', session.myPlayerId)
    .maybeSingle();

  if (playerError || !playerRow || playerRow.user_id !== user.id) {
    return null;
  }

  const { data: roundRow, error: roundError } = await supabaseClient
    .from('rounds')
    .select('id, code')
    .eq('code', session.roundCode)
    .maybeSingle();

  if (roundError || !roundRow || roundRow.id !== playerRow.round_id) {
    return null;
  }

  return {
    roundCode: roundRow.code,
    myPlayerId: playerRow.id,
  };
}

// A round code the user intended to join, stashed before an email
// round-trip (e.g. signing up from an invite link) so we can drop
// them back into that round once they return and log in.
function savePendingJoin(code) {
  try { localStorage.setItem(PENDING_JOIN_KEY, code); } catch (e) { /* ignore */ }
}
function loadPendingJoin() {
  try { return localStorage.getItem(PENDING_JOIN_KEY); } catch (e) { return null; }
}
function clearPendingJoin() {
  try { localStorage.removeItem(PENDING_JOIN_KEY); } catch (e) { /* ignore */ }
}

// Set right after a NON-invited signup (value = the name they entered)
// so that, once they verify their email and return, we can drop them on
// the profile screen to finish setup. Invited signups use the pending
// join above instead and skip onboarding, heading straight to their round.
function savePendingProfileSetup(name) {
  try { localStorage.setItem(PENDING_PROFILE_KEY, name || ''); } catch (e) { /* ignore */ }
}
function loadPendingProfileSetup() {
  try { return localStorage.getItem(PENDING_PROFILE_KEY); } catch (e) { return null; }
}
function clearPendingProfileSetup() {
  try { localStorage.removeItem(PENDING_PROFILE_KEY); } catch (e) { /* ignore */ }
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// Condense a display name to initials for tight spaces (e.g. the skins
// hole-by-hole strip). "Hunter Jackson" -> "HJ"; a single-word name with
// no last name -> just its first letter ("Hunter" -> "H"). Falls back to
// "?" for an empty/blank name.
function initials(name) {
  const parts = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Parse a handicap string, allowing one decimal place (e.g. 10.2).
// Returns a number rounded to 1 decimal place, clamped 0–54.
function parseHandicap(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return 0;
  return Math.min(54, Math.max(0, Math.round(n * 10) / 10));
}

// True if the currently-identified player is this round's host.
// Used to hide host-only controls (start round, edit par, and
// eventually editing other players' scores) from everyone else.
function isHost() {
  return !!(state.round && state.myPlayerId && state.myPlayerId === state.round.hostId);
}
