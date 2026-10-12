'use strict';

/* ===========================================================
   profile.js — the "Manage profile" screen: lets a signed-in
   user edit the profile saved to their account (name, default
   handicap, and home city/state).

   Name and handicap reuse the SAME user_profiles columns the
   round-setup and lobby flows already read (display_name,
   default_handicap), so editing them here also changes what
   pre-fills when you start or join a round. City and state are
   stored in their own columns (added in the Stage 1 migration).

   Loads after history.js, before app.js. Functions stay global.
   Depends on: core.js (showScreen, showToast, parseHandicap),
   Supabase client.
=========================================================== */

// value = 2-letter code stored in user_profiles.state; label = shown text.
const US_STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],
  ['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],
  ['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],
  ['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],
  ['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],
  ['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],
  ['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],
  ['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],
  ['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],
  ['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],
  ['SC','South Carolina'],['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],
  ['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],
  ['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']
];

// Fills the state <select> once. Idempotent — the data-filled guard
// means calling it on every screen open never duplicates the options.
function populateProfileStateOptions() {
  const sel = document.getElementById('profile-state');
  if (!sel || sel.dataset.filled === 'true') return;
  US_STATES.forEach(([code, name]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  sel.dataset.filled = 'true';
}

// Opens the profile screen, loading current values from user_profiles.
// Guests (anonymous sessions) have nothing durable to attach a profile
// to, so we send them back with a nudge to make an account.
async function openProfileScreen() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user || user.is_anonymous) {
    showToast('Create an account to set up a profile');
    return;
  }

  populateProfileStateOptions();
  document.getElementById('profile-error').hidden = true;

  const { data: profile } = await supabaseClient
    .from('user_profiles')
    .select('display_name, username, default_handicap, city, state')
    .eq('id', user.id)
    .maybeSingle();

  document.getElementById('profile-name').value = profile?.display_name || '';
  document.getElementById('profile-username').value = profile?.username || '';
  document.getElementById('profile-handicap').value =
    (profile && profile.default_handicap != null) ? profile.default_handicap : '';
  document.getElementById('profile-city').value = profile?.city || '';
  document.getElementById('profile-state').value = profile?.state || '';

  showScreen('screen-profile');
}

// Saves the form back to user_profiles. Upsert (not update) so a row
// is created if one doesn't already exist — e.g. an older account from
// before profiles were introduced.
async function saveProfile(e) {
  e.preventDefault();
  const errorEl = document.getElementById('profile-error');
  errorEl.hidden = true;

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user || user.is_anonymous) {
    showToast('Create an account to set up a profile');
    return;
  }

  const name = document.getElementById('profile-name').value.trim();
  if (!name) {
    errorEl.textContent = 'Please enter your name.';
    errorEl.hidden = false;
    return;
  }

  // Username is optional (older accounts may not have one yet), but if
  // provided it must match the DB format check: 3–20 chars, lowercase
  // letters / numbers / underscore. We lowercase for them so "HunterB" works.
  const usernameRaw = document.getElementById('profile-username').value.trim().replace(/^@+/, '').toLowerCase();
  if (usernameRaw && !/^[a-z0-9_]{3,20}$/.test(usernameRaw)) {
    errorEl.textContent = 'Username must be 3–20 characters: lowercase letters, numbers, or underscores.';
    errorEl.hidden = false;
    return;
  }

  const hcpRaw = document.getElementById('profile-handicap').value;
  const handicap = hcpRaw === '' ? 0 : parseHandicap(hcpRaw);

  const city = document.getElementById('profile-city').value.trim() || null;
  const state = document.getElementById('profile-state').value || null;

  const payload = {
    id: user.id,
    display_name: name,
    default_handicap: handicap,
    city,
    state,
  };
  // Only touch username when they typed one, so clearing the field never
  // silently wipes an existing handle.
  if (usernameRaw) payload.username = usernameRaw;

  const { error } = await supabaseClient
    .from('user_profiles')
    .upsert(payload);

  if (error) {
    console.error(error);
    // 23505 = unique_violation: the handle's already taken.
    errorEl.textContent = error.code === '23505'
      ? 'That username is taken — try another.'
      : 'Could not save — check your connection and try again.';
    errorEl.hidden = false;
    return;
  }

  showToast('Profile saved');
  await refreshDrawerName();
  showScreen('screen-home');
}

// Updates the identity block at the top of the home drawer (above the
// separator) to the signed-in user's display_name, with @username and
// handicap on their own lines below. All hidden for guests or before a
// name has been set.
async function refreshDrawerName() {
  const el = document.getElementById('drawer-user-name');
  const handleEl = document.getElementById('drawer-user-handle');
  const hcpEl = document.getElementById('drawer-user-hcp');
  if (!el) return;

  if (typeof refreshUsernameNudge === 'function') await refreshUsernameNudge();

  const hide = () => {
    el.textContent = '';
    el.hidden = true;
    if (handleEl) { handleEl.textContent = ''; handleEl.hidden = true; }
    if (hcpEl) { hcpEl.textContent = ''; hcpEl.hidden = true; }
  };

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user || user.is_anonymous) { hide(); return; }

  const { data: profile } = await supabaseClient
    .from('user_profiles')
    .select('display_name, username, default_handicap')
    .eq('id', user.id)
    .maybeSingle();

  const name = profile?.display_name || '';
  el.textContent = name;
  el.hidden = !name;

  if (handleEl) {
    const handle = profile?.username ? atHandle(profile.username) : '';
    handleEl.textContent = handle;
    handleEl.hidden = !handle;
  }

  if (hcpEl) {
    const hcp = Number(profile?.default_handicap);
    hcpEl.textContent = 'Handicap ' + (Number.isFinite(hcp) ? hcp.toFixed(1) : '0.0');
    hcpEl.hidden = !name;
  }
}

// First-run onboarding: called once, right after a NON-invited user
// verifies their email. Seeds the profile row with the name they gave at
// signup (so the screen pre-fills it), then drops them on the profile
// screen to add handicap and home city/state. Invited users never reach
// here — they're routed straight into their round instead.
async function beginProfileOnboarding(name) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user || user.is_anonymous) {
    await resetSetupScreen();
    showScreen('screen-home');
    return;
  }

  // The profile row won't exist yet on this path, so upsert to create it
  // with the signup name. openProfileScreen then reads it back to pre-fill.
  // Only display_name is set, so any later city/state stays untouched.
  if (name) {
    await supabaseClient
      .from('user_profiles')
      .upsert({ id: user.id, display_name: name });
  }

  await refreshDrawerName();
  await openProfileScreen();
}
