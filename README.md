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

Em desenvolvimento, o acesso de teste sem Google pode ser ativado com `ENABLE_DEV_LOGIN=true` no `.env`. O botão entra como o usuário de demonstração sem senha e a API nunca oferece essa rota quando `NODE_ENV=production`.

## Funcionalidades

- Login Google com verificação do e-mail, proteção de estado OAuth, sessão no MySQL e allowlist opcional.
- Dashboard inicial com indicadores de estoque, pesquisa de produtos, gráfico de movimentações, alerta de estoque baixo e atividade recente.
- Produtos: busca por nome, SKU e categoria, filtros por status/estoque, CRUD e edição em modal. Produtos com histórico não podem ser apagados; podem ser desativados.
- Movimentações: busca por produto/SKU, filtros por tipo e período, entradas e saídas. Cada movimento e atualização de saldo são atômicos; saídas acima do saldo disponível são recusadas.

## Produção

Configure HTTPS, um `SESSION_SECRET` seguro, as URLs OAuth de produção e `APP_URL`; restrinja `GOOGLE_ALLOWED_EMAILS`; use um gerenciador de processos para a API e sirva o diretório `dist` por um servidor web. Configure também política de backup e acesso do usuário MySQL com permissões mínimas.
