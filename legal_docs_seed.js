// ── Legal document seeds ──
// These are the initial versions seeded into the legal_documents table on first boot.
// All documents are stored as Markdown. Version 1 of each.
// Per Norrgren trading as Deeper Mindfulness, United Kingdom

const LEGAL_DOCS = [

  {
    id:       'doc-privacy-policy',
    slug:     'privacy-policy',
    title:    'Privacy Policy',
    version:  1,
    requires_consent: 0,
    content: `# Privacy Policy

**Per Norrgren trading as Deeper Mindfulness**
United Kingdom · per@deepermindfulness.org
Last updated: 1 July 2025 · Version 1

---

## Who we are

Deeper Mindfulness is a sole trader business run by Per Norrgren, based in the United Kingdom. We provide body-based mindfulness programmes, guided practices, and a digital companion platform called Per Bot.

When we say "we", "us", or "our", we mean Per Norrgren trading as Deeper Mindfulness.

---

## What information we collect

When you register for an account, we collect:

- Your first name and email address
- Your password (stored as a secure hash — we cannot read it)
- The date and time you created your account
- Your consent record — what you agreed to and when

When you use the platform, we also collect:

- Which content you have listened to, watched, or read
- Your communication preferences
- Any notes or summaries from practice sessions (if you are a clinical client)

If you become a Member, we also collect:

- Your membership tier and billing dates
- A Stripe customer ID (your payment details are held by Stripe, not by us — see below)

---

## How we use your information

We use your information to:

- Provide access to the platform and your practice space
- Send you messages you have opted into (daily messages, reminders, renewal notices)
- Maintain records of your practice history
- Respond to questions you send us
- Meet our legal obligations

We do not sell your data. We do not share it with third parties except as described below.

---

## Third parties

**Stripe** processes payments. When you become a Member, Stripe holds your payment card details under their own privacy policy. We receive only a customer reference number.

**Brevo** sends transactional emails on our behalf (welcome messages, daily messages, reminders). Your email address is passed to Brevo for this purpose only.

**ElevenLabs** provides the voice you hear in the Talk feature. Your spoken words are processed by ElevenLabs to convert speech to text. We do not store raw audio.

**Anthropic** powers the conversation responses. Text from your conversations is sent to Anthropic's API. We do not store conversation transcripts beyond your current session.

**Railway** hosts the platform. Your data is stored on Railway's infrastructure within their data centres.

---

## Your rights

Under UK GDPR you have the right to:

- **Access** the data we hold about you — use the "Download my data" option in My Account
- **Correct** inaccurate data — update your name or email in My Account
- **Delete** your account and all associated data — use "Delete account" in My Account
- **Object** to processing — contact us at per@deepermindfulness.org
- **Withdraw consent** at any time — you can unsubscribe from all communications in My Account

To exercise any of these rights, contact per@deepermindfulness.org. We will respond within 30 days.

---

## How long we keep your data

We keep your account data for as long as your account is active. If you delete your account, we delete your personal data within 30 days, except where we are required to keep records for legal or financial reasons (for example, payment records for up to 7 years under UK tax law).

---

## Cookies

We use a single session cookie to keep you logged in. We do not use tracking cookies or advertising cookies. See our Cookie Policy for details.

---

## Changes to this policy

If we make significant changes to this policy, we will notify you by email and ask you to review and accept the new version before continuing to use the platform.

---

## Contact

Per Norrgren trading as Deeper Mindfulness
per@deepermindfulness.org
United Kingdom
`
  },

  {
    id:       'doc-terms-of-service',
    slug:     'terms-of-service',
    title:    'Terms of Service',
    version:  1,
    requires_consent: 1,
    content: `# Terms of Service

**Per Norrgren trading as Deeper Mindfulness**
United Kingdom · per@deepermindfulness.org
Last updated: 1 July 2025 · Version 1

---

## About these terms

These terms govern your use of the Deeper Mindfulness platform, including the Per Bot digital companion. By creating an account you agree to these terms.

Please read them. They are written to be readable, not to obscure anything.

---

## What the platform is

Deeper Mindfulness provides body-based mindfulness programmes and a digital companion designed to support your personal practice. The platform includes guided audio and written material, a voice-based conversation feature, and tools to support your own reflection.

---

## What the platform is not

The platform is not a medical service. It is not therapy. It is not a substitute for professional mental health support, medical advice, or clinical treatment.

See our Clinical Disclaimer for full details. By using the platform you confirm you have read and understood it.

---

## Your account

You are responsible for keeping your login details secure. Do not share your account. You must be 18 or over to create an account.

If you become aware of any unauthorised use of your account, contact us immediately at per@deepermindfulness.org.

---

## Acceptable use

You may use the platform for your own personal practice and development. You may not:

- Share, copy, or redistribute any content from the platform
- Use the platform for any commercial purpose without our written permission
- Attempt to access areas of the platform you are not authorised to access
- Use the platform in any way that could harm others

---

## Content

All content on the platform — written material, audio, video, and the framework — is the intellectual property of Per Norrgren trading as Deeper Mindfulness. All rights reserved.

---

## Membership

Membership terms, pricing, and cancellation rights are set out in the Cancellation Policy, which forms part of these terms.

---

## Limitation of liability

To the fullest extent permitted by UK law, Deeper Mindfulness is not liable for any indirect, incidental, or consequential loss arising from your use of the platform.

Our total liability to you for any claim arising from these terms or your use of the platform will not exceed the amount you have paid us in the 12 months before the claim.

Nothing in these terms limits our liability for death or personal injury caused by negligence, or for fraud.

---

## Changes to the platform

We may update or change the platform at any time. We will give reasonable notice of significant changes.

---

## Changes to these terms

If we make significant changes to these terms, we will notify you and ask you to accept the new version before continuing to use the platform.

---

## Governing law

These terms are governed by the law of England and Wales.

---

## Contact

Per Norrgren trading as Deeper Mindfulness
per@deepermindfulness.org
United Kingdom
`
  },

  {
    id:       'doc-cancellation-policy',
    slug:     'cancellation-policy',
    title:    'Cancellation Policy',
    version:  1,
    requires_consent: 1,
    content: `# Cancellation Policy

**Per Norrgren trading as Deeper Mindfulness**
United Kingdom · per@deepermindfulness.org
Last updated: 1 July 2025 · Version 1

---

## Monthly membership

You may cancel your monthly membership at any time.

Cancellation takes effect at the end of your current billing period. You will not be charged again. You retain full access until the period ends.

No refund is given for the remaining days of a billing period already paid for.

---

## Annual membership

You may cancel your annual membership at any time.

Cancellation takes effect at the end of your current annual period. You retain full access until the period ends.

No refund is given for the unused portion of an annual period already paid for.

---

## Lifetime membership

Your lifetime membership gives you permanent access for a single one-off payment.

You have 14 days from the date of purchase to request a full refund, with no questions asked. This is your statutory right under the UK Consumer Contracts Regulations 2013.

After 14 days, no refund is available.

To request a refund within the 14-day window, email per@deepermindfulness.org with your name and the email address used to purchase. We will process your refund within 5 working days.

---

## How to cancel

Cancel at any time by:

- Going to My Account on the platform and managing your subscription, or
- Emailing per@deepermindfulness.org

We will confirm your cancellation by email.

---

## What happens when you cancel

When your membership ends:

- Your account remains active as a free Explorer account
- Your practice history and any saved content remain accessible
- You will no longer have access to Member-only content

---

## Exceptions

If the platform is unavailable for an extended period due to a fault on our side, we will consider pro-rata refunds on a case-by-case basis. Contact us at per@deepermindfulness.org.

---

## Contact

Per Norrgren trading as Deeper Mindfulness
per@deepermindfulness.org
United Kingdom
`
  },

  {
    id:       'doc-cookie-policy',
    slug:     'cookie-policy',
    title:    'Cookie Policy',
    version:  1,
    requires_consent: 0,
    content: `# Cookie Policy

**Per Norrgren trading as Deeper Mindfulness**
United Kingdom · per@deepermindfulness.org
Last updated: 1 July 2025 · Version 1

---

## What is a cookie?

A cookie is a small file stored in your browser that helps a website remember things between visits — for example, that you are logged in.

---

## What cookies we use

We use one cookie:

**perbot_session** — This is a session cookie. It keeps you logged into the platform. Without it you would need to log in on every page. It expires after 24 hours.

That is all. We do not use:

- Advertising cookies
- Analytics cookies
- Tracking cookies
- Third-party cookies

---

## Stripe

When you go through the Stripe payment process, Stripe may set their own cookies on their hosted payment page. This is governed by Stripe's own cookie policy. Their payment page is a separate domain from ours.

---

## Your choices

You can block or delete cookies in your browser settings. If you delete the perbot_session cookie you will be logged out.

---

## Changes

If we add any new cookies in future, we will update this policy and notify you.

---

## Contact

Per Norrgren trading as Deeper Mindfulness
per@deepermindfulness.org
United Kingdom
`
  },

  {
    id:       'doc-clinical-disclaimer',
    slug:     'clinical-disclaimer',
    title:    'Clinical Disclaimer',
    version:  1,
    requires_consent: 1,
    content: `# Clinical Disclaimer

**Per Norrgren trading as Deeper Mindfulness**
United Kingdom · per@deepermindfulness.org
Last updated: 1 July 2025 · Version 1

---

## Important — please read carefully

By using the Deeper Mindfulness platform and the Per Bot companion, you confirm that you have read, understood, and agreed to the following.

---

## For information and personal development only

All content on this platform — including written material, audio practices, video guides, and responses from the Per Bot companion — is provided **for information and personal development purposes only**.

Nothing on this platform constitutes:

- Medical advice
- Clinical diagnosis or assessment
- Psychotherapy or psychological treatment
- Counselling
- Any other form of regulated health or mental health service

---

## Not a substitute for professional help

The platform is not a substitute for professional medical, psychological, or psychiatric care.

If you are experiencing a mental health crisis, are having thoughts of harming yourself or others, or have a diagnosed mental health condition that requires clinical management, please seek support from a qualified professional.

**In the UK:** contact your GP, call NHS 111, or in an emergency call 999.
**Samaritans:** 116 123 (free, 24 hours)
**Crisis text line:** Text SHOUT to 85258

---

## Your responsibility

You accept full responsibility for your own mental and physical health and wellbeing in connection with your use of this platform.

You understand that mindfulness and body-based practices may bring up difficult emotions or memories. If this happens, please stop the practice and seek support from a qualified professional.

You agree not to use this platform as a replacement for treatment recommended by a healthcare professional.

---

## Per Bot is not a therapist

The Per Bot voice companion is an AI-powered tool designed to support personal mindfulness practice. It is not a therapist, counsellor, or clinical practitioner. It cannot assess your mental health, cannot diagnose, and cannot treat.

Responses from Per Bot are generated by an AI system and may not always be appropriate for your individual circumstances. Use your own judgement.

---

## Children and young people

This platform is intended for adults aged 18 and over. It is not designed for use by children or young people without appropriate professional supervision.

---

## Contact

If you have any questions about this disclaimer or about what the platform can and cannot offer, please contact:

Per Norrgren trading as Deeper Mindfulness
per@deepermindfulness.org
United Kingdom
`
  },

];

module.exports = { LEGAL_DOCS };
