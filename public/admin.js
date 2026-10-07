const API = window.INTERVIEW_API_BASE || '/api/interview';
const keyInput = document.querySelector('#adminKey');
const keyStatus = document.querySelector('#keyStatus');
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

async function refresh() {
  try {
    const [health, booked, unbooked] = await Promise.all([
      request(`${API}?action=health`),
      request(`${API}?action=admin-bookings`),
      request(`${API}?action=admin-unbooked`),
    ]);
    document.querySelector('#rosterCount').textContent = health.roster?.total ?? '-';
    document.querySelector('#gradeCounts').textContent = health.roster ? `${health.roster.freshman} / ${health.roster.sophomore}` : '-';
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
