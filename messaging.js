const { redis, jsonResponse, verifyToken, stripPrivate, todayStr, addDays } = require('./_shared/util');

const PACKS = {
  pack20: { label: '20 messages', price: 2000, messages: 20 },
  pack50: { label: '50 messages', price: 4000, messages: 50 },
  illimite: { label: 'Illimité (30 jours)', price: 7000, messages: null, days: 30 },
};

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function matchKey(a, b) { return [a, b].sort().join('_'); }

async function getUsers() { return (await redis.get('users')) || []; }
async function setUsers(v) { await redis.set('users', v); }
async function getInterests() { return (await redis.get('interests')) || []; }
async function getMessages() { return (await redis.get('messages')) || []; }
async function setMessages(v) { await redis.set('messages', v); }
async function getTopups() { return (await redis.get('topups')) || []; }
async function setTopups(v) { await redis.set('topups', v); }

function isMatched(interests, a, b) {
  return interests.some((i) => ((i.fromUserId === a && i.toUserId === b) || (i.fromUserId === b && i.toUserId === a)) && i.statut === 'accepte');
}
function quotaOk(u) {
  return (u.quotaUnlimitedUntil && u.quotaUnlimitedUntil >= todayStr()) || (u.quotaMessages || 0) > 0;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const body = req.body || {};
  const action = body.action;
  const payload = await verifyToken(body.token);

  // ---------------- ACTIONS MODÉRATION ----------------
  if (typeof action === 'string' && action.startsWith('admin-')) {
    if (!payload || payload.role !== 'platform-admin') return jsonResponse(res, { error: 'Non autorisé.' }, 403);
    const users = await getUsers();
    if (action === 'admin-list-topups') {
      const topups = await getTopups();
      const pending = topups.filter((t) => t.statut === 'en_attente')
        .map((t) => ({ ...t, user: stripPrivate(users.find((u) => u.id === t.userId) || {}) }));
      return jsonResponse(res, { topups: pending });
    }
    if (action === 'admin-confirm-topup') {
      const topups = await getTopups();
      const t = topups.find((x) => x.id === body.topupId);
      if (!t) return jsonResponse(res, { error: 'Introuvable.' }, 404);
      const u = users.find((x) => x.id === t.userId);
      const pack = PACKS[t.packKey];
      if (u && pack) {
        if (pack.messages) u.quotaMessages = (u.quotaMessages || 0) + pack.messages;
        if (pack.days) u.quotaUnlimitedUntil = addDays(todayStr(), pack.days);
      }
      t.statut = 'confirme';
      await setUsers(users); await setTopups(topups);
      return jsonResponse(res, { ok: true });
    }
    if (action === 'admin-reject-topup') {
      const topups = await getTopups();
      const t = topups.find((x) => x.id === body.topupId);
      if (t) t.statut = 'rejete';
      await setTopups(topups);
      return jsonResponse(res, { ok: true });
    }
    return jsonResponse(res, { error: 'Action inconnue.' }, 400);
  }

  // ---------------- ACTIONS UTILISATEUR ----------------
  if (!payload || payload.role !== 'user') return jsonResponse(res, { error: 'Non autorisé.' }, 401);
  const users = await getUsers();
  const me = users.find((x) => x.id === payload.userId);
  if (!me) return jsonResponse(res, { error: 'Profil introuvable.' }, 404);
  const interests = await getInterests();

  if (action === 'list-matches') {
    const matchIds = interests.filter((i) => i.statut === 'accepte' && (i.fromUserId === me.id || i.toUserId === me.id))
      .map((i) => (i.fromUserId === me.id ? i.toUserId : i.fromUserId))
      .filter((v, idx, arr) => arr.indexOf(v) === idx);
    const messages = await getMessages();
    const matches = matchIds.map((id) => {
      const o = users.find((u) => u.id === id);
      if (!o) return null;
      const conv = messages.filter((m) => m.matchKey === matchKey(me.id, id));
      const last = conv[conv.length - 1];
      return { profile: stripPrivate(o), lastMessage: last ? last.texte : null };
    }).filter(Boolean);
    return jsonResponse(res, { matches, quotaMessages: me.quotaMessages, quotaUnlimitedUntil: me.quotaUnlimitedUntil });
  }

  if (action === 'get-conversation') {
    const otherId = body.otherId;
    if (!isMatched(interests, me.id, otherId)) return jsonResponse(res, { error: 'Aucun accord mutuel avec ce profil.' }, 403);
    const messages = await getMessages();
    const conv = messages.filter((m) => m.matchKey === matchKey(me.id, otherId)).sort((a, b) => a.date.localeCompare(b.date));
    return jsonResponse(res, { messages: conv.map((m) => ({ texte: m.texte, mine: m.fromUserId === me.id, date: m.date })) });
  }

  if (action === 'send-message') {
    const otherId = body.otherId;
    const texte = String(body.texte || '').trim();
    if (!texte) return jsonResponse(res, { error: 'Message vide.' }, 400);
    if (!isMatched(interests, me.id, otherId)) return jsonResponse(res, { error: 'Aucun accord mutuel avec ce profil.' }, 403);
    if (!quotaOk(me)) return jsonResponse(res, { error: 'quota_exceeded' }, 403);
    const messages = await getMessages();
    messages.push({ id: uid(), matchKey: matchKey(me.id, otherId), fromUserId: me.id, texte, date: new Date().toISOString() });
    if (!(me.quotaUnlimitedUntil && me.quotaUnlimitedUntil >= todayStr())) {
      me.quotaMessages = Math.max(0, (me.quotaMessages || 0) - 1);
    }
    await setMessages(messages); await setUsers(users);
    return jsonResponse(res, { ok: true, quotaMessages: me.quotaMessages, quotaUnlimitedUntil: me.quotaUnlimitedUntil });
  }

  if (action === 'request-topup') {
    const topups = await getTopups();
    if (!PACKS[body.packKey]) return jsonResponse(res, { error: 'Pack inconnu.' }, 400);
    if (!body.transactionRef) return jsonResponse(res, { error: 'Référence de transaction requise.' }, 400);
    topups.push({ id: uid(), userId: me.id, packKey: body.packKey, transactionRef: body.transactionRef, statut: 'en_attente', date: todayStr() });
    await setTopups(topups);
    return jsonResponse(res, { ok: true });
  }

  return jsonResponse(res, { error: 'Action inconnue.' }, 400);
};
