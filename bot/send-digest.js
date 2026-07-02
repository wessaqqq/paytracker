// BYbank — умные напоминания об оплатах в Telegram.
// Запускается GitHub Actions по расписанию (09:00 МСК) и вручную.
// Пишет в чат ТОЛЬКО когда есть что-то горящее/просроченное/ждём оплату — иначе молчит.
// Логика учитывает выходные: оплата идёт через бухгалтера и на сб/вс не проходит.
// Секреты из окружения: BOT_TOKEN, CHAT_ID, SUPABASE_URL, SUPABASE_KEY.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
const CHAT  = process.env.CHAT_ID;

const MON = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const NAMES = { yulia: 'Юля', masha: 'Маша' };
const LEAD_BIZ = 2;   // за сколько РАБОЧИХ дней предупреждать

// «Сегодня» по московскому времени (раннер работает в UTC)
const nowMsk = new Date(Date.now() + 3 * 3600 * 1000);
const today = new Date(Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate()));

function isoToUTC(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function daysTo(iso) { return Math.round((isoToUTC(iso) - today) / 86400000); }
function fmt(iso) { const [y, m, d] = iso.split('-').map(Number); return `${String(d).padStart(2,'0')}.${String(m).padStart(2,'0')}.${String(y).slice(2)}`; }
function fmtDate(dt) { return `${String(dt.getUTCDate()).padStart(2,'0')}.${String(dt.getUTCMonth()+1).padStart(2,'0')}.${String(dt.getUTCFullYear()).slice(2)}`; }

// Если оплата выпадает на сб/вс — реальный дедлайн переносим на пятницу (оплатить надо ДО выходных)
function payDeadline(iso) { const d = isoToUTC(iso); const wd = d.getUTCDay(); if (wd === 6) d.setUTCDate(d.getUTCDate() - 1); else if (wd === 0) d.setUTCDate(d.getUTCDate() - 2); return d; }
function minusBiz(dt, n) { const d = new Date(dt); let left = n; while (left > 0) { d.setUTCDate(d.getUTCDate() - 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) left--; } return d; }
// Горит ли сегодня: от «за 2 рабочих дня до дедлайна» и до самого дедлайна
function isHotToday(iso) { const from = minusBiz(payDeadline(iso), LEAD_BIZ); const dl = payDeadline(iso); return today >= from && today <= dl; }

function buildDigest(state) {
  const n = (state.settings && state.settings.notif) || {};
  const notif = { hot: n.hot !== false, overdue: n.overdue !== false, waiting: n.waiting !== false };
  const tg = (state.settings && state.settings.tg) || {};
  const groups = { overdue: [], hot: [], waiting: [] };
  const pinged = new Set();

  (state.projects || []).filter(p => !p.archived).forEach(p => {
    (p.subs || []).forEach(s => {
      if (s.status === 'paused' || s.status === 'closed') return;
      const handle = tg[p.owner] ? String(tg[p.owner]).replace(/^@?/, '@') : '';
      const owner = handle ? `${NAMES[p.owner] || ''} ${handle}` : (NAMES[p.owner] || '');
      if (s.end) {
        const d = daysTo(s.end);
        if (notif.overdue && d < 0) { groups.overdue.push(`• ${s.svc} — ${p.name} (${owner}), было ${fmt(s.end)}`); if (handle) pinged.add(handle); }
        else if (notif.hot && d >= 0 && isHotToday(s.end)) { groups.hot.push(`• ${s.svc} — ${p.name} (${owner}) — оплатить до ${fmtDate(payDeadline(s.end))}`); if (handle) pinged.add(handle); }
      }
      if (notif.waiting && s.status === 'waiting') { groups.waiting.push(`• ${s.svc} — ${p.name} (${owner})`); if (handle) pinged.add(handle); }
    });
  });

  const hasAny = groups.overdue.length + groups.hot.length + groups.waiting.length;
  if (!hasAny) return null;   // тихий день — не шлём ничего

  const dateLabel = `${today.getUTCDate()} ${MON[today.getUTCMonth()]}`;
  const parts = [`🔔 <b>BYbank — что горит на ${dateLabel}</b>`];
  if (groups.overdue.length) parts.push(`\n⚠ <b>Просрочено:</b>\n` + groups.overdue.join('\n'));
  if (groups.hot.length)     parts.push(`\n🔥 <b>Пора платить:</b>\n` + groups.hot.join('\n'));
  if (groups.waiting.length) parts.push(`\n📨 <b>Ждём оплату клиента:</b>\n` + groups.waiting.join('\n'));
  if (pinged.size) parts.push('\n' + [...pinged].join(' ') + ' — проверьте, пожалуйста 🙌');

  return parts.join('\n');
}

// Берём данные из общей базы Supabase; если она не настроена — из bot/data.json
async function getState() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (url && key) {
    try {
      const res = await fetch(`${url}/rest/v1/bybank?id=eq.1&select=data`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      const rows = await res.json();
      if (Array.isArray(rows) && rows[0] && rows[0].data) return rows[0].data;
      console.warn('Supabase: строка не найдена, беру bot/data.json');
    } catch (e) {
      console.warn('Supabase недоступна, беру bot/data.json:', e.message);
    }
  }
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
}

async function main() {
  if (!TOKEN || !CHAT) {
    console.error('Нет BOT_TOKEN или CHAT_ID в секретах. Задай их в Settings → Secrets and variables → Actions.');
    process.exit(1);
  }
  const state = await getState();

  // Тест-режим (кнопка Run workflow → test = true): шлём проверочное сообщение с вашими никами
  if (process.env.TEST === 'true') {
    const tg = (state.settings && state.settings.tg) || {};
    const nick = o => (tg[o] ? String(tg[o]).replace(/^@?/, '@') : '@' + o);
    const text = `✅ <b>BYbank — тест бота</b>\n\nБот на связи и умеет тегать вас лично: ${nick('yulia')} ${nick('masha')}\n\nВ будни в 09:00 сюда будут приходить только 🔥 горящие оплаты и ⚠ просрочки. Если тихо — значит всё под контролем.`;
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const jr = await r.json();
    if (!jr.ok) { console.error('Telegram вернул ошибку:', jr.description); process.exit(1); }
    console.log('Тестовое сообщение отправлено ✅');
    return;
  }

  // Выходные — не беспокоим (оплаты через бухгалтера в сб/вс не проходят, всё срочное ушло в пятницу)
  const wd = today.getUTCDay();
  if (wd === 0 || wd === 6) { console.log('Выходной — напоминания не шлём ✅'); return; }

  const text = buildDigest(state);

  if (!text) { console.log('Тихий день — ничего горящего, сообщение не отправлено ✅'); return; }

  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const j = await res.json();
  if (!j.ok) {
    console.error('Telegram вернул ошибку:', j.description);
    process.exit(1);
  }
  console.log('Напоминание отправлено ✅');
}

main().catch(e => { console.error(e); process.exit(1); });
