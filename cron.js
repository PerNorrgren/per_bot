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

function startCronJobs({ db, sendScheduledMotd, emailTrialDay3, emailTrialDay7, emailTrialDay10, emailTrialDay14, sendInactivityReminders, sendCustomReminders, sendRenewalReminders, sendBirthdayMessages, sweepStaleChatSessions, sendDueCampaignEmailSteps, sendDueSaversEmails, processDueSaversDowngrades, emailSaversCancelGrace0, sendDueScheduledMessages, sendDueSessionReminders, sendDueQueuedPublishes, topUpSocialQueue, cleanupExpiredFormResponses, pollEmailDeliveryStatus, sendNewsletterWinbackEmails }) {

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

  // ── BulkPublish queue — hourly, 25 past ──
  // Same reasoning as the scheduled-messages tick above: its own slot,
  // staggered so a slow run of one job never delays another. Checks
  // every active social_publish_queue row that's due — immediate
  // (queued, no schedule), a one-off scheduled_for that's arrived, or a
  // recurring post whose recurrence matches this day and whose target
  // time-of-day has arrived — and actually sends whichever are ready via
  // sendDueQueuedPublishes (server.js).
  //
  // Per App 30 — was '25 * * * *' (once an hour). Social media is
  // genuinely sensitive to posting time in a way email newsletters
  // aren't, and an hourly tick meant a post "scheduled for 9:00" could
  // actually go out anywhere from 9:00 to 9:59 depending on exactly
  // when within that hour it happened to check — the granularity ceiling
  // was the cron frequency itself, not anything in the UI. Every 5
  // minutes gets a scheduled post out within 5 minutes of its target
  // time-of-day, which is the point of setting one at all.
  cron.schedule('*/5 * * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await sendDueQueuedPublishes();
      console.log('[cron] bulkpublish queue:', JSON.stringify(result));
      record('bulkpublish_queue', 'ok', JSON.stringify(result), null, t0);
    } catch (e) {
      console.error('[cron] bulkpublish queue failed:', e.message);
      record('bulkpublish_queue', 'failed', null, e.message, t0);
    }
  });

  // ── Social queue auto-prepare (Per App 31 — "B" of the social
  // streamlining plan) — once daily, 05:15 UTC. Checks each platform's
  // queue against its own schedule config (social_schedule_config, "A")
  // and generates whatever's missing to keep a rolling week's worth
  // queued per channel — text via Message Builder's own generator, a
  // still image/infographic via GPT Image, scheduled straight into the
  // gap it's filling. Same function a manual "Prepare now" admin button
  // calls (POST /api/admin/social-queue/prepare) — see topUpSocialQueue
  // in server.js for the actual logic and its own staging guard.
  // Staggered 15 minutes after the 05:00 cron log prune, well before the
  // 06:50 membership sweep — nothing else runs in this window.
  cron.schedule('15 5 * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await topUpSocialQueue();
      console.log('[cron] social queue auto-prepare:', JSON.stringify(result));
      record('social_queue_autoprepare', 'ok', JSON.stringify(result), null, t0);
    } catch (e) {
      console.error('[cron] social queue auto-prepare failed:', e.message);
      record('social_queue_autoprepare', 'failed', null, e.message, t0);
    }
  });

  // ── Forms module GDPR cleanup (Per App 31) — once daily, 05:20 UTC ──
  // Clears the actual answers for any form whose stated retention policy
  // is "delete after the instance is finished," once that instance's
  // end_date has genuinely passed. See cleanupExpiredFormResponses in
  // db.js for exactly what's removed and what's deliberately left behind.
  cron.schedule('20 5 * * *', async () => {
    const t0 = Date.now();
    try {
      const result = cleanupExpiredFormResponses();
      console.log('[cron] form response cleanup:', JSON.stringify(result));
      record('form_response_cleanup', 'ok', JSON.stringify(result), null, t0);
    } catch (e) {
      console.error('[cron] form response cleanup failed:', e.message);
      record('form_response_cleanup', 'failed', null, e.message, t0);
    }
  });

  // ── Email delivery status poller (Per App 31) — every 30 minutes ──
  // Asks Scaleway what actually happened to a batch of recently-sent
  // emails (up to 50 per run) that haven't been resolved yet — genuinely
  // more frequent than most jobs here on purpose, since email_health's
  // auto-flagging depends on this catching bounces reasonably promptly,
  // not once a day. See pollEmailDeliveryStatus in server.js.
  cron.schedule('*/30 * * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await pollEmailDeliveryStatus();
      console.log('[cron] email delivery poll:', JSON.stringify(result));
      record('email_delivery_poll', 'ok', JSON.stringify(result), null, t0);
    } catch (e) {
      console.error('[cron] email delivery poll failed:', e.message);
      record('email_delivery_poll', 'failed', null, e.message, t0);
    }
  });

  // ── Newsletter win-back sweep (Per App 31) — once daily, 08:10 UTC ──
  // One honest nudge, once, for anyone who unsubscribed 21+ days ago and
  // hasn't come back — see sendNewsletterWinbackEmails in server.js.
  // Staggered after the 08:00 savers protocol slot.
  cron.schedule('10 8 * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await sendNewsletterWinbackEmails();
      console.log('[cron] newsletter win-back:', JSON.stringify(result));
      record('newsletter_winback', 'ok', JSON.stringify(result), null, t0);
    } catch (e) {
      console.error('[cron] newsletter win-back failed:', e.message);
      record('newsletter_winback', 'failed', null, e.message, t0);
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

  // ── Inactivity reminders — hourly, :15 past ──
  // Per Bot 24 (activity/engagement, group 1) — was a single fixed
  // 07:20 UTC run for everyone; now hourly (staggered 15 minutes off
  // MOTD's own hourly :00 tick, same reasoning as the original daily
  // stagger) so sendInactivityReminders can catch each person's own
  // likely hour rather than firing at one arbitrary UTC time regardless
  // of where they are or when they actually tend to show up.
  cron.schedule('15 * * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await sendInactivityReminders();
      const detail = `matched=${result.matched} pool=${result.candidatePool} threshold=${result.thresholdDays}d`;
      console.log(`[cron] inactivity reminders: ${detail}`);
      record('inactivity_reminders', 'ok', detail, null, t0);
    } catch (e) {
      console.error('[cron] inactivity reminders failed:', e.message);
      record('inactivity_reminders', 'failed', null, e.message, t0);
    }
  });

  // ── Custom reminders — hourly, :20 past (see cron.js) ── Per Bot 50.
  // Its own tick, staggered 5 minutes off inactivity reminders' :15 —
  // same reasoning as every other hourly job in this file being offset
  // from each other: nothing about these two needs to run at the exact
  // same moment, and spreading the minute they land on keeps any one
  // tick's work smaller.
  cron.schedule('20 * * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await sendCustomReminders();
      const detail = `matched=${result.matched} active=${result.totalActive} email=${result.sentEmail} sms=${result.sentSms}`;
      console.log(`[cron] custom reminders: ${detail}`);
      record('custom_reminders', 'ok', detail, null, t0);
    } catch (e) {
      console.error('[cron] custom reminders failed:', e.message);
      record('custom_reminders', 'failed', null, e.message, t0);
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

  // ── Session reminders (Per's request) — every 15 minutes ── 3 days /
  // 1 day / 1 hour before a scheduled cohort session. Runs this often
  // specifically so the 1-hour tier stays reasonably tight — an hourly
  // check could miss that window by up to 59 minutes either way; the
  // real duplicate-prevention is the UNIQUE constraint on
  // session_reminders_sent (see db.js), not this interval choice, so
  // running it frequently costs nothing beyond the extra query.
  cron.schedule('*/15 * * * *', async () => {
    const t0 = Date.now();
    try {
      const result = await sendDueSessionReminders();
      if (result.sentCount > 0 || result.errorCount > 0) {
        console.log('[cron] session reminders:', JSON.stringify(result));
      }
      record('session_reminders', result.errorCount > 0 ? 'partial' : 'ok', JSON.stringify(result), result.errors?.length ? result.errors.join('; ') : null, t0);
    } catch (e) {
      console.error('[cron] session reminders failed:', e.message);
      record('session_reminders', 'failed', null, e.message, t0);
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

  console.log('[cron] scheduled: expired trial/membership sweep (06:50 UTC), MOTD (hourly, per-user day/hour prefs), scheduled messages (hourly, 5 past), bulkpublish queue (hourly, 25 past), social queue auto-prepare (05:15 UTC), form response cleanup (05:20 UTC), email delivery poll (every 30 min), trial emails (07:10 UTC), inactivity reminders (07:20 UTC), renewal reminders (07:30 UTC), birthday messages (07:40 UTC), campaign email steps (07:50 UTC), savers protocol (08:00 UTC), newsletter win-back (08:10 UTC), session reminders (every 15 min), stale chat sweep (every 10 min), cron log prune (05:00 UTC)');
}

module.exports = { startCronJobs };
