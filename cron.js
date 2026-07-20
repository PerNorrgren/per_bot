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

const cron = require('node-cron');

function startCronJobs({ db, sendScheduledMotd, emailTrialDay3, emailTrialDay7, emailTrialDay10, emailTrialDay14, sendInactivityReminders, sendRenewalReminders, sendBirthdayMessages, sweepStaleChatSessions, sendDueCampaignEmailSteps, sendDueSaversEmails, processDueSaversDowngrades }) {
  // ── Scheduled MOTD send — hourly, on the hour ──
  // Each run checks which users' motd_days/motd_hour match right now and
  // sends only to them. See sendScheduledMotd() in server.js for the full
  // per-user delivery + queue-advance logic.
  cron.schedule('0 * * * *', async () => {
    try {
      const result = await sendScheduledMotd();
      console.log('[cron] scheduled MOTD:', JSON.stringify(result));
    } catch (e) {
      console.error('[cron] scheduled MOTD send failed:', e.message);
    }
  });

  // ── Trial email sequence — 07:10 UTC ──
  cron.schedule('10 7 * * *', async () => {
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

      console.log(`[cron] trial email sequence: day3=${day3.length} day7=${day7.length} day10=${day10.length} day14=${day14.length}`);
    } catch (e) {
      console.error('[cron] trial email sequence failed:', e.message);
    }
  });

  // ── Inactivity reminders — 07:20 UTC ──
  // Threshold and subject are config-driven (app_config.reminder_days /
  // reminder_subject, editable in the admin comms panel) — see
  // sendInactivityReminders() in server.js.
  cron.schedule('20 7 * * *', async () => {
    try {
      const result = await sendInactivityReminders();
      console.log(`[cron] inactivity reminders: sent=${result.sent} threshold=${result.thresholdDays}d`);
    } catch (e) {
      console.error('[cron] inactivity reminders failed:', e.message);
    }
  });

  // ── Renewal reminders — 07:30 UTC ──
  // Genuinely new (Per Bot 6) — checks member_expires_at against
  // app_config.renewal_reminder_days and notifies anyone whose subscription
  // renews in exactly that many days. See sendRenewalReminders() and
  // getUpcomingRenewals() for why this only matches active subscriptions
  // (lifetime members have no expiry to remind about).
  cron.schedule('30 7 * * *', async () => {
    try {
      const result = await sendRenewalReminders();
      console.log(`[cron] renewal reminders: matched=${result.matched} emails=${result.sentEmail} sms=${result.sentSms} threshold=${result.thresholdDays}d`);
    } catch (e) {
      console.error('[cron] renewal reminders failed:', e.message);
    }
  });

  // ── Birthday messages — 07:40 UTC ──
  // Month/day match only (no year stored anywhere) — providing a DOB at
  // all is the consent to send this, so there's no preference flag to
  // check here unlike every other job above. See sendBirthdayMessages()
  // and getUsersWithBirthdayToday() in server.js/db.js.
  cron.schedule('40 7 * * *', async () => {
    try {
      const result = await sendBirthdayMessages();
      console.log(`[cron] birthday messages: matched=${result.matched} emails=${result.sentEmail} sms=${result.sentSms}`);
    } catch (e) {
      console.error('[cron] birthday messages failed:', e.message);
    }
  });

  // ── Campaign email steps — 07:50 UTC ──
  // The one channel campaigns need a cron for — social steps are
  // scheduled directly with BulkPublish at go-live time instead (see
  // /api/admin/campaigns/:id/activate in server.js) and never reach here.
  cron.schedule('50 7 * * *', async () => {
    try {
      const count = await sendDueCampaignEmailSteps();
      console.log(`[cron] campaign email steps: ${count} step(s) due`);
    } catch (e) {
      console.error('[cron] campaign email steps failed:', e.message);
    }
  });

  // ── Savers Protocol — 08:00 UTC ──
  // Mid/final touchpoints and the actual grace-period downgrade. Day0/
  // grace0 fire immediately from the Stripe webhook handlers themselves,
  // not from here — those are event-triggered, not calendar-triggered.
  cron.schedule('0 8 * * *', async () => {
    try {
      const emailCount = await sendDueSaversEmails();
      const downgradeCount = await processDueSaversDowngrades();
      console.log(`[cron] savers protocol: ${emailCount} email(s) sent, ${downgradeCount} downgrade(s)`);
    } catch (e) {
      console.error('[cron] savers protocol failed:', e.message);
    }
  });

  // ── Stale chat session sweep — every 10 minutes ──
  // Safety net for Keep History (Per Bot 6) — catches any automated Talk
  // conversation that went quiet without the client's own beacon firing
  // (crashed tab, killed app), so an opted-in person's arc still gets
  // built from it. Runs often since it's cheap when there's nothing stale
  // — most sweeps will find zero sessions to finalize.
  cron.schedule('*/10 * * * *', () => {
    try {
      const result = sweepStaleChatSessions();
      if (result.swept > 0) console.log(`[cron] chat session sweep: finalized ${result.swept} stale session(s)`);
    } catch (e) {
      console.error('[cron] chat session sweep failed:', e.message);
    }
  });

  console.log('[cron] scheduled: MOTD (hourly, per-user day/hour prefs), trial emails (07:10 UTC), inactivity reminders (07:20 UTC), renewal reminders (07:30 UTC), birthday messages (07:40 UTC), campaign email steps (07:50 UTC), savers protocol (08:00 UTC), stale chat sweep (every 10 min)');
}

module.exports = { startCronJobs };
