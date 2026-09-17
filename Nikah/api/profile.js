const { put } = require('@vercel/blob');
const { redis, jsonResponse, verifyToken, stripSecret, findEnv } = require('./_shared/util');

const ALLOWED_FIELDS = [
  'prenom', 'ville', 'statutMatrimonial', 'niveauPratique', 'description', 'recherche',
  'photoUrl', 'photosVisibles', 'waliNom', 'waliContact', 'waliEmail', 'waliVisibiliteMessages',
];

async function getUsers() { return (await redis.get('users')) || []; }
async function setUsers(users) { await redis.set('users', users); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const body = req.body || {};
  const action = body.action;
  const payload = await verifyToken(body.token);
  if (!payload || payload.role !== 'user') return jsonResponse(res, { error: 'Non autorisé.' }, 401);

  const users = await getUsers();
  const u = users.find((x) => x.id === payload.userId);
  if (!u) return jsonResponse(res, { error: 'Profil introuvable.' }, 404);

  if (action === 'update') {
    for (const key of ALLOWED_FIELDS) {
      if (key in body) u[key] = body[key];
    }
    await setUsers(users);
    return jsonResponse(res, { ok: true, user: stripSecret(u) });
  }

  if (action === 'upload-photo') {
    const { imageBase64, mimeType } = body;
    if (!imageBase64) return jsonResponse(res, { error: 'Image manquante.' }, 400);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      return jsonResponse(res, { error: 'Format non supporté (JPEG, PNG ou WEBP uniquement).' }, 400);
    }
    const buffer = Buffer.from(imageBase64, 'base64');
    if (buffer.length > 4 * 1024 * 1024) {
      return jsonResponse(res, { error: "L'image dépasse la taille maximale autorisée (4 Mo)." }, 400);
    }
    const blobToken = findEnv(['BLOB_READ_WRITE_TOKEN']);
    if (!blobToken) {
      return jsonResponse(res, { error: "Le stockage d'images n'est pas encore configuré (Vercel Blob)." }, 200);
    }
    try {
      const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
      const blob = await put(`profiles/${u.id}-${Date.now()}.${ext}`, buffer, {
        access: 'public',
        contentType: mimeType,
        token: blobToken,
      });
      u.photoUrl = blob.url;
      await setUsers(users);
      return jsonResponse(res, { ok: true, url: blob.url });
    } catch (err) {
      return jsonResponse(res, { error: "Échec de l'envoi de l'image : " + String(err.message || err) }, 500);
    }
  }

  return jsonResponse(res, { error: 'Action inconnue.' }, 400);
};
