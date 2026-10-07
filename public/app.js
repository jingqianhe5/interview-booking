const API = window.INTERVIEW_API_BASE || '/api/interview';

const state = { grade: '', name: '', date: '', time: '', schedule: null, students: [] };
const els = {
  gradeChoices: document.querySelector('#gradeChoices'),
  nameBlock: document.querySelector('#nameBlock'),
  namePicker: document.querySelector('#namePicker'),
  nameSearch: document.querySelector('#nameSearch'),
  nameOptions: document.querySelector('#nameOptions'),
  nameHelp: document.querySelector('#nameHelp'),
  dateBlock: document.querySelector('#dateBlock'),
  dateChoices: document.querySelector('#dateChoices'),
  dateHint: document.querySelector('#dateHint'),
  slotBlock: document.querySelector('#slotBlock'),
  slotChoices: document.querySelector('#slotChoices'),
  summary: document.querySelector('#summary'),
  submitBtn: document.querySelector('#submitBtn'),
  notice: document.querySelector('#notice'),
  sumGrade: document.querySelector('#sumGrade'),
  sumName: document.querySelector('#sumName'),
  sumDate: document.querySelector('#sumDate'),
  sumTime: document.querySelector('#sumTime'),
};

function showNotice(message, type = '') {
  els.notice.textContent = message;
  els.notice.className = `notice ${type}`.trim();
  els.notice.hidden = false;
}
function clearNotice() { els.notice.hidden = true; }

function fmtDate(v) {
  const [, m, d] = v.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function weekday(v) {
  return ['周日','周一','周二','周三','周四','周五','周六'][new Date(`${v}T00:00:00+08:00`).getDay()];
}

async function request(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || data.error || '请求失败');
    e.payload = data;
    throw e;
  }
  return data;
}

function updateSummary() {
  const done = state.grade && state.name && state.date && state.time;
  els.summary.hidden = !done;
  els.submitBtn.disabled = !done;
  if (!done) return;
  els.sumGrade.textContent = state.grade;
  els.sumName.textContent = state.name;
  els.sumDate.textContent = fmtDate(state.date);
  els.sumTime.textContent = state.time;
}

async function loadSchedule() {
  try {
    const data = await request(`${API}?action=schedule`);
    state.schedule = data.schedule;
  } catch (e) {
    showNotice('系统配置暂时无法加载，请稍后刷新。', 'error');
  }
}

function resetAfterName() {
  state.date = '';
  state.time = '';
  els.dateBlock.hidden = true;
  els.slotBlock.hidden = true;
  updateSummary();
}

function chooseName(student) {
  if (!student || student.booked) {
    if (student?.booked) showNotice('这个姓名已经完成预约，如需修改请联系负责人。', 'error');
    return;
  }
  clearNotice();
  state.name = student.name;
  els.nameSearch.value = student.name;
  els.nameOptions.hidden = true;
  resetAfterName();
  renderDates();
}

function renderNameOptions(query = '') {
  const q = query.trim();
  const all = state.students || [];
  const matched = all
    .filter((s) => !q || s.name.includes(q))
    .sort((a, b) => {
      const aStarts = q && a.name.startsWith(q) ? 0 : 1;
      const bStarts = q && b.name.startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

  const shown = matched.slice(0, q ? 30 : 12);
  if (!shown.length) {
    els.nameOptions.innerHTML = '<div class="name-empty">没有找到匹配的姓名</div>';
  } else {
    els.nameOptions.innerHTML = shown.map((s) => `
      <button type="button" class="name-option ${s.booked ? 'booked' : ''}" data-name="${escapeHtml(s.name)}" ${s.booked ? 'disabled' : ''}>
        <span>${escapeHtml(s.name)}</span>
        <small>${s.booked ? '已预约' : '选择'}</small>
      </button>`).join('');
  }

  els.nameOptions.hidden = false;
  const suffix = matched.length > shown.length ? `，当前显示前 ${shown.length} 个` : '';
  els.nameHelp.textContent = q
    ? `找到 ${matched.length} 个匹配结果${suffix}`
    : `本年级共 ${all.length} 人，输入姓名关键词可快速筛选`;

  els.nameOptions.querySelectorAll('.name-option:not(:disabled)').forEach((btn) => {
    btn.addEventListener('click', () => {
      const student = all.find((s) => s.name === btn.dataset.name);
      chooseName(student);
    });
  });
}

async function chooseGrade(grade) {
  clearNotice();
  state.grade = grade;
  state.name = '';
  state.date = '';
  state.time = '';
  state.students = [];
  document.querySelectorAll('[data-grade]').forEach((b) => b.classList.toggle('active', b.dataset.grade === grade));
  els.nameBlock.hidden = false;
  els.dateBlock.hidden = true;
  els.slotBlock.hidden = true;
  els.nameSearch.value = '';
  els.nameSearch.placeholder = '正在加载名单…';
  els.nameSearch.disabled = true;
  els.nameOptions.hidden = true;
  els.nameHelp.textContent = '';
  updateSummary();

  try {
    const data = await request(`${API}?action=students&grade=${encodeURIComponent(grade)}`);
    state.students = data.students || [];
    els.nameSearch.disabled = false;
    els.nameSearch.placeholder = '输入姓名搜索，例如：陈';
    if (!state.students.length) {
      els.nameHelp.textContent = '当前年级还没有可用名单';
      showNotice('管理员还没有导入这个年级的报名名单。', 'error');
      return;
    }
    renderNameOptions('');
    els.nameSearch.focus();
  } catch (e) {
    els.nameSearch.placeholder = '名单加载失败';
    els.nameHelp.textContent = '';
    showNotice(e.message, 'error');
  }
}

function renderDates() {
  const cfg = state.schedule?.[state.grade];
  if (!cfg || !state.name) return;
  els.dateHint.textContent = state.grade === '大二' ? '每场 5 分钟' : '每场 10 分钟';
  els.dateChoices.innerHTML = cfg.dates.map((d) => `<button type="button" data-date="${d}"><strong>${fmtDate(d)}</strong><br><small>${weekday(d)}</small></button>`).join('');
  els.dateBlock.hidden = false;
  els.slotBlock.hidden = true;
  els.dateChoices.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => chooseDate(btn.dataset.date)));
}

async function chooseDate(date) {
  clearNotice();
  state.date = date;
  state.time = '';
  els.dateChoices.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.date === date));
  els.slotBlock.hidden = false;
  els.slotChoices.innerHTML = '<div class="muted">正在加载剩余名额…</div>';
  updateSummary();

  try {
    const data = await request(`${API}?action=slots&grade=${encodeURIComponent(state.grade)}&date=${encodeURIComponent(date)}`);
    els.slotChoices.innerHTML = (data.slots || []).map((s) => `
      <button type="button" class="slot" data-time="${s.time}" ${s.full ? 'disabled' : ''}>
        <strong>${s.time}</strong>
        <small>${s.full ? '已满' : `剩余 ${s.remaining} 个名额`}</small>
      </button>`).join('');
    els.slotChoices.querySelectorAll('.slot:not(:disabled)').forEach((btn) => btn.addEventListener('click', () => {
      state.time = btn.dataset.time;
      els.slotChoices.querySelectorAll('.slot').forEach((b) => b.classList.toggle('active', b === btn));
      updateSummary();
    }));
  } catch (e) {
    els.slotChoices.innerHTML = '';
    showNotice(e.message, 'error');
  }
}

els.gradeChoices.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-grade]');
  if (btn) chooseGrade(btn.dataset.grade);
});

els.nameSearch.addEventListener('focus', () => {
  if (state.students.length) renderNameOptions(els.nameSearch.value);
});

els.nameSearch.addEventListener('input', () => {
  const typed = els.nameSearch.value.trim();
  if (typed !== state.name) {
    state.name = '';
    resetAfterName();
  }
  renderNameOptions(typed);
});

els.nameSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = els.nameSearch.value.trim();
  const firstAvailable = state.students.find((s) => !s.booked && s.name.includes(q));
  if (firstAvailable) chooseName(firstAvailable);
});

document.addEventListener('click', (e) => {
  if (!els.namePicker.contains(e.target)) els.nameOptions.hidden = true;
});

els.submitBtn.addEventListener('click', async () => {
  if (!(state.grade && state.name && state.date && state.time)) return;
  clearNotice();
  els.submitBtn.disabled = true;
  els.submitBtn.textContent = '正在提交…';
  try {
    const data = await request(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'book', grade: state.grade, name: state.name, date: state.date, time: state.time }),
    });
    const b = data.booking;
    document.querySelector('.form-card').innerHTML = `
      <div class="success-screen">
        <div class="success-mark">✓</div>
        <h2>预约成功</h2>
        <p>${escapeHtml(b.name)}，你的面试时间已锁定。</p>
        <div class="success-booking"><strong>${fmtDate(b.date)} · ${escapeHtml(b.time)}</strong><span>${escapeHtml(b.grade)}</span></div>
        <p class="muted">请提前到场。如需调整时间，请联系招新负责人。</p>
      </div>`;
  } catch (e) {
    const p = e.payload || {};
    showNotice(p.message || e.message, 'error');
    if (p.error === 'SLOT_FULL') await chooseDate(state.date);
    els.submitBtn.disabled = false;
    els.submitBtn.textContent = '确认预约';
  }
});

function escapeHtml(v) {
  return String(v).replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

loadSchedule();
