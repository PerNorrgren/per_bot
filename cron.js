// ── cron.js ──
// Wires the Per Bot recurring jobs onto node-cron: the hourly scheduled MOTD
// send (per-user day/hour preferences — Per Bot 6), the trial email sequence
// (day 3 / 7 / 10 / 14), and inactivity reminders.
//
// All schedules are UTC (node-cron's default, no timezone option set below).
// The MOTD job runs on the hour every hour so it can catch each user's
// chosen motd_hour (0-23 UTC, default 9); the other two jobs are staggered
// ten minutes apart within their own daily slot so they never overlap on a
// slow boot.
//
// Each job is wrapped in try/catch individually — one job failing (e.g. Brevo
// having a bad moment) must never take down the others or crash the process.
//
// Per Bot 20 — every run (success or failure) is also recorded to
// db.logCronRun(), feeding the Reports hub's cron activity report. This is
// deliberately a thin addition alongside the existing console.log/error
// lines, not a replacement for them — Railway's own logs stay the
// first place to look for a live problem; cron_log is for "has this job
// quietly been failing all week" questions asked later, from the admin
// panel, without needing log access at all.

const cron = require('node-cron');

function startCronJobs({ db, sendScheduledMotd, emailTrialDay3, emailTrialDay7, emailTrialDay10, emailTrialDay14, sendInactivityReminders, sendRenewalReminders, sendBirthdayMessages, sweepStaleChatSessions, sendDueCampaignEmailSteps, sendDueSaversEmails, processDueSaversDowngrades, emailSaversCancelGrace0, sendDueScheduledMessages }) {

  // Records a run to cron_log without ever letting a logging failure
  // affect the job itself — this is a health log, not core functionality.
  function record(jobName, status, detail, error, startedAt) {
    try { db.logCronRun(jobName, status, detail, error, Date.now() - startedAt); }
    catch (e) { console.error('[cron] failed to record cron_log for', jobName, ':', e.message); }
  }

  // ── Scheduled MOTD send — hourly, on the hour ──
  cron.schedule('0 * * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await sendScheduledMotd();
      console.log('[cron] scheduled MOTD:', JSON.stringify(result));
      record('scheduled_motd', 'ok', JSON.stringify(result), null, t0);
    } catch (e) {
      console.error('[cron] scheduled MOTD send failed:', e.message);
      record('scheduled_motd', 'failed', null, e.message, t0);
    }
  });

  // ── Recurring scheduled messages (Per Bot 21) — hourly, 5 past ──
  // Deliberately its own hourly tick rather than piggybacking on the MOTD
  // one above — different concern, and staggered 5 minutes so a slow run
  // of one never delays the other. Every active scheduled_messages row
  // gets checked every hour; whichever ones match today's date AND whose
  // send_hour is this hour AND haven't already sent today actually fire.
  cron.schedule('5 * * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await sendDueScheduledMessages();
      console.log('[cron] scheduled messages:', JSON.stringify(result));
      record('scheduled_messages', 'ok', JSON.stringify(result), null, t0);
    } catch (e) {
      console.error('[cron] scheduled messages failed:', e.message);
      record('scheduled_messages', 'failed', null, e.message, t0);
    }
  });

  // ── Expired trial/membership sweep — 06:50 UTC ──
  // Per Bot 21 — trial lapses still downgrade on the spot (unchanged);
  // anyone whose real paid-until date has lapsed with no live Stripe
  // subscription now enters the same 14-day Savers grace sequence a
  // Stripe cancellation reaching term-end gets, rather than being
  // downgraded immediately — see sweepExpiredMemberships in db.js.
  cron.schedule('50 6 * * *', async () => {
    const t0 = Date.now();
    try {
      const { trialLapsed, enteredGrace } = db.sweepExpiredMemberships();
      for (const user of enteredGrace) {
        try { await emailSaversCancelGrace0(user); }
        catch (e) { console.error('[cron] savers grace-entry email failed for', user.email, ':', e.message); }
      }
      const detail = `${trialLapsed.length} trial downgraded, ${enteredGrace.length} entered savers grace (paid-until lapsed)`;
      console.log(`[cron] expired trial/membership sweep: ${detail}`);
      record('expired_trial_membership_sweep', 'ok', detail, null, t0);
    } catch (e) {
      console.error('[cron] expired trial/membership sweep failed:', e.message);
      record('expired_trial_membership_sweep', 'failed', null, e.message, t0);
    }
  });

  // ── Trial email sequence — 07:10 UTC ──
  cron.schedule('10 7 * * *', async () => {
    const t0 = Date.now();
    try {
      const day3 = db.getTrialEmailCandidates(3, 'trial_email_day3_sent');
      for (const user of day3) {
        await emailTrialDay3(user);
        db.markTrialEmailSent(user.id, 'trial_email_day3_sent');
      }

      const day7 = db.getTrialEmailCandidates(7, 'trial_email_day7_sent');
      for (const user of day7) {
        await emailTrialDay7(user);
        db.markTrialEmailSent(user.id, 'trial_email_day7_sent');
      }

      const day10 = db.getTrialEmailCandidates(10, 'trial_email_day10_sent');
      for (const user of day10) {
        await emailTrialDay10(user);
        db.markTrialEmailSent(user.id, 'trial_email_day10_sent');
      }

      const day14 = db.getTrialEmailCandidates(14, 'trial_email_day14_sent');
      for (const user of day14) {
        await emailTrialDay14(user);
        db.markTrialEmailSent(user.id, 'trial_email_day14_sent');
      }

      const detail = `day3=${day3.length} day7=${day7.length} day10=${day10.length} day14=${day14.length}`;
      console.log(`[cron] trial email sequence: ${detail}`);
      record('trial_email_sequence', 'ok', detail, null, t0);
    } catch (e) {
      console.error('[cron] trial email sequence failed:', e.message);
      record('trial_email_sequence', 'failed', null, e.message, t0);
    }
  });

  // ── Inactivity reminders — 07:20 UTC ──
  cron.schedule('20 7 * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await sendInactivityReminders();
      const detail = `sent=${result.sent} threshold=${result.thresholdDays}d`;
      console.log(`[cron] inactivity reminders: ${detail}`);
      record('inactivity_reminders', 'ok', detail, null, t0);
    } catch (e) {
      console.error('[cron] inactivity reminders failed:', e.message);
      record('inactivity_reminders', 'failed', null, e.message, t0);
    }
  });

  // ── Renewal reminders — 07:30 UTC ──
  cron.schedule('30 7 * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await sendRenewalReminders();
      const detail = `matched=${result.matched} emails=${result.sentEmail} sms=${result.sentSms} threshold=${result.thresholdDays}d`;
      console.log(`[cron] renewal reminders: ${detail}`);
      record('renewal_reminders', 'ok', detail, null, t0);
    } catch (e) {
      console.error('[cron] renewal reminders failed:', e.message);
      record('renewal_reminders', 'failed', null, e.message, t0);
    }
  });

  // ── Birthday messages — 07:40 UTC ──
  cron.schedule('40 7 * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await sendBirthdayMessages();
      const detail = `matched=${result.matched} emails=${result.sentEmail} sms=${result.sentSms}`;
      console.log(`[cron] birthday messages: ${detail}`);
      record('birthday_messages', 'ok', detail, null, t0);
    } catch (e) {
      console.error('[cron] birthday messages failed:', e.message);
      record('birthday_messages', 'failed', null, e.message, t0);
    }
  });

  // ── Campaign email steps — 07:50 UTC ──
  cron.schedule('50 7 * * *', async () => {
    const t0 = Date.now();
    try {
      const count = await sendDueCampaignEmailSteps();
      const detail = `${count} step(s) due`;
      console.log(`[cron] campaign email steps: ${detail}`);
      record('campaign_email_steps', 'ok', detail, null, t0);
    } catch (e) {
      console.error('[cron] campaign email steps failed:', e.message);
      record('campaign_email_steps', 'failed', null, e.message, t0);
    }
  });

  // ── Savers Protocol — 08:00 UTC ──
  cron.schedule('0 8 * * *', async () => {
    const t0 = Date.now();
    try {
      const emailCount = await sendDueSaversEmails();
      const downgradeCount = await processDueSaversDowngrades();
      const detail = `${emailCount} email(s) sent, ${downgradeCount} downgrade(s)`;
      console.log(`[cron] savers protocol: ${detail}`);
      record('savers_protocol', 'ok', detail, null, t0);
    } catch (e) {
      console.error('[cron] savers protocol failed:', e.message);
      record('savers_protocol', 'failed', null, e.message, t0);
    }
  });

  // ── Stale chat session sweep — every 10 minutes ──
  // Only logged to cron_log when it actually did something, same as the
  // console.log below — otherwise 10-minute runs would flood the report
  // with 144 identical no-op rows a day.
  cron.schedule('*/10 * * * *', () => {
    const t0 = Date.now();
    try {
      const result = sweepStaleChatSessions();
      if (result.swept > 0) {
        console.log(`[cron] chat session sweep: finalized ${result.swept} stale session(s)`);
        record('stale_chat_sweep', 'ok', `finalized ${result.swept} session(s)`, null, t0);
      }
    } catch (e) {
      console.error('[cron] chat session sweep failed:', e.message);
      record('stale_chat_sweep', 'failed', null, e.message, t0);
    }
  });

  // ── Cron log prune — once daily, 05:00 UTC ──
  // Keeps cron_log and login_log from growing forever. Deliberately not
  // logged to cron_log — pruning the log about itself is a bit much.
  cron.schedule('0 5 * * *', () => {
    try { db.pruneCronLog(); }
    catch (e) { console.error('[cron] cron_log prune failed:', e.message); }
    try { db.pruneLoginLog(); }
    catch (e) { console.error('[cron] login_log prune failed:', e.message); }
  });

  console.log('[cron] scheduled: expired trial/membership sweep (06:50 UTC), MOTD (hourly, per-user day/hour prefs), scheduled messages (hourly, 5 past), trial emails (07:10 UTC), inactivity reminders (07:20 UTC), renewal reminders (07:30 UTC), birthday messages (07:40 UTC), campaign email steps (07:50 UTC), savers protocol (08:00 UTC), stale chat sweep (every 10 min), cron log prune (05:00 UTC)');
}

module.exports = { startCronJobs };
