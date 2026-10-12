'use strict';

/* ===========================================================
   auth.js — login, signup, email verification, password reset,
   Google/Apple sign-in.
   Depends on: core.js (state, showToast, showScreen)
   Calls into: setup.js (resetSetupScreen), lobby.js (joinRound)
   when continuing a flow after auth succeeds.
=========================================================== */

// --- Google/Apple sign-in config -----------------------------------------
// Google: the WEB client ID from Google Cloud Console — used for the web
// GIS flow AND passed to the native plugin's initialize() on iOS (Google's
// native SDKs always take the web client ID, never the iOS one; the iOS
// client ID only shows up in Info.plist's GIDClientID + URL scheme).
// Apple: the Services ID from the Apple Developer Portal — used only on
// web (native iOS doesn't need a client ID; it's inferred from the app's
// Sign in with Apple entitlement).
// Replace both once the corresponding dashboards/portals are set up.
const GOOGLE_WEB_CLIENT_ID = '584419088693-vpig28i5d43jtbcfiq6pk10q1d4u9oar.apps.googleusercontent.com';
const APPLE_SERVICES_ID = 'REPLACE_WITH_APPLE_SERVICES_ID';
// --------------------------------------------------------------------------

function setAuthMode(mode) {
  state.authMode = mode;
  document.getElementById('auth-tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('auth-tab-signup').classList.toggle('active', mode === 'signup');
  document.getElementById('auth-name-field').hidden = mode !== 'signup';
  document.getElementById('btn-auth-submit').querySelector('.btn-label').textContent =
    mode === 'signup' ? 'Create account' : 'Log in';
  document.getElementById('auth-error').hidden = true;
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errorEl = document.getElementById('auth-error');
  errorEl.hidden = true;

  if (state.authMode === 'signup') {
    const name = document.getElementById('auth-name-field').value.trim();
    if (!name) {
      errorEl.textContent = 'Please enter your name.';
      errorEl.hidden = false;
      return;
    }
   const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      return;
    }
    // Stash the name so we can create the profile row after they verify
    // and log in for the first time (no session exists yet to do it now).
    state.pendingSignupName = name;
    // If they're signing up from a round invite, remember the code across
    // the email verification round-trip so we can rejoin them afterward —
    // invited users go straight into that round and skip profile setup.
    // Everyone else is flagged (with their name) so we can drop them on
    // the profile screen to finish setting up once they verify.
    if (state.pendingJoinCode) {
      savePendingJoin(state.pendingJoinCode);
    } else {
      savePendingProfileSetup(name);
    }
    document.getElementById('verify-email-display').textContent = email;
    state.pendingVerifyEmail = email;
    document.getElementById('form-auth').reset();
    showScreen('screen-verify');
  } else {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.toLowerCase().includes('email not confirmed')) {
        document.getElementById('verify-email-display').textContent = email;
        state.pendingVerifyEmail = email;
        showScreen('screen-verify');
        return;
      }
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      return;
    }
    await afterAuthSuccess();
  }
}

async function afterAuthSuccess() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  document.getElementById('auth-user-email').textContent = user ? user.email : '';
  document.getElementById('form-auth').reset();

  // Name from signup: in memory if they logged in in the same tab, or —
  // after the email round-trip — only in the pending-profile flag. Also
  // tells us whether this is a fresh non-invited signup to onboard below.
  const pendingProfileName = loadPendingProfileSetup();

  if (user) {
    const { data: existingProfile } = await supabaseClient
      .from('user_profiles')
      .select('id')
      .eq('id', user.id)
      .single();

    if (!existingProfile) {
      // Google always includes the real name in user_metadata; Apple only
      // ever includes it on a user's very first authorization (Supabase
      // surfaces it as user_metadata.name when present). Prefer those over
      // a manually-typed name so Google/Apple signups don't have to type
      // anything.
      const oauthName = user.user_metadata?.full_name || user.user_metadata?.name;
      await supabaseClient.from('user_profiles').insert({
        id: user.id,
        display_name: oauthName || state.pendingSignupName || pendingProfileName || user.email,
      });
    }
    state.pendingSignupName = null;
  }

  await refreshDrawerName();

  // A non-invited new user who just verified and logged in: send them to
  // the profile screen to add handicap + home city/state. One-shot flag,
  // so returning users never hit this. Invited users don't have the flag
  // (they carry a pending join code instead), so they fall through below.
  if (pendingProfileName !== null) {
    clearPendingProfileSetup();
    await beginProfileOnboarding(pendingProfileName);
    return;
  }

  if (state.pendingJoinCode) {
    const code = state.pendingJoinCode;
    state.pendingJoinCode = null;
    showScreen('screen-home');
    joinRound(code);
    return;
  }

  await resetSetupScreen();
  showScreen('screen-home');
}

async function playAsGuest() {
  if (!state.pendingJoinCode) return;
  const code = state.pendingJoinCode;
  state.pendingJoinCode = null;
  const { error } = await supabaseClient.auth.signInAnonymously();
  if (error) {
    showToast('Could not start a guest session — check your connection');
    state.pendingJoinCode = code; // restore so they can try again
    return;
  }
  showScreen('screen-home');
  joinRound(code);
}

// --- Google/Apple sign-in -------------------------------------------------
// On the native iOS app, Capacitor's bridge auto-injects window.Capacitor
// (and window.Capacitor.Plugins) directly into the WKWebView regardless of
// this app having no bundler — that part works identically to every other
// Capacitor plugin call in this codebase. On the plain web build nothing
// injects it, so isNativeApp() is false there and we talk to Google's/
// Apple's own web JS SDKs directly instead of going through the plugins'
// web fallbacks (Google's redirects the whole page and never resolves;
// Apple's works but ships as an ES module, which this no-bundler app can't
// import — so we mirror what it does internally by hand below).

function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

// SHA-256 hex digest, used only for Apple's nonce (see signInWithApple).
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function bridgeIdTokenToSupabase(provider, token, nonce) {
  const { error } = await supabaseClient.auth.signInWithIdToken({ provider, token, nonce });
  if (error) {
    showToast('Sign-in failed — try again');
    return;
  }
  await afterAuthSuccess();
}

async function signInWithGoogle() {
  try {
    if (isNativeApp()) {
      const { GoogleSignIn } = window.Capacitor.Plugins;
      // Must be called before every sign-in per the plugin's docs; cheap/
      // idempotent, so simplest to just call it here rather than track
      // init state separately. Always the WEB client ID, even on iOS —
      // Google's native SDKs never take the iOS one directly.
      await GoogleSignIn.initialize({ clientId: GOOGLE_WEB_CLIENT_ID });
      const result = await GoogleSignIn.signIn();
      await bridgeIdTokenToSupabase('google', result.idToken);
    } else {
      const idToken = await getGoogleIdTokenViaGIS();
      await bridgeIdTokenToSupabase('google', idToken);
    }
  } catch (err) {
    showToast('Google sign-in failed — try again');
  }
}

// Google Identity Services (loaded via <script> in index.html). Resolves
// in-page with an ID token via One Tap — no full-page redirect, so none of
// state.pendingJoinCode/pendingSignupName need special handling.
function getGoogleIdTokenViaGIS() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.id) {
      reject(new Error('Google Identity Services not loaded'));
      return;
    }
    google.accounts.id.initialize({
      client_id: GOOGLE_WEB_CLIENT_ID,
      callback: (response) => resolve(response.credential),
    });
    google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed?.() || notification.isSkippedMoment?.()) {
        reject(new Error('Google sign-in was dismissed'));
      }
    });
  });
}

async function signInWithApple() {
  try {
    // Apple's native/web SDKs both take the nonce as-is and never hash it
    // themselves (confirmed by reading the plugin's own source) — Apple's
    // own guidance is that the HASHED nonce goes to Apple, and the RAW
    // nonce goes to Supabase, which hashes it again itself to compare
    // against the token's claim. Passing the same raw value to both sides
    // would make the token's nonce claim the unhashed string, which
    // wouldn't match what Supabase computes, and sign-in would fail.
    const rawNonce = crypto.randomUUID();
    const hashedNonce = await sha256Hex(rawNonce);
    let idToken;
    if (isNativeApp()) {
      const { AppleSignIn } = window.Capacitor.Plugins;
      // 'EMAIL'/'FULL_NAME' are the plugin's SignInScope.Email/.FullName
      // enum values — passed as raw strings since this app has no bundler
      // to import the TS enum from.
      const result = await AppleSignIn.signIn({ scopes: ['EMAIL', 'FULL_NAME'], nonce: hashedNonce });
      idToken = result.idToken;
    } else {
      idToken = await getAppleIdTokenViaJsSdk(hashedNonce);
    }
    await bridgeIdTokenToSupabase('apple', idToken, rawNonce);
  } catch (err) {
    showToast('Apple sign-in failed — try again');
  }
}

// Apple's own JS SDK (script tag added in index.html), called directly —
// mirrors what @capawesome/capacitor-apple-sign-in's web implementation
// does internally, since that plugin ships as an ES module this no-bundler
// app can't import. usePopup keeps this in-page, no redirect.
function getAppleIdTokenViaJsSdk(hashedNonce) {
  return new Promise((resolve, reject) => {
    if (!window.AppleID) {
      reject(new Error('Apple Sign-In SDK not loaded'));
      return;
    }
    AppleID.auth.init({
      clientId: APPLE_SERVICES_ID,
      scope: 'name email',
      redirectURI: window.location.origin,
      nonce: hashedNonce,
      usePopup: true,
    });
    AppleID.auth.signIn()
      .then((response) => resolve(response.authorization.id_token))
      .catch(reject);
  });
}

async function handleLogout() {
  await supabaseClient.auth.signOut();
  goHome();
  showScreen('screen-auth');
}

async function checkAuthOnLoad() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    document.getElementById('auth-user-email').textContent = session.user.email;
    await refreshDrawerName();
    return true;
  }
  return false;
}
 async function handleResendVerify() {
  if (!state.pendingVerifyEmail) return;
  const { error } = await supabaseClient.auth.resend({
    type: 'signup',
    email: state.pendingVerifyEmail,
  });
  if (error) {
    showToast('Could not resend — try again shortly');
  } else {
    showToast('Verification email resent');
  }
}

async function handleForgotSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-email').value.trim();
  const errorEl = document.getElementById('forgot-error');
  errorEl.hidden = true;

  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });

  if (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    return;
  }
  document.getElementById('form-forgot').reset();
  showToast('Reset link sent — check your email');
  showScreen('screen-auth');
}

async function handleResetPasswordSubmit(e) {
  e.preventDefault();
  const newPassword = document.getElementById('reset-password-new').value;
  const errorEl = document.getElementById('reset-password-error');
  errorEl.hidden = true;

  const { error } = await supabaseClient.auth.updateUser({ password: newPassword });

  if (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    return;
  }
  document.getElementById('form-reset-password').reset();
  showToast('Password updated — you can log in now');
  await supabaseClient.auth.signOut();
  showScreen('screen-auth');
}
