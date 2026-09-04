# Sessão do Help Desk e proxy de mesma origem

O login existente em `POST /api/login` agora emite uma sessão opaca. O identificador
aleatório fica somente em cookie HttpOnly, SameSite=Lax, Path=/, sem Domain.
Em produção o cookie tem prefixo `__Host-` e atributo Secure. Não há bearer token
nem segredo de sessão no frontend. `GET /api/auth/me` recupera o usuário e
`POST /api/auth/logout` revoga a sessão no servidor.

## Configuração

- `NODE_ENV=production` obrigatório na implantação.
- `FRONTEND_URL=https://helpdesk.seu-dominio` deve ser a origem pública real.
- `SESSION_TTL_MS=28800000`: expiração absoluta de 8 horas; máximo 24 horas.
- `ENABLE_DEV_SEED=false`: seeds só podem executar com valor true E NODE_ENV
  explicitamente development/test. Nenhum usuário existente é removido ou alterado.
- DB_PATH, VISIT_DOCUMENTS_PATH e configurações Graph continuam independentes.

Armazenamento de sessão em memória, limitado a 10.000 entradas, para uma instância
Node. Reiniciar o processo encerra as sessões e exige novo login. Não usar cluster,
múltiplos workers ou múltiplas réplicas sem implantar futuramente um store compartilhado.
Não há tabela/migration de sessão no banco de visitas. Mudança de senha ou usuário
inativo invalida sessões; permissões são consultadas no banco em cada requisição.
Senhas novas/alteradas usam scrypt com salt aleatório. Senhas legadas são aceitas
sem regravar dados automaticamente. Credenciais fracas já existentes não são resetadas.

## Proxy de produção (exemplo Nginx, adaptar domínio/certificados/root)

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 180s;
    proxy_cache off;
}
location / {
    try_files $uri $uri/ /index.html;
}
```

Servir frontend e `/api` no MESMO domínio HTTPS. Redirecionar HTTP para HTTPS.
Preservar Cookie, Set-Cookie e Origin; não reescrever cookie para outro domínio.
Não armazenar respostas da API em cache e não publicar PDFs/SQLite como arquivos estáticos.
Restringir a porta Node via firewall ao proxy. O servidor não confia em headers
X-Forwarded-* para autenticação. O proxy deve aplicar limitação de tentativas por IP
em `/api/login` e recuperação de senha; o login também tem limite local por IP/usuário.

O build frontend usa `/api` relativo, independentemente do antigo VITE_API_URL.
No Vite local, BACKEND_PROXY_TARGET (ou antigo VITE_API_URL) seleciona o upstream,
com fallback http://127.0.0.1:5000. Não é necessário expor essa variável no build.
As rotas públicas por token não consultam a sessão nem recebem proteção de login.

## Permissões e limites de escopo

- Visitas, documentos e cadastros auxiliares: admin_goldtech e tecnico.
- Usuários: administradores podem gerenciar todos; cliente_gestor só perfis de
  cliente da própria empresa, sem promover técnico/administrador ou trocar empresa.
- Leituras de usuários para clientes são limitadas à empresa da sessão.
- Escritas de empresas: somente administrador. Clientes leem somente a própria empresa;
  administradores e técnicos mantêm acesso operacional a todas.
- Recuperação de senha permanece pública, com token válido, expirável e de uso único.
- Chamados e interações exigem sessão: clientes acessam somente a própria empresa;
  admin/técnico mantêm acesso operacional. Autoria é sempre a da sessão. Somente
  perfis internos alteram status/atribuição e leem/escrevem notas internas.
- Notificações são individuais, inclusive para administradores. Workload é interno.
- Solicitações administrativas de validação não retornam token/hash/URL. O link
  fica somente no e-mail ao responsável; os endpoints públicos continuam por token.
- Recuperação limita 5 tentativas/conta normalizada e 20/IP a cada 15 minutos,
  com resposta genérica idêntica antes de consultar a conta. Limites em memória,
  por processo, reiniciados junto com o servidor. Não confia em X-Forwarded-For:
  atrás do proxy, a quota local de IP é compartilhada; aplicar também limites
  individuais no proxy de borda. Não usar múltiplas réplicas sem store compartilhado.
- Webhook WhatsApp desabilitado em TODOS os ambientes: nenhum adaptador de
  assinatura/autenticidade existe no legado. Flags isoladas não o habilitam;
  integração autenticada deverá ser avaliada separadamente antes de reativação.

Nenhum banco existente deve ser substituído pelo DEV durante a implantação.
Fazer backup consistente do banco e documentos antes de qualquer publicação.
