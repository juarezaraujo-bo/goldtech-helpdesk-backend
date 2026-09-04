const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVisitGraphMailer } = require('../services/visit-graph-mailer');

const env = { MS_TENANT_ID: 'tenant-test', MS_CLIENT_ID: 'client-test', MS_CLIENT_SECRET: 'secret-test', MS_SENDER_EMAIL: 'visitas@example.test' };
const mail = { to: 'gestor@example.test', subject: 'Visita teste', text: 'Link: https://frontend.test/visitas/validar/token-test', html: '<a href="https://frontend.test/visitas/validar/token-test">Validar</a>' };
const tokenResponse = () => ({ ok: true, status: 200, json: async () => ({ access_token: 'access-token-test' }) });

test('Graph usa client credentials e preserva destinatário, texto, HTML e link no MIME', async () => {
  const calls = [];
  const mailer = createVisitGraphMailer({ env, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return calls.length === 1 ? tokenResponse() : { status: 202 };
  } });
  await mailer.sendMail(mail);
  assert.equal(calls[0].url, 'https://login.microsoftonline.com/tenant-test/oauth2/v2.0/token');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)), {
    grant_type: 'client_credentials', client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default'
  });
  assert.equal(calls[1].url, 'https://graph.microsoft.com/v1.0/users/visitas%40example.test/sendMail');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer access-token-test');
  assert.equal(calls[1].options.headers['Content-Type'], 'text/plain');
  const mime = Buffer.from(calls[1].options.body, 'base64').toString().replace(/=\r\n/g, '').replace(/=3D/g, '=');
  assert.match(mime, /From: Visita Tecnica Goldtech <visitas@example.test>/);
  assert.match(mime, /To: gestor@example.test/);
  assert.match(mime, /Subject: Visita teste/);
  assert.ok(mime.includes(mail.text));
  assert.ok(mime.includes(mail.html));
});

test('Graph mantém o PDF anexo com os mesmos bytes e nome', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-mail-test-'));
  const file = path.join(directory, 'comprovante.pdf');
  const bytes = Buffer.from('%PDF-1.4\ntest');
  fs.writeFileSync(file, bytes);
  try {
    let count = 0, mime;
    const mailer = createVisitGraphMailer({ env, fetchImpl: async (url, options) => {
      if (++count === 1) return tokenResponse();
      mime = Buffer.from(options.body, 'base64').toString(); return { status: 202 };
    } });
    await mailer.sendMail({ to: mail.to, subject: mail.subject, text: mail.text, attachments: [{ filename: 'comprovante.pdf', path: file }] });
    assert.match(mime, /application\/pdf/);
    assert.match(mime, /comprovante.pdf/);
    assert.ok(mime.includes(bytes.toString('base64')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const scenario of ['configuration', 'oauth', 'graph', 'network']) {
  test(`Falha ${scenario}: somente status e mensagem segura, sem conteúdo sensível`, async t => {
    const logs = [];
    t.mock.method(console, 'error', value => logs.push(value));
    let count = 0;
    const mailer = createVisitGraphMailer({ env: scenario === 'configuration' ? {} : env, fetchImpl: async () => {
      count++;
      if (scenario === 'network') throw new Error('secret-test access-token-test token-test');
      if (scenario === 'oauth') return { ok: false, status: 401, json: async () => { throw new Error('Sensitive body must not be read'); } };
      return count === 1 ? tokenResponse() : { status: 403, json: async () => { throw new Error('Sensitive body must not be read'); } };
    } });
    await assert.rejects(mailer.sendMail(mail), error => !/secret-test|access-token-test|token-test/.test(error.message));
    assert.equal(logs.length, 1);
    assert.deepEqual(Object.keys(logs[0]), ['status', 'message']);
    assert.equal(logs[0].status, scenario === 'oauth' ? 401 : scenario === 'graph' ? 403 : null);
    assert.doesNotMatch(JSON.stringify(logs), /secret-test|access-token-test|token-test|gestor@example/);
    assert.equal(count, scenario === 'configuration' ? 0 : scenario === 'graph' ? 2 : 1);
  });
}
