/**
 * Code.gs — Guild Timesheet backend
 * ==================================
 * This Apps Script is bound to the Google Sheet that acts as the database
 * for the timesheet website. It is deployed as a Web App and the frontend
 * (hosted on GitHub Pages) talks to it over HTTPS with plain POST requests.
 *
 * SETUP (see README.md in the repo for the full walkthrough):
 *   1. Create a new Google Sheet.
 *   2. Extensions > Apps Script. Delete the default code.
 *   3. Create this file (Code.gs) and SeedData.gs, paste in their contents.
 *   4. Run `setupSheet` once from the Apps Script editor (pick it from the
 *      function dropdown and click Run). Approve the permissions prompt.
 *      This builds all the tabs and loads your crew + project list.
 *   5. Run `setPassword` once (edit the password inside it first) to set
 *      the login password for the site.
 *   6. Deploy > New deployment > type "Web app". Execute as "Me", access
 *      "Anyone". Copy the resulting URL into js/config.js in the frontend.
 */

// ---------------------------------------------------------------------
// Sheet tab names & column schemas
// ---------------------------------------------------------------------
var SHEET_CREW = 'Crew';
var SHEET_PROJECTS = 'Projects';
var SHEET_ENTRIES = 'Entries';
var SHEET_RETROFIT_DAYS = 'RetrofitDays';
var SHEET_RETROFIT_ASSIGN = 'RetrofitAssignments';

var COLS = {};
COLS[SHEET_CREW] = ['ID', 'Name', 'Position', 'Active'];
COLS[SHEET_PROJECTS] = ['ID', 'Label', 'IsRetrofit', 'Active'];
COLS[SHEET_ENTRIES] = ['EntryID', 'WeekEnding', 'Day', 'CrewID', 'ProjectID', 'Hours', 'PayType', 'CreatedAt', 'UpdatedAt'];
COLS[SHEET_RETROFIT_DAYS] = ['WeekEnding', 'Day', 'TrafficLights', 'UpdatedAt'];
COLS[SHEET_RETROFIT_ASSIGN] = ['AssignmentID', 'WeekEnding', 'Day', 'CrewID', 'Hours', 'PayType', 'UpdatedAt'];

var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var PAY_TYPES = ['Regular', 'OT15', 'OT2'];
var PAY_TYPE_LABELS = { Regular: 'Regular', OT15: 'O/T (1.5x)', OT2: 'O/T (2x)' };

var DEFAULT_HOURS_PER_LIGHT = 4;
var SESSION_SECONDS = 6 * 60 * 60; // 6 hours (CacheService max)

// ---------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(COLS).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    var headers = COLS[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  });

  // Remove the default "Sheet1" if it's still sitting there empty.
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() <= 1 && ss.getSheets().length > 1) {
    ss.deleteSheet(def);
  }

  // Seed Crew tab if empty.
  var crewSheet = ss.getSheetByName(SHEET_CREW);
  if (crewSheet.getLastRow() <= 1) {
    var crewRows = SEED_CREW.map(function (c) { return [c.id, c.name, c.position, true]; });
    if (crewRows.length) {
      crewSheet.getRange(2, 1, crewRows.length, 4).setValues(crewRows);
    }
  }

  // Seed Projects tab if empty.
  var projSheet = ss.getSheetByName(SHEET_PROJECTS);
  if (projSheet.getLastRow() <= 1) {
    var projRows = SEED_PROJECTS.map(function (p) { return [p.id, p.label, !!p.isRetrofit, true]; });
    if (projRows.length) {
      projSheet.getRange(2, 1, projRows.length, 4).setValues(projRows);
    }
  }

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_PASSWORD')) {
    props.setProperty('APP_PASSWORD', 'changeme');
  }
  if (!props.getProperty('HOURS_PER_LIGHT')) {
    props.setProperty('HOURS_PER_LIGHT', String(DEFAULT_HOURS_PER_LIGHT));
  }

  Logger.log('Setup complete. Crew rows: %s, Project rows: %s', crewSheet.getLastRow() - 1, projSheet.getLastRow() - 1);
  Logger.log('Default password is "changeme" unless already set — run setPassword() to change it.');
}

/** Edit the string below, then run this once from the editor. */
function setPassword() {
  var newPassword = 'giuseppe123';
  PropertiesService.getScriptProperties().setProperty('APP_PASSWORD', newPassword);
  Logger.log('Password updated.');
}

/** Optional: change how many labor-hours one traffic light is worth. */
function setHoursPerLight() {
  var hours = 4;
  PropertiesService.getScriptProperties().setProperty('HOURS_PER_LIGHT', String(hours));
  Logger.log('Hours per traffic light set to ' + hours);
}

// ---------------------------------------------------------------------
// Generic sheet table helpers
// ---------------------------------------------------------------------
function getSS_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var sheet = getSS_().getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet tab: ' + name + '. Run setupSheet() first.');
  return sheet;
}

// Sheets auto-detects a "YYYY-MM-DD"-looking string written into a cell and
// silently stores it as a real Date instead of text, even though every write
// in this file sends a plain string. Left alone, every WeekEnding-based
// lookup below (===  against a string) would just never match a row that
// came back as a Date, which is why this normalizes it back to the same
// "YYYY-MM-DD" string on read, regardless of which form the cell holds.
function normalizeDateCell_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var y = v.getFullYear();
    var m = ('0' + (v.getMonth() + 1)).slice(-2);
    var d = ('0' + v.getDate()).slice(-2);
    return y + '-' + m + '-' + d;
  }
  return v;
}

function readTable_(name) {
  var sheet = getSheet_(name);
  var lastRow = sheet.getLastRow();
  var lastCol = COLS[name].length;
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var headers = COLS[name];
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var obj = { _row: r + 2 };
    for (var c = 0; c < headers.length; c++) {
      var val = row[c];
      if (headers[c] === 'WeekEnding') val = normalizeDateCell_(val);
      obj[headers[c]] = val;
    }
    out.push(obj);
  }
  return out;
}

function appendRow_(name, obj) {
  var sheet = getSheet_(name);
  var headers = COLS[name];
  var row = headers.map(function (h) { return (obj[h] === undefined || obj[h] === null) ? '' : obj[h]; });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function findRowById_(name, idCol, idVal) {
  var sheet = getSheet_(name);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var colIndex = COLS[name].indexOf(idCol) + 1;
  var ids = sheet.getRange(2, colIndex, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(idVal)) return i + 2;
  }
  return -1;
}

function updateRow_(name, rowIndex, patch) {
  var sheet = getSheet_(name);
  var headers = COLS[name];
  var current = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  headers.forEach(function (h, i) {
    if (patch.hasOwnProperty(h)) current[i] = patch[h];
  });
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([current]);
}

function deleteRow_(name, rowIndex) {
  getSheet_(name).deleteRow(rowIndex);
}

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
function login_(password) {
  var stored = PropertiesService.getScriptProperties().getProperty('APP_PASSWORD') || 'changeme';
  if (String(password) !== String(stored)) {
    return { ok: false, error: 'Wrong password.' };
  }
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('session_' + token, 'ok', SESSION_SECONDS);
  return { ok: true, token: token };
}

function requireAuth_(token) {
  if (!token) throw new Error('Not logged in.');
  var cached = CacheService.getScriptCache().get('session_' + token);
  if (cached !== 'ok') throw new Error('Session expired. Please log in again.');
}

// ---------------------------------------------------------------------
// Domain reads
// ---------------------------------------------------------------------
function getCrew_() {
  return readTable_(SHEET_CREW)
    .filter(function (r) { return r.Active !== false; })
    .map(function (r) { return { id: String(r.ID), name: r.Name, position: r.Position }; });
}

function getProjects_() {
  return readTable_(SHEET_PROJECTS)
    .filter(function (r) { return r.Active !== false; })
    .map(function (r) { return { id: String(r.ID), label: r.Label, isRetrofit: !!r.IsRetrofit }; });
}

function getRetrofitProjectId_() {
  var projects = getProjects_();
  var rp = projects.filter(function (p) { return p.isRetrofit; })[0];
  return rp ? rp.id : null;
}

function getHoursPerLight_() {
  var v = PropertiesService.getScriptProperties().getProperty('HOURS_PER_LIGHT');
  return v ? Number(v) : DEFAULT_HOURS_PER_LIGHT;
}

function getEntriesForWeek_(weekEnding) {
  return readTable_(SHEET_ENTRIES).filter(function (r) { return r.WeekEnding === weekEnding; });
}

function getRetrofitDaysForWeek_(weekEnding) {
  return readTable_(SHEET_RETROFIT_DAYS).filter(function (r) { return r.WeekEnding === weekEnding; });
}

function getAssignmentsForWeek_(weekEnding) {
  return readTable_(SHEET_RETROFIT_ASSIGN).filter(function (r) { return r.WeekEnding === weekEnding; });
}

// ---------------------------------------------------------------------
// Seeded "random" shuffle — deterministic per (weekEnding, crewId) so the
// same inputs always produce the same reallocation, but which of a
// person's other-project entries loses hours isn't hand-picked.
// ---------------------------------------------------------------------
function seededRandom_(seedStr) {
  var seed = 0;
  for (var i = 0; i < seedStr.length; i++) {
    seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  return function () {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function shuffleWithSeed_(arr, seedStr) {
  var rnd = seededRandom_(seedStr);
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rnd() * (i + 1));
    var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// ---------------------------------------------------------------------
// Core: compute the "effective" (post-reallocation) hours for a week.
//
// Manual entries (typed into the day grid) are the ground truth of what
// actually happened on site. Retrofit assignments are an instruction:
// "move N hours for this crew member out of their other-project hours
// this week, and count them under Retrofit instead." This function
// applies that instruction without ever mutating the underlying manual
// entries, so it can be safely recomputed any time either changes.
// ---------------------------------------------------------------------
function computeEffectiveForWeek_(weekEnding) {
  var retrofitId = getRetrofitProjectId_();
  var manualEntries = getEntriesForWeek_(weekEnding);
  var assignments = getAssignmentsForWeek_(weekEnding);

  // Group assignments by crew.
  var byCrew = {};
  assignments.forEach(function (a) {
    var crewId = String(a.CrewID);
    if (!byCrew[crewId]) byCrew[crewId] = [];
    byCrew[crewId].push({
      day: a.Day,
      hours: Number(a.Hours) || 0,
      payType: a.PayType || 'Regular'
    });
  });

  // Working copy of manual entries' remaining hours, keyed by row identity.
  var working = manualEntries.map(function (e) {
    return {
      entryId: e.EntryID,
      day: e.Day,
      crewId: String(e.CrewID),
      projectId: String(e.ProjectID),
      payType: e.PayType || 'Regular',
      original: Number(e.Hours) || 0,
      remaining: Number(e.Hours) || 0
    };
  });

  var warnings = [];
  var effectiveRetrofitLines = []; // {crewId, day, hours, payType}

  Object.keys(byCrew).forEach(function (crewId) {
    var wanted = byCrew[crewId];
    var totalWanted = wanted.reduce(function (s, w) { return s + w.hours; }, 0);
    if (totalWanted <= 0) return;

    var sources = working.filter(function (w) {
      return w.crewId === crewId && w.projectId !== retrofitId && w.remaining > 0;
    });
    sources = shuffleWithSeed_(sources, weekEnding + '|' + crewId);

    var remainingNeeded = totalWanted;
    for (var i = 0; i < sources.length && remainingNeeded > 0.0001; i++) {
      var src = sources[i];
      var take = Math.min(src.remaining, remainingNeeded);
      src.remaining -= take;
      remainingNeeded -= take;
    }

    var actuallyMoved = totalWanted - remainingNeeded;
    if (remainingNeeded > 0.0001) {
      warnings.push({
        crewId: crewId,
        requested: round2_(totalWanted),
        moved: round2_(actuallyMoved),
        shortfall: round2_(remainingNeeded)
      });
    }

    var factor = totalWanted > 0 ? (actuallyMoved / totalWanted) : 0;
    wanted.forEach(function (w) {
      var scaled = round2_(w.hours * factor);
      if (scaled > 0) {
        effectiveRetrofitLines.push({ crewId: crewId, day: w.day, hours: scaled, payType: w.payType });
      }
    });
  });

  // Build final per-project / per-crew / per-payType totals.
  var totals = {}; // projectId -> crewId -> payType -> hours

  function add(projectId, crewId, payType, hours) {
    if (!hours) return;
    if (!totals[projectId]) totals[projectId] = {};
    if (!totals[projectId][crewId]) totals[projectId][crewId] = { Regular: 0, OT15: 0, OT2: 0 };
    totals[projectId][crewId][payType] += hours;
  }

  working.forEach(function (w) {
    if (w.remaining > 0) add(w.projectId, w.crewId, w.payType, round2_(w.remaining));
  });
  effectiveRetrofitLines.forEach(function (l) {
    add(retrofitId, l.crewId, l.payType, l.hours);
  });

  return { totals: totals, warnings: warnings, retrofitId: retrofitId };
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------
// API actions
// ---------------------------------------------------------------------
function action_ping_() {
  return { ok: true, message: 'pong' };
}

function action_login_(p) {
  return login_(p.password);
}

function action_bootstrap_(p) {
  requireAuth_(p.token);
  return {
    ok: true,
    crew: getCrew_(),
    projects: getProjects_(),
    hoursPerLight: getHoursPerLight_(),
    days: DAYS,
    payTypes: PAY_TYPES,
    payTypeLabels: PAY_TYPE_LABELS
  };
}

function action_addCrew_(p) {
  requireAuth_(p.token);
  var id = 'NEW-' + Utilities.getUuid().slice(0, 8);
  appendRow_(SHEET_CREW, { ID: id, Name: p.name, Position: p.position || '', Active: true });
  return { ok: true, crew: { id: id, name: p.name, position: p.position || '' } };
}

function action_addProject_(p) {
  requireAuth_(p.token);
  var id = p.id ? String(p.id).trim() : ('NEW-' + Utilities.getUuid().slice(0, 6));
  var existing = findRowById_(SHEET_PROJECTS, 'ID', id);
  if (existing !== -1) throw new Error('A project with that ID already exists.');
  appendRow_(SHEET_PROJECTS, { ID: id, Label: p.label, IsRetrofit: false, Active: true });
  return { ok: true, project: { id: id, label: p.label, isRetrofit: false } };
}

function action_getWeek_(p) {
  requireAuth_(p.token);
  var weekEnding = p.weekEnding;
  var entries = getEntriesForWeek_(weekEnding).map(function (r) {
    return {
      entryId: r.EntryID, weekEnding: r.WeekEnding, day: r.Day, crewId: String(r.CrewID),
      projectId: String(r.ProjectID), hours: Number(r.Hours) || 0, payType: r.PayType || 'Regular'
    };
  });
  var retrofitDays = {};
  getRetrofitDaysForWeek_(weekEnding).forEach(function (r) {
    retrofitDays[r.Day] = Number(r.TrafficLights) || 0;
  });
  var assignments = getAssignmentsForWeek_(weekEnding).map(function (r) {
    return {
      assignmentId: r.AssignmentID, day: r.Day, crewId: String(r.CrewID),
      hours: Number(r.Hours) || 0, payType: r.PayType || 'Regular'
    };
  });
  return { ok: true, entries: entries, retrofitDays: retrofitDays, assignments: assignments };
}

function action_saveEntry_(p) {
  requireAuth_(p.token);
  var now = new Date().toISOString();
  // Retrofit is a normal selectable project here too — crew who actually did
  // the traffic-light work log their hours directly, same as any project.
  // The Retrofit tab separately hands out whatever budget is left over
  // (traffic lights x hours-per-light, minus hours already logged directly)
  // to other crew, sourced from their other-project hours that week.
  if (p.entryId) {
    var rowIndex = findRowById_(SHEET_ENTRIES, 'EntryID', p.entryId);
    if (rowIndex === -1) throw new Error('Entry not found.');
    updateRow_(SHEET_ENTRIES, rowIndex, {
      Day: p.day, CrewID: p.crewId, ProjectID: p.projectId, Hours: Number(p.hours) || 0,
      PayType: p.payType || 'Regular', UpdatedAt: now
    });
    return { ok: true, entryId: p.entryId };
  } else {
    var entryId = Utilities.getUuid();
    appendRow_(SHEET_ENTRIES, {
      EntryID: entryId, WeekEnding: p.weekEnding, Day: p.day, CrewID: p.crewId,
      ProjectID: p.projectId, Hours: Number(p.hours) || 0, PayType: p.payType || 'Regular',
      CreatedAt: now, UpdatedAt: now
    });
    return { ok: true, entryId: entryId };
  }
}

function action_deleteEntry_(p) {
  requireAuth_(p.token);
  var rowIndex = findRowById_(SHEET_ENTRIES, 'EntryID', p.entryId);
  if (rowIndex === -1) throw new Error('Entry not found.');
  deleteRow_(SHEET_ENTRIES, rowIndex);
  return { ok: true };
}

function action_saveRetrofitDay_(p) {
  requireAuth_(p.token);
  var now = new Date().toISOString();
  var rows = readTable_(SHEET_RETROFIT_DAYS);
  var existing = rows.filter(function (r) { return r.WeekEnding === p.weekEnding && r.Day === p.day; })[0];
  if (existing) {
    updateRow_(SHEET_RETROFIT_DAYS, existing._row, { TrafficLights: Number(p.trafficLights) || 0, UpdatedAt: now });
  } else {
    appendRow_(SHEET_RETROFIT_DAYS, { WeekEnding: p.weekEnding, Day: p.day, TrafficLights: Number(p.trafficLights) || 0, UpdatedAt: now });
  }
  return { ok: true };
}

function action_saveRetrofitAssignments_(p) {
  requireAuth_(p.token);
  var now = new Date().toISOString();
  // Replace all assignments for this weekEnding+day in one pass.
  var rows = readTable_(SHEET_RETROFIT_ASSIGN);
  var toDelete = rows.filter(function (r) { return r.WeekEnding === p.weekEnding && r.Day === p.day; });
  // delete bottom-up so row indices stay valid
  toDelete.sort(function (a, b) { return b._row - a._row; }).forEach(function (r) {
    deleteRow_(SHEET_RETROFIT_ASSIGN, r._row);
  });
  (p.assignments || []).forEach(function (a) {
    if (!a.crewId || !(Number(a.hours) > 0)) return;
    appendRow_(SHEET_RETROFIT_ASSIGN, {
      AssignmentID: Utilities.getUuid(), WeekEnding: p.weekEnding, Day: p.day,
      CrewID: a.crewId, Hours: Number(a.hours), PayType: a.payType || 'Regular', UpdatedAt: now
    });
  });
  return { ok: true };
}

function action_getSnapshot_(p) {
  requireAuth_(p.token);
  var entries = getEntriesForWeek_(p.weekEnding);
  var crew = getCrew_();
  var nameById = {};
  crew.forEach(function (c) { nameById[c.id] = c.name; });

  var totals = {}; // crewId -> hours
  entries.forEach(function (e) {
    var crewId = String(e.CrewID);
    totals[crewId] = (totals[crewId] || 0) + (Number(e.Hours) || 0);
  });
  var list = Object.keys(totals).map(function (crewId) {
    return { crewId: crewId, name: nameById[crewId] || '(unknown)', hours: round2_(totals[crewId]) };
  });
  list.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { ok: true, snapshot: list };
}

function action_getReport_(p) {
  requireAuth_(p.token);
  var computed = computeEffectiveForWeek_(p.weekEnding);
  var crew = getCrew_();
  var projects = getProjects_();
  var nameById = {}; crew.forEach(function (c) { nameById[c.id] = c.name; });
  var labelById = {}; projects.forEach(function (pr) { labelById[pr.id] = pr.label; });

  var projectOrder = projects.map(function (pr) { return pr.id; });
  var report = [];
  projectOrder.forEach(function (projectId) {
    var crewTotals = computed.totals[projectId];
    if (!crewTotals) return;
    var lines = Object.keys(crewTotals).map(function (crewId) {
      var t = crewTotals[crewId];
      var parts = [];
      PAY_TYPES.forEach(function (pt) {
        if (t[pt] > 0.0001) parts.push({ payType: pt, label: PAY_TYPE_LABELS[pt], hours: round2_(t[pt]) });
      });
      return { crewId: crewId, name: nameById[crewId] || '(unknown)', parts: parts, total: round2_(parts.reduce(function (s, x) { return s + x.hours; }, 0)) };
    });
    lines.sort(function (a, b) { return a.name.localeCompare(b.name); });
    report.push({ projectId: projectId, label: labelById[projectId] || projectId, lines: lines });
  });

  var warningsWithNames = computed.warnings.map(function (w) {
    return {
      name: nameById[w.crewId] || w.crewId,
      requested: w.requested, moved: w.moved, shortfall: w.shortfall
    };
  });

  return { ok: true, report: report, warnings: warningsWithNames };
}

function action_listWeeks_(p) {
  requireAuth_(p.token);
  var weeks = {};
  readTable_(SHEET_ENTRIES).forEach(function (r) { if (r.WeekEnding) weeks[r.WeekEnding] = true; });
  readTable_(SHEET_RETROFIT_DAYS).forEach(function (r) { if (r.WeekEnding) weeks[r.WeekEnding] = true; });
  var list = Object.keys(weeks).sort().reverse();
  return { ok: true, weeks: list };
}

// ---------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------
function doPost(e) {
  var response;
  try {
    var body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    var action = body.action;
    var handlers = {
      ping: action_ping_,
      login: action_login_,
      bootstrap: action_bootstrap_,
      addCrew: action_addCrew_,
      addProject: action_addProject_,
      getWeek: action_getWeek_,
      saveEntry: action_saveEntry_,
      deleteEntry: action_deleteEntry_,
      saveRetrofitDay: action_saveRetrofitDay_,
      saveRetrofitAssignments: action_saveRetrofitAssignments_,
      getSnapshot: action_getSnapshot_,
      getReport: action_getReport_,
      listWeeks: action_listWeeks_
    };
    var handler = handlers[action];
    if (!handler) throw new Error('Unknown action: ' + action);
    response = handler(body);
  } catch (err) {
    response = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, message: 'Guild Timesheet API is running. Use POST.' }))
    .setMimeType(ContentService.MimeType.JSON);
}
