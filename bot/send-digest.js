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
  const notif = { hot: n.hot !== false, soon10: n.soon10 !== false, overdue: n.overdue !== false, waiting: n.waiting !== false };
  const tg = (state.settings && state.settings.tg) || {};

  // Группируем по владельцу: каждому — свой блок (сразу видно «где мои, где твои»)
  const byOwner = {};
  const bucket = o => byOwner[o] || (byOwner[o] = { overdue: [], hot: [], soon10: [], waiting: [] });

  (state.projects || []).filter(p => !p.archived).forEach(p => {
    (p.subs || []).forEach(s => {
      if (s.status === 'paused' || s.status === 'closed') return;
      const g = bucket(p.owner);
      if (s.end) {
        const d = daysTo(s.end);
        if (notif.overdue && d < 0) g.overdue.push(`• ${s.svc} — ${p.name}, было ${fmt(s.end)}`);
        else if (notif.hot && d >= 0 && isHotToday(s.end)) g.hot.push(`• ${s.svc} — ${p.name} — оплатить до ${fmtDate(payDeadline(s.end))}`);
        else if (notif.soon10 && d >= 8 && d <= 10) g.soon10.push(`• ${s.svc} — ${p.name} — через ${d} дн., ${fmt(s.end)}`);
      }
      if (notif.waiting && s.status === 'waiting') g.waiting.push(`• ${s.svc} — ${p.name}`);
    });
  });

  const dateLabel = `${today.getUTCDate()} ${MON[today.getUTCMonth()]}`;
  const parts = [`🔔 <b>BYbank — оплаты на ${dateLabel}</b>`];
  let hasAny = false;

  ['yulia', 'masha'].forEach(o => {
    const g = byOwner[o]; if (!g) return;
    if (!(g.overdue.length + g.hot.length + g.soon10.length + g.waiting.length)) return;
    hasAny = true;
    const handle = tg[o] ? String(tg[o]).replace(/^@?/, '@') : '';
    const sub = [`\n━━━━━━━━━━━━\n👤 <b>${NAMES[o] || ''}${handle ? ' ' + handle : ''}</b>`];
    if (g.overdue.length) sub.push(`⚠ <b>Просрочено:</b>\n` + g.overdue.join('\n'));
    if (g.hot.length)     sub.push(`🔥 <b>Очень-очень пора платить (2 дн):</b>\n` + g.hot.join('\n'));
    if (g.soon10.length)  sub.push(`📌 <b>Пора платить (10 дн):</b>\n` + g.soon10.join('\n'));
    if (g.waiting.length) sub.push(`📨 <b>Ждём оплату клиента:</b>\n` + g.waiting.join('\n'));
    parts.push(sub.join('\n\n'));
  });

  if (!hasAny) return null;   // тихий день — не шлём ничего
  return parts.join('\n');
}

// Диагностика источника данных (видна в сообщении, пока отлаживаем)
let SOURCE = 'data.json';
let SRCERR = '';

// Берём данные из общей базы Supabase; если не получилось — из bot/data.json
async function getState() {
  let url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (!url || !key) { SRCERR = 'нет SUPABASE_URL/KEY в секретах'; return fallback(); }
  url = url.trim().replace(/\/+$/, '');   // убираем пробелы и хвостовой слэш
  key = key.trim();
  try {
    const res = await fetch(`${url}/rest/v1/bybank?id=eq.1&select=data`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const body = await res.text();
    if (!res.ok) { SRCERR = `HTTP ${res.status}: ${body.slice(0, 140)}`; return fallback(); }
    let rows; try { rows = JSON.parse(body); } catch (e) { SRCERR = 'ответ не JSON: ' + body.slice(0, 140); return fallback(); }
    if (Array.isArray(rows) && rows[0] && rows[0].data) { SOURCE = 'Supabase'; return rows[0].data; }
    SRCERR = 'строка id=1 пустая или не найдена (ответ: ' + body.slice(0, 100) + ')';
    return fallback();
  } catch (e) {
    SRCERR = 'сеть/запрос: ' + (e.message || e);
    return fallback();
  }
}
function fallback() { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8')); }

async function main() {
  if (!TOKEN || !CHAT) {
    console.error('Нет BOT_TOKEN или CHAT_ID в секретах. Задай их в Settings → Secrets and variables → Actions.');
    process.exit(1);
  }
  const state = await getState();

  // Если база вдруг не прочиталась — тихо логируем (в сообщение не тащим)
  if (SOURCE !== 'Supabase') console.warn('Источник: запасной файл. Причина:', SRCERR);

  // Тест-режим (кнопка Run workflow → test = true): шлём ПРИМЕР настоящего письма с вашими никами
  if (process.env.TEST === 'true') {
    const tg = (state.settings && state.settings.tg) || {};
    const nick = o => (tg[o] ? String(tg[o]).replace(/^@?/, '@') : '@' + o);
    const y = nick('yulia'), m = nick('masha');
    const text =
      `🧪 <b>BYbank — тест (пример письма)</b>\n` +
      `Так будут выглядеть напоминания — сгруппированы по человеку. Данные выдуманные, для проверки формата.\n` +
      `\n━━━━━━━━━━━━\n👤 <b>Юля ${y}</b>` +
      `\n\n⚠ <b>Просрочено:</b>\n• Ройстат — Марсель, было 02.07.26` +
      `\n\n🔥 <b>Очень-очень пора платить (2 дн):</b>\n• Тильда — EvExperts — оплатить до 05.07.26` +
      `\n\n━━━━━━━━━━━━\n👤 <b>Маша ${m}</b>` +
      `\n\n📌 <b>Пора платить (10 дн):</b>\n• Ройстат — Fortex — через 10 дн., 14.07.26` +
      `\n\n📨 <b>Ждём оплату клиента:</b>\n• Подписка Сергей — Ковролин Ру` +
      `\n\n✅ Бот подключён к общей базе — по будням в 09:00 будет присылать это по вашим реальным оплатам.`;
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

  const digest = buildDigest(state);

  if (!digest) { console.log('Тихий день — ничего горящего, сообщение не отправлено ✅'); return; }
  const text = digest;

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
