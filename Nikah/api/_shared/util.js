const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

// Vercel peut préfixer les noms de variables (ex. "xxx_KV_REST_API_URL") selon
// l'intégration installée. On cherche donc n'importe quelle variable dont le nom
// se termine par le suffixe attendu, plutôt que d'exiger un nom exact.
function findEnv(suffixes) {
  const keys = Object.keys(process.env);
  for (const suffix of suffixes) {
    const found = keys.find((k) => k.endsWith(suffix));
    if (found) return process.env[found];
  }
  return undefined;
}

const redis = new Redis({
  url: findEnv(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']),
  token: findEnv(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']),
});

function jsonResponse(res, data, status = 200) {
  res.status(status).json(data);
}

let cachedSecret = null;
async function getSecret() {
  if (cachedSecret) return cachedSecret;
  let secret = await redis.get('__session_secret__');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    await redis.set('__session_secret__', secret);
  }
  cachedSecret = secret;
  return secret;
}

function hashPassword(password, saltHint) {
  return crypto.createHash('sha256').update(`${saltHint.toLowerCase()}:${password}`).digest('hex');
}

async function signToken(payload) {
  const secret = await getSecret();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

async function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const secret = await getSecret();
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Ne renvoie jamais les champs sensibles à un autre utilisateur ou au client.
function stripPrivate(u) {
  const { passwordHash, email, waliContact, waliEmail, blockedUsers, ...safe } = u;
  return safe;
}
// Pour l'utilisateur lui-même : tout sauf le mot de passe.
function stripSecret(u) {
  const { passwordHash, ...safe } = u;
  return safe;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function ageFromDate(dateStr) {
  const b = new Date(dateStr);
  const t = new Date();
  let age = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) age--;
  return age;
}
const FREE_QUOTA = 5;
function refreshQuota(u) {
  if (!u) return false;
  if (u.quotaUnlimitedUntil && u.quotaUnlimitedUntil >= todayStr()) return false;
  const fom = firstOfMonth();
  if (!u.quotaResetDate || u.quotaResetDate < fom) {
    u.quotaMessages = (u.quotaMessages || 0) + FREE_QUOTA;
    u.quotaResetDate = fom;
    return true;
  }
  return false;
}
function matchKey(a, b) { return [a, b].sort().join('_'); }

module.exports = {
  redis, jsonResponse, hashPassword, signToken, verifyToken,
  stripPrivate, stripSecret, todayStr, firstOfMonth, addDays, ageFromDate,
  refreshQuota, matchKey, FREE_QUOTA, findEnv,
};
