const MailComposer = require('nodemailer/lib/mail-composer');

// MIME formatting only; delivery is exclusively Microsoft Graph, never SMTP.
function createVisitGraphMailer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const failure = (status, message) => {
    const error = new Error(message);
    error.status = Number.isInteger(status) ? status : null;
    console.error({ status: error.status, message });
    return error;
  };

  return {
    async sendMail(mail) {
      const { MS_TENANT_ID: tenant, MS_CLIENT_ID: client, MS_CLIENT_SECRET: secret, MS_SENDER_EMAIL: sender } = env;
      if (![tenant, client, secret, sender].every(value => typeof value === 'string' && value.trim())) {
        throw failure(null, 'Configuração Microsoft Graph incompleta para envio de visitas.');
      }

      let tokenResponse;
      try {
        tokenResponse = await fetchImpl(
          `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
          {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'client_credentials', client_id: client, client_secret: secret,
              scope: 'https://graph.microsoft.com/.default'
            }).toString()
          }
        );
      } catch {
        throw failure(null, 'Falha de conexão ou timeout na autenticação Microsoft Graph.');
      }
      if (!tokenResponse.ok) throw failure(tokenResponse.status, 'Autenticação Microsoft Graph recusada.');
      let token;
      try {
        const data = await tokenResponse.json();
        if (typeof data.access_token !== 'string' || !data.access_token) throw new Error();
        token = data.access_token;
      } catch {
        throw failure(tokenResponse.status, 'Resposta de autenticação Microsoft Graph inválida.');
      }

      let mime;
      try {
        mime = await new MailComposer({ ...mail, from: { name: 'Visita Tecnica Goldtech', address: sender } }).compile().build();
      } catch {
        throw failure(null, 'Não foi possível preparar a mensagem ou anexo da visita.');
      }
      let response;
      try {
        response = await fetchImpl(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
          {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
            body: mime.toString('base64')
          }
        );
      } catch {
        throw failure(null, 'Falha de conexão ou timeout no envio Microsoft Graph.');
      }
      if (response.status !== 202) throw failure(response.status, 'Envio Microsoft Graph recusado.');
      return { accepted: [mail.to] };
    }
  };
}

module.exports = { createVisitGraphMailer };
