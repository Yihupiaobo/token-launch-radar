// Token Launch Radar — the dashboard. It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, live filters, a per-protocol detail view with the
// model's full factor breakdown and farm plan, and the live peer table that priced the
// board. No network: every byte it shows is in data.js. URL parameters (?category=Dexs,
// ?detail=<slug>, ?watch=1, ?q=<text>) preset the view, so a shared link or a screenshot
// always shows the same filtered board.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var params = new URLSearchParams(location.search);
  var state = {
    q: params.get('q') || '',
    category: params.get('category') || 'all',
    chain: params.get('chain') || 'all',
    conf: params.get('conf') || 'all',
    watch: params.get('watch') === '1',
    sort: 'implied_value_usd',
    dir: -1,
    selected: params.get('detail') || null,
  };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + Number(n).toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + ' yrs';
    return Math.round(days) + ' days';
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The model in one function: the page recomputes a row's implied value from the factors
  // data.js carries and checks it against the row, so page and board visibly agree.
  function impliedOf(row) {
    return Math.max(1, Math.round(row.tvl_usd * row.peer_multiple * row.growth_multiplier * row.maturity_multiplier * row.breadth_multiplier));
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (state.conf !== 'all' && r.confidence !== state.conf) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function sorted(rows) {
    var key = state.sort, dir = state.dir;
    return rows.slice().sort(function (a, b) {
      var x = a[key], y = b[key];
      if (x === null || x === undefined) x = -Infinity;
      if (y === null || y === undefined) y = -Infinity;
      if (typeof x === 'string') return dir * x.localeCompare(y);
      return dir * (x - y) || a.rank - b.rank;
    });
  }

  function header() {
    return el('header', { 'class': 'hero' },
      el('div', { 'class': 'kicker', text: 'Token Launch Radar · model ' + DATA.model_version }),
      el('h1', null, 'Which pre-token protocol is ', el('span', { 'class': 'thin', text: 'worth farming next?' })),
      el('p', { 'class': 'sub' },
        'Every protocol in the snapshot that ', el('b', { text: 'records no token yet' }),
        ', priced by the protocols that already trade — then ranked, with the exact steps to farm each one. ',
        'Snapshot of ' + DATA.as_of + ', source: ' + DATA.source + '. An implied value is this board\u2019s own claim, not a prediction that a token will launch.'));
  }
  function stats() {
    var s = el('div', { 'class': 'stats' });
    [
      [String(DATA.board_size), 'pre-token protocols ranked (' + DATA.watchlist_size + ' watchlist + ' + DATA.early_size + ' early finds)'],
      [fmtUsd(DATA.total_tvl_usd), 'combined TVL under watch'],
      [fmtUsd(DATA.total_implied_usd), 'combined implied launch value'],
      [fmtUsd(DATA.total_community_pool_usd), 'community pool if 10% of each launch went to farmers (scenario)'],
    ].forEach(function (pair) {
      s.appendChild(el('div', { 'class': 'stat' }, el('div', { 'class': 'num', text: pair[0] }), el('div', { 'class': 'lab', text: pair[1] })));
    });
    return s;
  }
  function modelBox() {
    return el('section', { 'class': 'model' },
      el('h2', { text: 'How the pricing works — no name is ever hand-picked' }),
      el('p', null,
        'Implied value = TVL \u00d7 ', el('code', { text: 'peer multiple' }),
        ' \u00d7 growth \u00d7 maturity \u00d7 breadth. The peer multiple is the median market-cap/TVL of live-token protocols in the same category (global median when a category has fewer than ' + DATA.model.min_peers + ' priced peers), clamped to ' + DATA.model.multiple_floor + '\u2013' + DATA.model.multiple_cap + '. ',
        'Growth uses the 7-day TVL change clamped to ' + DATA.model.growth_floor + '%\u2026+' + DATA.model.growth_cap + '% at weight ' + DATA.model.growth_weight + '; maturity rewards time live with no token (up to ' + DATA.model.maturity_days + ' days); breadth adds ' + Math.round(DATA.model.breadth_step * 100) + '% per extra chain, up to four. ',
        'Confidence grades the evidence (TVL size, age, peer depth, calm growth): A strongest, C thinnest. Click any row for its full breakdown and farm plan.'));
  }
  function controls() {
    var wrap = el('div', { 'class': 'controls' });
    var search = el('input', { type: 'search', placeholder: 'Search name or slug\u2026', value: state.q });
    search.addEventListener('input', function () { state.q = search.value; render(); });
    wrap.appendChild(search);
    function select(options, value, onchange, label) {
      var sel = el('select', { 'aria-label': label });
      options.forEach(function (o) { sel.appendChild(el('option', { value: o, text: o === 'all' ? label + ': all' : o })); });
      sel.value = value;
      sel.addEventListener('change', function () { onchange(sel.value); render(); });
      return sel;
    }
    wrap.appendChild(select(['all'].concat(DATA.categories), state.category, function (v) { state.category = v; }, 'Category'));
    wrap.appendChild(select(['all'].concat(DATA.chains), state.chain, function (v) { state.chain = v; }, 'Chain'));
    wrap.appendChild(select(['all', 'A', 'B', 'C'], state.conf, function (v) { state.conf = v; }, 'Confidence'));
    var toggle = el('label', { 'class': 'toggle' });
    var box = el('input', { type: 'checkbox' });
    box.checked = state.watch;
    box.addEventListener('change', function () { state.watch = box.checked; render(); });
    toggle.appendChild(box);
    toggle.appendChild(document.createTextNode(' Watchlist only (' + DATA.watchlist_size + ')'));
    wrap.appendChild(toggle);
    wrap.appendChild(el('span', { 'class': 'count', id: 'rowcount' }));
    return wrap;
  }

  function boardTable(rows) {
    var table = el('table');
    var head = el('tr');
    var cols = [
      ['rank', '#', ''], ['name', 'Protocol', ''], ['implied_value_usd', 'Implied value', 'num'],
      ['tvl_usd', 'TVL', 'num hide'], ['change_7d', '7d', 'num'], ['peer_multiple', 'Peer \u00d7', 'num hide'],
      ['confidence', 'Conf.', ''], ['community_pool_usd', 'Farmer pool*', 'num hide'],
    ];
    cols.forEach(function (c) {
      var th = el('th', { 'class': c[2], text: c[1] + (state.sort === c[0] ? (state.dir < 0 ? ' \u2193' : ' \u2191') : '') });
      th.addEventListener('click', function () {
        if (state.sort === c[0]) state.dir = -state.dir; else { state.sort = c[0]; state.dir = c[0] === 'name' || c[0] === 'confidence' ? 1 : -1; }
        render();
      });
      head.appendChild(th);
    });
    table.appendChild(el('thead', null, head));
    var body = el('tbody');
    var maxImplied = DATA.rows.length ? DATA.rows[0].implied_value_usd : 1;
    rows.slice(0, 120).forEach(function (r) {
      var nameCell = el('td', null,
        el('span', { 'class': 'pname', text: r.name }),
        r.on_watchlist ? el('span', { 'class': 'badge watch', text: 'watchlist' }) : el('span', { 'class': 'badge', text: 'early' }),
        el('div', { 'class': 'slug', text: r.slug + ' · ' + (r.category || 'Uncategorised') + ' · ' + (r.chains.join(', ') || 'no chain listed') }));
      var impliedCell = el('td', { 'class': 'num' },
        el('span', { 'class': 'implied', text: fmtUsd(r.implied_value_usd) }),
        el('div', { 'class': 'bar' }, el('i', { style: 'width:' + Math.max(2, Math.round(100 * r.implied_value_usd / maxImplied)) + '%' })));
      var tr = el('tr', { 'class': 'row' },
        el('td', { 'class': 'rank', text: '#' + r.rank }),
        nameCell,
        impliedCell,
        el('td', { 'class': 'num hide', text: fmtUsd(r.tvl_usd) }),
        el('td', { 'class': 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { 'class': 'num hide', text: r.peer_multiple.toFixed(2) + '\u00d7 (' + r.peer_count + ')' }),
        el('td', null, el('span', { 'class': 'conf ' + r.confidence, text: r.confidence })),
        el('td', { 'class': 'num hide', text: fmtUsd(r.community_pool_usd) }));
      tr.addEventListener('click', function () { state.selected = r.slug; render(); window.scrollTo(0, 0); });
      body.appendChild(tr);
    });
    table.appendChild(body);
    return table;
  }

  function detailView() {
    if (!state.selected) return null;
    var r = null;
    DATA.rows.forEach(function (x) { if (x.slug === state.selected) r = x; });
    if (!r) return null;
    var check = impliedOf(r);
    var wrap = el('section', { 'class': 'detail', id: 'detail' },
      el('h2', null, '#' + r.rank + ' ' + r.name, r.on_watchlist ? el('span', { 'class': 'badge watch', text: 'on the watchlist' }) : el('span', { 'class': 'badge', text: 'early find below the $50M floor' })),
      el('div', { 'class': 'meta', text: r.slug + ' · ' + (r.category || 'Uncategorised') + ' · chains: ' + (r.chains.join(', ') || 'none listed') + ' · tracked for ' + fmtAge(r.age_days) + ' · records no token in this snapshot (no symbol, no CoinGecko id, no market cap)' }));
    var factors = el('div', { 'class': 'factors' });
    [
      [fmtUsd(r.tvl_usd), 'TVL — the base the multiple prices'],
      [r.peer_multiple.toFixed(2) + '\u00d7', 'peer multiple — median of ' + r.peer_count + ' live ' + (r.peer_scope === 'category' ? (r.category || '') + ' peers' : 'protocols overall')],
      [r.growth_multiplier.toFixed(2) + '\u00d7', 'growth — 7d TVL change ' + fmtPct(r.change_7d) + ', clamped and weighted'],
      [r.maturity_multiplier.toFixed(2) + '\u00d7 / ' + r.breadth_multiplier.toFixed(2) + '\u00d7', 'maturity (age ' + fmtAge(r.age_days) + ') / breadth (' + r.chains.length + ' chains)'],
      [fmtUsd(r.implied_value_usd), 'implied launch value (page recomputes ' + fmtUsd(check) + ' — same arithmetic)'],
      [fmtUsd(r.community_pool_usd), 'farmer pool if 10% went to the community (scenario)'],
      [r.confidence, 'confidence grade for this estimate'],
    ].forEach(function (pair) {
      factors.appendChild(el('div', { 'class': 'factor' }, el('div', { 'class': 'fv', text: pair[0] }), el('div', { 'class': 'fl', text: pair[1] })));
    });
    wrap.appendChild(factors);
    wrap.appendChild(el('h3', { text: 'Farm plan — seven steps, costs and time included' }));
    var list = el('ol', { 'class': 'steps' });
    r.farm_steps.forEach(function (s, i) {
      list.appendChild(el('li', null, el('span', { 'class': 'st', text: 'Step ' + (i + 1) + '. ' }), document.createTextNode(s)));
    });
    wrap.appendChild(list);
    return wrap;
  }

  function liveTable() {
    var wrap = el('div');
    wrap.appendChild(el('h2', { 'class': 'section', text: 'Already trading — the peers that priced this board' }));
    wrap.appendChild(el('p', { 'class': 'note', text: 'These protocols already have a token, so they are never ranked as launches. Their market-cap/TVL ratios are the evidence the peer multiples come from; the board\u2019s job is the ' + DATA.board_size + ' protocols above that still record no token.' }));
    var table = el('table');
    table.appendChild(el('thead', null, el('tr', null,
      el('th', { text: 'Protocol' }), el('th', { 'class': 'num', text: 'Market cap' }),
      el('th', { 'class': 'num hide', text: 'TVL' }), el('th', { 'class': 'num', text: 'Mcap / TVL' }), el('th', { 'class': 'num hide', text: '7d' }))));
    var body = el('tbody');
    DATA.live.forEach(function (p) {
      body.appendChild(el('tr', null,
        el('td', null, el('span', { 'class': 'pname', text: p.name }), el('div', { 'class': 'slug', text: p.slug + ' · ' + (p.category || 'Uncategorised') })),
        el('td', { 'class': 'num', text: fmtUsd(p.mcap_usd) }),
        el('td', { 'class': 'num hide', text: fmtUsd(p.tvl_usd) }),
        el('td', { 'class': 'num', text: p.mcap_tvl === null ? 'n/a' : p.mcap_tvl.toFixed(2) + '\u00d7' }),
        el('td', { 'class': 'num hide ' + (p.change_7d === null ? '' : p.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(p.change_7d) })));
    });
    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
  }

  function render() {
    var rows = sorted(filtered());
    app.textContent = '';
    app.appendChild(header());
    app.appendChild(stats());
    app.appendChild(modelBox());
    var detail = detailView();
    if (detail) app.appendChild(detail);
    app.appendChild(controls());
    app.appendChild(boardTable(rows));
    var count = document.getElementById('rowcount');
    if (count) count.textContent = 'Showing ' + Math.min(120, rows.length) + ' of ' + rows.length + ' matching protocols (' + DATA.board_size + ' ranked in all)';
    app.appendChild(el('p', { 'class': 'note', text: '* Farmer pool is a scenario column: the value early farmers would share if a launch allocated 10% of the implied value to its community. It is a sizing aid, not a promise by any protocol.' }));
    app.appendChild(liveTable());
    app.appendChild(el('footer', { text: 'Built from the sealed token-radar-01 snapshot (' + DATA.source + '). Protocols are described as recording no token in that snapshot, never as having none. Implied values are this board\u2019s own model output; farming any protocol carries smart-contract and market risk, and no step here is financial advice.' }));
    app.setAttribute('aria-busy', 'false');
  }
  render();
})();
