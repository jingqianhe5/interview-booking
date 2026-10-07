const tcb = require('@cloudbase/node-sdk');
const crypto = require('crypto');

const app = tcb.init({ env: tcb.SYMBOL_DEFAULT_ENV });
const db = app.database();

const CAPACITY = 2;
const SCHEDULE = {
  '大二': {
    dates: ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'],
    step: 5,
    windows: [['14:30', '17:00'], ['19:30', '21:30']],
  },
  '大一': {
    dates: ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'],
    step: 10,
    windows: [['14:30', '17:00'], ['19:30', '21:30']],
  },
};

let collectionsReady;

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-admin-key',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(data),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  } catch (_) {
    return {};
  }
}

function one(result) {
  const data = result && result.data;
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function makeId(prefix, ...parts) {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)}`;
}

function minutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function hhmm(total) {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function buildSlots(grade, date) {
  const cfg = SCHEDULE[grade];
  if (!cfg || !cfg.dates.includes(date)) return [];
  const slots = [];
  for (const [start, end] of cfg.windows) {
    for (let t = minutes(start); t < minutes(end); t += cfg.step) {
      slots.push(`${hhmm(t)}-${hhmm(t + cfg.step)}`);
    }
  }
  return slots;
}

function isValidBooking(grade, date, time) {
  return buildSlots(grade, date).includes(time);
}

async function ensureCollections() {
  if (collectionsReady) return collectionsReady;
  collectionsReady = (async () => {
    for (const name of ['students', 'slots', 'bookings']) {
      try {
        await db.createCollection(name);
      } catch (_) {
        // Existing collections may raise an error; safe to ignore.
      }
    }
  })();
  return collectionsReady;
}

async function getStudents(grade) {
  const result = await db.collection('students')
    .where({ grade, active: true })
    .limit(500)
    .get();
  return (result.data || [])
    .map((x) => ({ name: x.name, booked: Boolean(x.bookingId) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

async function getSlots(grade, date) {
  const valid = buildSlots(grade, date);
  if (!valid.length) return [];
  const result = await db.collection('slots')
    .where({ grade, date })
    .limit(200)
    .get();
  const counts = new Map((result.data || []).map((x) => [x.time, Number(x.count || 0)]));
  return valid.map((time) => {
    const used = counts.get(time) || 0;
    return { time, used, remaining: Math.max(0, CAPACITY - used), full: used >= CAPACITY };
  });
}

async function createBooking({ grade, name, date, time }) {
  name = normalizeName(name);
  if (!SCHEDULE[grade] || !name || !isValidBooking(grade, date, time)) {
    const err = new Error('INVALID_BOOKING');
    err.code = 'INVALID_BOOKING';
    throw err;
  }

  const studentId = makeId('stu', grade, name);
  const slotId = makeId('slot', grade, date, time);
  const bookingId = makeId('bk', grade, name);
  const now = new Date();
  const booking = { grade, name, date, time };

  await db.runTransaction(async (tx) => {
    const studentRef = tx.collection('students').doc(studentId);
    const slotRef = tx.collection('slots').doc(slotId);
    const bookingRef = tx.collection('bookings').doc(bookingId);

    const studentRes = await studentRef.get();
    const student = one(studentRes);
    if (!student || !student.active || student.grade !== grade || student.name !== name) {
      const e = new Error('STUDENT_NOT_FOUND');
      e.code = 'STUDENT_NOT_FOUND';
      throw e;
    }
    if (student.bookingId) {
      const e = new Error('ALREADY_BOOKED');
      e.code = 'ALREADY_BOOKED';
      e.booking = student.booking || null;
      throw e;
    }

    const slotRes = await slotRef.get();
    const slot = one(slotRes) || { count: 0 };
    const count = Number(slot.count || 0);
    if (count >= CAPACITY) {
      const e = new Error('SLOT_FULL');
      e.code = 'SLOT_FULL';
      throw e;
    }

    await slotRef.set({
      grade,
      date,
      time,
      count: count + 1,
      capacity: CAPACITY,
      updatedAt: now,
    });

    await bookingRef.set({
      ...booking,
      studentId,
      createdAt: now,
    });

    await studentRef.update({
      bookingId,
      booking,
      bookedAt: now,
    });
  });

  return { bookingId, booking };
}

function requireAdmin(event) {
  const configured = process.env.ADMIN_KEY;
  if (!configured) return { ok: false, reason: 'ADMIN_KEY_NOT_CONFIGURED' };
  const headers = event.headers || {};
  const provided = headers['x-admin-key'] || headers['X-Admin-Key'] || headers['X-ADMIN-KEY'];
  if (provided !== configured) return { ok: false, reason: 'UNAUTHORIZED' };
  return { ok: true };
}

async function importStudents(items) {
  if (!Array.isArray(items)) throw new Error('INVALID_STUDENTS');
  const cleaned = [];
  const seen = new Set();
  for (const item of items) {
    const grade = String(item.grade || '').trim();
    const name = normalizeName(item.name);
    if (!SCHEDULE[grade] || !name) continue;
    const key = `${grade}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ grade, name });
  }
  if (!cleaned.length) throw new Error('NO_VALID_STUDENTS');

  const now = new Date();
  for (const s of cleaned) {
    const id = makeId('stu', s.grade, s.name);
    const existing = await db.collection('students').doc(id).get();
    if (one(existing)) {
      await db.collection('students').doc(id).update({ name: s.name, grade: s.grade, active: true, updatedAt: now });
    } else {
      await db.collection('students').doc(id).set({ name: s.name, grade: s.grade, active: true, createdAt: now, updatedAt: now });
    }
  }
  return { imported: cleaned.length };
}

async function listBookings() {
  const result = await db.collection('bookings').limit(500).get();
  return (result.data || [])
    .map((x) => ({ id: x._id, grade: x.grade, name: x.name, date: x.date, time: x.time, createdAt: x.createdAt }))
    .sort((a, b) => `${a.date} ${a.time} ${a.grade} ${a.name}`.localeCompare(`${b.date} ${b.time} ${b.grade} ${b.name}`, 'zh-CN'));
}

async function listUnbooked() {
  const result = await db.collection('students').where({ active: true }).limit(500).get();
  return (result.data || [])
    .filter((x) => !x.bookingId)
    .map((x) => ({ grade: x.grade, name: x.name }))
    .sort((a, b) => `${a.grade}${a.name}`.localeCompare(`${b.grade}${b.name}`, 'zh-CN'));
}

exports.main = async (event) => {
  if ((event.httpMethod || '').toUpperCase() === 'OPTIONS') return json(204, {});

  await ensureCollections();

  const method = (event.httpMethod || 'GET').toUpperCase();
  const q = event.queryStringParameters || {};
  const body = method === 'POST' ? parseBody(event) : {};
  const action = String(q.action || body.action || 'health');

  try {
    if (method === 'GET' && action === 'health') {
      return json(200, { ok: true, capacity: CAPACITY });
    }

    if (method === 'GET' && action === 'schedule') {
      return json(200, { ok: true, schedule: SCHEDULE, capacity: CAPACITY });
    }

    if (method === 'GET' && action === 'students') {
      if (!SCHEDULE[q.grade]) return json(400, { ok: false, error: 'INVALID_GRADE' });
      return json(200, { ok: true, students: await getStudents(q.grade) });
    }

    if (method === 'GET' && action === 'slots') {
      if (!SCHEDULE[q.grade] || !q.date) return json(400, { ok: false, error: 'INVALID_PARAMS' });
      return json(200, { ok: true, slots: await getSlots(q.grade, q.date) });
    }

    if (method === 'POST' && action === 'book') {
      const result = await createBooking(body);
      return json(200, { ok: true, ...result });
    }

    if (action.startsWith('admin-')) {
      const auth = requireAdmin(event);
      if (!auth.ok) return json(auth.reason === 'ADMIN_KEY_NOT_CONFIGURED' ? 503 : 401, { ok: false, error: auth.reason });

      if (method === 'POST' && action === 'admin-import') {
        return json(200, { ok: true, ...(await importStudents(body.students)) });
      }
      if (method === 'GET' && action === 'admin-bookings') {
        const bookings = await listBookings();
        return json(200, { ok: true, bookings, count: bookings.length });
      }
      if (method === 'GET' && action === 'admin-unbooked') {
        const students = await listUnbooked();
        return json(200, { ok: true, students, count: students.length });
      }
    }

    return json(404, { ok: false, error: 'NOT_FOUND' });
  } catch (err) {
    const code = err.code || err.message || 'INTERNAL_ERROR';
    if (code === 'SLOT_FULL') return json(409, { ok: false, error: code, message: '这个时间段刚刚已经满了，请选择其他时间。' });
    if (code === 'ALREADY_BOOKED') return json(409, { ok: false, error: code, message: '你已经预约过面试时间。', booking: err.booking || null });
    if (code === 'STUDENT_NOT_FOUND') return json(404, { ok: false, error: code, message: '报名名单中没有找到该姓名，请联系管理员。' });
    if (code === 'INVALID_BOOKING') return json(400, { ok: false, error: code, message: '年级、日期或时间不正确。' });
    console.error(err);
    return json(500, { ok: false, error: 'INTERNAL_ERROR', message: '系统暂时繁忙，请稍后再试。' });
  }
};
