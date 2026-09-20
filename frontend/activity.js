// Activity tab: a GitHub-style contribution graph of sessions started per day (UTC), one column per week
// (Sun–Sat), with a year list on the right. Loads the current year unless ?year= is in the URL; picking
// a year writes it there and refetches.

const ACTIVITY_YEARS = 5; // current year and the 4 before it
const ACTIVITY_LEVELS = 4; // shades of green above "none"
const DAY_MS = 864e5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function renderActivity(root, status, params) {
  const el = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  };

  const panel = el('div', 'activity-panel');
  const graph = el('div', 'activity-graph');
  const summary = el('p', 'activity-summary muted');
  const legend = el('div', 'activity-legend muted');
  legend.append(el('span', null, 'Less'));
  for (let l = 0; l <= ACTIVITY_LEVELS; l++) {
    const sq = el('span', 'day');
    sq.dataset.level = l;
    legend.append(sq);
  }
  legend.append(el('span', null, 'More'));
  const footer = el('div', 'activity-footer');
  footer.append(summary, legend);
  panel.append(graph, footer);

  const years = el('nav', 'activity-years');
  const thisYear = new Date().getUTCFullYear();
  for (let y = thisYear; y > thisYear - ACTIVITY_YEARS; y--) {
    const b = el('button', 'year-btn', String(y));
    b.type = 'button';
    b.dataset.year = y;
    b.addEventListener('click', () => {
      const q = new URLSearchParams(location.search);
      q.set('year', y);
      history.replaceState(null, '', `?${q}`);
      load(y);
    });
    years.append(b);
  }

  root.append(panel, years);
  root.hidden = false;

  const selectYear = (year) => {
    for (const b of years.children) {
      const on = Number(b.dataset.year) === year;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
  };

  let latest = 0; // ignore responses from a year that's no longer selected
  async function load(year) {
    const req = ++latest;
    if (year) selectYear(year);
    panel.classList.add('loading');
    try {
      const res = await fetch(year ? `/fetch-activity?year=${year}` : '/fetch-activity');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      if (req !== latest) return;
      selectYear(data.year);
      draw(data);
      status.textContent = '';
    } catch (err) {
      if (req === latest) status.textContent = `Error: ${err.message}`;
    } finally {
      if (req === latest) panel.classList.remove('loading');
    }
  }

  // Grid: column 1 holds the weekday labels, row 1 the month labels; the first week column starts on the
  // Sunday on or before Jan 1, and days outside the year are left blank.
  function draw(data) {
    const year = Number.isInteger(data.year) ? data.year : new Date().getUTCFullYear();
    // Only well-formed day counts; anything else counts as no sessions that day
    const days = Object.fromEntries(
      Object.entries(data.days && typeof data.days === 'object' ? data.days : {}).filter(([, n]) => Number.isFinite(n) && n > 0)
    );
    const jan1 = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    const start = jan1 - new Date(jan1).getUTCDay() * DAY_MS;
    const max = Math.max(0, ...Object.values(days));
    const cells = [];

    ['Mon', 'Wed', 'Fri'].forEach((d, i) => {
      const label = el('span', 'weekday', d);
      label.style.gridColumn = 1;
      label.style.gridRow = 3 + 2 * i; // Mon, Wed, Fri are rows 2, 4, 6 of the week (+1 for the month row)
      cells.push(label);
    });

    let total = 0, active = 0;
    for (let t = start, i = 0; t < end; t += DAY_MS, i++) {
      const col = 2 + Math.floor(i / 7);
      const d = new Date(t);
      if (d.getUTCDate() === 1) {
        // Month label above the week holding its 1st; it overflows its fixed-width column
        const m = el('span', 'month', MONTHS[d.getUTCMonth()]);
        m.style.gridColumn = col;
        cells.push(m);
      }
      if (t < jan1) continue;
      const key = d.toISOString().slice(0, 10);
      const n = days[key] ?? 0;
      total += n;
      if (n) active++;
      const sq = el('span', 'day');
      sq.style.gridColumn = col;
      sq.style.gridRow = 2 + d.getUTCDay();
      sq.dataset.level = n ? Math.ceil((n / max) * ACTIVITY_LEVELS) : 0;
      const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      sq.title = `${n || 'No'} session${n === 1 ? '' : 's'} on ${date}`;
      cells.push(sq);
    }

    graph.style.gridTemplateColumns = `auto repeat(${Math.ceil((end - start) / DAY_MS / 7)}, var(--cell))`;
    graph.replaceChildren(...cells);
    summary.textContent = `${total.toLocaleString()} session${total === 1 ? '' : 's'} on ${active} day${active === 1 ? '' : 's'} in ${year} (UTC)`;
  }

  const y = Number(params.get('year'));
  load(Number.isInteger(y) && y > 0 ? y : null);
}
