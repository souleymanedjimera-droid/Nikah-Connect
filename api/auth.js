const {
  redis, jsonResponse, hashPassword, signToken, verifyToken,
  stripPrivate, stripSecret, todayStr, firstOfMonth, ageFromDate, refreshQuota,
} = require('./_shared/util');
const { sendSignupNotification } = require('./_shared/email');

const MIN_AGE = 18;
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

async function getUsers() { return (await redis.get('users')) || []; }
async function setUsers(users) { await redis.set('users', users); }
async function getAdminCreds() {
  let creds = await redis.get('admin-credentials');
  if (!creds) {
    creds = { passwordHash: hashPassword('nikah2026', 'platform-admin') };
    await redis.set('admin-credentials', creds);
  }
  return creds;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const body = req.body || {};
  const action = body.action;

  // ---------------- INSCRIPTION ----------------
  if (action === 'signup') {
    const { prenom, genre, dateNaissance, ville, statutMatrimonial, niveauPratique, description, recherche, waliNom, waliContact, waliEmail, waliVisibiliteMessages, email, password, majeurConfirme } = body;
    if (!prenom || !dateNaissance || !email || !password) {
      return jsonResponse(res, { error: 'Merci de remplir tous les champs obligatoires.' }, 400);
    }
    const age = ageFromDate(dateNaissance);
    if (age < MIN_AGE) {
      return jsonResponse(res, { error: 'Cette plateforme est réservée aux personnes majeures (18 ans et plus). Votre inscription ne peut pas être validée.' }, 400);
    }
    if (!majeurConfirme) {
      return jsonResponse(res, { error: 'Merci de confirmer que vous avez 18 ans ou plus et des intentions sérieuses.' }, 400);
    }
    if (String(password).length < 8) {
      return jsonResponse(res, { error: 'Le mot de passe doit contenir au moins 8 caractères.' }, 400);
    }
    const emailLower = String(email).trim().toLowerCase();
    const users = await getUsers();
    if (users.some((u) => u.email.toLowerCase() === emailLower)) {
      return jsonResponse(res, { error: 'Un compte existe déjà avec cet email.' }, 400);
    }
    const user = {
      id: uid(), prenom, genre, dateNaissance, ville, statutMatrimonial, niveauPratique,
      description: description || '', recherche: recherche || '', photoUrl: '', photosVisibles: false,
      waliNom: waliNom || '', waliContact: waliContact || '', waliEmail: waliEmail || '', waliVisibiliteMessages: !!waliVisibiliteMessages,
      email: emailLower, passwordHash: hashPassword(password, emailLower),
      statut: 'en_attente', dateInscription: todayStr(),
      quotaMessages: 5, quotaResetDate: firstOfMonth(), quotaUnlimitedUntil: null,
      blockedUsers: [],
    };
    users.push(user);
    await setUsers(users);
    const emailResult = await sendSignupNotification({ adminEmail: process.env.ADMIN_NOTIFY_EMAIL, prenom, ville, email: emailLower });
    return jsonResponse(res, { ok: true, emailResult });
  }

  // ---------------- CONNEXION ----------------
  if (action === 'login') {
    const emailLower = String(body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const users = await getUsers();
    const u = users.find((x) => x.email.toLowerCase() === emailLower);
    if (!u) return jsonResponse(res, { error: 'Aucun compte ne correspond à cet email.' }, 401);
    if (hashPassword(password, emailLower) !== u.passwordHash) return jsonResponse(res, { error: 'Mot de passe incorrect.' }, 401);
    if (u.statut === 'en_attente') return jsonResponse(res, { status: 'pending' });
    if (u.statut === 'rejete') return jsonResponse(res, { status: 'rejected' });
    if (u.statut === 'suspendu') return jsonResponse(res, { status: 'suspended' });
    if (refreshQuota(u)) await setUsers(users);
    const token = await signToken({ userId: u.id, role: 'user', exp: Date.now() + TOKEN_TTL_MS });
    return jsonResponse(res, { token, user: stripSecret(u) });
  }

  // ---------------- CONNEXION MODÉRATION ----------------
  if (action === 'admin-login') {
    const creds = await getAdminCreds();
    if (hashPassword(body.password || '', 'platform-admin') !== creds.passwordHash) {
      return jsonResponse(res, { error: 'Mot de passe incorrect.' }, 401);
    }
    const token = await signToken({ role: 'platform-admin', exp: Date.now() + TOKEN_TTL_MS });
    return jsonResponse(res, { token });
  }
  if (action === 'admin-change-password') {
    const payload = await verifyToken(body.token);
    if (!payload || payload.role !== 'platform-admin') return jsonResponse(res, { error: 'Non autorisé.' }, 403);
    if (String(body.newPassword || '').length < 8) return jsonResponse(res, { error: '8 caractères minimum.' }, 400);
    await redis.set('admin-credentials', { passwordHash: hashPassword(body.newPassword, 'platform-admin') });
    return jsonResponse(res, { ok: true });
  }

  // ---------------- VÉRIFICATION / PROFIL COURANT ----------------
  if (action === 'verify') {
    const payload = await verifyToken(body.token);
    if (!payload) return jsonResponse(res, { valid: false });
    return jsonResponse(res, { valid: true, role: payload.role, userId: payload.userId });
  }
  if (action === 'me') {
    const payload = await verifyToken(body.token);
    if (!payload || payload.role !== 'user') return jsonResponse(res, { error: 'Session invalide.' }, 401);
    const users = await getUsers();
    const u = users.find((x) => x.id === payload.userId);
    if (!u) return jsonResponse(res, { error: 'Profil introuvable.' }, 404);
    if (u.statut !== 'actif') return jsonResponse(res, { error: 'not_active', statut: u.statut }, 403);
    if (refreshQuota(u)) await setUsers(users);
    return jsonResponse(res, { user: stripSecret(u) });
  }

  // ---------------- ACTIONS MODÉRATION ----------------
  if (typeof action === 'string' && action.startsWith('admin-')) {
    const payload = await verifyToken(body.token);
    if (!payload || payload.role !== 'platform-admin') return jsonResponse(res, { error: 'Non autorisé.' }, 403);
    const users = await getUsers();

    if (action === 'admin-list-users') {
      return jsonResponse(res, { users: users.map(stripSecret) });
    }
    const u = users.find((x) => x.id === body.userId);
    if (!u) return jsonResponse(res, { error: 'Profil introuvable.' }, 404);
    if (action === 'admin-approve') u.statut = 'actif';
    else if (action === 'admin-reject') u.statut = 'rejete';
    else if (action === 'admin-suspend') u.statut = 'suspendu';
    else return jsonResponse(res, { error: 'Action inconnue.' }, 400);
    await setUsers(users);
    return jsonResponse(res, { ok: true });
  }

  return jsonResponse(res, { error: 'Action inconnue.' }, 400);
};
