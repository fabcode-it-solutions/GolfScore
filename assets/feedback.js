'use strict';

/* ===========================================================
   feedback.js — lightweight "send feedback" flow. No backend
   involved: the message is handed off to the user's own email
   app via a mailto: link addressed to strokesadmin@gmail.com,
   so there's nothing to store or maintain server-side.
   Depends on: core.js (state, showToast), Supabase client.
=========================================================== */

const FEEDBACK_EMAIL = 'strokesadmin@gmail.com';

function openFeedbackModal() {
  document.getElementById('feedback-message').value = '';
  document.getElementById('feedback-modal').hidden = false;
}

function closeFeedbackModal() {
  document.getElementById('feedback-modal').hidden = true;
}

async function sendFeedback() {
  const message = document.getElementById('feedback-message').value.trim();
  if (!message) {
    showToast('Write a quick note first');
    return;
  }

  // Best-effort context so a bug report doesn't need to be re-explained —
  // never blocks sending if any of this is unavailable (e.g. a guest).
  let context = '';
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (user && !user.is_anonymous && user.email) {
      context += `From: ${user.email}\n`;
    }
  } catch (e) { /* auth unavailable — fine, skip */ }

  if (state.roundCode) context += `Round code: ${state.roundCode}\n`;

  const subject = 'GolfScore feedback';
  const body = context ? `${message}\n\n---\n${context}` : message;
  const mailtoUrl = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  window.location.href = mailtoUrl;
  closeFeedbackModal();
  showToast('Opening your email app…');
}