const API = window.INTERVIEW_API_BASE || '/api/interview';
const keyInput = document.querySelector('#adminKey');
const keyStatus = document.querySelector('#keyStatus');
const importResult = document.querySelector('#importResult');
let cachedBookings = [];

keyInput.value = localStorage.getItem('interview_admin_key') || '';
if (keyInput.value) keyStatus.textContent = '已从本机保存的密钥中载入';

document.querySelector('#saveKey').addEventListener('click', () => {
  localStorage.setItem('interview_admin_key', keyInput.value.trim());
  keyStatus.textContent = '已保存到当前浏览器';
});

function adminHeaders(extra = {}) {
  return { 'x-admin-key': keyInput.value.trim(), ...extra };
}

async function request(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts, headers: adminHeaders(opts.headers || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || '请求失败');
  return data;
}

function showBox(el, text, type = '') {
  el.textContent = text;
  el.className = `notice ${type}`.trim();
  el.hidden = false;
}

function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((x) => x.trim());
  if (lines.length < 2) return [];
  const split = (line) => {
    const out = []; let cur = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
      } else if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = split(lines[0]);
  const nameIndex = headers.findIndex((x) => /姓名|名字|name/i.test(x));
  const gradeIndex = headers.findIndex((x) => /年级|grade/i.test(x));
  if (nameIndex < 0 || gradeIndex < 0) throw new Error('CSV 中没有找到「姓名」和「年级」两列');
  return lines.slice(1).map(split).map((row) => ({ name: row[nameIndex] || '', grade: normalizeGrade(row[gradeIndex] || '') })).filter((x) => x.name && x.grade);
}

function normalizeGrade(v) {
  const s = String(v).trim();
  if (/大一|一年级|2026/.test(s)) return '大一';
  if (/大二|二年级|2025/.test(s)) return '大二';
  return s === '大一' || s === '大二' ? s : '';
}

document.querySelector('#importBtn').addEventListener('click', async () => {
  const file = document.querySelector('#csvFile').files[0];
  if (!file) return showBox(importResult, '请先选择 CSV 文件。', 'error');
  try {
    const students = parseCSV(await file.text());
    if (!students.length) throw new Error('没有解析到有效的学生记录');
    const data = await request(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'admin-import', students }),
    });
    showBox(importResult, `导入完成，共 ${data.imported} 人。`, 'success');
    await refresh();
  } catch (e) {
    showBox(importResult, e.message, 'error');
  }
});

async function refresh() {
  try {
    const [booked, unbooked] = await Promise.all([
      request(`${API}?action=admin-bookings`),
      request(`${API}?action=admin-unbooked`),
    ]);
    cachedBookings = booked.bookings || [];
    document.querySelector('#bookedCount').textContent = booked.count;
    document.querySelector('#unbookedCount').textContent = unbooked.count;
    const tbody = document.querySelector('#bookingRows');
    tbody.innerHTML = cachedBookings.length ? cachedBookings.map((b) => `<tr><td>${esc(b.grade)}</td><td>${esc(b.name)}</td><td>${esc(b.date)}</td><td>${esc(b.time)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">暂无预约</td></tr>';
    const list = document.querySelector('#unbookedList');
    list.innerHTML = unbooked.students.length ? unbooked.students.map((s) => `<span class="pill">${esc(s.grade)} · ${esc(s.name)}</span>`).join('') : '<span class="muted">全部人员均已预约</span>';
  } catch (e) {
    alert(e.message);
  }
}

document.querySelector('#refreshBtn').addEventListener('click', refresh);

document.querySelector('#exportBtn').addEventListener('click', () => {
  if (!cachedBookings.length) return alert('当前没有可导出的预约数据');
  const rows = [['年级','姓名','日期','时间'], ...cachedBookings.map((b) => [b.grade,b.name,b.date,b.time])];
  const csv = '\uFEFF' + rows.map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `面试预约_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
