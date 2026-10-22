# Controle de Estoque

Aplicação web responsiva em português para cadastro de produtos, consulta de indicadores e registro do histórico de entradas e saídas. O frontend usa React/Vite; a API usa Express; os dados e sessões ficam no MySQL.

## Requisitos

- Node.js 20 ou superior e npm (ou pnpm).
- MySQL 8.0 ou superior.
- Credenciais OAuth 2.0 de um cliente Google do tipo Aplicativo da Web.

## Configuração

1. Copie `.env.example` para `.env` e preencha os dados do MySQL, um `SESSION_SECRET` aleatório e as chaves OAuth do Google.
2. Inicialize banco e tabelas com `npm run db:setup` (ou execute `database/schema.sql` no MySQL).
3. No Google Cloud Console, habilite Google Identity, configure a origem autorizada `http://localhost:5173` e o URI de redirecionamento `http://localhost:3000/auth/google/callback`.
4. Opcional: defina `GOOGLE_ALLOWED_EMAILS` com e-mails separados por vírgula para restringir o acesso. Vazio permite qualquer conta Google com e-mail verificado.
5. Instale dependências com `npm install` e inicie a aplicação com `npm run dev`.
6. Acesse `http://localhost:5173`. A API roda em `http://localhost:3000`.

Para preencher o banco com produtos e movimentações de exemplo, execute `npm run db:seed-demo`. Os SKUs começam com `DEMO-` e as observações com `TESTE:`. O comando pode ser repetido sem duplicar as movimentações de demonstração.


## Funcionalidades

- Login Google com verificação do e-mail, proteção de estado OAuth, sessão no MySQL e allowlist opcional.
- Dashboard inicial com indicadores de estoque, pesquisa de produtos, gráfico de movimentações, alerta de estoque baixo e atividade recente.
- Produtos: busca por nome, SKU e categoria, filtros por status/estoque, CRUD e edição em modal. Produtos com histórico não podem ser apagados; podem ser desativados.
- Movimentações: busca por produto/SKU, filtros por tipo e período, entradas e saídas. Cada movimento e atualização de saldo são atômicos; saídas acima do saldo disponível são recusadas.

## Produção

Configure HTTPS, um `SESSION_SECRET` seguro, as URLs OAuth de produção e `APP_URL`; restrinja `GOOGLE_ALLOWED_EMAILS`; use um gerenciador de processos para a API e sirva o diretório `dist` por um servidor web. Configure também política de backup e acesso do usuário MySQL com permissões mínimas.

## Publicação no Render

O servidor Express entrega o frontend compilado e a API pelo mesmo domínio em produção. O endpoint `/healthz` pode ser usado como verificação de saúde do serviço. O banco MySQL deve ser hospedado separadamente; o Render não oferece MySQL gerenciado.

1. Envie este repositório para o GitHub, incluindo `pnpm-lock.yaml` e `render.yaml`. O arquivo `.env` já é ignorado pelo Git; nunca publique suas credenciais.
2. No Render, escolha **New > Blueprint** e conecte o repositório. Revise o serviço web antes de aplicar. O blueprint usa o plano gratuito; troque para um plano pago se precisar evitar suspensão por inatividade.
3. Crie ou escolha um MySQL acessível pela internet. No painel do banco, crie o schema executando `database/schema.sql` e guarde host, porta, usuário, senha e nome do banco. Libere conexões de saída do Render conforme as regras do provedor MySQL.
4. No serviço web do Render, configure `APP_URL` como a URL HTTPS pública do serviço. Configure `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD` e `MYSQL_DATABASE` com os dados do banco. Se o banco exigir TLS, adicione o certificado CA como **Secret File** no Render e defina `MYSQL_SSL_CA` para o caminho montado, por exemplo `/etc/secrets/mysql-ca.pem`.
5. Defina `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_ALLOWED_EMAILS`. Use uma lista de e-mails autorizados separada por vírgulas. Gere um segredo aleatório forte para `SESSION_SECRET` (ao menos 32 caracteres). Não defina `PORT`; o Render fornece essa variável.
6. No cliente OAuth do Google Cloud, cadastre a URL base do Render em **Origens JavaScript autorizadas** e `https://SEU-DOMINIO/auth/google/callback` em **URIs de redirecionamento autorizados**. A URL precisa corresponder exatamente ao domínio e caminho configurados em `GOOGLE_CALLBACK_URL`.
7. Configure `GOOGLE_CALLBACK_URL` com a URL pública completa, por exemplo `https://estoque-exemplo.onrender.com/auth/google/callback`. Salve as variáveis e faça um novo deploy.
8. Abra `/healthz` no domínio publicado e depois valide login Google, leitura do dashboard, cadastro/edição de produto e uma movimentação. Faça um backup do banco antes de inserir dados reais.

Comandos configurados no blueprint: build `pnpm install --frozen-lockfile --prod=false && pnpm run build`; start `pnpm start`; verificação de saúde `/healthz`. O script `db:seed-demo` existe apenas para dados de demonstração; não o execute no banco de produção.
