'use strict';

/* ===========================================================
   app.js — wires up DOM events to the functions defined in
   core.js, auth.js, setup.js, lobby.js, and round.js, and
   handles initial page load (resuming a session, deep links,
   password-recovery links).

   This file should stay short. If you find yourself adding
   real logic here instead of an addEventListener call, it
   probably belongs in one of the other files instead.
=========================================================== */

function init() {
  setAuthMode('login');

  if (typeof initializeSetupCourseSearch === 'function') {
    initializeSetupCourseSearch();
  }

  document.getElementById('btn-new-round').addEventListener('click', async () => {
    state.pendingNewIsTournament = false;
    const inProgressRounds = await getInProgressRounds('round');
    if (inProgressRounds.length > 0) {
      showResumePrompt(inProgressRounds);
    } else {
      await resetSetupScreen(false);
      showScreen('screen-setup');
    }
  });

  // Opens the setup screen in tournament mode — same course/players/bets flow
  // as a normal round, plus team assignment and (optional) match pairings.
  document.getElementById('btn-new-tournament').addEventListener('click', async () => {
    state.pendingNewIsTournament = true;
    const inProgressRounds = await getInProgressRounds('tournament');
    if (inProgressRounds.length > 0) {
      showResumePrompt(inProgressRounds);
    } else {
      await resetSetupScreen(true);
      showScreen('screen-setup');
    }
  });

  document.getElementById('btn-course-upload-back').addEventListener('click', () => showScreen('screen-home'));
  document.getElementById('course-hole-count').addEventListener('change', renderCourseHoleGrid);
  document.getElementById('btn-save-course').addEventListener('click', saveCourse);
  document.getElementById('btn-save-course-start-round').addEventListener('click', saveCourseAndStartRound);

  document.getElementById('btn-manage-courses').addEventListener('click', async () => {
    await renderCourseManageList();
    showScreen('screen-course-manage');
  });
  document.getElementById('btn-course-manage-back').addEventListener('click', () => showScreen('screen-home'));

  document.getElementById('btn-manage-profile').addEventListener('click', openProfileScreen);
  document.getElementById('btn-profile-back').addEventListener('click', () => showScreen('screen-home'));
  document.getElementById('form-profile').addEventListener('submit', saveProfile);

  document.getElementById('btn-friends').addEventListener('click', openFriendsScreen);
  document.getElementById('btn-friends-back').addEventListener('click', () => showScreen('screen-home'));
  if (typeof initFriends === 'function') initFriends();
  if (typeof initFriendRounds === 'function') initFriendRounds();
  document.getElementById('btn-manage-add-course').addEventListener('click', async () => {
    await resetCourseUploadScreen();
    showScreen('screen-course-upload');
  });
  document.getElementById('btn-resume-prompt-yes').addEventListener('click', () => {
    hideResumePrompt();
    renderResumeRoundsList(state.pendingResumeRounds || []);
    showScreen('screen-resume-rounds');
  });

  document.getElementById('btn-resume-prompt-no').addEventListener('click', async () => {
    hideResumePrompt();
    await resetSetupScreen(!!state.pendingNewIsTournament);
    showScreen('screen-setup');
  });

  document.getElementById('btn-resume-rounds-close').addEventListener('click', () => {
    showScreen('screen-home');
  });

  document.querySelectorAll('#view-rounds-tab-row .modetab').forEach(btn => {
    btn.addEventListener('click', () => setViewRoundsTab(btn.dataset.viewRoundsTab));
  });
  document.getElementById('btn-resume-list-confirm-yes').addEventListener('click', confirmResumeFromList);
  document.getElementById('btn-resume-list-confirm-no').addEventListener('click', cancelResumeFromList);
  document.getElementById('btn-course-detail-back').addEventListener('click', () => showScreen('screen-course-manage'));

  document.getElementById('btn-cancel-round-lobby').addEventListener('click', () => promptCancelRound(state.roundId));
  document.getElementById('btn-revoke-invite').addEventListener('click', revokeRoundInvite);
  document.getElementById('btn-cancel-round').addEventListener('click', () => promptCancelRound(state.roundId));
  document.getElementById('btn-cancel-round-confirm-yes').addEventListener('click', confirmCancelRound);
  document.getElementById('btn-cancel-round-confirm-no').addEventListener('click', dismissCancelRoundPrompt);
  document.getElementById('cancel-round-confirm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'cancel-round-confirm-modal') dismissCancelRoundPrompt();
  });

  document.getElementById('form-join').addEventListener('submit', e => {
    e.preventDefault();
    joinRound(document.getElementById('join-code').value);
  });

  document.getElementById('btn-setup-back').addEventListener('click', () => {
    if (state.editingRoundId) {
      state.editingRoundId = null;
      showScreen('screen-round');
    } else {
      showScreen('screen-home');
    }
  });

  document.getElementById('btn-edit-round').addEventListener('click', openRoundEditor);

  document.getElementById('hole-count').addEventListener('change', () => {
    const course = state.selectedFullCourse;
    const isSavedCourse = course && (state.myCourses || []).some(c => c.id === course.id);
    if (isSavedCourse) {
      applySelectedCourse(course.id);
    } else {
      renderParGrid();
    }
  });

  document.getElementById('btn-nine-front').addEventListener('click', () => selectCourseNine('front'));
  document.getElementById('btn-nine-back').addEventListener('click', () => selectCourseNine('back'));

  document.getElementById('btn-add-player').addEventListener('click', () => {
    state.setupPlayers.push({ id: uid('p'), name: '', handicap: 0 });
    renderSetupPlayerList();
  });

  document.querySelectorAll('#mode-grid input[name="mode"]').forEach(cb => {
    cb.addEventListener('change', () => {
      syncModeConfigFields();
      cb.closest('.mode-card').classList.toggle('checked', cb.checked);
    });
  });

  // Tournament: changing the team count re-scopes the team/pairing selects,
  // and re-balances if auto-assign is on.
  document.querySelector('.team-count-minus')?.addEventListener('click', () => setTeamCount(-1));
  document.querySelector('.team-count-plus')?.addEventListener('click', () => setTeamCount(1));
  document.getElementById('auto-assign-teams').addEventListener('change', applyAutoAssign);
  document.getElementById('btn-add-pairing').addEventListener('click', addTournamentPairing);

  document.getElementById('btn-create-round').addEventListener('click', () => {
    if (state.editingRoundId) saveRoundEdits();
    else createRound();
  });

  document.getElementById('bets-enabled').addEventListener('change', e => {
    state.setupBetsEnabled = e.target.checked;
    document.getElementById('set-stakes-field').hidden = !e.target.checked;
  });
  document.getElementById('btn-set-stakes').addEventListener('click', () => openStakesScreen('setup'));
  document.getElementById('btn-stakes-back').addEventListener('click', () => {
    showScreen(state.stakesContext === 'lobby' ? 'screen-lobby' : 'screen-setup');
  });
  document.getElementById('btn-stakes-save').addEventListener('click', saveStakesScreen);

  // Stakes rows are rebuilt on each open, so delegate the info-link taps
  // to the stable container.
  document.getElementById('stakes-list').addEventListener('click', (e) => {
    const link = e.target.closest('.stakes-info-link');
    if (link) openBetInfo(link.dataset.mode);
  });
  document.getElementById('btn-bet-info-close').addEventListener('click', closeBetInfo);
  document.getElementById('bet-info-modal').addEventListener('click', (e) => {
    if (e.target.id === 'bet-info-modal') closeBetInfo();
  });

  document.getElementById('btn-lobby-leave').addEventListener('click', goHome);
  document.getElementById('btn-copy-code').addEventListener('click', async () => {
    const link = makeJoinLink(state.roundCode);
    try {
      await navigator.clipboard.writeText(link);
      showToast('Join link copied');
    } catch (e) {
      showToast(`Your code: ${state.roundCode}`);
    }
  });
  document.getElementById('btn-lobby-add-player').addEventListener('click', () => {
    addPlayerToRound(state.roundId);
  });
  document.getElementById('btn-edit-stakes').addEventListener('click', () => openStakesScreen('lobby'));
  document.getElementById('btn-start-round').addEventListener('click', async () => {
    if (!state.round || state.round.players.length === 0) {
      showToast('Add at least one player before starting');
      return;
    }
    if (!state.myPlayerId) {
      showToast('Tap a player below to identify yourself first');
      renderIdentifyList(state.round);
      showScreen('screen-identify');
      return;
    }
    const { error } = await supabaseClient.from('rounds').update({ started: true }).eq('id', state.roundId);
    if (error) {
      showToast('Could not start round — check your connection');
      return;
    }
    await loadRound(state.roundId);
    enterRound();
  });

  document.getElementById('btn-identify-back').addEventListener('click', goHome);
  document.getElementById('btn-identify-add-self').addEventListener('click', async () => {
    const id = await addPlayerToRound(state.roundId);
    if (id) {
      state.myPlayerId = id;
      saveSession();
      await loadRound(state.roundId);
      subscribeToRound(state.roundId);
      showScreen('screen-lobby');
      renderLobby();
    }
  });

  document.getElementById('btn-round-leave').addEventListener('click', goHome);
  document.getElementById('btn-round-share').addEventListener('click', async () => {
    const link = makeJoinLink(state.roundCode);
    try {
      await navigator.clipboard.writeText(link);
      showToast('Join link copied');
    } catch (e) {
      showToast('Round code: ' + state.roundCode);
    }
  });

  // Scoped to the round tabbar so it never grabs the friend-rounds tabs,
  // which reuse the .tab class for the same underline styling.
  document.querySelectorAll('#round-tabbar .tab').forEach(t => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  document.getElementById('btn-hole-prev').addEventListener('click', () => {
    state.currentHole = Math.max(1, state.currentHole - 1);
    document.getElementById('par-editor').hidden = true;
    renderScorecardTab();
  });
  document.getElementById('btn-hole-next').addEventListener('click', () => {
    state.currentHole = Math.min(state.round.holeCount, state.currentHole + 1);
    document.getElementById('par-editor').hidden = true;
    renderScorecardTab();
  });

  document.getElementById('btn-par-toggle').addEventListener('click', () => {
    const el = document.getElementById('par-editor');
    el.hidden = !el.hidden;
  });
  document.getElementById('btn-par-save').addEventListener('click', savePar);

  document.getElementById('scoring-for-select').addEventListener('change', e => {
    state.scoringPlayerId = e.target.value;
    state.currentHole = nextUnplayedHole(scoringPlayer(), state.round.holeCount);
    document.getElementById('par-editor').hidden = true;
    renderScorecardTab();
  });

  document.getElementById('btn-stroke-minus').addEventListener('click', () => setStroke(-1));
  document.getElementById('btn-stroke-plus').addEventListener('click', () => setStroke(1));

  document.getElementById('putts-row').addEventListener('click', e => {
    const btn = e.target.closest('.putts-btn');
    if (!btn || btn.disabled) return;
    setPutts(Number(btn.dataset.delta));
  });

  document.getElementById('btn-end-round').addEventListener('click', endRound);

  document.getElementById('auth-tab-login').addEventListener('click', () => setAuthMode('login'));
  document.getElementById('auth-tab-signup').addEventListener('click', () => setAuthMode('signup'));
  document.getElementById('form-auth').addEventListener('submit', handleAuthSubmit);
  document.getElementById('btn-google-auth').addEventListener('click', signInWithGoogle);
  document.getElementById('btn-apple-auth').addEventListener('click', signInWithApple);
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  // ----- Feedback -----
  document.getElementById('btn-feedback').addEventListener('click', openFeedbackModal);
  document.getElementById('btn-feedback-close').addEventListener('click', closeFeedbackModal);
  document.getElementById('feedback-modal').addEventListener('click', (e) => {
    if (e.target.id === 'feedback-modal') closeFeedbackModal();
  });
  document.getElementById('btn-feedback-send').addEventListener('click', sendFeedback);
  document.getElementById('btn-round-feedback').addEventListener('click', openFeedbackModal);

  // ----- Home sidebar drawer -----
  const appDrawer = document.getElementById('app-drawer');
  const drawerOverlay = document.getElementById('drawer-overlay');
  function openDrawer() {
    appDrawer.classList.add('open');
    drawerOverlay.classList.add('open');
    appDrawer.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    appDrawer.classList.remove('open');
    drawerOverlay.classList.remove('open');
    appDrawer.setAttribute('aria-hidden', 'true');
  }
  document.getElementById('btn-open-drawer').addEventListener('click', openDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  // Any drawer item closes the drawer; its own handler still fires.
  appDrawer.addEventListener('click', (e) => {
    if (e.target.closest('.drawer-item')) closeDrawer();
  });

  document.getElementById('btn-round-history').addEventListener('click', openRoundHistory);
  document.getElementById('btn-history-back').addEventListener('click', () => showScreen('screen-home'));
  document.getElementById('btn-history-detail-back').addEventListener('click', () => showScreen('screen-history'));

  document.getElementById('btn-resend-verify').addEventListener('click', handleResendVerify);
  document.getElementById('btn-verify-back').addEventListener('click', () => showScreen('screen-auth'));

  document.getElementById('btn-forgot-password').addEventListener('click', () => showScreen('screen-forgot'));
  document.getElementById('btn-forgot-back').addEventListener('click', () => showScreen('screen-auth'));
  document.getElementById('form-forgot').addEventListener('submit', handleForgotSubmit);

  document.getElementById('btn-join-signup').addEventListener('click', () => {
    setAuthMode('signup');
    showScreen('screen-auth');
  });
  document.getElementById('btn-join-login').addEventListener('click', () => {
    setAuthMode('login');
    showScreen('screen-auth');
  });
  document.getElementById('btn-join-google').addEventListener('click', signInWithGoogle);
  document.getElementById('btn-join-apple').addEventListener('click', signInWithApple);
  document.getElementById('btn-join-guest').addEventListener('click', playAsGuest);

  document.getElementById('form-reset-password').addEventListener('submit', handleResetPasswordSubmit);

  // If this load is from a password-reset email link, Supabase fires this
  // event once the recovery token in the URL has been processed.
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      showScreen('screen-reset-password');
    }
  });

  // Pull a round code out of a deep link like ?code=AB3K7, if present.
  const urlParams = new URLSearchParams(window.location.search);
  const codeFromUrl = urlParams.get('code');

  // If this is a password-recovery link, the URL hash will contain
  // "type=recovery". Catch this BEFORE normal login routing runs, so
  // it always wins over the home/resume logic below.
  const isRecoveryLink = window.location.hash.includes('type=recovery');

  checkAuthOnLoad().then(async isLoggedIn => {
    if (isRecoveryLink) {
      showScreen('screen-reset-password');
      return;
    }
    if (!isLoggedIn) {
      if (codeFromUrl) {
        state.pendingJoinCode = codeFromUrl.toUpperCase();
        showScreen('screen-join-options');
        return;
      }
      showScreen('screen-auth');
      return;
    }

    // If we're already a member of a round on this device, resume it —
    // even though the URL still carries the ?code= we joined through.
    // Without this, a mid-round refresh re-runs the join flow and dumps us
    // on the identify screen, where our own name reads "Already joined" and
    // can't be re-selected. Resume wins unless the URL code is for a
    // *different* round, and unless a pending email-invite join is waiting.
    const resumable = loadSession();
    if (!loadPendingJoin() && resumable && resumable.roundCode &&
      (!codeFromUrl || codeFromUrl.toUpperCase() === resumable.roundCode)) {
      resumeSession(resumable);
      return;
    }

    if (codeFromUrl) {
      showScreen('screen-home');
      joinRound(codeFromUrl);
      return;
    }

    // Returning from email verification after signing up via an invite:
    // the round code was stashed before the email round-trip. Consume it
    // and drop them straight into that round.
    const pendingJoin = loadPendingJoin();
    if (pendingJoin) {
      clearPendingJoin();
      showScreen('screen-home');
      joinRound(pendingJoin);
      return;
    }

    // A non-invited user who just verified their email: send them to the
    // profile screen to finish setup (name pre-filled from signup). The
    // invite branch above already returned, so this never fires for anyone
    // who signed up from a round code.
    const pendingProfile = loadPendingProfileSetup();
    if (pendingProfile !== null) {
      clearPendingProfileSetup();
      await beginProfileOnboarding(pendingProfile);
      return;
    }

    const session = loadSession();
    if (session && session.roundCode) {
      resumeSession(session);
    } else {
      await resetSetupScreen();
      showScreen('screen-home');
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
