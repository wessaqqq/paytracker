// PayFlow — ежедневный дайджест оплат в Telegram.
// Запускается GitHub Actions по расписанию (09:00 МСК) и вручную.
// Читает bot/data.json (экспорт из приложения) и шлёт сообщение в чат.
// Секреты берутся из переменных окружения: BOT_TOKEN и CHAT_ID.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
const CHAT  = process.env.CHAT_ID;

const MON = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const NAMES = { yulia: 'Юля', masha: 'Маша' };

// «Сегодня» по московскому времени (раннер работает в UTC)
const nowMsk = new Date(Date.now() + 3 * 3600 * 1000);
const today = new Date(Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate()));

function daysTo(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return Math.round((t - today) / 86400000);
}
function fmt(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${String(y).slice(2)}`;
}

function buildDigest(state) {
  const notif = (state.settings && state.settings.notif) || { d7: true, d3: true, d1: true, day: true, sent3: true, overdue: true };
  const groups = { overdue: [], today: [], soon: [], waiting: [] };

  (state.projects || []).filter(p => !p.archived).forEach(p => {
    (p.subs || []).forEach(s => {
      if (s.status === 'paused' || s.status === 'closed') return;
      const owner = NAMES[p.owner] || '';
      if (s.end) {
        const d = daysTo(s.end);
        if (notif.overdue && d < 0)      groups.overdue.push(`• ${s.svc} — ${p.name} (${owner}), было ${fmt(s.end)}`);
        else if (notif.day && d === 0)   groups.today.push(`• ${s.svc} — ${p.name} (${owner})`);
        else if (notif.d1 && d === 1)    groups.soon.push(`• завтра — ${s.svc} — ${p.name} (${owner})`);
        else if (notif.d3 && d === 3)    groups.soon.push(`• через 3 дня — ${s.svc} — ${p.name} (${owner})`);
        else if (notif.d7 && d === 7)    groups.soon.push(`• через 7 дней — ${s.svc} — ${p.name} (${owner})`);
      }
      if (notif.sent3 && s.status === 'waiting') groups.waiting.push(`• ${s.svc} — ${p.name} (${owner})`);
    });
  });

  const dateLabel = `${today.getUTCDate()} ${MON[today.getUTCMonth()]}`;
  const parts = [`📋 <b>Оплаты на ${dateLabel}</b>`];
  if (groups.overdue.length) parts.push(`\n⚠ <b>Просрочено:</b>\n` + groups.overdue.join('\n'));
  if (groups.today.length)   parts.push(`\n🔔 <b>Сегодня оплата:</b>\n` + groups.today.join('\n'));
  if (groups.soon.length)    parts.push(`\n📅 <b>Скоро:</b>\n` + groups.soon.join('\n'));
  if (groups.waiting.length) parts.push(`\n📨 <b>Ждём оплату клиента:</b>\n` + groups.waiting.join('\n'));

  const hasAny = groups.overdue.length + groups.today.length + groups.soon.length + groups.waiting.length;
  if (!hasAny) parts.push('\n✅ На сегодня оплат и напоминаний нет.');

  return parts.join('\n');
}

async function main() {
  if (!TOKEN || !CHAT) {
    console.error('Нет BOT_TOKEN или CHAT_ID в секретах. Задай их в Settings → Secrets and variables → Actions.');
    process.exit(1);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
  } catch (e) {
    console.error('Не удалось прочитать bot/data.json:', e.message);
    process.exit(1);
  }

  const text = buildDigest(state);
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
  console.log('Дайджест отправлен ✅');
}

main().catch(e => { console.error(e); process.exit(1); });
