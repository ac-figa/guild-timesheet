/* Guild Timesheet — frontend app
 * Vanilla JS, no build step. Talks to the Apps Script backend configured
 * in js/config.js.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  var state = {
    token: null,
    crew: [],
    crewById: {},
    projects: [],
    projectsById: {},
    retrofitProjectId: null,
    hoursPerLight: 4,
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    payTypes: ['Regular', 'OT15', 'OT2'],
    payTypeLabels: { Regular: 'Regular', OT15: 'O/T (1.5x)', OT2: 'O/T (2x)' },
    weekEnding: null, // 'YYYY-MM-DD', a Saturday
    weekData: { entries: [], retrofitDays: {}, assignments: [] },
    currentCrewId: null
  };

  // ---------------------------------------------------------------
  // Date helpers (local time, no UTC surprises)
  // ---------------------------------------------------------------
  function parseISODate(s) {
    var parts = s.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  function toISODate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function addDays(d, n) {
    var copy = new Date(d.getTime());
    copy.setDate(copy.getDate() + n);
    return copy;
  }
  function snapToSaturday(d) {
    var diff = (6 - d.getDay() + 7) % 7;
    return addDays(d, diff);
  }
  function formatDisplay(d, withYear) {
    var opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (withYear) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }
  function getWeekDates(weekEndingStr) {
    var sat = parseISODate(weekEndingStr);
    var out = [];
    for (var i = 5; i >= 0; i--) out.push(addDays(sat, -i));
    return out; // [Mon..Sat]
  }

  // ---------------------------------------------------------------
  // API
  // ---------------------------------------------------------------
  function api(action, payload) {
    var body = Object.assign({ action: action, token: state.token }, payload || {});
    return fetch(window.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!json.ok) throw new Error(json.error || 'Something went wrong.');
        return json;
      });
  }

  // ---------------------------------------------------------------
  // Save status toast
  // ---------------------------------------------------------------
  var saveStatusEl = document.getElementById('save-status');
  var saveStatusTimer = null;
  function showStatus(text, kind) {
    saveStatusEl.textContent = text;
    saveStatusEl.className = 'save-status' + (kind ? ' ' + kind : '');
    saveStatusEl.hidden = false;
    clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(function () { saveStatusEl.hidden = true; }, 2200);
  }

  // ---------------------------------------------------------------
  // Debounce helper (independent timers keyed by string)
  // ---------------------------------------------------------------
  function makeDebouncer(ms) {
    var timers = {};
    return function (key, fn) {
      clearTimeout(timers[key]);
      timers[key] = setTimeout(fn, ms);
    };
  }
  var debounce = makeDebouncer(500);

  // ---------------------------------------------------------------
  // Auth / bootstrap
  // ---------------------------------------------------------------
  var loginScreen = document.getElementById('login-screen');
  var appScreen = document.getElementById('app');
  var loginForm = document.getElementById('login-form');
  var loginError = document.getElementById('login-error');

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    loginError.hidden = true;
    var password = document.getElementById('login-password').value;
    api('login', { password: password }).then(function (res) {
      state.token = res.token;
      localStorage.setItem('gts_token', res.token);
      boot();
    }).catch(function (err) {
      loginError.textContent = err.message;
      loginError.hidden = false;
    });
  });

  document.getElementById('logout-btn').addEventListener('click', function () {
    localStorage.removeItem('gts_token');
    location.reload();
  });

  function boot() {
    api('bootstrap', {}).then(function (res) {
      state.crew = res.crew;
      state.crew.forEach(function (c) { state.crewById[c.id] = c; });
      state.projects = res.projects;
      state.projects.forEach(function (p) { state.projectsById[p.id] = p; });
      state.retrofitProjectId = (state.projects.filter(function (p) { return p.isRetrofit; })[0] || {}).id || null;
      state.hoursPerLight = res.hoursPerLight;
      state.days = res.days;
      state.payTypes = res.payTypes;
      state.payTypeLabels = res.payTypeLabels;

      loginScreen.hidden = true;
      appScreen.hidden = false;

      var today = new Date();
      today.setHours(0, 0, 0, 0);
      setWeekEnding(toISODate(snapToSaturday(today)));

      document.getElementById('retrofit-project-label').textContent =
        (state.projectsById[state.retrofitProjectId] || {}).label
          ? 'Retrofit project: ' + state.projectsById[state.retrofitProjectId].label
          : 'Retrofit project';
    }).catch(function (err) {
      // token invalid/expired -> back to login
      localStorage.removeItem('gts_token');
      loginScreen.hidden = false;
      appScreen.hidden = true;
      if (err && err.message) loginError.textContent = err.message, loginError.hidden = false;
    });
  }

  var savedToken = localStorage.getItem('gts_token');
  if (savedToken) {
    state.token = savedToken;
    boot();
  }

  // ---------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // ---------------------------------------------------------------
  // Week picker
  // ---------------------------------------------------------------
  var weekInput = document.getElementById('week-ending');
  var weekRangeEl = document.getElementById('week-range');

  function setWeekEnding(iso) {
    state.weekEnding = iso;
    weekInput.value = iso;
    renderWeekRange();
    loadWeek();
  }
  function renderWeekRange() {
    var dates = getWeekDates(state.weekEnding);
    weekRangeEl.textContent = formatDisplay(dates[0]) + ' – ' + formatDisplay(dates[5], true);
  }

  weekInput.addEventListener('change', function () {
    if (!weekInput.value) return;
    var snapped = toISODate(snapToSaturday(parseISODate(weekInput.value)));
    setWeekEnding(snapped);
  });
  document.getElementById('week-prev').addEventListener('click', function () {
    setWeekEnding(toISODate(addDays(parseISODate(state.weekEnding), -7)));
  });
  document.getElementById('week-next').addEventListener('click', function () {
    setWeekEnding(toISODate(addDays(parseISODate(state.weekEnding), 7)));
  });
  document.getElementById('week-today').addEventListener('click', function () {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    setWeekEnding(toISODate(snapToSaturday(today)));
  });

  // ---------------------------------------------------------------
  // Load a week's data
  // ---------------------------------------------------------------
  function loadWeek() {
    api('getWeek', { weekEnding: state.weekEnding }).then(function (res) {
      state.weekData.entries = res.entries;
      state.weekData.retrofitDays = res.retrofitDays;
      state.weekData.assignments = res.assignments;
      renderSnapshot();
      if (state.currentCrewId) renderCrewWeekPanel();
      renderRetrofitTab();
      // Report tab needs an explicit "Generate" click so it always reflects
      // a deliberate, fresh computation.
      document.getElementById('report-output').innerHTML = '';
      document.getElementById('report-warnings').hidden = true;
      document.getElementById('copy-report-btn').hidden = true;
      document.getElementById('print-report-btn').hidden = true;
    }).catch(function (err) { showStatus(err.message, 'error'); });
  }

  // ---------------------------------------------------------------
  // Generic autocomplete
  // ---------------------------------------------------------------
  function setupAutocomplete(opts) {
    // opts: inputEl, suggestionsEl, getQuery results via state.crew, onSelect(crewObj), allowAddNew(bool)
    var inputEl = opts.inputEl, boxEl = opts.suggestionsEl;
    var highlighted = -1;

    function render(query) {
      var q = query.trim().toLowerCase();
      boxEl.innerHTML = '';
      highlighted = -1;
      if (!q) { boxEl.hidden = true; return; }
      var matches = state.crew.filter(function (c) {
        return c.name.toLowerCase().indexOf(q) !== -1 || (c.position || '').toLowerCase().indexOf(q) !== -1;
      }).slice(0, 8);

      matches.forEach(function (c) {
        var item = document.createElement('div');
        item.className = 'suggestion-item';
        item.innerHTML = '<span>' + escapeHtml(c.name) + '</span><span class="pos">' + escapeHtml(c.position || '') + '</span>';
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          opts.onSelect(c);
          boxEl.hidden = true;
          inputEl.value = opts.clearAfterSelect ? '' : c.name;
        });
        boxEl.appendChild(item);
      });

      if (opts.allowAddNew && q.length > 0) {
        var exact = state.crew.some(function (c) { return c.name.toLowerCase() === q; });
        if (!exact) {
          var addItem = document.createElement('div');
          addItem.className = 'suggestion-item add-new';
          addItem.textContent = '+ Add "' + query.trim() + '" as a new crew member';
          addItem.addEventListener('mousedown', function (e) {
            e.preventDefault();
            var position = prompt('Position code for ' + query.trim() + ' (e.g. J, L, F, La) — optional:', '') || '';
            api('addCrew', { name: query.trim(), position: position.trim() }).then(function (res) {
              state.crew.push(res.crew);
              state.crewById[res.crew.id] = res.crew;
              opts.onSelect(res.crew);
              boxEl.hidden = true;
              inputEl.value = opts.clearAfterSelect ? '' : res.crew.name;
              showStatus('Added ' + res.crew.name + ' to the crew list.', 'success');
            }).catch(function (err) { showStatus(err.message, 'error'); });
          });
          boxEl.appendChild(addItem);
        }
      }

      boxEl.hidden = boxEl.children.length === 0;
    }

    inputEl.addEventListener('input', function () { render(inputEl.value); });
    inputEl.addEventListener('focus', function () { if (inputEl.value) render(inputEl.value); });
    inputEl.addEventListener('blur', function () {
      setTimeout(function () { boxEl.hidden = true; }, 150);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------------------------------------------------------
  // Hours Entry tab
  // ---------------------------------------------------------------
  var crewSearchInput = document.getElementById('crew-search');
  var crewSuggestionsEl = document.getElementById('crew-suggestions');
  var crewWeekPanel = document.getElementById('crew-week-panel');
  var hoursEmptyHint = document.getElementById('hours-empty-hint');

  setupAutocomplete({
    inputEl: crewSearchInput,
    suggestionsEl: crewSuggestionsEl,
    allowAddNew: true,
    clearAfterSelect: true,
    onSelect: function (crew) {
      state.currentCrewId = crew.id;
      renderCrewWeekPanel();
    }
  });

  function nonRetrofitProjects() {
    return state.projects.filter(function (p) { return p.id !== state.retrofitProjectId; });
  }

  function buildProjectSelect(selectEl, selectedId) {
    selectEl.innerHTML = '<option value="">Select project...</option>';
    nonRetrofitProjects().forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.id + ' — ' + p.label;
      if (p.id === selectedId) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }
  function buildPayTypeSelect(selectEl, selected) {
    selectEl.innerHTML = '';
    state.payTypes.forEach(function (pt) {
      var opt = document.createElement('option');
      opt.value = pt;
      opt.textContent = state.payTypeLabels[pt] || pt;
      if (pt === selected) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }

  function entriesFor(crewId, day) {
    return state.weekData.entries.filter(function (e) {
      return e.crewId === crewId && e.day === day;
    });
  }

  function renderCrewWeekPanel() {
    var crew = state.crewById[state.currentCrewId];
    if (!crew) return;
    hoursEmptyHint.hidden = true;
    crewWeekPanel.hidden = false;

    document.getElementById('crew-week-name').textContent = crew.name;
    document.getElementById('crew-week-position').textContent = crew.position || '';

    var container = document.getElementById('crew-days');
    container.innerHTML = '';
    var dates = getWeekDates(state.weekEnding);
    var dayNames = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };

    state.days.forEach(function (day, idx) {
      var block = document.createElement('div');
      block.className = 'day-block';
      block.dataset.day = day;

      var header = document.createElement('div');
      header.className = 'day-block-header';
      header.innerHTML =
        '<span class="day-name">' + dayNames[day] + '</span>' +
        '<span class="day-date">' + formatDisplay(dates[idx]) + '</span>' +
        '<span class="day-total"></span>';
      block.appendChild(header);

      var rowsWrap = document.createElement('div');
      rowsWrap.className = 'day-rows';
      block.appendChild(rowsWrap);

      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'add-row-btn';
      addBtn.textContent = '+ Add another project for this day';
      addBtn.addEventListener('click', function () {
        addEntryRow(rowsWrap, crew.id, day, null);
        updateDayTotal(block);
        updateWeekTotal();
      });
      block.appendChild(addBtn);

      var existing = entriesFor(crew.id, day);
      if (existing.length === 0) {
        addEntryRow(rowsWrap, crew.id, day, null);
      } else {
        existing.forEach(function (entry) { addEntryRow(rowsWrap, crew.id, day, entry); });
      }

      container.appendChild(block);
      updateDayTotal(block);
    });

    updateWeekTotal();
  }

  function updateDayTotal(block) {
    var total = 0;
    block.querySelectorAll('.hours-input').forEach(function (inp) { total += Number(inp.value) || 0; });
    block.querySelector('.day-total').textContent = total > 0 ? total + ' hrs' : '';
  }
  function updateWeekTotal() {
    var total = 0;
    document.querySelectorAll('#crew-days .hours-input').forEach(function (inp) { total += Number(inp.value) || 0; });
    document.getElementById('crew-week-total').textContent = 'Week total: ' + round2(total) + ' hrs';
  }

  function addEntryRow(rowsWrap, crewId, day, entry) {
    var tpl = document.getElementById('tpl-day-row');
    var node = tpl.content.firstElementChild.cloneNode(true);
    var projectSelect = node.querySelector('.project-select');
    var hoursInput = node.querySelector('.hours-input');
    var paytypeSelect = node.querySelector('.paytype-select');
    var removeBtn = node.querySelector('.remove-row-btn');

    buildProjectSelect(projectSelect, entry ? entry.projectId : '');
    buildPayTypeSelect(paytypeSelect, entry ? entry.payType : 'Regular');
    hoursInput.value = entry ? entry.hours : '';
    node.dataset.entryId = entry ? entry.entryId : '';
    var rowUid = 'row-' + Math.random().toString(36).slice(2);

    function currentBlock() { return node.closest('.day-block'); }

    function persist() {
      var hours = Number(hoursInput.value) || 0;
      var projectId = projectSelect.value;
      var payType = paytypeSelect.value;
      var entryId = node.dataset.entryId;

      updateDayTotal(currentBlock());
      updateWeekTotal();

      if (hours <= 0) {
        if (entryId) {
          api('deleteEntry', { entryId: entryId }).then(function () {
            state.weekData.entries = state.weekData.entries.filter(function (e) { return e.entryId !== entryId; });
            node.dataset.entryId = '';
            showStatus('Removed.', 'success');
            renderSnapshot();
          }).catch(function (err) { showStatus(err.message, 'error'); });
        }
        return;
      }
      if (!projectId) return; // wait until a project is chosen

      showStatus('Saving...');
      api('saveEntry', {
        weekEnding: state.weekEnding, day: day, crewId: crewId,
        projectId: projectId, hours: hours, payType: payType, entryId: entryId || undefined
      }).then(function (res) {
        node.dataset.entryId = res.entryId;
        var idx = state.weekData.entries.findIndex(function (e) { return e.entryId === res.entryId; });
        var record = { entryId: res.entryId, weekEnding: state.weekEnding, day: day, crewId: crewId, projectId: projectId, hours: hours, payType: payType };
        if (idx === -1) state.weekData.entries.push(record); else state.weekData.entries[idx] = record;
        showStatus('Saved.', 'success');
        renderSnapshot();
      }).catch(function (err) { showStatus(err.message, 'error'); });
    }

    [hoursInput].forEach(function (el) {
      el.addEventListener('input', function () {
        updateDayTotal(currentBlock());
        updateWeekTotal();
        debounce(rowUid, persist);
      });
    });
    [projectSelect, paytypeSelect].forEach(function (el) {
      el.addEventListener('change', persist);
    });

    removeBtn.addEventListener('click', function () {
      var entryId = node.dataset.entryId;
      var block = currentBlock();
      var doRemove = function () {
        node.remove();
        updateDayTotal(block);
        updateWeekTotal();
        var rowsWrap = block.querySelector('.day-rows');
        if (rowsWrap.children.length === 0) addEntryRow(rowsWrap, crewId, day, null);
      };
      if (entryId) {
        api('deleteEntry', { entryId: entryId }).then(function () {
          state.weekData.entries = state.weekData.entries.filter(function (e) { return e.entryId !== entryId; });
          renderSnapshot();
          doRemove();
        }).catch(function (err) { showStatus(err.message, 'error'); });
      } else {
        doRemove();
      }
    });

    rowsWrap.appendChild(node);
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  // ---------------------------------------------------------------
  // Snapshot sidebar
  // ---------------------------------------------------------------
  function renderSnapshot() {
    var totals = {};
    state.weekData.entries.forEach(function (e) {
      totals[e.crewId] = (totals[e.crewId] || 0) + (Number(e.hours) || 0);
    });
    var list = Object.keys(totals).map(function (crewId) {
      return { crewId: crewId, name: (state.crewById[crewId] || {}).name || '(unknown)', hours: round2(totals[crewId]) };
    }).filter(function (x) { return x.hours > 0; });
    list.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var ul = document.getElementById('snapshot-list');
    var emptyMsg = document.getElementById('snapshot-empty');
    ul.innerHTML = '';
    emptyMsg.hidden = list.length > 0;

    list.forEach(function (item) {
      var li = document.createElement('li');
      li.innerHTML = '<span>' + escapeHtml(item.name) + '</span><span class="snap-hours">' + item.hours + ' hrs</span>';
      li.addEventListener('click', function () {
        state.currentCrewId = item.crewId;
        renderCrewWeekPanel();
        crewWeekPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      ul.appendChild(li);
    });
  }

  // ---------------------------------------------------------------
  // Retrofit tab
  // ---------------------------------------------------------------
  var dayNamesFull = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };

  function assignmentsFor(day) {
    return state.weekData.assignments.filter(function (a) { return a.day === day; });
  }

  function renderRetrofitTab() {
    var container = document.getElementById('retrofit-days');
    container.innerHTML = '';
    var dates = getWeekDates(state.weekEnding);

    state.days.forEach(function (day, idx) {
      var card = document.createElement('div');
      card.className = 'retrofit-day-card';
      card.dataset.day = day;

      var header = document.createElement('div');
      header.className = 'retrofit-day-card-header';
      header.innerHTML =
        '<span class="day-name">' + dayNamesFull[day] + '</span>' +
        '<span class="day-date muted">' + formatDisplay(dates[idx]) + '</span>' +
        '<div class="lights-input-group">' +
        '<label>Traffic lights:</label><input type="number" min="0" step="1" class="lights-input" />' +
        '</div>' +
        '<div class="budget-info"></div>';
      card.appendChild(header);

      var lightsInput = header.querySelector('.lights-input');
      lightsInput.value = state.weekData.retrofitDays[day] || '';

      var rowsWrap = document.createElement('div');
      rowsWrap.className = 'assign-rows';
      card.appendChild(rowsWrap);

      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'add-row-btn';
      addBtn.textContent = '+ Add crew member to this day';
      addBtn.addEventListener('click', function () {
        addAssignRow(rowsWrap, day, null);
        updateBudgetInfo(card);
      });
      card.appendChild(addBtn);

      container.appendChild(card);

      var existing = assignmentsFor(day);
      existing.forEach(function (a) { addAssignRow(rowsWrap, day, a); });

      lightsInput.addEventListener('input', function () {
        updateBudgetInfo(card);
        debounce('lights-' + day, function () { saveRetrofitDayNow(day, lightsInput.value); });
      });

      updateBudgetInfo(card);
    });
  }

  function updateBudgetInfo(card) {
    var day = card.dataset.day;
    var lights = Number(card.querySelector('.lights-input').value) || 0;
    var budget = round2(lights * state.hoursPerLight);
    var assigned = 0;
    card.querySelectorAll('.assign-row .hours-input').forEach(function (inp) { assigned += Number(inp.value) || 0; });
    var info = card.querySelector('.budget-info');
    var text = '<strong>' + budget + ' hrs</strong> available (' + lights + ' × ' + state.hoursPerLight + 'h) — ' + round2(assigned) + ' hrs assigned';
    if (assigned > budget + 0.001) {
      text += ' <span class="budget-warn">— over budget</span>';
    }
    info.innerHTML = text;
  }

  function saveRetrofitDayNow(day, lightsVal) {
    var lights = Number(lightsVal) || 0;
    api('saveRetrofitDay', { weekEnding: state.weekEnding, day: day, trafficLights: lights }).then(function () {
      state.weekData.retrofitDays[day] = lights;
      showStatus('Saved.', 'success');
    }).catch(function (err) { showStatus(err.message, 'error'); });
  }

  function addAssignRow(rowsWrap, day, assignment) {
    var tpl = document.getElementById('tpl-assign-row');
    var node = tpl.content.firstElementChild.cloneNode(true);
    var searchInput = node.querySelector('.assign-crew-search');
    var suggestionsEl = node.querySelector('.assign-suggestions');
    var hoursInput = node.querySelector('.hours-input');
    var paytypeSelect = node.querySelector('.paytype-select');
    var removeBtn = node.querySelector('.remove-row-btn');

    buildPayTypeSelect(paytypeSelect, assignment ? assignment.payType : 'Regular');
    hoursInput.value = assignment ? assignment.hours : '';
    node.dataset.crewId = assignment ? assignment.crewId : '';
    if (assignment) {
      var c = state.crewById[assignment.crewId];
      searchInput.value = c ? c.name : assignment.crewId;
    }

    setupAutocomplete({
      inputEl: searchInput,
      suggestionsEl: suggestionsEl,
      allowAddNew: true,
      clearAfterSelect: false,
      onSelect: function (crew) {
        node.dataset.crewId = crew.id;
        saveDay();
      }
    });

    function saveDay() {
      updateBudgetInfo(node.closest('.retrofit-day-card'));
      debounce('assign-' + day, function () { persistDayAssignments(day, rowsWrap); });
    }

    hoursInput.addEventListener('input', saveDay);
    paytypeSelect.addEventListener('change', saveDay);
    removeBtn.addEventListener('click', function () {
      node.remove();
      var card = rowsWrap.closest('.retrofit-day-card');
      updateBudgetInfo(card);
      persistDayAssignments(day, rowsWrap);
    });

    rowsWrap.appendChild(node);
  }

  function persistDayAssignments(day, rowsWrap) {
    var assignments = [];
    rowsWrap.querySelectorAll('.assign-row').forEach(function (row) {
      var crewId = row.dataset.crewId;
      var hours = Number(row.querySelector('.hours-input').value) || 0;
      var payType = row.querySelector('.paytype-select').value;
      if (crewId && hours > 0) assignments.push({ crewId: crewId, hours: hours, payType: payType });
    });
    showStatus('Saving...');
    api('saveRetrofitAssignments', { weekEnding: state.weekEnding, day: day, assignments: assignments }).then(function () {
      state.weekData.assignments = state.weekData.assignments.filter(function (a) { return a.day !== day; })
        .concat(assignments.map(function (a) { return Object.assign({ day: day, assignmentId: null }, a); }));
      showStatus('Saved.', 'success');
    }).catch(function (err) { showStatus(err.message, 'error'); });
  }

  // ---------------------------------------------------------------
  // Report tab
  // ---------------------------------------------------------------
  var lastReport = null;

  document.getElementById('generate-report-btn').addEventListener('click', function () {
    showStatus('Generating report...');
    api('getReport', { weekEnding: state.weekEnding }).then(function (res) {
      lastReport = res;
      renderReport(res);
      showStatus('Report ready.', 'success');
    }).catch(function (err) { showStatus(err.message, 'error'); });
  });

  document.getElementById('print-report-btn').addEventListener('click', function () { window.print(); });

  document.getElementById('copy-report-btn').addEventListener('click', function () {
    if (!lastReport) return;
    var text = reportToPlainText(lastReport);
    navigator.clipboard.writeText(text).then(function () {
      showStatus('Report copied to clipboard.', 'success');
    }).catch(function () { showStatus('Could not copy — select and copy manually.', 'error'); });
  });

  function reportToPlainText(res) {
    var lines = [];
    lines.push('Timesheet — week ending ' + formatDisplay(parseISODate(state.weekEnding), true));
    lines.push('');
    res.report.forEach(function (proj) {
      lines.push('Project ' + proj.projectId + ' — ' + proj.label);
      proj.lines.forEach(function (line) {
        var parts = line.parts.map(function (p) { return p.hours + ' Hours ' + p.label; }).join(' ');
        lines.push(line.name + ' ' + parts);
      });
      lines.push('');
    });
    if (res.warnings && res.warnings.length) {
      lines.push('Warnings:');
      res.warnings.forEach(function (w) {
        lines.push('- ' + w.name + ': only moved ' + w.moved + ' of ' + w.requested + ' hours requested for Retrofit (short ' + w.shortfall + ' hrs).');
      });
    }
    return lines.join('\n');
  }

  function renderReport(res) {
    var out = document.getElementById('report-output');
    var warnBox = document.getElementById('report-warnings');
    out.innerHTML = '';

    if (res.warnings && res.warnings.length) {
      warnBox.hidden = false;
      warnBox.innerHTML = '<h4>Heads up</h4>' + res.warnings.map(function (w) {
        return '<div>' + escapeHtml(w.name) + ' — could only move ' + w.moved + ' of ' + w.requested +
          ' hours requested for the Retrofit project (short ' + w.shortfall + ' hrs). They may not have enough recorded on other projects this week.</div>';
      }).join('');
    } else {
      warnBox.hidden = true;
    }

    if (!res.report.length) {
      out.innerHTML += '<p class="report-empty">No hours recorded for this week yet.</p>';
      document.getElementById('copy-report-btn').hidden = true;
      document.getElementById('print-report-btn').hidden = true;
      return;
    }

    res.report.forEach(function (proj) {
      var section = document.createElement('div');
      section.className = 'report-project';
      var h3 = document.createElement('h3');
      h3.textContent = 'Project ' + proj.projectId + ' — ' + proj.label;
      section.appendChild(h3);
      proj.lines.forEach(function (line) {
        var p = document.createElement('div');
        p.className = 'report-line';
        var parts = line.parts.map(function (x) { return x.hours + ' Hours ' + x.label; }).join(', ');
        p.textContent = line.name + ' — ' + parts;
        section.appendChild(p);
      });
      out.appendChild(section);
    });

    document.getElementById('copy-report-btn').hidden = false;
    document.getElementById('print-report-btn').hidden = false;
  }
})();
