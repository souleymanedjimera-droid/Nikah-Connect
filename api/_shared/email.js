function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'Email notifications not configured yet.' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Nikah Connect <onboarding@resend.dev>', to: [to], subject, html }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { sent: false, error: detail };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: String(err) };
  }
}

async function sendWaliMatchNotification({ waliEmail, waliNom, prenom }) {
  if (!waliEmail) return { sent: false, reason: 'no wali email' };
  const html = `
    <div style="font-family: sans-serif; line-height:1.6; color:#1F2E2A;">
      <h2 style="margin-bottom:4px;">Nikah Connect — mise à jour</h2>
      <p>Bonjour ${escapeHtml(waliNom || '')},</p>
      <p><strong>${escapeHtml(prenom)}</strong> vous a désigné(e) comme tuteur/wali sur Nikah Connect, une plateforme de mise en relation en vue du mariage.</p>
      <p>Un accord mutuel vient d'être établi avec un autre profil vérifié par notre équipe. Une conversation encadrée (avec quota de messages) va démarrer entre eux.</p>
      <p>Nous vous invitons à rester impliqué(e) dans cette démarche, conformément au souhait exprimé.</p>
    </div>
  `;
  return sendEmail({ to: waliEmail, subject: `Nikah Connect — mise à jour concernant ${prenom}`, html });
}

async function sendSignupNotification({ adminEmail, prenom, ville, email }) {
  if (!adminEmail) return { sent: false, reason: 'Email notifications not configured yet.' };
  const html = `
    <div style="font-family: sans-serif; line-height:1.6; color:#1F2E2A;">
      <h2>Nouveau profil à valider — Nikah Connect</h2>
      <p><strong>Prénom :</strong> ${escapeHtml(prenom)}</p>
      <p><strong>Ville :</strong> ${escapeHtml(ville)}</p>
      <p><strong>Email :</strong> ${escapeHtml(email)}</p>
      <p>Connectez-vous à l'espace modération pour valider ou rejeter ce profil.</p>
    </div>
  `;
  return sendEmail({ to: adminEmail, subject: `Nouveau profil à valider — ${prenom}`, html });
}

module.exports = { sendEmail, sendWaliMatchNotification, sendSignupNotification };
