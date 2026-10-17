// links_page.js — Per App 38 (34): /links, the page for social media bios.
//
// Per's request (17 Oct 2026): one page to link from Instagram and the
// other bios, "showing current posts, white papers, bios, etc. When I
// upload something it adds it here and replaces what was there in the
// category."
//
// Nothing here is kept by hand. Each time the page is opened it reads:
//  - Featured now: the piece the current campaign links to (passed in as
//    getFeatured, from the Message of the Day brief today, the social
//    campaign later); if there is none, the newest public piece.
//  - The newest public blog, white paper and poem. A new upload with its
//    own public page takes that category's place straight away.
//  - The books, the free practice pages, courses, Learn, podcasts and
//    talks, and About Per, which are fixed pages on the site.

function mountLinksPage(app, { db, publicPages, seoStore, invalidate = () => {}, siteUrl, heroImg, getFeatured = () => null, getContactEmail = () => '', getTagline = () => '', log = console.log }) {
  const SITE = String(siteUrl || 'https://www.deepermindfulness.org').replace(/\/+$/, '');
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cleanTitle = t => String(t || '').replace(/^(blog|poem|whitepaper|news)\s*[-–:]?\s*/i, '').replace(/\s+v\d+$/i, '').replace(/\s+/g, ' ').trim();
  const KIND_WORD = { blog: 'Latest blog', paper: 'Latest white paper', poem: 'Latest poem' };
  const KIND_ALL = { blog: ['/blog', 'All blogs'], paper: ['/papers', 'All white papers'], poem: ['/poems', 'All poems'] };
  const pathOf = url => String(url || '').replace(/^https?:\/\/[^/]+/i, '') || '/';

  // The newest published piece of each kind, with its title from the library.
  function newest() {
    const out = {};
    const rows = (publicPages.list() || []).filter(r => r.published && r.url)
      // Newest publish date first; pieces without a date go last (an old
      // import with no date must not look like the newest upload).
      .sort((a, b) => String(b.published_at || '0').localeCompare(String(a.published_at || '0')) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    for (const r of rows) {
      if (out[r.kind]) continue;
      const f = db.getLibraryFile(r.file_id);
      if (!f || f.archived) continue;
      out[r.kind] = { kind: r.kind, title: cleanTitle(f.title), description: r.description || '', path: pathOf(r.url), fileId: r.file_id };
    }
    return out;
  }

  function card({ tag, title, text, href, external }) {
    return `<a class="item" href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : ''}>
      ${tag ? `<span class="ltag">${esc(tag)}</span>` : ''}
      <h2>${esc(title)}</h2>
      ${text ? `<p>${esc(text)}</p>` : ''}
    </a>`;
  }

  function render() {
    const n = newest();
    let featured = null;
    try { featured = getFeatured() || null; } catch (e) { featured = null; }
    // A featured piece is shown once, at the top, not again in its category.
    if (!featured) {
      const pick = [n.blog, n.paper, n.poem].filter(Boolean)[0];
      if (pick) featured = { title: pick.title, text: pick.description, href: pick.path, tag: KIND_WORD[pick.kind].replace('Latest ', '') };
    }
    const featuredPath = featured ? pathOf(featured.href) : '';
    const latest = ['blog', 'paper', 'poem'].map(k => {
      const it = n[k];
      if (!it || it.path === featuredPath) return '';
      return card({ tag: KIND_WORD[k], title: it.title, text: it.description, href: it.path });
    }).join('');
    const alls = ['blog', 'paper', 'poem'].filter(k => n[k]).map(k => `<a href="${KIND_ALL[k][0]}">${KIND_ALL[k][1]}</a>`).join(' · ');
    const email = getContactEmail();
    let tagline = '';
    try { tagline = getTagline() || ''; } catch (e) { tagline = ''; }

    const inner = `<main class="links-page">
  <div class="lhead">
    <p class="lname">Per Norrgren</p>
    <p class="lbio">A meditation teacher, a yoga teacher and a long-term practitioner, and the creator of FELT·FIBRE.</p>
    ${tagline ? `<p class="ltag-line">${esc(tagline)}</p>` : ''}
    <p><a class="cta" href="/register?src=links">Try the app free</a></p>
  </div>

  ${featured ? `<p class="lsec">Featured now</p>
  <div class="list">${card({ tag: featured.tag || '', title: featured.title, text: featured.text, href: featured.href })}</div>` : ''}

  ${latest ? `<p class="lsec">New</p>
  <div class="list">${latest}</div>` : ''}
  ${alls ? `<p class="lall">${alls}</p>` : ''}

  <p class="lsec">Books</p>
  <div class="list">
    ${card({ tag: 'Book', title: 'The Wired Heart', text: 'When love activates fear, and how the body heals it.', href: '/wired-heart' })}
    ${card({ tag: 'Book and audiobook', title: 'The Alarm That Would Not Stop', text: 'How your nervous system got hijacked, and how to take it back.', href: '/alarm' })}
  </div>

  <p class="lsec">Practise for free</p>
  <div class="list">
    ${card({ tag: 'Guided practices', title: 'The Alarm practices', text: 'The twelve five-minute practices from the book. No sign-up needed.', href: '/the_alarm' })}
    ${card({ tag: 'Guided practices', title: 'FELT: the guided practices', text: 'Settling through the body, session by session.', href: '/felt' })}
  </div>

  <p class="lsec">More</p>
  <div class="list">
    ${card({ tag: 'Courses', title: 'Courses', text: 'Self-paced and live courses, including Mindfulness for Life.', href: '/courses' })}
    ${card({ tag: 'Learn', title: 'Questions people ask', text: 'Short answers on sleep, stress and the body.', href: '/learn' })}
    ${card({ tag: 'Talks', title: 'Podcasts and talks', text: 'Per is available for podcasts, interviews and talks.', href: '/podcasts' })}
    ${card({ tag: 'About', title: 'About Per', text: 'Teaching, supervision, and work with teams and workplaces.', href: '/#contact' })}
    ${email ? card({ tag: 'Contact', title: 'Get in touch', text: email, href: `mailto:${email}?subject=${encodeURIComponent('Enquiry from deepermindfulness.org/links')}` }) : ''}
  </div>
</main>`;
    const head = `<link rel="canonical" href="${SITE}/links">
<meta property="og:title" content="Per Norrgren · Deeper Mindfulness">
<meta property="og:description" content="The latest writing, books and free practices from Per Norrgren.">
<meta property="og:url" content="${SITE}/links">
${heroImg ? `<meta property="og:image" content="${esc(heroImg)}">` : ''}
<style>
  .links-page { max-width:560px; padding-top:32px; }
  .lhead { text-align:center; margin-bottom:8px; }
  .lname { font-size:28px; margin:0 0 6px; color:var(--ink); }
  .lbio { font-size:16px; color:var(--soft); margin:0 0 6px; }
  .ltag-line { font-size:15px; font-style:italic; color:var(--faint); margin:0 0 18px; }
  .lsec { font-size:11px; letter-spacing:0.22em; text-transform:uppercase; color:var(--faint); margin:34px 0 -14px; }
  .lall { font-size:14px; text-align:center; margin:14px 0 0; color:var(--faint); }
  .links-page .item h2 { font-size:19px; }
  .ltag { display:block; font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:var(--mint); margin:0 0 6px; }
</style>`;
    return publicPages.shell('Per Norrgren · Deeper Mindfulness: links', 'The latest writing, books and free practices from Per Norrgren, all in one place.', inner, head);
  }

  app.get('/links', (req, res) => {
    try { res.set('Cache-Control', 'no-cache'); res.type('html').send(render()); }
    catch (e) { log('[links] page failed: ' + e.message); res.status(500).send('Sorry, this page could not be shown just now.'); }
  });
  app.get(['/links/', '/link', '/bio'], (req, res) => res.redirect(301, '/links'));

  function syncSearch() {
    const pages = seoStore.listPages();
    const ex = pages.find(p => p.path === '/links');
    seoStore.savePage({ id: ex ? ex.id : undefined, path: '/links', title: 'Per Norrgren · Deeper Mindfulness: links',
      description: 'The latest writing, books and free practices from Per Norrgren, all in one place.',
      image_url: heroImg, og_type: 'website', schema_type: 'CollectionPage', in_sitemap: 1, in_llms: 1, priority: 0.5,
      schema_json: JSON.stringify({ '@type': 'CollectionPage', name: 'Per Norrgren: links', url: `${SITE}/links`, author: { '@type': 'Person', name: 'Per Norrgren', url: SITE } }) });
    invalidate();
  }

  return { syncSearch, render };
}

module.exports = { mountLinksPage };
