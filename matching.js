const { redis, jsonResponse, verifyToken, stripPrivate, ageFromDate } = require('./_shared/util');
const { sendWaliMatchNotification } = require('./_shared/email');

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

async function getUsers() { return (await redis.get('users')) || []; }
async function setUsers(users) { await redis.set('users', users); }
async function getInterests() { return (await redis.get('interests')) || []; }
async function setInterests(v) { await redis.set('interests', v); }
async function getReports() { return (await redis.get('reports')) || []; }
async function setReports(v) { await redis.set('reports', v); }

function isMatched(interests, a, b) {
  return interests.some((i) => ((i.fromUserId === a && i.toUserId === b) || (i.fromUserId === b && i.toUserId === a)) && i.statut === 'accepte');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const body = req.body || {};
  const action = body.action;
  const payload = await verifyToken(body.token);

  // ---------------- ACTIONS MODÉRATION ----------------
  if (typeof action === 'string' && action.startsWith('admin-')) {
    if (!payload || payload.role !== 'platform-admin') return jsonResponse(res, { error: 'Non autorisé.' }, 403);
    if (action === 'admin-list-reports') {
      const reports = await getReports();
      return jsonResponse(res, { reports: reports.filter((r) => r.statut === 'ouvert') });
    }
    if (action === 'admin-resolve-report') {
      const reports = await getReports();
      const r = reports.find((x) => x.id === body.reportId);
      if (r) r.statut = 'traite';
      await setReports(reports);
      return jsonResponse(res, { ok: true });
    }
    return jsonResponse(res, { error: 'Action inconnue.' }, 400);
  }

  // ---------------- ACTIONS UTILISATEUR ----------------
  if (!payload || payload.role !== 'user') return jsonResponse(res, { error: 'Non autorisé.' }, 401);
  const users = await getUsers();
  const me = users.find((x) => x.id === payload.userId);
  if (!me) return jsonResponse(res, { error: 'Profil introuvable.' }, 404);

  if (action === 'discover') {
    const interests = await getInterests();
    const { ville, ageMin, ageMax } = body;
    const blockedByMe = me.blockedUsers || [];
    const candidates = users.filter((o) =>
      o.statut === 'actif' && o.id !== me.id && o.genre !== me.genre &&
      !blockedByMe.includes(o.id) && !(o.blockedUsers || []).includes(me.id) &&
      (!ville || o.ville === ville) &&
      ageFromDate(o.dateNaissance) >= (ageMin || 18) && ageFromDate(o.dateNaissance) <= (ageMax || 99)
    );
    const results = candidates.map((o) => {
      const matched = isMatched(interests, me.id, o.id);
      const alreadySent = interests.some((i) => i.fromUserId === me.id && i.toUserId === o.id);
      const safe = stripPrivate(o);
      if (!(matched && o.photosVisibles)) safe.photoUrl = '';
      return { ...safe, matched, alreadySent };
    });
    return jsonResponse(res, { profiles: results });
  }

  if (action === 'send-interest') {
    const interests = await getInterests();
    if (interests.some((i) => i.fromUserId === me.id && i.toUserId === body.toUserId)) {
      return jsonResponse(res, { error: 'Intérêt déjà envoyé.' }, 400);
    }
    interests.push({ id: uid(), fromUserId: me.id, toUserId: body.toUserId, statut: 'envoye', date: todayStr() });
    await setInterests(interests);
    return jsonResponse(res, { ok: true });
  }

  if (action === 'list-interests') {
    const interests = await getInterests();
    const recus = interests.filter((i) => i.toUserId === me.id && i.statut === 'envoye')
      .map((i) => ({ ...i, from: stripPrivate(users.find((u) => u.id === i.fromUserId) || {}) }));
    const envoyes = interests.filter((i) => i.fromUserId === me.id)
      .map((i) => ({ ...i, to: stripPrivate(users.find((u) => u.id === i.toUserId) || {}) }));
    return jsonResponse(res, { recus, envoyes });
  }

  if (action === 'respond-interest') {
    const interests = await getInterests();
    const i = interests.find((x) => x.id === body.interestId && x.toUserId === me.id);
    if (!i) return jsonResponse(res, { error: 'Introuvable.' }, 404);
    i.statut = body.accepted ? 'accepte' : 'refuse';
    await setInterests(interests);
    if (body.accepted) {
      const other = users.find((u) => u.id === i.fromUserId);
      if (me.waliVisibiliteMessages && me.waliEmail) {
        await sendWaliMatchNotification({ waliEmail: me.waliEmail, waliNom: me.waliNom, prenom: me.prenom });
      }
      if (other && other.waliVisibiliteMessages && other.waliEmail) {
        await sendWaliMatchNotification({ waliEmail: other.waliEmail, waliNom: other.waliNom, prenom: other.prenom });
      }
    }
    return jsonResponse(res, { ok: true });
  }

  if (action === 'block-user') {
    me.blockedUsers = me.blockedUsers || [];
    if (!me.blockedUsers.includes(body.blockedId)) me.blockedUsers.push(body.blockedId);
    await setUsers(users);
    return jsonResponse(res, { ok: true });
  }

  if (action === 'report-user') {
    const reports = await getReports();
    reports.push({ id: uid(), reporterId: me.id, reportedId: body.reportedId, motif: body.motif, details: body.details || '', date: todayStr(), statut: 'ouvert' });
    await setReports(reports);
    return jsonResponse(res, { ok: true });
  }

  return jsonResponse(res, { error: 'Action inconnue.' }, 400);
};
