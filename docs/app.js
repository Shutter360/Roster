// Shutter 360 Roster: app logic. Loaded by index.html after config.js.
(function () {
  'use strict';

  var API = window.ROSTER_API_URL;
  var S = {
    token: localStorage.getItem('roster_token') || '',
    user: null,
    config: { appName: 'Roster', skills: [], blocks: [
      { key: 'morning', label: 'Morning' }, { key: 'evening', label: 'Evening' }] },
    view: '', refreshing: 0, booting: false, mineWeek: 0,
    mine: null, draft: {}, dirty: false,
    overview: null, staff: null,
    jobs: null, jobWeek: 0, openJob: null, jobShowAll: false, confirmRemove: '', confirmAnyway: '', showOthers: false,
    gridWeek: 0, gridSkill: '', freeDate: '', freeBlock: '', freeSkill: '',
    editing: null,
    schedStaff: '', mySched: null
  };
  var BLOCK_HINT = { morning: '9am to 6pm', evening: '6pm to 12am' };
  function keys() { return S.config.blocks.map(function (b) { return b.key; }); }

  // ------------------------------------------------------------ utils
  function $(sel) { return document.querySelector(sel); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function d8(ymd) { return new Date(ymd + 'T12:00:00'); }
  function fmtDay(ymd) { return d8(ymd).toLocaleDateString('en-AU', { weekday: 'short' }); }
  function fmtDM(ymd) { return d8(ymd).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); }
  function fmtLong(ymd) { return d8(ymd).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }); }
  function isWeekend(ymd) { var g = d8(ymd).getDay(); return g === 0 || g === 6; }
  function busy(on) { $('#spinner').classList.toggle('hidden', !on); }
  var toastTimer;
  function toast(t) { var el = $('#toast'); el.textContent = t; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2600); }
  function blockLabel(k) { return { morning: 'Morning', evening: 'Evening' }[k] || k; }

  function api(action, data, quiet) {
    if (!API || API.indexOf('PASTE_') === 0) return Promise.reject(new Error('The app is not connected yet. Add the web app URL to config.js.'));
    var body = Object.assign({ action: action, token: S.token }, data || {});
    if (!quiet) busy(true);
    // No custom headers: keeps this a "simple" request so Apps Script accepts it from GitHub Pages.
    return fetch(API, { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!quiet) busy(false);
        if (!j.ok) {
          if (j.code === 'AUTH' && action !== 'login') { signOutLocal(); render(); }
          var e = new Error(j.error || 'Request failed'); e.code = j.code; throw e;
        }
        return j.data;
      }, function (err) {
        if (!quiet) busy(false);
        if (err.code) throw err;
        throw new Error('Could not reach the server. Check your connection and try again.');
      });
  }

  function signOutLocal() {
    S.token = ''; S.user = null; S.mine = null; S.overview = null; S.staff = null; S.jobs = null;
    localStorage.removeItem('roster_token');
    ['user', 'mine', 'jobs', 'overview'].forEach(function (k) { store(k, null); });
  }

  // Last-seen data is kept on this device so the app opens instantly, then refreshes in the background.
  function store(key, val) {
    try {
      if (val === null) localStorage.removeItem('roster_c_' + key);
      else localStorage.setItem('roster_c_' + key, JSON.stringify(val));
    } catch (e) {}
  }
  function stored(key) {
    try { var v = localStorage.getItem('roster_c_' + key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function applyMine(d) {
    S.mine = d; store('mine', d);
    resetDraft(S.dirty);
  }
  function applyJobs(jobs, overview) {
    if (jobs) { S.jobs = jobs; store('jobs', jobs); }
    if (overview) applyOverview(overview);
    if (S.jobs && !S.jobWeekPicked) { // first visit: open the first week that has jobs
      S.jobWeekPicked = true;
      var wks = weeks(S.jobs.dates);
      for (var i = 0; i < wks.length; i++) if (jobsInWeek(wks[i]).length) { S.jobWeek = i; break; }
    }
  }
  function applyOverview(d) {
    S.overview = d; store('overview', d);
    if (!S.freeDate || d.dates.indexOf(S.freeDate) < 0) S.freeDate = d.dates[0];
  }
  function applyBoot(d) {
    S.user = d.user; S.config = d.config; store('user', { user: d.user, config: d.config });
    if (d.mine) applyMine(d.mine);
    if (d.jobs || d.overview) applyJobs(d.jobs, d.overview);
    if (d.jobsError) toast(d.jobsError);
  }

  // ------------------------------------------------------------ routing
  function tabsFor(user) {
    if (user.role === 'admin') {
      var t = [['jobs', 'Jobs'], ['schedule', 'Work schedule'], ['grid', 'Availability grid'], ['free', "Who's free"], ['gaps', 'Gaps'], ['conflicts', 'Conflicts'], ['staff', 'Staff']];
      if (user.rostered) t.push(['mine', 'My availability']);
      t.push(['account', 'Account']);
      return t;
    }
    return [['mine', 'My availability'], ['schedule', 'Work schedule'], ['account', 'Account']];
  }

  function go(view, noLoad) {
    if (view !== 'mine' && S.dirty && !confirm('You have unsaved changes. Leave without saving?')) return;
    if (view !== 'mine') S.dirty = false;
    S.view = view;
    S.editing = null;
    render();
    if (!noLoad) load(view);
  }

  // Shows whatever is already on screen straight away and refreshes quietly.
  function refresh(promise) {
    S.refreshing++; keepScroll(render);
    return promise.then(function () { S.refreshing--; keepScroll(render); }, function (e) { S.refreshing--; keepScroll(render); showErr(e); });
  }

  function load(view) {
    if (view === 'mine') return refresh(api('myAvailability', {}, true).then(applyMine));
    if (['grid', 'free', 'gaps', 'conflicts'].indexOf(view) >= 0) return refresh(api('adminOverview', {}, true).then(applyOverview));
    if (view === 'schedule' && S.user.role !== 'admin') return refresh(api('mySchedule', {}, true).then(function (d) { S.mySched = d; }));
    if (view === 'jobs' || view === 'schedule') return refresh(api('adminJobsPage', {}, true).then(function (d) { applyJobs(d.jobs, d.overview); }));
    if (view === 'staff') return refresh(api('adminListStaff', {}, true).then(function (d) { S.staff = d.staff; }));
  }

  function showErr(e) { toast(e.message); }

  // ------------------------------------------------------------ render shell
  function render() {
    var root = $('#root');
    var params = new URLSearchParams(location.search);
    if (params.get('reset')) { root.innerHTML = viewReset(); return bindReset(params.get('reset')); }
    if (!S.user && S.booting) { root.innerHTML = '<div class="auth-wrap"><p class="sub">Loading...</p></div>'; return; }
    if (!S.user) { root.innerHTML = S.view === 'forgot' ? viewForgot() : viewLogin(); return S.view === 'forgot' ? bindForgot() : bindLogin(); }

    document.title = S.config.appName;
    var tabs = tabsFor(S.user);
    var html = '<header class="top"><div class="top-row"><div class="brand">' + esc(S.config.appName) +
      '<small>' + (S.user.role === 'admin' ? 'Admin' : 'Staff') + '</small></div>' +
      '<div class="who">' + esc(S.user.name) + (S.refreshing ? '<small style="display:block;color:#bdbdc4">Updating...</small>' : '') + '</div></div><nav class="tabs">' +
      tabs.map(function (t) { return '<button data-go="' + t[0] + '" class="' + (S.view === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') +
      '</nav></header><main>';

    var v = S.view;
    if (v === 'mine') html += viewMine();
    else if (v === 'jobs') html += viewJobs();
    else if (v === 'schedule') html += viewSchedule();
    else if (v === 'grid') html += viewGrid();
    else if (v === 'free') html += viewFree();
    else if (v === 'gaps') html += viewGaps();
    else if (v === 'conflicts') html += viewConflicts();
    else if (v === 'staff') html += viewStaff();
    else if (v === 'account') html += viewAccount();
    html += '</main>';
    if (v === 'mine' && S.mine) html += '<div class="savebar"><div class="txt">' + (S.dirty ? '<strong>Unsaved changes</strong>' : 'All changes saved') +
      '</div><button class="btn" id="save" ' + (S.dirty ? '' : 'disabled') + '>Save availability</button></div>';
    root.innerHTML = html;

    root.querySelectorAll('[data-go]').forEach(function (b) { b.onclick = function () { go(b.getAttribute('data-go')); }; });
    if (v === 'mine') bindMine();
    if (v === 'grid') bindGrid();
    if (v === 'jobs') bindJobs();
    if (v === 'schedule') bindSchedule();
    if (v === 'free') bindFree();
    if (v === 'gaps' || v === 'conflicts' || v === 'grid' || v === 'jobs') bindSync();
    if (v === 'staff') bindStaff();
    if (v === 'account') bindAccount();
  }

  // ------------------------------------------------------------ auth views
  function viewLogin() {
    return '<div class="auth-wrap"><form class="card auth" id="login" novalidate>' +
      '<div class="logo">' + esc(S.config.appName) + '</div><p class="sub">Log in to update your availability.</p>' +
      '<label for="em">Email</label><input id="em" type="email" autocomplete="username" required>' +
      '<label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>' +
      '<button class="btn block" type="submit">Log in</button>' +
      '<p style="text-align:center;margin:14px 0 0"><button type="button" class="linkbtn" id="toForgot">Forgot password?</button></p>' +
      '<div id="m"></div></form></div>';
  }
  function bindLogin() {
    $('#toForgot').onclick = function () { S.view = 'forgot'; render(); };
    $('#login').onsubmit = function (e) {
      e.preventDefault();
      api('login', { email: $('#em').value, password: $('#pw').value, include: 'auto' }).then(function (d) {
        S.token = d.token; localStorage.setItem('roster_token', d.token);
        applyBoot(d);
        go(tabsFor(S.user)[0][0], true);
      }).catch(function (err) { $('#m').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; });
    };
  }
  function viewForgot() {
    return '<div class="auth-wrap"><form class="card auth" id="forgot">' +
      '<div class="logo">Reset password</div><p class="sub">Enter your email and we\'ll send you a reset link.</p>' +
      '<label for="em">Email</label><input id="em" type="email" autocomplete="username" required>' +
      '<button class="btn block" type="submit">Send reset link</button>' +
      '<p style="text-align:center;margin:14px 0 0"><button type="button" class="linkbtn" id="back">Back to log in</button></p>' +
      '<div id="m"></div></form></div>';
  }
  function bindForgot() {
    $('#back').onclick = function () { S.view = ''; render(); };
    $('#forgot').onsubmit = function (e) {
      e.preventDefault();
      api('requestReset', { email: $('#em').value }).then(function () {
        $('#m').innerHTML = '<div class="msg ok">If that email is registered, a reset link is on its way. Check your inbox and junk folder.</div>';
      }).catch(function (err) { $('#m').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; });
    };
  }
  function viewReset() {
    return '<div class="auth-wrap"><form class="card auth" id="reset">' +
      '<div class="logo">Set a new password</div><p class="sub">At least 8 characters.</p>' +
      '<label for="p1">New password</label><input id="p1" type="password" autocomplete="new-password">' +
      '<label for="p2">Repeat new password</label><input id="p2" type="password" autocomplete="new-password">' +
      '<button class="btn block" type="submit">Save password</button><div id="m"></div></form></div>';
  }
  function bindReset(token) {
    $('#reset').onsubmit = function (e) {
      e.preventDefault();
      if ($('#p1').value !== $('#p2').value) { $('#m').innerHTML = '<div class="msg err">The passwords don\'t match.</div>'; return; }
      api('resetPassword', { resetToken: token, newPassword: $('#p1').value }).then(function () {
        history.replaceState(null, '', location.pathname);
        signOutLocal(); S.view = ''; render();
        toast('Password updated. Log in with your new password.');
      }).catch(function (err) { $('#m').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; });
    };
  }

  // ------------------------------------------------------------ my availability
  function resetDraft(keepEdits) {
    var old = keepEdits ? S.draft : {};
    S.draft = {};
    S.mine.dates.forEach(function (d) {
      var a = S.mine.avail[d];
      S.draft[d] = old[d] || { morning: a ? a.morning : null, evening: a ? a.evening : null };
    });
    if (!keepEdits) S.dirty = false;
  }

  // A day counts as filled once any slot is marked Available or Not available (or is booked).
  function dayFilled(d) {
    var bk = S.mine.booked[d] || {}, dr = S.draft[d];
    return keys().some(function (k) { return bk[k] || dr[k] === true || dr[k] === false; });
  }

  // Weeks run Monday to Sunday. The first week may be partial (starts today).
  function addDay(ymd, n) { var d = d8(ymd); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  // Full Monday to Sunday list for a week, including days before today (shown as past).
  function fullWeek(wk) {
    var out = wk.slice();
    while (d8(out[0]).getDay() !== 1) out.unshift(addDay(out[0], -1));
    return out;
  }

  function weeks(dates) {
    var out = [];
    dates.forEach(function (d) {
      if (!out.length || d8(d).getDay() === 1) out.push([]);
      out[out.length - 1].push(d);
    });
    return out;
  }

  function viewMine() {
    if (!S.mine) return '<div class="card"><p class="empty">Loading your availability...</p></div>';
    var unfilled = S.mine.dates.filter(function (d) { return !dayFilled(d); }).length;
    var html = '<h1>My availability</h1><p class="sub">Tap a slot to switch between Available, Not available and Not set. ' +
      'Morning is 9am to 6pm, Evening is 6pm to 12am.' +
      (unfilled ? ' <span class="tag unfilled">' + unfilled + ' days not filled</span>' : '') + '</p>';
    var wks = weeks(S.mine.dates);
    if (S.mineWeek >= wks.length) S.mineWeek = 0;
    // Week picker, same as the admin grid. A gold dot marks weeks with days not filled.
    html += '<div class="toolbar"><div class="chips">' + wks.map(function (w, i) {
      var gaps = w.some(function (d) { return !dayFilled(d); });
      return '<button class="chip' + (i === S.mineWeek ? ' on' : '') + '" data-mw="' + i + '">' + (i === 0 ? 'This week' : 'w/c ' + fmtDM(w[0])) +
        (gaps ? ' <span class="gapdot" title="Days not filled"></span>' : '') + '</button>';
    }).join('') + '</div></div>';
    wks.forEach(function (wk, wi) {
      if (wi !== S.mineWeek) return;
      var range = wk.length === 1 ? fmtDay(wk[0]) + ' ' + fmtDM(wk[0]) : fmtDM(wk[0]) + ' to ' + fmtDM(wk[wk.length - 1]);
      html += '<section class="card week"><div class="week-head"><h2>' + (wi === 0 ? 'This week: ' : '') + range + '</h2>' +
        '<div class="quick"><button class="btn ghost small" data-q="evening" data-w="' + wi + '">All evenings available</button>' +
        '<button class="btn ghost small" data-q="all" data-w="' + wi + '">All day available</button>' +
        '<button class="btn ghost small" data-q="rest" data-w="' + wi + '">Rest not available</button>' +
        '<button class="btn ghost small" data-q="clear" data-w="' + wi + '">Clear week</button></div></div>';
      wk.forEach(function (d) {
        var dr = S.draft[d], bk = S.mine.booked[d] || {};
        html += '<div class="day' + (isWeekend(d) ? ' weekend' : '') + '"><div class="d">' + fmtDay(d) + ' ' + fmtDM(d) +
          (!dayFilled(d) ? '<small><span class="tag unfilled">Not filled</span></small>' : '') + '</div><div class="slots">';
        S.config.blocks.forEach(function (b) {
          if (bk[b.key]) {
            html += '<button class="slot booked" disabled title="' + esc(bk[b.key].title) + '">Booked<small>' + esc(bk[b.key].title) + '</small></button>';
          } else {
            var v = dr[b.key];
            var cls = v === true ? ' on' : v === false ? ' off' : ' unset';
            var txt = v === true ? 'Available' : v === false ? 'Not available' : 'Not set';
            html += '<button class="slot' + cls + '" data-d="' + d + '" data-b="' + b.key + '" aria-label="' + b.label + ': ' + txt + '">' +
              b.label + '<small>' + txt + '</small></button>';
          }
        });
        html += '</div></div>';
      });
      html += '<div class="toolbar" style="justify-content:space-between;margin:12px 0 0">' +
        (wi > 0 ? '<button class="btn ghost small" data-mw="' + (wi - 1) + '">Previous week</button>' : '<span></span>') +
        (wi < wks.length - 1 ? '<button class="btn ghost small" data-mw="' + (wi + 1) + '">Next week</button>' : '<span></span>') + '</div>';
      html += '</section>';
    });
    if (S.mine.lastSync) html += '<p class="sub">Booked jobs last updated ' + esc(fmtStamp(S.mine.lastSync)) + '.</p>';
    return html;
  }

  function bindMine() {
    if (!S.mine) return;
    document.querySelectorAll('[data-mw]').forEach(function (b) {
      b.onclick = function () { S.mineWeek = +b.getAttribute('data-mw'); render(); window.scrollTo(0, 0); };
    });
    document.querySelectorAll('.slot[data-d]').forEach(function (b) {
      b.onclick = function () {
        var d = b.getAttribute('data-d'), k = b.getAttribute('data-b');
        var v = S.draft[d][k];
        S.draft[d][k] = v === null ? true : v === true ? false : null; // Not set > Available > Not available > Not set
        S.dirty = true; keepScroll(render);
      };
    });
    document.querySelectorAll('[data-q]').forEach(function (b) {
      b.onclick = function () {
        var q = b.getAttribute('data-q'), wk = weeks(S.mine.dates)[+b.getAttribute('data-w')];
        wk.forEach(function (d) {
          var bk = S.mine.booked[d] || {};
          keys().forEach(function (k) {
            if (bk[k]) return;
            if (q === 'clear') S.draft[d][k] = null;
            else if (q === 'all') S.draft[d][k] = true;
            else if (q === 'evening' && k === 'evening') S.draft[d][k] = true;
            else if (q === 'rest' && S.draft[d][k] === null) S.draft[d][k] = false;
          });
        });
        S.dirty = true; keepScroll(render);
      };
    });
    var save = $('#save');
    if (save) save.onclick = function () {
      var days = S.mine.dates.map(function (d) { var x = S.draft[d]; return { date: d, morning: x.morning, evening: x.evening }; });
      api('saveMyAvailability', { days: days }).then(function () {
        S.dirty = false; toast('Availability saved'); return load('mine');
      }).catch(showErr);
    };
  }

  function keepScroll(fn) { var y = window.scrollY; fn(); window.scrollTo(0, y); }

  // ------------------------------------------------------------ admin: shared
  function syncBar() {
    var o = S.overview;
    return '<div class="toolbar" style="justify-content:space-between"><span class="sub" style="margin:0">' +
      (o && o.lastSync ? 'Calendar last synced ' + esc(fmtStamp(o.lastSync)) + (o.lastSyncResult ? ' (' + esc(o.lastSyncResult) + ')' : '') : 'Calendar not synced yet') +
      '</span><button class="btn ghost small" id="sync">Sync calendar now</button></div>';
  }
  function bindSync() {
    var b = $('#sync'); if (!b) return;
    b.onclick = function () {
      api('adminSyncNow').then(function (r) { toast('Synced: ' + r.summary); return load(S.view); }).catch(showErr);
    };
  }
  function skillSelect(id, val) {
    return '<select id="' + id + '"><option value="">All booth types</option>' +
      S.config.skills.map(function (s) { return '<option' + (s === val ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>';
  }
  function staffFiltered(skill) {
    return S.overview.staff.filter(function (s) { return !skill || s.skills.indexOf(skill) >= 0; });
  }
  function state(email, d, k) {
    var o = S.overview, a = (o.avail[email] || {})[d], b = ((o.booked[email] || {})[d] || {})[k];
    if (b) return a && a[k] === true ? 'b' : 'x';
    if (!a || a[k] === null || a[k] === undefined) return 'u';
    return a[k] ? 'a' : 'n';
  }

  // ------------------------------------------------------------ admin: jobs
  function fmtTime(hm) {
    var h = +hm.slice(0, 2), m = hm.slice(3, 5);
    return ((h % 12) || 12) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  // "2026-11-02 13:37" -> "Mon 2 Nov, 1:37 PM"
  function fmtStamp(v) {
    var m = String(v || '').match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)/);
    return m ? fmtDay(m[1]) + ' ' + fmtDM(m[1]) + ', ' + fmtTime(m[2]) : String(v || '');
  }
  function jobCounts(j) {
    var acc = 0, wait = 0;
    j.staff.forEach(function (x) { if (x.status === 'accepted') acc++; else if (x.status !== 'declined') wait++; });
    return { acc: acc, wait: wait };
  }
  function jobPill(j) {
    var c = jobCounts(j);
    if (!j.needed && !j.staff.length) return '<span class="st mu">No staff needed</span>';
    if (c.acc >= j.needed) return '<span class="st ok">' + c.acc + ' of ' + j.needed + ' accepted</span>';
    if (c.acc + c.wait >= j.needed) return '<span class="st wa">' + (c.acc ? c.acc + ' accepted, ' : '') + c.wait + ' awaiting reply</span>';
    return '<span class="st dg">' + (c.acc + c.wait) + ' of ' + j.needed + ' allocated</span>';
  }
  function jobsInWeek(wk) {
    var set = {}; wk.forEach(function (d) { set[d] = true; });
    return S.jobs.jobs.filter(function (j) { return set[j.date]; });
  }
  function slotText(j) {
    if (!j.slots.length) return 'Outside roster hours';
    var seen = {}, out = [];
    j.slots.forEach(function (x) { if (!seen[x.block]) { seen[x.block] = 1; out.push(blockLabel(x.block)); } });
    return out.join(', ');
  }

  function viewJobs() {
    if (!S.jobs || !S.overview) return '<h1>Jobs</h1><div class="card"><p class="empty">Loading jobs...</p></div>';
    var wks = weeks(S.jobs.dates);
    if (S.jobWeek >= wks.length) S.jobWeek = 0;
    var list = jobsInWeek(wks[S.jobWeek]);
    var short = list.filter(function (j) { var c = jobCounts(j); return c.acc + c.wait < j.needed; }).length;
    var html = '<h1>Jobs</h1>' + syncBar() +
      '<div class="toolbar"><div class="chips">' + wks.map(function (w, i) {
        var n = jobsInWeek(w).length;
        return '<button class="chip' + (i === S.jobWeek ? ' on' : '') + '" data-jw="' + i + '">' + (i === 0 ? 'This week' : 'w/c ' + fmtDM(w[0])) + (n ? ' (' + n + ')' : '') + '</button>';
      }).join('') + '</div></div>' +
      '<p class="sub">' + list.length + ' job' + (list.length === 1 ? '' : 's') + (short ? ', <strong style="color:var(--warn)">' + short + ' need' + (short === 1 ? 's' : '') + ' staff</strong>' : '') +
      (S.jobs.hidden ? '. ' + S.jobs.hidden + ' check-ins, training sessions and reminders hidden.' : '.') + ' Tap a job to allocate staff.</p>';
    if (!list.length) return html + '<div class="card"><p class="empty">No jobs in the bookings calendar this week.</p></div>';
    list.forEach(function (j) {
      var open = S.openJob === j.id;
      var time = j.allDay ? 'All day' : fmtTime(j.startTime) + ' to ' + fmtTime(j.endTime);
      html += '<div class="job' + (open ? ' open' : '') + '" data-job="' + esc(j.id) + '"><div class="when">' + fmtDay(j.date) + ' ' + fmtDM(j.date) +
        '<small>' + slotText(j) + '</small></div><div><div class="t">' + esc(j.title) + '</div><div class="meta">' + time +
        (j.location ? ' · ' + esc(j.location) : '') + ' · ' + (j.services.length ? esc(j.services.join(', ')) : 'No service listed') + (j.needed ? ' · needs ' + j.needed : '') + '</div>' +
        (j.serviceFound ? '' : '<div class="warnline">No "Services:" line found in the event details, so this job needs 1 by default.</div>') +
        '</div><div>' + jobPill(j) + '</div></div>';
      if (open) html += allocPanel(j, wks[S.jobWeek]);
    });
    return html;
  }

  function staffJobsThisWeek(email, wk) {
    return jobsInWeek(wk).filter(function (j) {
      return j.staff.some(function (x) { return x.email === email && x.status !== 'declined'; });
    }).length;
  }

  function allocPanel(j, wk) {
    var o = S.overview;
    var statusTxt = { accepted: ['ok', 'Accepted'], invited: ['wa', 'Invite sent, awaiting reply'], maybe: ['wa', 'Replied maybe'], declined: ['dg', 'Declined'] };
    var html = '<div class="alloc"><h3>Allocated</h3>';
    if (!j.staff.length) html += '<div class="arow"><small>Nobody yet.</small></div>';
    j.staff.forEach(function (x) {
      var key = j.id + '|' + x.email, st = statusTxt[x.status] || statusTxt.invited;
      html += '<div class="arow"><span>' + esc(x.name) + '</span><span style="display:flex;gap:8px;align-items:center"><span class="st ' + st[0] + '">' + st[1] + '</span>' +
        (x.status === 'declined' ? '<button class="btn ghost small" data-alloc="' + esc(x.email) + '">Invite again</button>' : '') +
        '<button class="btn ghost small" data-rm="' + esc(x.email) + '">' + (S.confirmRemove === key ? 'Confirm remove' : 'Remove') + '</button></span></div>';
    });

    var taken = {}; j.staff.forEach(function (x) { taken[x.email] = true; });
    var pool = o.staff.filter(function (s) { return !taken[s.email]; });
    var filtered = j.skills.length && !S.jobShowAll;
    if (filtered) pool = pool.filter(function (s) { return s.skills.some(function (k) { return j.skills.indexOf(k) >= 0; }); });

    var full = [], part = [], other = [];
    pool.forEach(function (s) {
      var free = [], reason = '';
      j.slots.forEach(function (x) {
        var b = ((o.booked[s.email] || {})[x.date] || {})[x.block];
        var a = ((o.avail[s.email] || {})[x.date] || {})[x.block];
        if (b && b.eventId !== j.iCalUID) { reason = reason || 'Booked: ' + b.title; return; }
        if (a === true) free.push(x.block); else reason = reason || (a === false ? 'Not available' : 'Not set');
      });
      var item = { s: s, n: staffJobsThisWeek(s.email, wk), reason: reason, free: free };
      if (!j.slots.length) part.push(item);
      else if (free.length === j.slots.length) full.push(item);
      else if (free.length) part.push(item);
      else other.push(item);
    });
    var byLoad = function (a, b) { return a.n - b.n || a.s.name.localeCompare(b.s.name); };
    full.sort(byLoad); part.sort(byLoad); other.sort(function (a, b) { return a.s.name.localeCompare(b.s.name); });
    var row = function (it, btn) {
      return '<div class="arow"><span>' + esc(it.s.name) + ' <small>' + esc(it.s.skills.join(', ') || 'No booth types') + ' · ' + it.n + ' job' + (it.n === 1 ? '' : 's') + ' this week' +
        (it.reason && btn ? ' · ' + esc(it.reason) : '') + '</small></span>' +
        (btn ? '<button class="btn small" data-alloc="' + esc(it.s.email) + '">Allocate</button>'
             : '<span style="display:flex;gap:8px;align-items:center"><small>' + esc(it.reason) + '</small><button class="btn ghost small" data-anyway="' + esc(it.s.email) + '">' +
               (S.confirmAnyway === j.id + '|' + it.s.email ? 'Confirm allocate' : 'Allocate anyway') + '</button></span>') + '</div>';
    };

    if (j.skills.length) html += '<div class="toolbar" style="margin:12px 0 0"><span class="sub" style="margin:0">' + (filtered ? 'Showing staff tagged ' + esc(j.skills.join(' or ')) + '.' : 'Showing all staff.') +
      '</span><button class="linkbtn" id="jall">' + (filtered ? 'Show all staff' : 'Only ' + esc(j.skills.join(' or '))) + '</button></div>';
    if (!j.slots.length) {
      html += '<h3>Outside roster hours, check with staff first</h3>' + (part.map(function (it) { return row(it, true); }).join('') || '<div class="arow"><small>Nobody to show.</small></div>');
    } else {
      html += '<h3>Available for the whole job (' + full.length + ')</h3>' + (full.map(function (it) { return row(it, true); }).join('') || '<div class="arow"><small>Nobody is free for every slot of this job.</small></div>');
      if (part.length) html += '<h3>Available for part of the job (' + part.length + ')</h3>' + part.map(function (it) {
        it.reason = 'Free ' + it.free.map(blockLabel).join(', ').toLowerCase() + ' only'; return row(it, true); }).join('');
    }
    if (other.length) {
      html += '<h3>Not available, booked or not set (' + other.length + ') <button class="linkbtn" id="jothers" style="text-transform:none;letter-spacing:0">' + (S.showOthers ? 'Hide' : 'Show') + '</button></h3>';
      if (S.showOthers) html += '<div class="arow"><small>You can still allocate anyone here, for example someone you removed earlier. Check with them first, as their availability doesn\'t match this job.</small></div>' +
        other.map(function (it) { return row(it, false); }).join('');
    }
    return html + '<p class="sub" style="margin:12px 0 0">Allocate adds them as a guest on the calendar event, so Google sends them an invite, and the app emails them the job details too. They show as Booked once they click Yes.</p></div>';
  }

  function bindJobs() {
    if (!S.jobs) return;
    document.querySelectorAll('[data-jw]').forEach(function (b) { b.onclick = function () { S.jobWeekPicked = true; S.jobWeek = +b.getAttribute('data-jw'); S.openJob = null; render(); }; });
    document.querySelectorAll('[data-job]').forEach(function (b) {
      b.onclick = function () { var id = b.getAttribute('data-job'); S.openJob = S.openJob === id ? null : id; S.confirmRemove = ''; S.showOthers = false; S.jobShowAll = false; keepScroll(render); };
    });
    var job = S.jobs.jobs.filter(function (j) { return j.id === S.openJob; })[0];
    if (!job) return;
    var all = $('#jall'); if (all) all.onclick = function () { S.jobShowAll = !S.jobShowAll; keepScroll(render); };
    var oth = $('#jothers'); if (oth) oth.onclick = function () { S.showOthers = !S.showOthers; keepScroll(render); };
    var nameOf = function (email) { var s = S.overview.staff.filter(function (x) { return x.email === email; })[0]; return s ? s.name : email; };
    document.querySelectorAll('[data-alloc]').forEach(function (b) {
      b.onclick = function () {
        var email = b.getAttribute('data-alloc');
        api('adminAllocate', { eventId: job.id, email: email }).then(function (r) {
          toast(r.already ? nameOf(email) + ' is already on this job' : 'Invite' + (r.emailed ? ' and email' : '') + ' sent to ' + nameOf(email));
          return load('jobs');
        }).catch(showErr);
      };
    });
    document.querySelectorAll('[data-anyway]').forEach(function (b) {
      b.onclick = function () {
        var email = b.getAttribute('data-anyway'), key = job.id + '|' + email;
        if (S.confirmAnyway !== key) { S.confirmAnyway = key; return keepScroll(render); }
        S.confirmAnyway = '';
        api('adminAllocate', { eventId: job.id, email: email }).then(function (r) {
          toast(r.already ? nameOf(email) + ' is already on this job' : 'Invite' + (r.emailed ? ' and email' : '') + ' sent to ' + nameOf(email));
          return load('jobs');
        }).catch(showErr);
      };
    });
    document.querySelectorAll('[data-rm]').forEach(function (b) {
      b.onclick = function () {
        var email = b.getAttribute('data-rm'), key = job.id + '|' + email;
        if (S.confirmRemove !== key) { S.confirmRemove = key; return keepScroll(render); }
        S.confirmRemove = '';
        api('adminUnallocate', { eventId: job.id, email: email }).then(function () {
          toast(nameOf(email) + ' removed and emailed');
          return load('jobs');
        }).catch(showErr);
      };
    });
  }

  // ------------------------------------------------------------ work schedule
  function viewSchedule() {
    var isAdmin = S.user.role === 'admin';
    var html = '<h1>Work schedule</h1>';
    var jobs, today;
    if (isAdmin) {
      if (!S.jobs || !S.overview) return html + '<div class="card"><p class="empty">Loading...</p></div>';
      if (!S.schedStaff && S.overview.staff.length) S.schedStaff = S.overview.staff[0].email;
      html += '<div class="toolbar"><select id="schedwho">' + S.overview.staff.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (s) {
        return '<option value="' + esc(s.email) + '"' + (s.email === S.schedStaff ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select></div>';
      today = S.jobs.dates[0];
      jobs = [];
      S.jobs.jobs.forEach(function (j) {
        var me = j.staff.filter(function (x) { return x.email === S.schedStaff; })[0];
        if (me && me.status !== 'declined') jobs.push(Object.assign({}, j, { status: me.status }));
      });
    } else {
      if (!S.mySched) return html + '<div class="card"><p class="empty">Loading your jobs...</p></div>';
      today = S.mySched.today; jobs = S.mySched.jobs;
    }
    html += '<p class="sub">Accepted jobs and invites awaiting a reply, from Monday this week to the end of the 8-week window.</p>';
    if (!jobs.length) return html + '<div class="card"><p class="empty">' + (isAdmin ? 'No jobs for this person.' : 'You have no jobs yet.') + '</p></div>';
    var groups = {}, order = [];
    jobs.forEach(function (j) {
      var mon = fullWeek([j.date])[0];
      if (!groups[mon]) { groups[mon] = []; order.push(mon); }
      groups[mon].push(j);
    });
    order.sort().forEach(function (mon) {
      html += '<section class="card"><h2>Week of ' + fmtDM(mon) + '</h2>';
      groups[mon].forEach(function (j) {
        var past = j.date < today;
        var time = j.allDay ? 'All day' : fmtTime(j.startTime) + ' to ' + fmtTime(j.endTime);
        var pill = past ? '<span class="st mu">Done</span>' : j.status === 'accepted' ? '<span class="st ok">Accepted</span>' : '<span class="st wa">Awaiting reply</span>';
        html += '<div class="arow"' + (past ? ' style="opacity:.55"' : '') + '><span><strong>' + fmtDay(j.date) + ' ' + fmtDM(j.date) + '</strong> · ' + time +
          '<br>' + esc(j.title) + '<br><small>' + (j.location ? esc(j.location) + ' · ' : '') + (j.services.length ? esc(j.services.join(', ')) : 'No service listed') + '</small></span>' + pill + '</div>';
      });
      html += '</section>';
    });
    return html;
  }
  function bindSchedule() {
    var w = $('#schedwho'); if (w) w.onchange = function () { S.schedStaff = w.value; render(); };
  }

  // ------------------------------------------------------------ admin: grid
  function viewGrid() {
    var o = S.overview;
    if (!o) return '<div class="card"><p class="empty">Loading...</p></div>';
    var wks = weeks(o.dates), wk = wks[S.gridWeek] || wks[0];
    var staff = staffFiltered(S.gridSkill);
    var html = '<h1>Availability grid</h1>' + syncBar() +
      '<div class="toolbar"><div class="chips">' + wks.map(function (w, i) {
        return '<button class="chip' + (i === S.gridWeek ? ' on' : '') + '" data-wk="' + i + '">' + (i === 0 ? 'This week' : 'w/c ' + fmtDM(w[0])) + '</button>'; }).join('') +
      '</div>' + skillSelect('gskill', S.gridSkill) + '</div>';
    if (!staff.length) return html + '<div class="card"><p class="empty">No rostered staff yet. Add them on the Staff tab.</p></div>';
    var inWin = {}; o.dates.forEach(function (d) { inWin[d] = true; });
    wk = fullWeek(wk);
    html += '<div class="gridwrap"><table class="grid"><thead><tr><th>Staff</th>' + wk.map(function (d) {
      return '<th class="' + (isWeekend(d) ? 'wk' : '') + '"' + (inWin[d] ? '' : ' style="opacity:.4"') + '>' + fmtDay(d) + '<br>' + fmtDM(d) + '</th>'; }).join('') + '</tr></thead><tbody>';
    staff.forEach(function (s) {
      html += '<tr><td><strong>' + esc(s.name) + '</strong><br><span class="sub" style="font-size:11px">' + esc(s.skills.join(', ')) + '</span></td>';
      wk.forEach(function (d) {
        if (!inWin[d]) { html += '<td><span class="sub" style="font-size:11px">Past</span></td>'; return; }
        html += '<td><div class="cells">' + keys().map(function (k) {
          var st = state(s.email, d, k);
          var bk = ((o.booked[s.email] || {})[d] || {})[k];
          var tip = blockLabel(k) + ': ' + ({ a: 'Available', n: 'Not available', u: 'Not set', b: 'Booked', x: 'Booked, not marked available' }[st]) + (bk ? ' (' + bk.title + ')' : '');
          if (st === 'b' || st === 'x') return '<span class="cell ' + st + '" title="' + esc(tip) + '" aria-label="' + esc(tip) + '"></span>';
          return '<button class="cell ' + st + ' edit" data-ce="' + esc(s.email) + '" data-cd="' + d + '" data-cb="' + k + '" title="' + esc(tip + '. Click to change') + '" aria-label="' + esc(tip + '. Click to change') + '"></button>';
        }).join('') + '</div></td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div><div class="legend">' +
      '<span><i class="cell a"></i>Available</span><span><i class="cell n"></i>Not available</span><span><i class="cell u"></i>Not set</span>' +
      '<span><i class="cell b"></i>Booked</span><span><i class="cell x"></i>Conflict</span><span>Each day shows Morning (9am to 6pm), then Evening (6pm to 12am). Click a slot to change it: Available, Not available, Not set. Booked slots can\'t be changed here.</span></div>';
    return html;
  }
  // Admin override: each click saves straight away. Requests run one after another so fast clicks land in order.
  var saveQueue = Promise.resolve();
  function setSlot(email, d, k) {
    var o = S.overview;
    var day = ((o.avail[email] = o.avail[email] || {})[d]) || { morning: null, evening: null };
    var before = day[k] === undefined ? null : day[k];
    var next = before === true ? false : before === false ? null : true; // Available > Not available > Not set
    day[k] = next; o.avail[email][d] = day;
    if (day.morning === null && day.evening === null) delete o.avail[email][d];
    S.refreshing++; keepScroll(render);
    saveQueue = saveQueue.then(function () {
      return api('adminSetAvailability', { email: email, date: d, block: k, value: next }, true).catch(function (e) {
        var cur = (o.avail[email][d] = o.avail[email][d] || { morning: null, evening: null });
        cur[k] = before; showErr(e);
      });
    }).then(function () {
      S.refreshing--;
      if (!S.refreshing) return api('adminOverview', {}, true).then(applyOverview).catch(function () {}).then(function () { keepScroll(render); });
      keepScroll(render);
    });
  }

  function bindGrid() {
    document.querySelectorAll('[data-ce]').forEach(function (b) {
      b.onclick = function () { setSlot(b.getAttribute('data-ce'), b.getAttribute('data-cd'), b.getAttribute('data-cb')); };
    });
    document.querySelectorAll('[data-wk]').forEach(function (b) { b.onclick = function () { S.gridWeek = +b.getAttribute('data-wk'); render(); }; });
    var sk = $('#gskill'); if (sk) sk.onchange = function () { S.gridSkill = sk.value; render(); };
  }

  // ------------------------------------------------------------ admin: who's free
  function viewFree() {
    var o = S.overview;
    if (!o) return '<div class="card"><p class="empty">Loading...</p></div>';
    var html = '<h1>Who\'s free</h1><div class="toolbar">' +
      '<select id="fdate">' + o.dates.map(function (d) { return '<option value="' + d + '"' + (d === S.freeDate ? ' selected' : '') + '>' + fmtLong(d) + '</option>'; }).join('') + '</select>' +
      '<select id="fblock"><option value="">Any block</option>' + S.config.blocks.map(function (b) {
        return '<option value="' + b.key + '"' + (b.key === S.freeBlock ? ' selected' : '') + '>' + b.label + ' (' + BLOCK_HINT[b.key] + ')</option>'; }).join('') + '</select>' +
      skillSelect('fskill', S.freeSkill) + '</div>';

    var groups = { free: [], booked: [], no: [], unfilled: [] };
    var d = S.freeDate;
    var ks = S.freeBlock ? [S.freeBlock] : keys();
    staffFiltered(S.freeSkill).forEach(function (s) {
      var states = ks.map(function (k) { return { k: k, st: state(s.email, d, k) }; });
      var freeK = states.filter(function (x) { return x.st === 'a'; }).map(function (x) { return blockLabel(x.k); });
      var bookedK = states.filter(function (x) { return x.st === 'b' || x.st === 'x'; });
      if (freeK.length) groups.free.push({ s: s, note: S.freeBlock ? '' : freeK.join(', ') });
      else if (bookedK.length) groups.booked.push({ s: s, note: bookedK.map(function (x) { return blockLabel(x.k) + ': ' + (((o.booked[s.email] || {})[d] || {})[x.k] || {}).title; }).join(' | ') });
      else if (states.every(function (x) { return x.st === 'u'; })) groups.unfilled.push({ s: s, note: '' });
      else groups.no.push({ s: s, note: '' });
    });
    function col(title, color, list) {
      return '<div class="card"><div class="col-head" style="color:' + color + '">' + title + ' (' + list.length + ')</div>' +
        (list.length ? list.map(function (x) { return '<div class="person">' + esc(x.s.name) + '<small>' + esc(x.note || x.s.skills.join(', ')) + '</small></div>'; }).join('')
          : '<p class="empty" style="padding:6px 0">Nobody</p>') + '</div>';
    }
    html += '<div class="cols">' + col('Available', 'var(--avail)', groups.free) + col('Booked', 'var(--booked)', groups.booked) +
      col('Not available', 'var(--muted)', groups.no) + col('Not set', '#8a6100', groups.unfilled) + '</div>';
    return html;
  }
  function bindFree() {
    if (!S.overview) return;
    $('#fdate').onchange = function () { S.freeDate = this.value; render(); };
    $('#fblock').onchange = function () { S.freeBlock = this.value; render(); };
    $('#fskill').onchange = function () { S.freeSkill = this.value; render(); };
  }

  // ------------------------------------------------------------ admin: gaps & conflicts
  function viewGaps() {
    var o = S.overview;
    if (!o) return '<div class="card"><p class="empty">Loading...</p></div>';
    var html = '<h1>Gaps</h1><p class="sub">Rostered staff with days in the next 8 weeks they haven\'t filled in yet.</p>' + syncBar();
    if (!o.gaps.length) return html + '<div class="card"><p class="empty">Everyone is up to date.</p></div>';
    html += '<div class="card"><table class="list"><thead><tr><th>Staff</th><th>Days not filled</th><th>First gap</th></tr></thead><tbody>';
    o.gaps.sort(function (a, b) { return b.missing - a.missing; }).forEach(function (g) {
      html += '<tr><td><strong>' + esc(g.name) + '</strong><br><span class="sub" style="font-size:12px">' + esc(g.email) + '</span></td><td>' + g.missing +
        ' of ' + o.dates.length + '</td><td>' + fmtDay(g.firstMissing) + ' ' + fmtDM(g.firstMissing) + '</td></tr>';
    });
    return html + '</tbody></table></div>';
  }
  function viewConflicts() {
    var o = S.overview;
    if (!o) return '<div class="card"><p class="empty">Loading...</p></div>';
    var html = '<h1>Conflicts</h1><p class="sub">Accepted jobs on blocks the staff member hasn\'t marked as available.</p>' + syncBar();
    if (!o.conflicts.length) return html + '<div class="card"><p class="empty">No conflicts.</p></div>';
    html += '<div class="card"><table class="list"><thead><tr><th>Date</th><th>Staff</th><th>Job</th><th>Issue</th></tr></thead><tbody>';
    o.conflicts.forEach(function (c) {
      html += '<tr><td>' + fmtDay(c.date) + ' ' + fmtDM(c.date) + '<br><span class="sub" style="font-size:12px">' + blockLabel(c.block) + '</span></td><td>' +
        esc(c.name) + '</td><td>' + esc(c.title) + '</td><td><span class="pill off">' + (c.notSet ? 'Slot not set' : 'Marked not available') + '</span></td></tr>';
    });
    return html + '</tbody></table></div>';
  }

  // ------------------------------------------------------------ admin: staff
  function viewStaff() {
    if (!S.staff) return '<div class="card"><p class="empty">Loading...</p></div>';
    var html = '<h1>Staff</h1><p class="sub">Login email must match the email you invite to job events in Google Calendar.</p>';
    if (S.editing) html += staffForm(S.editing);
    else html += '<div class="toolbar"><button class="btn" id="add">Add person</button></div>';
    html += '<div class="card"><table class="list"><thead><tr><th>Name</th><th>Booth types</th><th>Status</th><th></th></tr></thead><tbody>';
    S.staff.slice().sort(function (a, b) { return (b.active - a.active) || a.name.localeCompare(b.name); }).forEach(function (s) {
      html += '<tr><td><strong>' + esc(s.name) + '</strong><br><span class="sub" style="font-size:12px">' + esc(s.email) + '</span></td><td>' +
        (s.skills.length ? s.skills.map(function (k) { return '<span class="pill">' + esc(k) + '</span>'; }).join('') : '<span class="sub">None</span>') + '</td><td>' +
        (s.role === 'admin' ? '<span class="pill admin">Admin</span>' : '') + (s.active ? '' : '<span class="pill off">Inactive</span>') +
        (s.rostered ? '' : '<span class="pill">Not rostered</span>') + '</td><td style="text-align:right"><button class="btn ghost small" data-edit="' + esc(s.email) + '">Edit</button></td></tr>';
    });
    return html + '</tbody></table></div>';
  }
  function staffForm(s) {
    var isNew = !s.email;
    return '<form class="card" id="sform"><h2>' + (isNew ? 'Add person' : 'Edit ' + esc(s.name)) + '</h2>' +
      '<div class="row2"><div><label for="sn">Name</label><input id="sn" type="text" value="' + esc(s.name || '') + '"></div>' +
      '<div><label for="se">Email (login)</label><input id="se" type="email" value="' + esc(s.email || '') + '"' + (isNew ? '' : ' readonly') + '></div></div>' +
      '<label>Booth types</label><div class="checks">' + S.config.skills.map(function (k) {
        return '<label><input type="checkbox" name="sk" value="' + esc(k) + '"' + ((s.skills || []).indexOf(k) >= 0 ? ' checked' : '') + '> ' + esc(k) + '</label>'; }).join('') + '</div>' +
      '<label>Access</label><div class="checks">' +
      '<label><input type="checkbox" id="sadmin"' + (s.role === 'admin' ? ' checked' : '') + '> Admin</label>' +
      '<label><input type="checkbox" id="sroster"' + (s.rostered !== false ? ' checked' : '') + '> On the roster (enters availability)</label>' +
      '<label><input type="checkbox" id="sactive"' + (s.active !== false ? ' checked' : '') + '> Active</label></div>' +
      '<label for="spw">' + (isNew ? 'Starting password' : 'Set a new password (leave blank to keep current)') + '</label>' +
      '<div style="display:flex;gap:8px"><input id="spw" type="text" autocomplete="off" placeholder="At least 8 characters"><button type="button" class="btn ghost" id="gen">Generate</button></div>' +
      '<div id="m"></div><div class="toolbar" style="margin:16px 0 0"><button class="btn" type="submit">Save</button><button type="button" class="btn ghost" id="cancel">Cancel</button></div></form>';
  }
  function bindStaff() {
    var add = $('#add'); if (add) add.onclick = function () { S.editing = { rostered: true, active: true, skills: [] }; render(); };
    document.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () { var e = b.getAttribute('data-edit'); S.editing = S.staff.filter(function (s) { return s.email === e; })[0]; render(); window.scrollTo(0, 0); };
    });
    var f = $('#sform'); if (!f) return;
    $('#cancel').onclick = function () { S.editing = null; render(); };
    $('#gen').onclick = function () {
      var c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', a = new Uint32Array(10), p = '';
      crypto.getRandomValues(a); for (var i = 0; i < a.length; i++) p += c[a[i] % c.length];
      $('#spw').value = p;
    };
    f.onsubmit = function (e) {
      e.preventDefault();
      var payload = {
        name: $('#sn').value, email: $('#se').value,
        skills: Array.prototype.map.call(document.querySelectorAll('input[name=sk]:checked'), function (x) { return x.value; }),
        role: $('#sadmin').checked ? 'admin' : 'staff', rostered: $('#sroster').checked, active: $('#sactive').checked,
        password: $('#spw').value || undefined
      };
      api('adminSaveStaff', { staff: payload }).then(function (r) {
        toast(r.created ? payload.name + ' added. Send them their login details.' : 'Saved');
        S.editing = null; return load('staff');
      }).catch(function (err) { $('#m').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; });
    };
  }

  // ------------------------------------------------------------ account
  function viewAccount() {
    return '<h1>Account</h1><form class="card" id="cpw" style="max-width:440px"><h2>Change password</h2>' +
      '<label for="c0">Current password</label><input id="c0" type="password" autocomplete="current-password">' +
      '<label for="c1">New password</label><input id="c1" type="password" autocomplete="new-password">' +
      '<label for="c2">Repeat new password</label><input id="c2" type="password" autocomplete="new-password">' +
      '<button class="btn block" type="submit">Update password</button><div id="m"></div></form>' +
      '<div class="card" style="max-width:440px"><p class="sub" style="margin-top:0">Logged in as ' + esc(S.user.email) + '</p><button class="btn ghost" id="logout">Log out</button></div>';
  }
  function bindAccount() {
    $('#cpw').onsubmit = function (e) {
      e.preventDefault();
      if ($('#c1').value !== $('#c2').value) { $('#m').innerHTML = '<div class="msg err">The new passwords don\'t match.</div>'; return; }
      api('changePassword', { currentPassword: $('#c0').value, newPassword: $('#c1').value }).then(function () {
        $('#m').innerHTML = '<div class="msg ok">Password updated.</div>'; $('#c0').value = $('#c1').value = $('#c2').value = '';
      }).catch(function (err) { $('#m').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; });
    };
    $('#logout').onclick = function () {
      api('logout', {}, true).catch(function () {});
      signOutLocal(); S.view = ''; render();
    };
  }

  window.addEventListener('beforeunload', function (e) { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ------------------------------------------------------------ boot
  if (S.token && !new URLSearchParams(location.search).get('reset')) {
    // Open instantly with what this device saw last time, then refresh in one request.
    var cached = stored('user');
    if (cached) {
      S.user = cached.user; S.config = cached.config;
      var m = stored('mine'), j = stored('jobs'), o = stored('overview');
      if (m) { S.mine = m; resetDraft(); }
      if (j || o) applyJobs(j, o);
      go(tabsFor(S.user)[0][0], true);
    } else {
      S.booting = true; render();
    }
    S.refreshing++; if (S.user) render();
    api('me', { include: 'auto' }, true).then(function (d) {
      S.booting = false; S.refreshing--;
      var first = !S.user;
      applyBoot(d);
      if (first) go(tabsFor(S.user)[0][0], true); else keepScroll(render);
    }).catch(function (e) {
      S.booting = false; S.refreshing = 0;
      if (e.code === 'AUTH' || !S.user) { signOutLocal(); render(); } else { render(); showErr(e); }
    });
  } else {
    render();
    api('config', {}, true).then(function (c) { S.config = c; if (!S.user) render(); }).catch(function () {});
  }
})();
