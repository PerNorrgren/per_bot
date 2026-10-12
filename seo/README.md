# Search Visibility module (`seo/`)

A self-contained folder that drops into any Express app. Built in Per App 38; written to move into the Mare App unchanged.

## What it gives the app

- **Page tags, server-side.** For each public page listed in admin: title, meta description, canonical, Open Graph / X card tags and schema.org JSON-LD (organisation, person, website, plus the page's own Course / Book / Event / FAQ… schema). Added to the HTML as it is sent, so crawlers that don't run JavaScript (most AI crawlers) still see them.
- **Site files.** `/robots.txt`, `/sitemap.xml`, `/llms.txt`, generated from the same page list and settings.
- **AI visibility check.** Asks Claude, ChatGPT, Perplexity and Gemini (whichever have keys) the questions people really ask, with live web search on, and records: mentioned or not, place against named competitors, whether the site was cited, the full answer and its sources. On demand, or weekly.
- **AI suggestions, human-approved.** "Suggest with AI" drafts a page's title, description and schema from the page's own text; "Suggest questions" drafts tracking questions. Nothing goes live until someone presses Save.
- Admin page at `/admin/seo`, English and Dutch, spinner on every server button, a popup when each finishes, errors written as plain steps.

## The four files

| File | Job |
|---|---|
| `index.js` | `mountSeo(app, opts)` — routes, head injection, site files, check runner, weekly schedule |
| `store.js` | Its own five `seo_*` tables, through a two-function adapter |
| `engines.js` | The four AI engines and the mention matching |
| `admin.html` | The admin page (theme and language set by the host) |

Nothing in the folder refers to the host app. Everything app-specific comes in through `opts`.

## Mounting

Call it **after** `cookieParser()` and **before** `express.static` and before any route that sends a page.

```js
require('./seo').mountSeo(app, {
  store: { run, all },                       // required — see below
  requireAdminApi: auth.requireAuthApi(['admin']),  // required
  requireAdminPage: auth.requireAuth(['admin']),    // redirects to login when not signed in
  siteUrl: 'https://www.example.org',        // public address, no trailing slash
  appName: 'Example',
  theme: 'dark',                             // or 'light'
  lang: 'en',                                // admin page language at first open ('en' | 'nl')
  languages: ['en', 'nl'],                   // language switch shown on the admin page
  adminNavHtml: '<a href="/admin" class="btn">Home</a>…', // the host's admin menu, optional
  enableCron: true,                          // false on staging
  defaults: { siteName, orgName, orgDescription, personName, brandTerms: [], robotsDisallow: [], models: {} },
  // optional: adminPath ('/admin/seo'), apiBase ('/api/seo-admin'),
  // keys: { anthropic, openai, perplexity, gemini } (default: env vars),
  // serveRobots / serveSitemap / serveLlms: false to leave one to the host,
  // onScheduledRun({ ok, error }) — e.g. email staff when the weekly check fails.
});
```

`defaults` are starting values only. Anything saved in the admin Settings tab wins.

### The store adapter

Two functions over the host's own sql.js database:

- `run(sql, params)` — run one write **and persist it**
- `all(sql, params)` — return rows as plain objects

Per App: `db.rawRun` / `db.rawAll` (added to db.js in Per App 38).

Mare App's db.js already has the pieces:

```js
store: { run: (sql, p) => db.runBatch([[sql, p]]), all: db.allRows },
```

Tables are created on first use, so it is safe to mount before the database has opened.

## API keys (Railway Variables)

| Engine | Variable | Default model (change in Settings) |
|---|---|---|
| Claude | `ANTHROPIC_API_KEY` | host's `ANTHROPIC_MODEL`, else `claude-sonnet-5` |
| ChatGPT | `OPENAI_API_KEY` | `gpt-5-mini` |
| Perplexity | `PERPLEXITY_API_KEY` | `sonar` |
| Gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` |

An engine with no key is shown as "no key" and skipped. A refused key stops that engine for the rest of the run after one try, so a bad key costs one call, not fifty.

## Porting to the Mare App — checklist

1. Copy the `seo/` folder in as it is.
2. Mount it in `server.js` as above, before `express.static`, with the Mare adapter line, `theme: 'light'`, `lang: 'nl'`, `siteUrl: 'https://mare.deepermindfulness.org'`, Mare's admin menu as `adminNavHtml`, and Mare's own defaults (brand terms: the book titles in both languages, Mare, the domain).
3. If Mare has its own `/robots.txt` route or file, either remove it or pass `serveRobots: false`.
4. Add the files to Mare's deploy.sh (`copy_if_present` **and** `STAGE_CANDIDATES`).
5. Add a "Search" link to the Mare admin menu.

Note for the matching: `analyse()` treats subdomains as the same site, so a citation of `mare.deepermindfulness.org` counts as "site cited" for Per App too. That is intended — same organisation.
