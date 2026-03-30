# Sistema de Pagamentos

Sistema interno para controle dos pagamentos da empresa, com backend em TypeScript, frontend em React e autenticacao integrada ao Ecossistema Omega.

## Visao geral

- Login com prioridade para SSO vindo do Ecossistema Omega
- Login local disponivel apenas fora de producao
- Banco PostgreSQL com Prisma
- Upload e armazenamento local de arquivos para o modulo MEI
- Auditoria centralizada das acoes do sistema
- Estrutura preparada para receber novos modulos de pagamentos

## Estrutura

- `backend/`: API Fastify, Prisma, regras de negocio e uploads
- `frontend/`: aplicacao React/Vite

## Desenvolvimento local

1. Configure as variaveis de ambiente em um arquivo `.env` na raiz.
2. Instale as dependencias com `npm install`.
3. Gere o client do Prisma com `npm run prisma:generate`.
4. Aplique o schema no banco com `npm run prisma:push`.
5. Rode o ambiente com `npm run dev`.

## Deploy

- Aplicacao preparada para deploy no Railway
- O backend serve o frontend buildado em producao
- Uploads usam armazenamento local configurado por `UPLOADS_DIR`

## Observacoes

- O arquivo `.gitignore` ja ignora uploads locais e arquivos de ambiente
- Informacoes sensiveis devem ser configuradas apenas por variaveis de ambiente
