const http = require('http');
const crypto = require('crypto');
const tcb = require('@cloudbase/node-sdk');

const ENV_ID = 'interview-booking-d6d8ru0aa2e0c1';
const PORT = 9000;
const CAPACITY = 2;

if (!process.env.CLOUDBASE_APIKEY) {
  console.warn('CLOUDBASE_APIKEY is not configured. Database access will fail until it is set.');
}

const app = tcb.init({
  env: ENV_ID,
  accessKey: process.env.CLOUDBASE_APIKEY,
});
const db = app.database();

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

function send(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-admin-key',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
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

function first(result) {
  const data = result && result.data;
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('BODY_TOO_LARGE');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error('INVALID_JSON');
  }
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
    return {
      time,
      used,
      remaining: Math.max(0, CAPACITY - used),
      full: used >= CAPACITY,
    };
  });
}

async function createBooking({ grade, name, date, time }) {
  name = normalizeName(name);
  if (!SCHEDULE[grade] || !name || !isValidBooking(grade, date, time)) {
    const e = new Error('INVALID_BOOKING');
    e.code = 'INVALID_BOOKING';
    throw e;
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

    let student = null;
    try {
      student = first(await studentRef.get());
    } catch (_) {}

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

    let slot = null;
    try {
      slot = first(await slotRef.get());
    } catch (_) {}

    const count = Number((slot && slot.count) || 0);
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

function adminAuthorized(req) {
  const configured = process.env.ADMIN_KEY;
  if (!configured) return { ok: false, reason: 'ADMIN_KEY_NOT_CONFIGURED' };
  const provided = req.headers['x-admin-key'];
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
    let existing = null;
    try {
      existing = first(await db.collection('students').doc(id).get());
    } catch (_) {}

    if (existing) {
      await db.collection('students').doc(id).update({
        name: s.name,
        grade: s.grade,
        active: true,
        updatedAt: now,
      });
    } else {
      await db.collection('students').doc(id).set({
        name: s.name,
        grade: s.grade,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return { imported: cleaned.length };
}

async function listBookings() {
  const result = await db.collection('bookings').limit(500).get();
  return (result.data || [])
    .map((x) => ({
      id: x._id,
      grade: x.grade,
      name: x.name,
      date: x.date,
      time: x.time,
      createdAt: x.createdAt,
    }))
    .sort((a, b) =>
      `${a.date} ${a.time} ${a.grade} ${a.name}`
        .localeCompare(`${b.date} ${b.time} ${b.grade} ${b.name}`, 'zh-CN')
    );
}

async function listUnbooked() {
  const result = await db.collection('students')
    .where({ active: true })
    .limit(500)
    .get();

  return (result.data || [])
    .filter((x) => !x.bookingId)
    .map((x) => ({ grade: x.grade, name: x.name }))
    .sort((a, b) => `${a.grade}${a.name}`.localeCompare(`${b.grade}${b.name}`, 'zh-CN'));
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});

  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action') || 'health';

  try {
    if (req.method === 'GET' && action === 'health') {
      return send(res, 200, { ok: true, capacity: CAPACITY, envId: ENV_ID });
    }

    if (req.method === 'GET' && action === 'schedule') {
      return send(res, 200, { ok: true, schedule: SCHEDULE, capacity: CAPACITY });
    }

    if (req.method === 'GET' && action === 'students') {
      const grade = url.searchParams.get('grade');
      if (!SCHEDULE[grade]) return send(res, 400, { ok: false, error: 'INVALID_GRADE' });
      return send(res, 200, { ok: true, students: await getStudents(grade) });
    }

    if (req.method === 'GET' && action === 'slots') {
      const grade = url.searchParams.get('grade');
      const date = url.searchParams.get('date');
      if (!SCHEDULE[grade] || !date) {
        return send(res, 400, { ok: false, error: 'INVALID_PARAMS' });
      }
      return send(res, 200, { ok: true, slots: await getSlots(grade, date) });
    }

    const body = req.method === 'POST' ? await readJson(req) : {};

    if (req.method === 'POST' && (body.action || action) === 'book') {
      const result = await createBooking(body);
      return send(res, 200, { ok: true, ...result });
    }

    const resolvedAction = body.action || action;

    if (resolvedAction.startsWith('admin-')) {
      const auth = adminAuthorized(req);
      if (!auth.ok) {
        return send(res, auth.reason === 'ADMIN_KEY_NOT_CONFIGURED' ? 503 : 401, {
          ok: false,
          error: auth.reason,
        });
      }

      if (req.method === 'POST' && resolvedAction === 'admin-import') {
        return send(res, 200, { ok: true, ...(await importStudents(body.students)) });
      }

      if (req.method === 'GET' && resolvedAction === 'admin-bookings') {
        const bookings = await listBookings();
        return send(res, 200, { ok: true, bookings, count: bookings.length });
      }

      if (req.method === 'GET' && resolvedAction === 'admin-unbooked') {
        const students = await listUnbooked();
        return send(res, 200, { ok: true, students, count: students.length });
      }
    }

    return send(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (err) {
    const code = err.code || err.message || 'INTERNAL_ERROR';

    if (code === 'SLOT_FULL') {
      return send(res, 409, { ok: false, error: code, message: '这个时间段刚刚已经满了，请选择其他时间。' });
    }
    if (code === 'ALREADY_BOOKED') {
      return send(res, 409, {
        ok: false,
        error: code,
        message: '你已经预约过面试时间。',
        booking: err.booking || null,
      });
    }
    if (code === 'STUDENT_NOT_FOUND') {
      return send(res, 404, { ok: false, error: code, message: '报名名单中没有找到该姓名，请联系管理员。' });
    }
    if (code === 'INVALID_BOOKING') {
      return send(res, 400, { ok: false, error: code, message: '年级、日期或时间不正确。' });
    }
    if (code === 'INVALID_JSON') {
      return send(res, 400, { ok: false, error: code, message: '请求数据格式错误。' });
    }

    console.error(err);
    return send(res, 500, { ok: false, error: 'INTERNAL_ERROR', message: '系统暂时繁忙，请稍后再试。' });
  }
}

const server = http.createServer(handle);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`interview-api listening on ${PORT}`);
});
