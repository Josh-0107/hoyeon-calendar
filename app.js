// 호연 캘린더: 구글 캘린더를 저장소로 쓰는 월간 보기 PWA ('캘린더 구상' MVP)
const CONFIG = window.HOYEON_CONFIG || {};
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const API = 'https://www.googleapis.com/calendar/v3';
const TZ = 'Asia/Seoul';
const CAL_NAME = '호연';
// 구글 앱에서도 비슷하게 보이도록: vp 블루베리, fp 라벤더, fn 바나나, on 귤, bd 플라밍고
const COLOR_ID = { vp: '9', fp: '1', fn: '5', on: '6', bd: '4' };
const GROUP_LABEL = { school: '학교', job: '알바' };
const OWNER_LABEL = { bass: '베이스', tennis: '테니스', english: '영어', structure: '구조', mind: '마음', learnus: '런어스' };
const HOLIDAYS = { '2026-12-25': '성탄절', '2027-01-01': '신정' };
const MAX_CHIPS = 4;

const $ = (s) => document.querySelector(s);
const state = {
  token: load('token'),
  calId: load('calId'),
  year: 0, month: 0,
  events: [],
  selected: null,
  editing: null,
};

// ---------- 저장 ----------
function load(k) { try { return JSON.parse(localStorage.getItem('hy.' + k)); } catch { return null; } }
function save(k, v) { try { localStorage.setItem('hy.' + k, JSON.stringify(v)); } catch {} }

// ---------- 날짜 ----------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const shortTime = (d) => d.getMinutes() ? `${d.getHours()}:${pad(d.getMinutes())}` : `${d.getHours()}`;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

// ---------- 인증 ----------
let tokenClient = null;
function onGisLoad() {
  if (!CONFIG.clientId) { setStatus('config.js에 clientId를 넣어 주세요'); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.clientId,
    scope: SCOPE,
    hint: CONFIG.loginHint,
    callback: (resp) => {
      if (resp.error) { setStatus('연결 실패: ' + resp.error); showLogin(true); return; }
      state.token = { access_token: resp.access_token, exp: Date.now() + (resp.expires_in - 60) * 1000 };
      save('token', state.token);
      showLogin(false);
      start();
    },
  });
  if (tokenValid()) start();
  else if (state.token) tokenClient.requestAccessToken({ prompt: '' }); // 전에 허용했으면 조용히 다시 받음
  else showLogin(true);
}
const tokenValid = () => state.token && state.token.exp > Date.now();
function showLogin(on) { $('#login').hidden = !on; }

async function api(path, opts = {}) {
  if (!tokenValid()) { showLogin(true); throw new Error('로그인이 필요해요'); }
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + state.token.access_token, 'Content-Type': 'application/json' },
  });
  if (res.status === 401) { state.token = null; save('token', null); showLogin(true); throw new Error('다시 연결해 주세요'); }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// '호연' 캘린더를 찾고, 없으면 만들어요
async function ensureCalendar() {
  if (state.calId) return state.calId;
  const list = await api('/users/me/calendarList?minAccessRole=owner');
  let cal = list.items.find((c) => c.summary === CAL_NAME);
  if (!cal) cal = await api('/calendars', { method: 'POST', body: JSON.stringify({ summary: CAL_NAME, timeZone: TZ }) });
  state.calId = cal.id;
  save('calId', cal.id);
  return cal.id;
}
const calPath = () => '/calendars/' + encodeURIComponent(state.calId);

// ---------- 데이터 ----------
function priv(e) { return (e.extendedProperties && e.extendedProperties.private) || {}; }
function typeOf(e) {
  const t = priv(e).type;
  if (t) return t;
  const rev = Object.entries(COLOR_ID).find(([, id]) => id === e.colorId);
  return rev ? rev[0] : 'vp';
}
function norm(e) {
  const allDay = !!e.start.date;
  const start = allDay ? parseYmd(e.start.date) : new Date(e.start.dateTime);
  const end = allDay ? parseYmd(e.end.date) : new Date(e.end.dateTime);
  const p = priv(e);
  return { raw: e, id: e.id, title: e.summary || '(제목 없음)', allDay, start, end, type: typeOf(e),
    group: p.group, owner: p.owner || 'me', status: p.status || 'confirmed', recurring: !!e.recurringEventId };
}
function daysOf(ev) {
  if (!ev.allDay) return [ymd(ev.start)];
  const out = [];
  for (let d = ev.start; d < ev.end; d = addDays(d, 1)) out.push(ymd(d));
  return out;
}
function label(ev) { return (ev.owner !== 'me' && OWNER_LABEL[ev.owner] ? `[${OWNER_LABEL[ev.owner]}] ` : '') + ev.title; }
const byTime = (a, b) => (b.allDay - a.allDay) || (a.start - b.start);

function visibleRange() {
  const first = new Date(state.year, state.month, 1);
  const start = addDays(first, -first.getDay());
  const days = new Date(state.year, state.month + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + days) / 7);
  return { start, end: addDays(start, weeks * 7), weeks };
}

async function fetchEvents() {
  const { start, end } = visibleRange();
  const q = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', timeZone: TZ });
  setStatus('불러오는 중…');
  const res = await api(`${calPath()}/events?${q}`);
  state.events = res.items.filter((e) => e.status !== 'cancelled').map(norm);
  setStatus('');
}

// ---------- 그리기 ----------
function render() {
  $('#title').textContent = `${state.year}년 ${state.month + 1}월`;
  const { start, weeks } = visibleRange();
  const byDay = {};
  for (const ev of state.events) for (const d of daysOf(ev)) (byDay[d] ||= []).push(ev);

  const grid = $('#grid');
  grid.style.gridTemplateRows = `repeat(${weeks}, 1fr)`;
  grid.innerHTML = '';
  const todayKey = ymd(new Date());
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const key = ymd(d);
    const cell = document.createElement('div');
    cell.className = `cell d${d.getDay()}` + (d.getMonth() !== state.month ? ' out' : '') +
      (key === todayKey ? ' today' : '') + (key === state.selected ? ' sel' : '') + (HOLIDAYS[key] ? ' hol' : '');
    cell.innerHTML = `<div class="num"><b>${d.getDate()}</b>${HOLIDAYS[key] ? `<span class="hol">${HOLIDAYS[key]}</span>` : ''}</div>`;
    const chips = monthChips((byDay[key] || []).sort(byTime));
    chips.slice(0, MAX_CHIPS).forEach((c) => cell.appendChild(c));
    if (chips.length > MAX_CHIPS) cell.insertAdjacentHTML('beforeend', `<span class="more">+${chips.length - MAX_CHIPS}</span>`);
    cell.onclick = () => selectDay(key);
    grid.appendChild(cell);
  }
  if (state.selected) renderSheet(byDay[state.selected] || []);
}

// 월간 보기에서는 학교·알바를 하루 한 칩으로 묶어요
function monthChips(list) {
  const out = [];
  const seen = {};
  for (const ev of list) {
    if (ev.group && GROUP_LABEL[ev.group]) {
      if (seen[ev.group]) continue;
      seen[ev.group] = true;
      out.push(chip(GROUP_LABEL[ev.group], ev.type, null, false));
    } else {
      out.push(chip(label(ev), ev.type, ev.allDay ? null : ev.start, ev.status === 'proposed'));
    }
  }
  return out;
}
function chip(text, type, time, proposed) {
  const el = document.createElement('span');
  el.className = `chip ${type}` + (proposed ? ' proposed' : '');
  if (time) el.innerHTML = `<span class="t">${shortTime(time)}</span>`;
  el.appendChild(document.createTextNode(text));
  return el;
}

function selectDay(key) {
  state.selected = key;
  $('#sheet').hidden = false;
  render();
}
function renderSheet(list) {
  const d = parseYmd(state.selected);
  $('#sheet-title').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})` + (HOLIDAYS[state.selected] ? ' ' + HOLIDAYS[state.selected] : '');
  const ul = $('#day-list');
  ul.innerHTML = '';
  if (!list.length) { ul.innerHTML = '<li class="empty">일정 없음</li>'; return; }
  for (const ev of list.sort(byTime)) {
    const li = document.createElement('li');
    const when = ev.allDay ? '하루 종일' : `${hm(ev.start)}–${hm(ev.end)}`;
    const meta = [GROUP_LABEL[ev.group], ev.status === 'proposed' ? '제안' : '', ev.recurring ? '반복' : ''].filter(Boolean).join(' · ');
    li.innerHTML = `<span class="bar ${ev.type}"></span><span class="when"></span><span class="what"><div></div><div class="meta"></div></span>`;
    li.querySelector('.when').textContent = when;
    li.querySelector('.what div').textContent = label(ev);
    li.querySelector('.meta').textContent = meta;
    li.onclick = () => openForm(ev);
    ul.appendChild(li);
  }
}

// ---------- 추가·수정 폼 ----------
const form = $('#form');
const dialog = $('#form-dialog');
function typeFromAnswers(person, repeat) {
  return person ? (repeat ? 'fp' : 'vp') : (repeat ? 'fn' : 'on');
}
function currentType() {
  if (state.editing && state.editing.type === 'bd') return 'bd';
  return typeFromAnswers(form.person.value === '1', form.repeat.value === '1');
}
function refreshForm() {
  const t = currentType();
  const prev = $('#type-preview');
  prev.className = 'chip ' + t;
  prev.textContent = { vp: '변동 · 사람', fp: '고정 · 사람', on: '변동 · 무관', fn: '고정 · 무관', bd: '생일' }[t];
  form.querySelector('.times').style.display = form.allDay.checked ? 'none' : '';
  $('#repeat-opts').hidden = !(form.repeat.value === '1' && !state.editing);
}
form.addEventListener('change', refreshForm);

function openForm(ev) {
  state.editing = ev || null;
  form.reset();
  $('#form-title').textContent = ev ? '일정 수정' : '일정 추가';
  $('#delete').hidden = !ev;
  $('#instance-note').hidden = !(ev && ev.recurring);
  const isBd = ev && ev.type === 'bd';
  $('#q-person').hidden = isBd;
  $('#q-repeat').hidden = isBd;
  if (ev) {
    form.summary.value = ev.title;
    form.date.value = ymd(ev.start);
    form.allDay.checked = ev.allDay;
    if (!ev.allDay) { form.start.value = hm(ev.start); form.end.value = hm(ev.end); }
    form.person.value = ev.type === 'vp' || ev.type === 'fp' ? '1' : '0';
    form.repeat.value = ev.type === 'fp' || ev.type === 'fn' ? '1' : '0';
  } else {
    form.date.value = state.selected || ymd(new Date());
  }
  refreshForm();
  dialog.showModal();
}

function untilRule(dateStr, allDay) {
  if (!dateStr) return '';
  if (allDay) return ';UNTIL=' + dateStr.replace(/-/g, '');
  // 그날 23:59:59 KST를 UTC로
  const u = new Date(dateStr + 'T23:59:59+09:00').toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return ';UNTIL=' + u;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ev = state.editing;
  const date = form.date.value;
  const allDay = form.allDay.checked;
  if (!allDay && form.end.value <= form.start.value) { alert('끝 시간이 시작보다 늦어야 해요'); return; }
  const type = currentType();
  const body = {
    summary: form.summary.value.trim(),
    start: allDay ? { date } : { dateTime: `${date}T${form.start.value}:00`, timeZone: TZ },
    end: allDay ? { date: ymd(addDays(parseYmd(date), 1)) } : { dateTime: `${date}T${form.end.value}:00`, timeZone: TZ },
    colorId: COLOR_ID[type],
    extendedProperties: { private: { ...(ev ? priv(ev.raw) : { owner: 'me', status: 'confirmed' }), type } },
  };
  if (!ev && form.repeat.value === '1') {
    const f = form.freq.value;
    const rule = f === 'BIWEEKLY' ? 'FREQ=WEEKLY;INTERVAL=2' : 'FREQ=' + f;
    body.recurrence = ['RRULE:' + rule + untilRule(form.until.value, allDay)];
  }
  try {
    setStatus('저장 중…');
    if (ev) await api(`${calPath()}/events/${encodeURIComponent(ev.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    else await api(`${calPath()}/events`, { method: 'POST', body: JSON.stringify(body) });
    dialog.close();
    state.selected = date;
    await refresh();
  } catch (err) { setStatus('저장 실패: ' + err.message); }
});

$('#delete').onclick = async () => {
  const ev = state.editing;
  if (!ev || !confirm(ev.recurring ? '이 날짜의 일정만 지울까요?' : '이 일정을 지울까요?')) return;
  try {
    await api(`${calPath()}/events/${encodeURIComponent(ev.id)}`, { method: 'DELETE' });
    dialog.close();
    await refresh();
  } catch (err) { setStatus('삭제 실패: ' + err.message); }
};
$('#cancel').onclick = () => dialog.close();

// ---------- 초기 일정 넣기 (seed.js가 있을 때만, 로컬에서 한 번) ----------
async function runSeed() {
  const seed = window.HOYEON_SEED;
  if (!seed || !confirm(`초기 일정 ${seed.length}개를 '${CAL_NAME}' 캘린더에 넣을까요? 이미 넣은 건 건너뛰어요.`)) return;
  const all = await api(`${calPath()}/events?maxResults=2500&showDeleted=false`);
  const have = new Set(all.items.map((e) => priv(e).seedId).filter(Boolean));
  let added = 0;
  for (const s of seed) {
    if (have.has(s.seedId)) continue;
    const { seedId, type, group, owner = 'me', series, seriesTotal, exceptions, ...rest } = s;
    const p = { type, owner, status: 'confirmed', seedId };
    if (group) p.group = group;
    if (series) { p.series = series; p.seriesTotal = String(seriesTotal); }
    const created = await api(`${calPath()}/events`, { method: 'POST',
      body: JSON.stringify({ ...rest, colorId: COLOR_ID[type], extendedProperties: { private: p } }) });
    for (const x of exceptions || []) await applyException(created.id, x);
    added++;
    setStatus(`넣는 중… ${added}`);
  }
  setStatus(`${added}개 넣었어요`);
  await refresh();
}
async function applyException(eventId, x) {
  const q = new URLSearchParams({ timeMin: new Date(x.date + 'T00:00:00+09:00').toISOString(),
    timeMax: new Date(x.date + 'T23:59:59+09:00').toISOString() });
  const res = await api(`${calPath()}/events/${encodeURIComponent(eventId)}/instances?${q}`);
  for (const inst of res.items) {
    await api(`${calPath()}/events/${encodeURIComponent(inst.id)}`, { method: 'PATCH', body: JSON.stringify({
      start: { dateTime: `${x.date}T${x.start}:00`, timeZone: TZ },
      end: { dateTime: `${x.date}T${x.end}:00`, timeZone: TZ } }) });
  }
}

// ---------- 시작 ----------
function setStatus(s) { $('#status').textContent = s; }
async function refresh() {
  try { await fetchEvents(); } catch (err) { setStatus(err.message); }
  render();
}
async function start() {
  try { await ensureCalendar(); } catch (err) { setStatus(err.message); return; }
  $('#seed').hidden = !window.HOYEON_SEED;
  await refresh();
}
function go(delta) {
  const d = new Date(state.year, state.month + delta, 1);
  state.year = d.getFullYear(); state.month = d.getMonth();
  if (tokenValid()) refresh(); else render();
}

(function init() {
  const now = new Date();
  // MVP 범위는 2026년 11·12월: 그 전이면 11월부터 보여 줘요
  const first = now < new Date(2026, 10, 1) ? new Date(2026, 10, 1) : now;
  state.year = first.getFullYear(); state.month = first.getMonth();
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  $('#today').onclick = () => { const n = new Date(); state.year = n.getFullYear(); state.month = n.getMonth(); state.selected = ymd(n); go(0); $('#sheet').hidden = false; };
  $('#login').onclick = () => tokenClient && tokenClient.requestAccessToken({ prompt: state.token ? '' : 'consent' });
  $('#seed').onclick = () => runSeed().catch((err) => setStatus('초기 일정 실패: ' + err.message));
  $('#add').onclick = () => openForm(null);
  $('#sheet-close').onclick = () => { state.selected = null; $('#sheet').hidden = true; render(); };
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();
