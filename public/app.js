const API = window.INTERVIEW_API_BASE || '/api/interview';

const state = { grade: '', name: '', date: '', time: '', schedule: null };
const els = {
  gradeChoices: document.querySelector('#gradeChoices'),
  nameBlock: document.querySelector('#nameBlock'),
  nameSelect: document.querySelector('#nameSelect'),
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
  const [y, m, d] = v.split('-');
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

async function chooseGrade(grade) {
  clearNotice();
  state.grade = grade;
  state.name = '';
  state.date = '';
  state.time = '';
  document.querySelectorAll('[data-grade]').forEach((b) => b.classList.toggle('active', b.dataset.grade === grade));
  els.nameBlock.hidden = false;
  els.dateBlock.hidden = true;
  els.slotBlock.hidden = true;
  els.nameSelect.innerHTML = '<option value="">正在加载名单…</option>';
  updateSummary();

  try {
    const data = await request(`${API}?action=students&grade=${encodeURIComponent(grade)}`);
    const available = data.students || [];
    els.nameSelect.innerHTML = '<option value="">请选择你的姓名</option>' + available.map((s) => {
      const label = s.booked ? `${s.name}（已预约）` : s.name;
      return `<option value="${escapeHtml(s.name)}">${escapeHtml(label)}</option>`;
    }).join('');
    if (!available.length) showNotice('管理员还没有导入这个年级的报名名单。', 'error');
  } catch (e) {
    els.nameSelect.innerHTML = '<option value="">名单加载失败</option>';
    showNotice(e.message, 'error');
  }
}

function renderDates() {
  const cfg = state.schedule?.[state.grade];
  if (!cfg) return;
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

els.nameSelect.addEventListener('change', () => {
  state.name = els.nameSelect.value;
  state.date = '';
  state.time = '';
  els.slotBlock.hidden = true;
  if (state.name) renderDates(); else els.dateBlock.hidden = true;
  updateSummary();
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
