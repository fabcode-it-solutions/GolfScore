'use strict';

/* ===========================================================
   scorecard.js — the scorecard (input) tab: hole readout, the
   +/- stroke entry, the per-hole par editor, the hole-15
   reminder, and the mini-hole progress strip.

   Split out of round.js. All functions stay global; this file
   loads after round.js. See index.html for load order.
   Depends on: core.js (state, isHost, showToast), Supabase client.
=========================================================== */

function myPlayer() {
  return state.round.players.find(p => p.id === state.myPlayerId);
}

// The player whose scorecard is currently being entered — normally
// yourself, but the host can switch this via the dropdown to enter
// scores on behalf of someone else (e.g. their phone died mid-round).
function scoringPlayer() {
  const id = state.scoringPlayerId || state.myPlayerId;
  return state.round.players.find(p => p.id === id);
}

// The hole right after the last one this player has a score for —
// used so switching the scoring dropdown lands you where they left
// off instead of always jumping back to hole 1.
function nextUnplayedHole(player, holeCount) {
  if (!player || !player.scores) return 1;
  let lastPlayed = 0;
  for (let h = 1; h <= holeCount; h++) {
    if (player.scores[String(h)] != null) lastPlayed = h;
  }
  return Math.min(holeCount, lastPlayed + 1);
}

function renderScorecardTab() {
  const r = state.round;
  const player = scoringPlayer();
  if (!player) return;

  const h = state.currentHole;
  const par = r.pars[h - 1] || 4;
  const si = r.strokeIndex && r.strokeIndex[h - 1] != null ? r.strokeIndex[h - 1] : null;
  const gross = player.scores && player.scores[String(h)] != null ? Number(player.scores[String(h)]) : null;

  document.getElementById('hole-number').textContent = h + (r.holeOffset || 0);
  document.getElementById('hole-par').textContent = `Par ${par}`;
  document.getElementById('par-editor-input').value = par;

  // Hole readout under the number: handicap shows whenever the round has
  // stroke-index data; par shows until a score is entered, then gives way
  // to the entered score.
  const hcpEl = document.getElementById('hole-handicap');
  hcpEl.textContent = `Hcp ${si}`;
  hcpEl.hidden = si == null;

  const scoreEl = document.getElementById('hole-score');
  scoreEl.textContent = `Score ${gross}`;
  document.getElementById('hole-par').hidden = gross != null;
  scoreEl.hidden = gross == null;

  document.getElementById('btn-par-toggle').hidden = !isHost();
  if (!isHost()) document.getElementById('par-editor').hidden = true;

  document.getElementById('stroke-number').textContent = gross != null ? gross : '—';
  document.getElementById('stroke-caption').textContent = r.ended
    ? 'This round has ended — scores are locked'
    : (gross != null ? relativeToParLabel(gross, par) : 'Tap + to enter score');

  document.getElementById('btn-stroke-minus').disabled = !!r.ended;
  document.getElementById('btn-stroke-plus').disabled = !!r.ended;

  document.getElementById('end-round-wrap').hidden = !(isHost() && !r.ended && h === r.holeCount);

  renderPuttsRow(player, r, h, gross);

  renderMiniHoles(player, r);
}

function relativeToParLabel(gross, par) {
  const diff = gross - par;
  if (diff === 0) return 'Par';
  if (diff === -1) return 'Birdie';
  if (diff <= -2) return 'Eagle or better';
  if (diff === 1) return 'Bogey';
  if (diff === 2) return 'Double bogey';
  return `+${diff} over par`;
}

// Renders the player's card as a scorecard-style grid: the front nine on one
// row and the back nine on the next, each hole showing its number, a score box
// (blank until entered), and the hole's par + handicap underneath, with OUT /
// IN / TOTAL sums at the end of each row.
function renderMiniHoles(player, r) {
  const wrap = document.getElementById('mini-holes');
  wrap.innerHTML = '';

  const hc = r.holeCount;
  const nineCols = hc > 9 ? 9 : hc;
  // 9 (or fewer) hole columns, then a nine-total column, then a round-total
  // column — the second total column only exists on an 18-hole card.
  wrap.className = 'sc-strip' + (hc > 9 ? '' : ' sc-strip-single');
  wrap.style.setProperty('--sc-cols', nineCols);

  const grossAt = (h) => (player.scores && player.scores[String(h)] != null ? Number(player.scores[String(h)]) : null);

  // One playable hole cell — a button so tapping it jumps the entry to that hole.
  const holeCell = (h) => {
    const par = r.pars[h - 1] || 4;
    const si = r.strokeIndex && r.strokeIndex[h - 1] != null ? r.strokeIndex[h - 1] : null;
    const gross = grossAt(h);

    const cell = document.createElement('button');
    cell.type = 'button';
    let cls = 'sc-cell';
    if (gross != null) {
      cls += ' played';
      if (gross < par) cls += ' under';
      else if (gross > par) cls += ' over';
      else cls += ' even';
    }
    if (h === state.currentHole) cls += ' current';
    cell.className = cls;

    const meta = `<span>Par ${par}</span>` + (si != null ? `<span>Hcp ${si}</span>` : '');
    cell.innerHTML =
      `<span class="sc-cell-num">${h + (r.holeOffset || 0)}</span>` +
      `<span class="sc-cell-score">${gross != null ? gross : ''}</span>` +
      `<span class="sc-cell-meta">${meta}</span>`;
    cell.addEventListener('click', () => { state.currentHole = h; renderScorecardTab(); });
    return cell;
  };

  // A summary cell (OUT / IN / TOTAL). `to === 0` renders the empty grand-total
  // slot that keeps the front row aligned with the back row's TOTAL column.
  const totalCell = (label, from, to) => {
    const cell = document.createElement('div');
    cell.className = 'sc-cell sc-total' + (label === 'TOTAL' ? ' sc-grand' : '');
    if (to === 0) return cell; // empty alignment slot on the front row
    let sum = 0, any = false, parSum = 0;
    for (let h = from; h <= to; h++) {
      parSum += (r.pars[h - 1] || 4);
      const g = grossAt(h);
      if (g != null) { sum += g; any = true; }
    }
    cell.innerHTML =
      `<span class="sc-cell-num">${label}</span>` +
      `<span class="sc-cell-score">${any ? sum : ''}</span>` +
      `<span class="sc-cell-meta"><span>Par ${parSum}</span></span>`;
    return cell;
  };

  if (hc > 9) {
    for (let h = 1; h <= 9; h++) wrap.appendChild(holeCell(h));
    wrap.appendChild(totalCell('OUT', 1, 9));
    wrap.appendChild(totalCell('TOTAL', 0, 0)); // empty grand slot on front row
    for (let h = 10; h <= hc; h++) wrap.appendChild(holeCell(h));
    wrap.appendChild(totalCell('IN', 10, hc));
    wrap.appendChild(totalCell('TOTAL', 1, hc));
  } else {
    for (let h = 1; h <= hc; h++) wrap.appendChild(holeCell(h));
    wrap.appendChild(totalCell('TOTAL', 1, hc));
  }
}

// The putts chip row (0–5+) under the stroke entry. Shown only once the
// hole has a stroke score and only when entering your own card; the seeded
// default of 2 renders as the selected chip until the player adjusts it.
// The putts stepper (−/+, default 2) under the stroke entry. Always visible
// while scoring — including before a stroke is entered — so the count is
// always adjustable. Putts only persist once a stroke score exists for the
// hole (scores.strokes is NOT NULL); until then the value is held in memory
// and saved alongside the first stroke.
function renderPuttsRow(player, r, h, gross) {
  const wrap = document.getElementById('putts-row');
  if (!wrap) return;
  wrap.style.display = 'flex';

  const current = player.putts && player.putts[String(h)] != null ? Number(player.putts[String(h)]) : 2;
  const disabled = r.ended ? ' disabled' : '';

  wrap.innerHTML = `
    <span class="putts-label">Putts</span>
    <div class="putts-entry">
      <button type="button" class="putts-btn putts-minus" data-delta="-1" aria-label="Decrease putts"${disabled}>−</button>
      <span class="putts-number">${current}</span>
      <button type="button" class="putts-btn putts-plus" data-delta="1" aria-label="Increase putts"${disabled}>+</button>
    </div>`;
}

async function setPutts(delta) {
  const r = state.round;
  if (r.ended) {
    showToast('This round has ended');
    return;
  }
  const player = scoringPlayer();
  if (!player) return;
  const h = state.currentHole;

  if (!player.putts) player.putts = {};
  const current = player.putts[String(h)] != null ? Number(player.putts[String(h)]) : 2;
  const putts = Math.max(0, Math.min(10, current + delta));
  player.putts[String(h)] = putts;
  renderScorecardTab();

  // Can't persist putts without a stroke score — scores.strokes is NOT NULL.
  // Hold the value in memory; setStroke saves it with the first stroke.
  const hasScore = player.scores && player.scores[String(h)] != null;
  if (!hasScore) return;

  const strokes = Number(player.scores[String(h)]);
  const { error } = await saveScore(player, h, strokes, putts);

  if (error) {
    console.error(error);
    showToast('Could not save putts — check your connection');
  }
}

// Persists one hole's strokes + putts for a player, choosing the right write
// path: your own card writes directly; a teammate's card in a tournament goes
// through tournament_upsert_score (captain check); otherwise host_upsert_score.
async function saveScore(player, hole, strokes, putts) {
  if (player.id === state.myPlayerId) {
    return supabaseClient
      .from('scores')
      .upsert({ player_id: player.id, hole, strokes, putts }, { onConflict: 'player_id,hole' });
  }
  const rpc = state.round.isTournament ? 'tournament_upsert_score' : 'host_upsert_score';
  return supabaseClient.rpc(rpc, { p_player_id: player.id, p_hole: hole, p_strokes: strokes, p_putts: putts });
}

async function setStroke(delta) {
  const r = state.round;
  if (r.ended) {
    showToast('This round has ended');
    return;
  }
  const player = scoringPlayer();
  if (!player) return;
  const h = state.currentHole;
  const par = r.pars[h - 1] || 4;
  const current = player.scores && player.scores[String(h)] != null ? Number(player.scores[String(h)]) : null;
  let next = current == null ? par : current + delta;
  next = Math.max(1, Math.min(15, next));

  player.scores[String(h)] = next;

  // First score on this hole seeds putts with the default of 2 so the chip
  // row shows a real, saved value the player can adjust down or up.
  if (!player.putts) player.putts = {};
  if (player.putts[String(h)] == null) player.putts[String(h)] = 2;
  const putts = player.putts[String(h)];

  renderScorecardTab();

  const { error } = await saveScore(player, h, next, putts);

  if (error) {
    console.error(error);
    showToast('Could not save score — check your connection');
  }
}

async function savePar() {
  const h = state.currentHole;
  const val = Math.max(2, Math.min(6, Number(document.getElementById('par-editor-input').value) || 4));
  const newPars = [...state.round.pars];
  newPars[h - 1] = val;

  const { error } = await supabaseClient
    .from('rounds')
    .update({ pars: newPars })
    .eq('id', state.round.id);

  if (error) {
    showToast('Could not save par — check your connection');
    return;
  }
  state.round.pars = newPars;
  document.getElementById('par-editor').hidden = true;
  renderScorecardTab();
  showToast(`Hole ${h + (state.round.holeOffset || 0)} par set to ${val}`);
}
