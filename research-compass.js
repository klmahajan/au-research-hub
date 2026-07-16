// ============================================================
//  AU Faculty Research Hub v3
//  Principles:
//   - Identity (name/title/school/dept) comes from AU's own
//     directories via faculty-roster.json — never inferred.
//   - OpenAlex data appears ONLY for confirmed/approved matches.
//   - No generated content. Empty sources = honest empty states.
// ============================================================

const SCHOOL_ORDER = ['CAS', 'SPA', 'SIS', 'Kogod', 'SOE', 'SOC', 'WCL', 'Other'];
// CSS variables so colors adapt to light/dark theme automatically
const SCHOOL_COLORS = {
  'CAS':   'var(--school-cas)',
  'SPA':   'var(--school-spa)',
  'SIS':   'var(--school-sis)',
  'WCL':   'var(--school-wcl)',
  'SOC':   'var(--school-soc)',
  'Kogod': 'var(--school-kogod)',
  'SOE':   'var(--school-soe)',
  'Other': 'var(--school-other)',
};

const state = {
  authors: [],
  links: [],
  grantLinks: [],    // co-PI edges from Dimensions grants (gold)
  meta: {},          // top-level metadata from the data file
  enriched: false,   // true when faculty-enriched.json loaded
  deepProfiles: {},  // self-reported sections from profiles-deep.json (may be absent)
  dimGrantsTotal: 0, // total AU grants fetched from Dimensions
  selectedSchool: 'ALL',
  viewMode: 'all',   // 'all' | 'publications' | 'grants'
  minStrength: 3,
  includeRanks: { adjunct: false, visiting: false, emeritus: false },
  hideIsolated: true,
  activeAuthorId: null,
  searchQuery: '',
  simulation: null,
  zoom: null,
  _hasAutoFit: false,
};

// ── Search synonyms: query expansion only — data is never altered.
//    Extend this list as gaps are found (both directions must be listed).
const SEARCH_SYNONYMS = {
  'ai': ['artificial intelligence'],
  'artificial intelligence': ['ai'],
  'ml': ['machine learning'],
  'machine learning': ['ml'],
  'nlp': ['natural language processing'],
  'natural language processing': ['nlp'],
  'ir': ['international relations'],
  'international relations': ['ir'],
  'econ': ['economics'],
  'stats': ['statistics'],
  'cyber': ['cybersecurity', 'cyber security'],
  'ip': ['intellectual property'],
  'intellectual property': ['ip'],
  'poli sci': ['political science'],
  'quant': ['quantitative'],
  'neuro': ['neuroscience'],
  'psych': ['psychology'],
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Small, conservative suffix list (longest-first) for reducing a query to a
// coarse word stem — enough to unify noun/adjective and singular/plural forms
// (cognition~cognitive, biology~biological, policy~policies) without the
// surprises of a full stemmer. Deliberately hand-picked and easy to audit.
const STEM_SUFFIXES = [
  'ational', 'ically', 'isation', 'ization', 'ations', 'itions', 'ities',
  'ology', 'ation', 'ition', 'ical', 'ance', 'ence', 'ics', 'ive', 'ion',
  'ity', 'ies', 'ing', 'ism', 'ist', 'al', 'ic', 'es', 's', 'y', 'e',
];

// Strip ONE suffix, but only if the remaining stem stays ≥5 chars — so
// "cognition"→"cognit" (not "cogn", which would over-match "cognate").
function stemQuery(q) {
  for (const s of STEM_SUFFIXES) {
    if (q.endsWith(s) && q.length - s.length >= 5) return q.slice(0, q.length - s.length);
  }
  return q;
}

// Match at word starts, and handle two regimes:
//  - Short queries (≤3 chars, i.e. acronyms like AI/ML/IR): WHOLE-word match,
//    so "AI" finds the word "AI" but never "Airapetian".
//  - Longer queries: reduce to a coarse stem, then prefix-match at a word
//    boundary — so "cognition" finds "cognitive" and "neuro" finds
//    "neuroscience", but "cognition" never matches "recognition".
function textMatches(hay, term) {
  term = term.toLowerCase();
  if (term.length <= 3) return new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(hay);
  return new RegExp(`\\b${escapeRegex(stemQuery(term))}`, 'i').test(hay);
}

function matchesQuery(hay, q) {
  return [q, ...(SEARCH_SYNONYMS[q] || [])].some(t => textMatches(hay, t));
}

// ── Rank classification (UI filter only — title strings shown verbatim) ──
function rankOf(person) {
  const t = (person.title || '').toLowerCase().replace(/-/g, ' ');
  if (/emerit/.test(t)) return 'emeritus';
  if (/adjunct/.test(t)) return 'adjunct';
  if (/visiting|in residence/.test(t)) return 'visiting';
  return 'core';
}

function schoolBucket(school) {
  return SCHOOL_COLORS[school] ? school : 'Other';
}

function getInitials(name) {
  return name.split(' ').filter(Boolean).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

function hasPubData(a) {
  return a.pub_match === 'confirmed';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ============================================================
//  DATA LOADING — enriched file preferred, roster-only fallback
// ============================================================
function setLoadingText(main, sub = '') {
  const t = document.getElementById('loading-text');
  const s = document.getElementById('loading-sub');
  if (t) t.textContent = main;
  if (s) s.textContent = sub;
}

async function loadData() {
  let data = null;
  try {
    const res = await fetch('dimensions-enriched.json');
    if (res.ok) { data = await res.json(); state.enriched = true; }
  } catch (e) { /* fall through */ }
  if (!data) {
    const res = await fetch('faculty-roster.json'); // throws on file:// — caught in init
    if (!res.ok) throw new Error(`roster fetch failed: ${res.status}`);
    data = await res.json();
    state.enriched = false;
  }
  state.meta = {
    source: data._source || '',
    date: data._enriched_at || data._scraped_at || '',
    gaps: data._known_gaps || [],
    counts: data._counts || null,
  };
  // Self-reported profile content is optional — absence is a normal state
  try {
    const res = await fetch('profiles-deep.json');
    if (res.ok) state.deepProfiles = (await res.json()).profiles || {};
  } catch (e) { /* not scraped yet — drawer shows directory data only */ }
  // Dimensions grants (optional layer) — attach to matched roster people and
  // build co-PI edges. Only auto/approved matches are used, per accuracy rules.
  try {
    const res = await fetch('dimensions-grants.json');
    if (res.ok) {
      const dg = await res.json();
      state.dimGrantsTotal = dg._total_grants || 0;
      const byId = {};
      for (const p of data.faculty) byId[p.au_profile_url] = p;
      const pairMap = {};
      for (const g of dg.grants || []) {
        const matched = (g.researchers || []).filter(r =>
          (r.match === 'auto' || r.match === 'approved') && r.roster_id && byId[r.roster_id]);
        for (const r of matched) {
          const p = byId[r.roster_id];
          (p.dimGrants = p.dimGrants || []).push({
            title: g.title, funder: g.funder, year: g.start_year,
            amount: g.funding_usd, linkout: g.linkout,
          });
        }
        for (let i = 0; i < matched.length; i++) {
          for (let j = i + 1; j < matched.length; j++) {
            const [a, b] = [matched[i].roster_id, matched[j].roster_id].sort();
            const k = a + '||' + b;
            pairMap[k] = pairMap[k] || { source: a, target: b, strength: 0, grantTitles: [], funders: [] };
            const L = pairMap[k];
            L.strength++;
            if (L.grantTitles.length < 3) L.grantTitles.push((g.title || '').slice(0, 80));
            if (g.funder && !L.funders.includes(g.funder)) L.funders.push(g.funder);
          }
        }
      }
      state.grantLinks = Object.values(pairMap);
      for (const p of data.faculty) {
        if (p.dimGrants) p.dimGrants.sort((a, b) => (b.year || 0) - (a.year || 0));
      }
    }
  } catch (e) { /* Dimensions layer not fetched yet — tool works without it */ }

  // Flag grant-holders: own AU profile lists grants (unambiguous attribution)
  // and/or Dimensions grants matched to them
  for (const p of data.faculty) {
    const deep = state.deepProfiles[p.au_profile_url];
    p._hasGrant = !!(deep && deep.sections && deep.sections.grants) || !!(p.dimGrants && p.dimGrants.length);
  }
  return data.faculty.map((p, i) => ({
    ...p,
    id: p.au_profile_url || `roster-${i}`,
    rank: rankOf(p),
    schoolBucket: schoolBucket(p.school),
    topics: p.topics || [],
    fields: p.fields || [],
  }));
}

// ── Field links between confirmed-matched people ──
// Connections are based on shared ANZSRC Fields of Research (standardized
// categories from Dimensions), NOT the free-text concepts — two demographers
// connect via "Demography" even if their paper wording never overlaps.
// Concepts stay as descriptive detail in the drawer.
async function buildLinks(authors) {
  const links = [];
  const matched = authors.filter(hasPubData);
  const n = matched.length;
  for (let i = 0; i < n; i++) {
    const aFields = new Set(matched[i].fields.map(f => f.id));
    for (let j = i + 1; j < n; j++) {
      const shared = matched[j].fields.filter(f => aFields.has(f.id));
      if (shared.length >= 1) {
        links.push({
          source: matched[i].id,
          target: matched[j].id,
          strength: shared.length,
          sharedTopics: shared.slice(0, 5).map(f => f.display_name),
        });
      }
    }
    if (i > 0 && i % 40 === 0) {
      setLoadingText('Building collaboration graph…', `${Math.round((i / n) * 100)}%`);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return links;
}

// ============================================================
//  FILTERING — one source of truth used by list AND network
// ============================================================
// School / rank / view-mode filters — everything EXCEPT the search text.
function passesBaseFilters(a) {
  if (state.selectedSchool !== 'ALL' && a.schoolBucket !== state.selectedSchool) return false;
  if (a.rank !== 'core' && !state.includeRanks[a.rank]) return false;
  if (state.viewMode === 'publications' && !hasPubData(a)) return false;
  if (state.viewMode === 'grants' && !a._hasGrant) return false;
  return true;
}

// Does this person match the current search text? (True when no search.)
function matchesSearch(a) {
  const q = state.searchQuery.toLowerCase();
  if (!q) return true;
  const deep = state.deepProfiles[a.au_profile_url];
  const interests = (deep && deep.sections && deep.sections.research_interests
    && deep.sections.research_interests.items) || [];
  const hay = [
    a.name, a.department, a.school, a.title,
    ...(a.fields.map(f => f.display_name || '')),
    ...(a.topics.map(t => t.display_name || '')),
    ...((a.dimGrants || []).map(g => `${g.title} ${g.funder}`)),
    ...interests,
  ].join(' ').toLowerCase();
  return matchesQuery(hay, q);
}

// The list's view: people passing every filter including search.
function visibleAuthors() {
  return state.authors.filter(a => passesBaseFilters(a) && matchesSearch(a));
}

function visibleLinks(idSet) {
  return state.links.filter(l => {
    const s = l.source.id || l.source;
    const t = l.target.id || l.target;
    return idSet.has(s) && idSet.has(t) && l.strength >= state.minStrength;
  });
}

// ============================================================
//  PROFILES LIST (left panel)
// ============================================================
function renderProfilesList() {
  const list = document.getElementById('profiles-list');
  const filtered = visibleAuthors();

  document.getElementById('filtered-count').textContent =
    filtered.length === state.authors.length ? '' : `${filtered.length} shown`;

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <p>No faculty match the current filters</p></div>`;
    return;
  }

  const cardHtml = (a, extraClass) => {
    const color = SCHOOL_COLORS[a.schoolBucket];
    const isActive = a.id === state.activeAuthorId;
    const rankBadge = a.rank !== 'core'
      ? `<span class="rank-badge">${esc(a.rank)}</span>` : '';
    const grantBadge = a._hasGrant ? `<span class="grant-badge">🏛 Grant</span>` : '';
    const stats = hasPubData(a)
      ? `<span class="profile-stat">
           <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
           ${a.works_count}
         </span>
         <span class="profile-stat">
           <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
           ${(a.cited_by_count || 0).toLocaleString()}
         </span>`
      : '';
    return `<div class="profile-card${isActive ? ' active' : ''}${extraClass}" role="listitem" data-id="${esc(a.id)}" tabindex="0" aria-pressed="${isActive}">
      <div class="profile-avatar" style="background:${color}">${esc(getInitials(a.name))}</div>
      <div class="profile-info">
        <div class="profile-name">${esc(a.name)}</div>
        <div class="profile-dept">${esc(a.department || a.school)}</div>
        <div class="profile-meta">
          <span class="profile-badge">${esc(a.title || '—')}</span>
          ${rankBadge}${grantBadge}${stats}
        </div>
      </div>
    </div>`;
  };

  // Surface the people currently visible in the network view at the top of
  // the list; everyone else stays below for browsing.
  const gids = state._graphIds;
  let inView = filtered, outView = [];
  // Partition whenever the graph shows fewer people than the list — including
  // the case where NOTHING qualifies ("In network view (0)" is information too).
  if (gids && filtered.some(x => !gids.has(x.id))) {
    inView = filtered.filter(x => gids.has(x.id));
    outView = filtered.filter(x => !gids.has(x.id));
  }
  list.innerHTML = outView.length
    ? `<div class="list-section-header">In network view (${inView.length})</div>`
      + inView.map(a => cardHtml(a, '')).join('')
      + `<div class="list-section-header">Not in current view (${outView.length})</div>`
      + outView.map(a => cardHtml(a, ' not-in-view')).join('')
    : inView.map(a => cardHtml(a, '')).join('');

  list.querySelectorAll('.profile-card').forEach(card => {
    card.addEventListener('click', () => selectAuthor(card.dataset.id));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAuthor(card.dataset.id); }
    });
  });
}

// ── School tabs, generated from real data ──
function renderSchoolTabs() {
  const nav = document.getElementById('school-tabs');
  const present = new Set(state.authors.map(a => a.schoolBucket));
  const schools = SCHOOL_ORDER.filter(s => present.has(s));
  nav.innerHTML = [`<button class="panel-tab active" role="tab" data-school="ALL" aria-selected="true">All</button>`]
    .concat(schools.map(s =>
      `<button class="panel-tab" role="tab" data-school="${esc(s)}" aria-selected="false">${esc(s)}</button>`))
    .join('');
  nav.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => setSchoolFilter(tab.dataset.school));
  });
}

function setSchoolFilter(school) {
  state.selectedSchool = school;
  state._hasAutoFit = false;
  document.querySelectorAll('.panel-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.school === school);
    t.setAttribute('aria-selected', t.dataset.school === school);
  });
  renderNetwork();
  renderProfilesList();
}

// ============================================================
//  AUTHOR SELECTION
// ============================================================
function selectAuthor(id) {
  state.activeAuthorId = id;
  const author = state.authors.find(a => a.id === id);
  if (!author) return;
  if (state.selectedSchool !== 'ALL' && author.schoolBucket !== state.selectedSchool) {
    setSchoolFilter('ALL');
  } else {
    renderProfilesList();
  }
  openDrawer(author);
  highlightNode(id);
  const card = document.querySelector(`.profile-card[data-id="${CSS.escape(id)}"]`);
  if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  // Pan to node, keeping current zoom level
  if (nodeSel && state.zoom && svgSel) {
    nodeSel.each(d => {
      if (d.id === id && d.x != null) {
        const svg = document.getElementById('network-svg');
        const W = svg.clientWidth || 800;
        const H = svg.clientHeight || 600;
        const currentT = d3.zoomTransform(svg);
        const scale = Math.max(currentT.k, 1.2);
        svgSel.transition().duration(500).ease(d3.easeCubicOut).call(
          state.zoom.transform,
          d3.zoomIdentity.translate(W / 2 - scale * d.x, H / 2 - scale * d.y).scale(scale)
        );
      }
    });
  }
}

// ============================================================
//  DETAIL DRAWER
// ============================================================
function formatCitations(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'k';
  return String(n);
}

function openDrawer(author) {
  const color = SCHOOL_COLORS[author.schoolBucket];
  document.getElementById('drawer-avatar').style.background = color;
  document.getElementById('drawer-avatar').textContent = getInitials(author.name);
  document.getElementById('drawer-name').textContent = author.name;
  document.getElementById('drawer-dept').textContent =
    [author.title, author.department].filter(Boolean).join(' · ');
  const badge = document.getElementById('drawer-school-badge');
  badge.textContent = author.school;
  badge.style.background = color;

  const connections = state.links.filter(l =>
    (l.source.id || l.source) === author.id || (l.target.id || l.target) === author.id).length;

  // Stats row — real numbers or an honest em-dash
  const stat = (val, label) => `
    <div class="drawer-stat">
      <div class="drawer-stat-value">${val}</div>
      <div class="drawer-stat-label">${label}</div>
    </div>`;
  document.getElementById('drawer-stats').innerHTML = hasPubData(author)
    ? stat((author.works_count || 0).toLocaleString(), 'Works')
      + stat(formatCitations(author.cited_by_count || 0), 'Citations')
      + stat(connections, 'Connections')
    : stat('—', 'Works') + stat('—', 'Citations') + stat(connections, 'Connections');

  // Body
  let body = '';

  if (hasPubData(author)) {
    if (author.fields.length) {
      body += `<div class="drawer-section-title">Research Fields <span style="font-weight:400;text-transform:none;letter-spacing:0">(Dimensions — basis for connections)</span></div>
        <div class="topic-chips">${author.fields.map(f =>
          `<span class="topic-chip" style="border-color:var(--color-primary);color:var(--color-primary)">${esc(f.display_name)}</span>`).join('')}</div>`;
    }
    if (author.topics.length) {
      body += `<div class="drawer-section-title">Research Areas <span style="font-weight:400;text-transform:none;letter-spacing:0">(Dimensions concepts)</span></div>
        <div class="topic-chips">${author.topics.slice(0, 10).map(t =>
          `<span class="topic-chip">${esc(t.display_name)}</span>`).join('')}</div>`;
    }
    if (author.recent_titles && author.recent_titles.length) {
      body += `<div class="drawer-section-title">Recent Publications <span style="font-weight:400;text-transform:none;letter-spacing:0">(Dimensions)</span></div>`
        + author.recent_titles.map(t =>
          `<p style="font-size:var(--text-xs);line-height:1.5;padding:var(--space-2) 0;border-bottom:1px solid var(--color-divider)">${esc(t.title)}${t.year ? ` <span style="color:var(--color-text-muted)">(${t.year})</span>` : ''}</p>`).join('');
    }
  } else {
    body += `<div class="drawer-note">No confirmed Dimensions researcher profile (2019+ publications) — publication data unavailable. Identity shown is from AU's faculty directory.</div>`;
  }

  // Grants from Dimensions (matched to this person under the accuracy rules)
  if (author.dimGrants && author.dimGrants.length) {
    body += `<div class="drawer-section-title">Grants (${author.dimGrants.length}) <span style="font-weight:400;text-transform:none;letter-spacing:0">(Dimensions)</span></div>`
      + author.dimGrants.slice(0, 8).map(g => {
        const meta = [g.funder, g.year, g.amount ? '$' + Math.round(g.amount).toLocaleString() : null]
          .filter(Boolean).join(' · ');
        const title = g.linkout
          ? `<a href="${esc(g.linkout)}" target="_blank" rel="noopener noreferrer">${esc(g.title)}</a>`
          : esc(g.title);
        return `<p style="font-size:var(--text-xs);line-height:1.5;padding:var(--space-2) 0;border-bottom:1px solid var(--color-divider)"><span style="font-weight:600">${title}</span><br><span style="color:var(--color-text-muted)">${esc(meta)}</span></p>`;
      }).join('')
      + (author.dimGrants.length > 8 ? `<p style="font-size:11px;color:var(--color-text-muted);padding-top:var(--space-2)">+ ${author.dimGrants.length - 8} more in Dimensions</p>` : '');
  }

  // Self-reported sections from the person's own AU profile page (verbatim)
  const deep = state.deepProfiles[author.au_profile_url];
  if (deep && deep.sections) {
    const S = deep.sections;
    const label = (t) => `<div class="drawer-section-title">${esc(t)} <span style="font-weight:400;text-transform:none;letter-spacing:0">(self-reported, AU profile)</span></div>`;
    if (S.research_interests) {
      body += label('Research Interests')
        + S.research_interests.items.slice(0, 3).map(t =>
          `<p style="font-size:var(--text-xs);line-height:1.55;color:var(--color-text);margin-bottom:var(--space-2)">${esc(t)}</p>`).join('');
    }
    if (S.grants) {
      body += label(`Grants (${S.grants.items.length})`)
        + S.grants.items.slice(0, 8).map(g => {
          const structured = g.project
            ? `<span style="font-weight:600">${esc(g.project)}</span><br><span style="color:var(--color-text-muted)">${esc(g.sponsor)}</span>`
            : esc(g.raw);
          return `<p style="font-size:var(--text-xs);line-height:1.5;padding:var(--space-2) 0;border-bottom:1px solid var(--color-divider)">${structured}</p>`;
        }).join('')
        + (S.grants.items.length > 8 ? `<p style="font-size:11px;color:var(--color-text-muted);padding-top:var(--space-2)">+ ${S.grants.items.length - 8} more on AU profile</p>` : '');
    }
    if (S.publications) {
      body += label(`Selected Publications (${S.publications.items.length})`)
        + S.publications.items.slice(0, 5).map(t =>
          `<p style="font-size:var(--text-xs);line-height:1.5;padding:var(--space-2) 0;border-bottom:1px solid var(--color-divider)">${esc(t)}</p>`).join('')
        + (S.publications.items.length > 5 ? `<p style="font-size:11px;color:var(--color-text-muted);padding-top:var(--space-2)">+ ${S.publications.items.length - 5} more on AU profile</p>` : '');
    }
  }

  // Potential collaborators via shared topics
  const collabLinks = state.links
    .filter(l => (l.source.id || l.source) === author.id || (l.target.id || l.target) === author.id)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 15);
  if (collabLinks.length) {
    body += `<div class="drawer-section-title">Shared Research Fields (${collabLinks.length})</div>`
      + collabLinks.map(link => {
        const otherId = (link.source.id || link.source) === author.id
          ? (link.target.id || link.target) : (link.source.id || link.source);
        const other = state.authors.find(a => a.id === otherId);
        if (!other) return '';
        return `<div class="collab-item" data-id="${esc(other.id)}" role="button" tabindex="0" aria-label="View ${esc(other.name)}'s profile">
          <div class="collab-avatar" style="background:${SCHOOL_COLORS[other.schoolBucket]}">${esc(getInitials(other.name))}</div>
          <div>
            <div class="collab-name">${esc(other.name)}</div>
            <div class="collab-shared">${link.strength} shared field${link.strength > 1 ? 's' : ''}: ${esc((link.sharedTopics || []).slice(0, 2).join(', '))}</div>
          </div>
        </div>`;
      }).join('');
  }

  document.getElementById('drawer-body').innerHTML = body;

  // External links — only real ones
  const links = [];
  if (author.au_profile_url) {
    links.push(`<a class="drawer-ext-link" href="${esc(author.au_profile_url)}" target="_blank" rel="noopener noreferrer">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      AU faculty profile</a>`);
  }
  if (hasPubData(author) && author.dim_researcher_id) {
    links.push(`<a class="drawer-ext-link" href="https://app.dimensions.ai/discover/publication?and_facet_researcher=${esc(author.dim_researcher_id)}" target="_blank" rel="noopener noreferrer">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      Dimensions researcher profile</a>`);
  }
  if (author.email) {
    links.push(`<a class="drawer-ext-link" href="mailto:${esc(author.email)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>
      ${esc(author.email)}</a>`);
  }
  document.getElementById('drawer-links').innerHTML = links.join('');

  document.getElementById('drawer-body').querySelectorAll('.collab-item').forEach(el => {
    el.addEventListener('click', () => selectAuthor(el.dataset.id));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAuthor(el.dataset.id); }
    });
  });

  const drawer = document.getElementById('detail-drawer');
  drawer.classList.add('open');
  drawer.removeAttribute('aria-hidden');
}

function closeDrawer() {
  document.getElementById('detail-drawer').classList.remove('open');
  document.getElementById('detail-drawer').setAttribute('aria-hidden', 'true');
  state.activeAuthorId = null;
  clearHighlight();
  renderProfilesList();
}

// ============================================================
//  D3 NETWORK
// ============================================================
let svgSel, gRoot, linkSel, grantLinkSel, nodeSel, simulation;

function initNetwork() {
  const svg = document.getElementById('network-svg');
  svgSel = d3.select(svg);
  gRoot = d3.select('#svg-root');

  // Calmer zoom: ~half default wheel sensitivity, tamed pinch multiplier,
  // tighter scale range, no double-click zoom.
  state._nodeComp = 1;
  state.zoom = d3.zoom()
    .scaleExtent([0.25, 4])
    .wheelDelta(event => -event.deltaY *
      (event.deltaMode === 1 ? 0.025 : event.deltaMode ? 0.5 : 0.0009) *
      (event.ctrlKey ? 3 : 1))
    .on('zoom', e => {
      gRoot.attr('transform', e.transform);
      // Counter-scale nodes when zoomed out so they stay legible
      const comp = Math.max(1, Math.min(2.4, 1 / e.transform.k));
      if (comp !== state._nodeComp) {
        state._nodeComp = comp;
        if (nodeSel) nodeSel.attr('transform', d =>
          `translate(${d.x || 0},${d.y || 0}) scale(${comp})`);
      }
    });
  svgSel.call(state.zoom).on('dblclick.zoom', null);
}

function renderNetwork() {
  const svg = document.getElementById('network-svg');
  const W = svg.clientWidth || 800;
  const H = svg.clientHeight || 600;

  let filteredAuthors = visibleAuthors();

  // During a search, expand the graph to include the real neighbors of the
  // matched people — so searching a single name (e.g. "Nicole Angotti") shows
  // that person surrounded by her actual connections, exactly like clicking
  // her does, instead of a lone isolated node. Neighbors must still pass the
  // base school/rank/view filters; they simply don't have to match the search
  // text. Matched people stay highlighted, neighbors are dimmed (see
  // applySearchHighlight), so it's clear who matched vs. who's context.
  if (state.searchQuery) {
    const matchedIds = new Set(filteredAuthors.map(a => a.id));
    const memberIds = new Set(matchedIds);
    const linkPullsIn = (l, respectStrength) => {
      if (respectStrength && (l.strength || 0) < state.minStrength) return;
      const s = l.source.id || l.source, t = l.target.id || l.target;
      const sMatched = matchedIds.has(s), tMatched = matchedIds.has(t);
      if (sMatched === tMatched) return; // both or neither matched — no new neighbor
      const neighbor = sMatched ? t : s;
      const author = state.authors.find(a => a.id === neighbor);
      if (author && passesBaseFilters(author)) memberIds.add(neighbor);
    };
    if (state.viewMode !== 'grants') state.links.forEach(l => linkPullsIn(l, true));
    if (state.viewMode !== 'publications') state.grantLinks.forEach(l => linkPullsIn(l, false));
    filteredAuthors = state.authors.filter(a => memberIds.has(a.id));
  }

  const filteredIds = new Set(filteredAuthors.map(a => a.id));
  // topic links hidden in grants view; grant links hidden in publications view
  const filteredLinks = state.viewMode === 'grants' ? [] : visibleLinks(filteredIds);
  const filteredGrantLinks = state.viewMode === 'publications' ? [] :
    state.grantLinks.filter(l => {
      const s = l.source.id || l.source;
      const t = l.target.id || l.target;
      return filteredIds.has(s) && filteredIds.has(t);
    });

  // In grants view most nodes have no edges — hiding isolated nodes there
  // would blank the graph, so skip that filter. Same during a search: the
  // matched people should appear as nodes even if unconnected to each other
  // (search answers "who matches", lines answer "who's related").
  if (state.hideIsolated && state.viewMode !== 'grants' && !state.searchQuery) {
    const connected = new Set();
    [...filteredLinks, ...filteredGrantLinks].forEach(l => {
      connected.add(l.source.id || l.source);
      connected.add(l.target.id || l.target);
    });
    filteredAuthors = filteredAuthors.filter(a => connected.has(a.id));
  }

  state._graphIds = new Set(filteredAuthors.map(a => a.id));

  document.getElementById('stat-connections').style.display = '';
  document.getElementById('conn-count').textContent = filteredLinks.length + filteredGrantLinks.length;

  gRoot.selectAll('*').remove();
  if (simulation) simulation.stop();

  const linkG = gRoot.append('g').attr('class', 'links');
  linkSel = linkG.selectAll('line')
    .data(filteredLinks)
    .enter().append('line')
    .attr('class', 'link')
    .attr('stroke', d => d.strength >= 4 ? 'var(--color-primary)' : 'var(--link-weak)')
    .attr('stroke-opacity', d => d.strength >= 4 ? 0.55 : d.strength >= 2 ? 0.45 : 0.3)
    .attr('stroke-width', d => d.strength >= 4 ? Math.min(d.strength * 0.7, 4) : Math.min(d.strength * 0.6, 2))
    .on('mouseenter', (event, d) => {
      const src = typeof d.source === 'object' ? d.source.name : d.source;
      const tgt = typeof d.target === 'object' ? d.target.name : d.target;
      const topics = (d.sharedTopics || []).slice(0, 3).join(', ');
      const tt = document.getElementById('net-tooltip');
      tt.innerHTML = `<strong>${esc(src)} ↔ ${esc(tgt)}</strong>${d.strength} shared field${d.strength > 1 ? 's' : ''}: ${esc(topics)}`;
      tt.classList.add('visible');
      moveTooltip(event);
    })
    .on('mousemove', moveTooltip)
    .on('mouseleave', hideTooltip);

  // Gold shared-grant edges (Dimensions co-PIs) — drawn above topic links
  const grantLinkG = gRoot.append('g').attr('class', 'grant-links');
  grantLinkSel = grantLinkG.selectAll('line')
    .data(filteredGrantLinks)
    .enter().append('line')
    .attr('class', 'grant-link')
    .attr('stroke', 'var(--color-gold)')
    .attr('stroke-width', d => Math.min(1.5 + d.strength * 0.5, 4))
    .on('mouseenter', (event, d) => {
      const src = state.authors.find(a => a.id === (d.source.id || d.source));
      const tgt = state.authors.find(a => a.id === (d.target.id || d.target));
      const tt = document.getElementById('net-tooltip');
      tt.innerHTML = `<strong>🏛 ${esc(src?.name)} ↔ ${esc(tgt?.name)}</strong>` +
        `${d.strength} shared grant${d.strength > 1 ? 's' : ''} (${esc(d.funders.slice(0, 2).join(', '))})` +
        `<br>${esc(d.grantTitles[0] || '')}`;
      tt.classList.add('visible');
      moveTooltip(event);
    })
    .on('mousemove', moveTooltip)
    .on('mouseleave', hideTooltip);

  const nodeG = gRoot.append('g').attr('class', 'nodes');
  nodeSel = nodeG.selectAll('g.node')
    .data(filteredAuthors, d => d.id)
    .enter().append('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded));

  const nodeR = d => Math.max(6, Math.min(20, 4 + Math.sqrt(d.works_count || 1) * 1.2));

  nodeSel.append('circle')
    .attr('r', nodeR)
    .attr('fill', d => SCHOOL_COLORS[d.schoolBucket])
    .attr('stroke', 'rgba(255,255,255,0.5)')
    .attr('stroke-width', 1.5);

  // Gold ring: this person's own AU profile lists grants
  nodeSel.filter(d => d._hasGrant)
    .append('circle')
    .attr('r', d => nodeR(d) + 4)
    .attr('fill', 'none')
    .attr('stroke', 'var(--color-gold)')
    .attr('stroke-width', 2)
    .attr('pointer-events', 'none')
    .attr('opacity', 0.85);

  nodeSel.append('text')
    .text(d => nodeR(d) >= 9 ? getInitials(d.name) : '')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', d => Math.max(6, nodeR(d) * 0.58))
    .attr('font-weight', '700')
    .attr('fill', 'rgba(255,255,255,0.92)')
    .attr('pointer-events', 'none');

  nodeSel.append('text')
    .attr('class', 'node-label')
    .text(d => d.name.split(' ').slice(-1)[0])
    .attr('text-anchor', 'middle')
    .attr('dy', d => nodeR(d) + 10)
    .attr('font-size', 8)
    .attr('fill', 'var(--color-text-muted)')
    .attr('pointer-events', 'none');

  nodeSel.on('mouseenter', (event, d) => showTooltip(event, d))
    .on('mousemove', moveTooltip)
    .on('mouseleave', hideTooltip)
    .on('click', (event, d) => { event.stopPropagation(); selectAuthor(d.id); });

  simulation = d3.forceSimulation(filteredAuthors)
    .force('link', d3.forceLink([...filteredLinks, ...filteredGrantLinks])
      .id(d => d.id).distance(70).strength(0.3))
    .force('charge', d3.forceManyBody().strength(-160))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide().radius(d => Math.max(7, Math.sqrt(d.works_count || 1) * 1.3 + 5)))
    .alphaDecay(0.028)
    .on('tick', ticked)
    .stop();

  // Compute the layout synchronously — the rAF-driven timer stalls in
  // background/hidden tabs, leaving the graph unlaid-out. Capped for size,
  // and capped harder when the edge set is dense (slider at 1 can mean
  // thousands of field links) so the UI never freezes for seconds.
  const edgeCount = filteredLinks.length + filteredGrantLinks.length;
  const maxTicks = edgeCount > 6000 ? 90 : edgeCount > 2500 ? 150 : 250;
  const tickCount = Math.min(maxTicks, Math.ceil(
    Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())));
  for (let i = 0; i < tickCount; i++) simulation.tick();
  ticked();
  if (!state._hasAutoFit) {
    state._hasAutoFit = true;
    resetView();
  }

  state.simulation = simulation;
  svgSel.on('click', () => { closeDrawer(); });
}

function ticked() {
  if (linkSel) linkSel
    .attr('x1', d => d.source.x || 0).attr('y1', d => d.source.y || 0)
    .attr('x2', d => d.target.x || 0).attr('y2', d => d.target.y || 0);
  if (grantLinkSel) grantLinkSel
    .attr('x1', d => d.source.x || 0).attr('y1', d => d.source.y || 0)
    .attr('x2', d => d.target.x || 0).attr('y2', d => d.target.y || 0);
  if (nodeSel) nodeSel.attr('transform', d =>
    `translate(${d.x || 0},${d.y || 0}) scale(${state._nodeComp || 1})`);
}

function dragStarted(event, d) {
  if (!event.active && simulation) simulation.alphaTarget(0.3).restart();
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
function dragEnded(event, d) {
  if (!event.active && simulation) simulation.alphaTarget(0);
  d.fx = null; d.fy = null;
}

function highlightNode(authorId) {
  if (!nodeSel) return;
  const connectedIds = new Set([authorId]);
  const collect = sel => sel && sel.each(d => {
    const s = d.source.id || d.source, t = d.target.id || d.target;
    if (s === authorId) connectedIds.add(t);
    if (t === authorId) connectedIds.add(s);
  });
  collect(linkSel);
  collect(grantLinkSel);
  nodeSel.classed('dimmed', d => !connectedIds.has(d.id));
  const mark = sel => sel && sel
    .classed('dimmed', d => { const s = d.source.id || d.source, t = d.target.id || d.target; return s !== authorId && t !== authorId; })
    .classed('highlighted', d => { const s = d.source.id || d.source, t = d.target.id || d.target; return s === authorId || t === authorId; });
  mark(linkSel);
  mark(grantLinkSel);
}

function clearHighlight() {
  if (nodeSel) nodeSel.classed('dimmed', false);
  if (linkSel) linkSel.classed('dimmed', false).classed('highlighted', false);
  if (grantLinkSel) grantLinkSel.classed('dimmed', false).classed('highlighted', false);
}

// ── Tooltip ──
function showTooltip(event, d) {
  const tt = document.getElementById('net-tooltip');
  const connCount = state.links.filter(l =>
    (l.source.id || l.source) === d.id || (l.target.id || l.target) === d.id).length;
  const pub = hasPubData(d) ? `${d.works_count} works · ` : '';
  tt.innerHTML = `<strong>${esc(d.name)}</strong>${esc(d.school)}${d.department ? ' · ' + esc(d.department) : ''}<br>${pub}${connCount} connections`;
  tt.classList.add('visible');
  moveTooltip(event);
}
function moveTooltip(event) {
  const tt = document.getElementById('net-tooltip');
  const rect = document.getElementById('network-svg').getBoundingClientRect();
  let x = event.clientX - rect.left + 12;
  let y = event.clientY - rect.top + 12;
  if (x + 220 > rect.width) x = event.clientX - rect.left - 232;
  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
}
function hideTooltip() {
  document.getElementById('net-tooltip').classList.remove('visible');
}

// ── Reset view: zoom-to-fit ──
function resetView() {
  if (!state.zoom || !svgSel || !nodeSel) return;
  const svg = document.getElementById('network-svg');
  const W = svg.clientWidth || 800;
  const H = svg.clientHeight || 600;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  nodeSel.each(d => {
    if (d.x != null) { minX = Math.min(minX, d.x); maxX = Math.max(maxX, d.x); }
    if (d.y != null) { minY = Math.min(minY, d.y); maxY = Math.max(maxY, d.y); }
  });
  if (!isFinite(minX)) {
    svgSel.transition().duration(500).ease(d3.easeCubicOut)
      .call(state.zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2));
    return;
  }
  const pad = 60;
  const gW = maxX - minX || 1;
  const gH = maxY - minY || 1;
  const scale = Math.min((W - pad * 2) / gW, (H - pad * 2) / gH, 2);
  const tx = W / 2 - scale * (minX + maxX) / 2;
  const ty = H / 2 - scale * (minY + maxY) / 2;
  svgSel.transition().duration(600).ease(d3.easeCubicOut).call(
    state.zoom.transform,
    d3.zoomIdentity.translate(tx, ty).scale(scale)
  );
}

// ============================================================
//  EVENT WIRING
// ============================================================
function wireEvents() {
  document.getElementById('close-drawer').addEventListener('click', closeDrawer);
  document.getElementById('reset-view').addEventListener('click', resetView);

  // Search rebuilds the graph (debounced) so the network and the list always
  // describe the same filtered reality — highlight gives instant feedback in
  // the meantime, then the rebuild replaces it.
  let searchTimer = null;
  document.getElementById('global-search').addEventListener('input', e => {
    state.searchQuery = e.target.value.trim();
    renderProfilesList();
    applySearchHighlight();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state._hasAutoFit = false;
      renderNetwork();
      renderProfilesList();
      applySearchHighlight(); // dim the pulled-in neighbors, highlight matches
    }, 300);
  });

  document.getElementById('strength-slider').addEventListener('input', e => {
    state.minStrength = parseInt(e.target.value);
    document.getElementById('strength-val').textContent = e.target.value;
    state._hasAutoFit = false;
    renderNetwork();
    renderProfilesList();
  });

  const rankToggle = (btnId, rank) => {
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', () => {
      state.includeRanks[rank] = !state.includeRanks[rank];
      btn.classList.toggle('active', state.includeRanks[rank]);
      btn.setAttribute('aria-pressed', state.includeRanks[rank]);
      state._hasAutoFit = false;
      renderNetwork();
      renderProfilesList();
    });
  };
  rankToggle('toggle-adjunct', 'adjunct');
  rankToggle('toggle-visiting', 'visiting');
  rankToggle('toggle-emeritus', 'emeritus');

  document.querySelectorAll('.view-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view;
      document.querySelectorAll('.view-chip').forEach(b =>
        b.classList.toggle('active', b === btn));
      state._hasAutoFit = false;
      renderNetwork();
      renderProfilesList();
    });
  });

  const isolatedBtn = document.getElementById('toggle-isolated');
  isolatedBtn.addEventListener('click', () => {
    state.hideIsolated = !state.hideIsolated;
    isolatedBtn.classList.toggle('active', state.hideIsolated);
    isolatedBtn.setAttribute('aria-pressed', state.hideIsolated);
    state._hasAutoFit = false;
    renderNetwork();
    renderProfilesList();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('detail-drawer').classList.contains('open')) {
        closeDrawer();
      } else if (state.searchQuery) {
        state.searchQuery = '';
        document.getElementById('global-search').value = '';
        state._hasAutoFit = false;
        renderNetwork();
        renderProfilesList();
        applySearchHighlight();
      }
    }
    if ((e.key === 'r' || e.key === 'R') && !e.target.closest('input')) resetView();
  });

  // Re-fit the graph when the window/panel is resized (debounced)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resetView, 300);
  });

  // Dark mode toggle
  const t = document.getElementById('theme-toggle');
  const r = document.documentElement;
  let mode = matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
  r.setAttribute('data-theme', mode);
  const moonSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const sunSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  t.innerHTML = mode === 'dark' ? sunSvg : moonSvg;
  t.addEventListener('click', () => {
    mode = mode === 'dark' ? 'light' : 'dark';
    r.setAttribute('data-theme', mode);
    t.innerHTML = mode === 'dark' ? sunSvg : moonSvg;
  });
}

function applySearchHighlight() {
  if (!nodeSel) return;
  const q = state.searchQuery.toLowerCase();
  if (!q) { clearHighlight(); return; }
  const matchIds = new Set(visibleAuthors().map(a => a.id));
  nodeSel.classed('dimmed', d => !matchIds.has(d.id));
  const mark = sel => sel && sel
    .classed('highlighted', d => matchIds.has(d.source.id || d.source) && matchIds.has(d.target.id || d.target))
    .classed('dimmed', d => !matchIds.has(d.source.id || d.source) && !matchIds.has(d.target.id || d.target));
  mark(linkSel);
  mark(grantLinkSel);
}

// ── Provenance banner ──
function renderSourceBanner() {
  const b = document.getElementById('source-banner');
  b.style.display = '';
  if (state.enriched) {
    const c = state.meta.counts || {};
    const pubCount = (c.confirmed || 0) + (c.approved || 0);
    const deepCount = Object.keys(state.deepProfiles).length;
    const dimNote = state.dimGrantsTotal
      ? ` Grants: Dimensions (${state.dimGrantsTotal} AU grants, ${state.grantLinks.length} co-PI connections).` : '';
    b.textContent = `Roster: AU faculty directories. Publications: Dimensions 2019+ (${c.publications_scanned || '—'} scanned), shown only for ${pubCount} matched researchers${c.review ? ` · ${c.review} ambiguous held for review` : ''}.${dimNote}${deepCount ? ` Self-reported content from ${deepCount} AU profile pages.` : ''} Known gap: WCL directory offline.`;
  } else {
    b.classList.add('warn');
    b.textContent = 'Roster loaded from AU directories — Dimensions enrichment not yet run, so no publication data or connections are shown.';
  }
}

// ============================================================
//  BOOT
// ============================================================
async function init() {
  initNetwork();
  wireEvents();
  try {
    setLoadingText('Loading faculty roster…');
    state.authors = await loadData();

    document.getElementById('stat-count').textContent = state.authors.length;
    const enrichedCount = state.authors.filter(hasPubData).length;
    if (state.enriched) {
      document.getElementById('stat-enriched').style.display = '';
      document.getElementById('enriched-count').textContent = enrichedCount;
    }

    setLoadingText('Building collaboration graph…');
    state.links = await buildLinks(state.authors);

    renderSourceBanner();

    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 500);

    renderSchoolTabs();
    renderNetwork();
    renderProfilesList();
  } catch (err) {
    console.error(err);
    const isFile = location.protocol === 'file:';
    setLoadingText('Could not load data',
      isFile
        ? 'This page must be served over HTTP — run: python3 -m http.server 8000, then open http://localhost:8000/v3.html'
        : 'faculty-roster.json not found or invalid. Run scrape-roster.py first.');
    document.querySelector('.loading-spinner')?.remove();
  }
}

init();
