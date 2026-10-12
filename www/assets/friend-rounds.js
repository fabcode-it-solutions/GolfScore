'use strict';

/* ===========================================================
   friend-rounds.js — the friend-rounds screen: tap a friend on
   the Friends screen to see their completed-round history, with a
   profile header (name / @username / handicap) and an underline
   tabbar selector — "Rounds with me" (default) and "All rounds".

   Rows come from the get_friend_completed_rounds RPC, a
   SECURITY DEFINER function that returns the friend's completed
   rounds only when the caller is an accepted friend (the
   completed_rounds RLS otherwise hides rounds the caller wasn't
   in). "Rounds with me" is a client-side filter of that result.

   Cards and the tapped-through detail view are rendered by
   history.js (buildHistoryCard / openHistoryDetail), so a friend's
   round looks and scores exactly like your own.

   Loads after friends.js, before app.js. Functions stay global.
   Depends on: core.js (showScreen, showToast, escapeHtml),
   friends.js (atHandle), history.js (buildHistoryCard), Supabase.
=========================================================== */

let friendRoundsFriend = null;   // the friend object being viewed
let friendRoundsMe = null;       // signed-in user's id (for "(you)" + "with me" filter)
let friendRoundsRows = [];       // cached RPC result (all of the friend's rounds)
let friendRoundsTab = 'with-me'; // 'with-me' | 'all'

async function openFriendRounds(friend) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user || user.is_anonymous) {
    showToast('Log in to view rounds');
    return;
  }
  friendRoundsFriend = friend;
  friendRoundsMe = user.id;
  friendRoundsRows = [];
  friendRoundsTab = 'with-me';

  renderFriendRoundsHeader();
  showScreen('screen-friend-rounds');
  // Reflect the default tab before data lands.
  document.querySelectorAll('#friend-rounds-tabbar .tab').forEach(t =>
    t.classList.toggle('active', t.dataset.friendRoundsTab === friendRoundsTab)
  );
  await loadFriendRounds();
}

function renderFriendRoundsHeader() {
  const f = friendRoundsFriend || {};
  document.getElementById('friend-rounds-name').textContent = f.display_name || '';
  document.getElementById('friend-rounds-handle').textContent = atHandle(f.username);
  const hcp = Number(f.default_handicap);
  document.getElementById('friend-rounds-hcp').textContent =
    'Handicap ' + (Number.isFinite(hcp) ? hcp.toFixed(1) : '0.0');
}

async function loadFriendRounds() {
  const listEl = document.getElementById('friend-rounds-list');
  listEl.innerHTML = '<div class="history-empty">Loading rounds…</div>';

  const { data: rows, error } = await supabaseClient
    .rpc('get_friend_completed_rounds', { p_friend_id: friendRoundsFriend.id });

  if (error) {
    console.error(error);
    listEl.innerHTML = '<div class="history-empty">Could not load rounds — check your connection.</div>';
    return;
  }

  friendRoundsRows = rows || [];
  renderFriendRoundsList();
}

// Switches the underline tab and re-filters the cached rows (no re-fetch).
function setFriendRoundsTab(tab) {
  friendRoundsTab = tab;
  document.querySelectorAll('#friend-rounds-tabbar .tab').forEach(t =>
    t.classList.toggle('active', t.dataset.friendRoundsTab === tab)
  );
  renderFriendRoundsList();
}

function renderFriendRoundsList() {
  const listEl = document.getElementById('friend-rounds-list');
  const name = (friendRoundsFriend && friendRoundsFriend.display_name) || 'This friend';

  const rows = friendRoundsTab === 'with-me'
    ? friendRoundsRows.filter(r => (r.participant_user_ids || []).includes(friendRoundsMe))
    : friendRoundsRows;

  if (!rows.length) {
    const msg = friendRoundsTab === 'with-me'
      ? `No rounds with ${escapeHtml(name)} yet.`
      : `${escapeHtml(name)} has no completed rounds yet.`;
    listEl.innerHTML = `<div class="history-empty">${msg}</div>`;
    return;
  }

  listEl.innerHTML = '';
  rows.forEach(row => {
    // Show the friend's score line; still mark the signed-in user "(you)" in detail.
    const card = buildHistoryCard(row, friendRoundsFriend.id, friendRoundsMe);
    if (card) listEl.appendChild(card);
  });
}

// Wired once at startup from app.js init().
function initFriendRounds() {
  const tabbar = document.getElementById('friend-rounds-tabbar');
  if (tabbar) tabbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    setFriendRoundsTab(btn.dataset.friendRoundsTab);
  });
  const back = document.getElementById('btn-friend-rounds-back');
  if (back) back.addEventListener('click', () => showScreen('screen-friends'));
}
