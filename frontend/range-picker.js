// Time-range picker for the Completed tab, modelled on CloudWatch's: a segmented bar of quick relative
// presets plus "Custom", which opens a panel with two modes:
//   Relative  a grid of common spans, or any number of hours/days/weeks/months/years
//   Absolute  a two-month calendar (click a start day, then an end day) with date/time fields
// Times are local. The range itself lives in the URL (see server/range.ts): the picker reads the current
// params and hands new ones to onApply; nothing changes until Apply (or a preset) is clicked.

(() => {
  const UNIT_SHORT = { hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' };
  const UNIT_LABEL = { hour: 'Hours', day: 'Days', week: 'Weeks', month: 'Months', year: 'Years' };
  const PRESETS = [[1, 'hour'], [3, 'hour'], [12, 'hour'], [1, 'day'], [3, 'day'], [1, 'week']];
  const GRID = { hour: [1, 2, 3, 6, 12], day: [1, 2, 3, 5], week: [1, 2, 3, 4], month: [1, 3, 6, 12] };
  const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const CAL_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3"/></svg>';

  function mk(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    if (tag === 'button') el.type = 'button';
    return el;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const dateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const withTime = (day, time) => {
    const [h = 0, m = 0, s = 0] = time.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, s);
  };
  const parseDate = (v) => {
    const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms) : null;
  };
  const fmt = (d) => d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // URL params -> { mode: 'relative', period, unit } | { mode: 'absolute', start, end }
  function readCurrent(q) {
    if (q.timeRange === 'absolute') {
      const start = parseDate(q.startDate ?? '');
      const end = parseDate(q.endDate ?? '');
      if (start && end) return { mode: 'absolute', start, end };
    }
    const period = Number(q.period);
    const unit = q.unit?.replace(/s$/, '');
    if (Number.isInteger(period) && period > 0 && UNIT_SHORT[unit]) return { mode: 'relative', period, unit };
    return { mode: 'relative', period: 1, unit: 'week' };
  }

  // params: the range keys from the page URL. onApply({ timeRange, ... }) gets the new range params.
  // Returns { el, setResolved({ from, to }) }; setResolved passes in the server's resolved span, which
  // pre-fills the Absolute calendar when the current range is relative.
  window.createRangePicker = function (params, onApply) {
    const current = readCurrent(params);
    let resolvedRange = null;

    const root = mk('div', 'range-picker');

    // ---- Segmented bar ----
    const bar = mk('div', 'rp-bar');
    let isPreset = false;
    for (const [p, u] of PRESETS) {
      const b = mk('button', 'rp-preset', `${p}${UNIT_SHORT[u]}`);
      const on = current.mode === 'relative' && current.period === p && current.unit === u;
      isPreset ||= on;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      b.addEventListener('click', () => onApply({ timeRange: 'relative', period: String(p), unit: u }));
      bar.append(b);
    }
    const custom = mk('button', 'rp-custom');
    custom.setAttribute('aria-haspopup', 'dialog');
    custom.setAttribute('aria-expanded', 'false');
    custom.classList.toggle('active', !isPreset);
    custom.append(mk('span', null,
      current.mode === 'absolute' ? `${fmt(current.start)} → ${fmt(current.end)}`
        : isPreset ? 'Custom' : `Custom (${current.period}${UNIT_SHORT[current.unit]})`));
    custom.insertAdjacentHTML('beforeend', CAL_ICON);
    bar.append(custom);

    // ---- Custom panel ----
    const panel = mk('div', 'rp-panel');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Custom time range');
    const state = { mode: 'relative', period: 1, unit: 'week', start: null, end: null, view: null };

    // Mode: radios styled as tabs
    const modes = mk('div', 'rp-modes');
    modes.setAttribute('role', 'radiogroup');
    const radios = {};
    for (const m of ['absolute', 'relative']) {
      const label = mk('label', 'rp-mode');
      const input = mk('input');
      input.type = 'radio';
      input.name = 'rp-mode';
      input.value = m;
      input.addEventListener('change', () => { state.mode = m; render(); });
      label.append(input, m[0].toUpperCase() + m.slice(1));
      radios[m] = input;
      modes.append(label);
    }

    // Relative: preset grid + free entry
    const relBody = mk('div', 'rp-body rp-rel');
    const chips = [];
    for (const [unit, values] of Object.entries(GRID)) {
      const row = mk('div', 'rp-row');
      const list = mk('div', 'rp-chips');
      for (const v of values) {
        const c = mk('button', 'rp-chip', String(v));
        c.addEventListener('click', () => { state.period = v; state.unit = unit; render(); });
        chips.push({ c, v, unit });
        list.append(c);
      }
      row.append(mk('span', 'rp-row-label', UNIT_LABEL[unit]), list);
      relBody.append(row);
    }
    const freeRow = mk('div', 'rp-free');
    const num = mk('input', 'rp-input');
    num.type = 'number';
    num.min = '1';
    num.step = '1';
    num.setAttribute('aria-label', 'Amount');
    num.addEventListener('input', () => { state.period = Number(num.value); render(); });
    const sel = mk('select', 'rp-input');
    sel.setAttribute('aria-label', 'Unit');
    for (const [u, label] of Object.entries(UNIT_LABEL)) {
      const o = mk('option', null, label);
      o.value = u;
      sel.append(o);
    }
    sel.addEventListener('change', () => { state.unit = sel.value; render(); });
    freeRow.append(num, sel);
    relBody.append(freeRow);

    // Absolute: two months + date/time fields
    const absBody = mk('div', 'rp-body rp-abs');
    const months = mk('div', 'rp-months');
    const field = (text) => {
      const wrap = mk('div', 'rp-field');
      const date = mk('input', 'rp-input');
      date.type = 'date';
      const time = mk('input', 'rp-input');
      time.type = 'time';
      time.step = '1';
      const inputs = mk('div', 'rp-field-inputs');
      inputs.append(date, time);
      wrap.append(mk('span', 'rp-field-label', text), inputs);
      for (const i of [date, time]) i.addEventListener('change', onFieldChange);
      return { wrap, date, time };
    };
    const fStart = field('Start date and time');
    const fEnd = field('End date and time');
    const fields = mk('div', 'rp-fields');
    fields.append(fStart.wrap, fEnd.wrap);
    absBody.append(months, fields);

    const fromField = (f) => (f.date.value ? new Date(`${f.date.value}T${f.time.value || '00:00:00'}`) : null);
    function onFieldChange() {
      state.start = fromField(fStart);
      state.end = fromField(fEnd);
      render({ fields: false }); // don't overwrite what's being typed
    }

    // First click sets the start; the next sets the end (or moves the start, if earlier). Clicks select
    // whole days; the time fields refine them.
    function pickDay(day) {
      if (!state.start || state.end) {
        state.start = withTime(day, '00:00:00');
        state.end = null;
      } else if (day < dayStart(state.start)) {
        state.start = withTime(day, '00:00:00');
      } else {
        state.end = withTime(day, '23:59:59');
      }
      render();
    }

    function monthGrid(first, nav) {
      const today = dayStart(new Date());
      const block = mk('div', 'rp-month');
      const head = mk('div', 'rp-month-head');
      const navBtn = (step, label, text) => {
        const b = mk('button', 'rp-nav', text);
        b.setAttribute('aria-label', label);
        b.disabled = step > 0 && addMonths(first, 1) > today; // nothing to see in the future
        b.addEventListener('click', () => { state.view = addMonths(state.view, step); render({ fields: false }); });
        return b;
      };
      head.append(
        nav === 'prev' ? navBtn(-1, 'Previous month', '‹') : mk('span', 'rp-nav-spacer'),
        mk('span', 'rp-month-title', first.toLocaleString(undefined, { month: 'long', year: 'numeric' })),
        nav === 'next' ? navBtn(1, 'Next month', '›') : mk('span', 'rp-nav-spacer'));

      const grid = mk('div', 'rp-days');
      for (const w of WEEKDAYS) grid.append(mk('span', 'rp-dow', w));
      for (let i = 0; i < first.getDay(); i++) grid.append(mk('span'));
      const s = state.start && dayStart(state.start);
      const e = state.end && dayStart(state.end);
      const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      for (let d = 1; d <= daysIn; d++) {
        const day = new Date(first.getFullYear(), first.getMonth(), d);
        const b = mk('button', 'rp-day', String(d));
        b.disabled = day > today;
        b.classList.toggle('today', +day === +today);
        b.classList.toggle('selected', +day === +s || +day === +e);
        b.classList.toggle('in-range', !!(s && e && day > s && day < e));
        b.setAttribute('aria-label', day.toDateString());
        b.addEventListener('click', () => pickDay(day));
        grid.append(b);
      }
      block.append(head, grid);
      return block;
    }

    // Footer
    const footer = mk('div', 'rp-footer');
    const hint = mk('span', 'rp-hint');
    const cancel = mk('button', 'rp-btn', 'Cancel');
    const apply = mk('button', 'rp-btn primary', 'Apply');
    cancel.addEventListener('click', close);
    apply.addEventListener('click', () => {
      if (problem()) return;
      if (state.mode === 'relative') onApply({ timeRange: 'relative', period: String(state.period), unit: state.unit });
      else onApply({ timeRange: 'absolute', startDate: state.start.toISOString(), endDate: state.end.toISOString() });
    });
    footer.append(hint, cancel, apply);

    panel.append(modes, relBody, absBody, footer);

    function problem() {
      if (state.mode === 'relative') return Number.isInteger(state.period) && state.period >= 1 ? '' : 'Enter a whole number, 1 or more';
      if (!state.start || isNaN(state.start)) return 'Pick a start day';
      if (!state.end || isNaN(state.end)) return 'Pick an end day';
      if (state.start > state.end) return 'Start is after end';
      return '';
    }

    function render({ fields = true } = {}) {
      radios[state.mode].checked = true;
      relBody.hidden = state.mode !== 'relative';
      absBody.hidden = state.mode !== 'absolute';
      for (const { c, v, unit } of chips) c.classList.toggle('active', state.unit === unit && state.period === v);
      if (document.activeElement !== num) num.value = state.period || '';
      sel.value = state.unit;
      months.replaceChildren(monthGrid(state.view, 'prev'), monthGrid(addMonths(state.view, 1), 'next'));
      if (fields) {
        for (const [f, d] of [[fStart, state.start], [fEnd, state.end]]) {
          f.date.value = d ? dateValue(d) : '';
          f.time.value = d ? timeValue(d) : '';
        }
      }
      hint.textContent = problem();
      apply.disabled = !!hint.textContent;
    }

    // Each open starts from the applied range, so Cancel discards edits. A relative range pre-fills the
    // absolute tab with the span it resolved to.
    function open() {
      state.mode = current.mode;
      if (current.mode === 'relative') Object.assign(state, { period: current.period, unit: current.unit });
      const span = current.mode === 'absolute' ? current
        : resolvedRange ? { start: new Date(resolvedRange.from), end: new Date(resolvedRange.to) }
          : { start: new Date(Date.now() - 7 * 864e5), end: new Date() };
      Object.assign(state, { start: span.start, end: span.end });
      state.view = addMonths(state.end, -1); // end month on the right
      render();
      panel.hidden = false;
      custom.setAttribute('aria-expanded', 'true');
      radios[state.mode].focus();
    }

    function close() {
      panel.hidden = true;
      custom.setAttribute('aria-expanded', 'false');
    }

    custom.addEventListener('click', () => (panel.hidden ? open() : close()));
    document.addEventListener('mousedown', (e) => { if (!panel.hidden && !root.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) { close(); custom.focus(); }
    });

    root.append(bar, panel);
    return {
      el: root,
      setResolved(range) {
        resolvedRange = range;
      },
    };
  };
})();
