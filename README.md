# Farm Stock

App de controle de estoque de medicamentos e insumos, com leitura de código
de barras/QR, **multi-fazenda** (cada cliente com seu próprio espaço
isolado), login por usuário (Operador/Gestor), itens com múltiplos lotes
(cada lote com sua própria validade), foto do item, retiro de destino na
saída (com carrinho para revisar antes de confirmar), alerta de validade e
funcionamento **offline** — instalável no celular como um app (PWA).

## Modelo de dados

- **Fazenda** — cada cliente tem seu próprio código de acesso. Nenhuma
  fazenda vê os dados de outra: usuários, itens, lotes, retiros e
  histórico são todos isolados por fazenda.
- **Item** — um produto genérico (ex.: "Oxitetraciclina 200mg"), com um
  **Código do item** cadastrado manualmente pelo Gestor.
- **Lote** — um lote físico de um item, identificado pelo **Código do
  lote** (o código de barras/QR da embalagem). Um item pode ter vários
  lotes em estoque ao mesmo tempo, cada um com sua própria validade.

## Controle de acesso

- Ao abrir o app, primeiro se escolhe/cadastra a **fazenda** (por um código
  de acesso). Só depois disso aparece a tela de login de usuário.
- Dentro de cada fazenda, só existe autocadastro para o **primeiro
  usuário** (necessário para alguém conseguir entrar pela primeira vez) —
  ele vira Gestor automaticamente.
- Depois disso, só um **Gestor logado** pode cadastrar novos usuários (aba
  Usuários) e novos retiros (aba Retiros). Ninguém mais consegue se
  autocadastrar.
- **Operador**: dá entrada/saída em itens já cadastrados, consulta
  estoque/histórico, escolhe entre os retiros já cadastrados.
- **Gestor**: tudo isso, mais cadastra/edita itens e lotes, corrige
  estoque, cadastra retiros novos e gerencia usuários (inclusive
  promover/rebaixar perfil).

## Como funciona a entrada (Código do item x Código do lote)

Ao escanear um código na Entrada:
- Se o **código do lote** já existe, o app pede só a quantidade e a
  validade (atualizável) daquele lote.
- Se é um lote novo, o Gestor busca o item pelo nome ou pelo **código do
  item** (com sugestões enquanto digita). Se o item já existir, só pede os
  dados do novo lote. Se não existir, cadastra o item e o primeiro lote de
  uma vez.

## Como funciona a saída (carrinho)

Ao tocar em Saída, o app escaneia o primeiro lote, pede a quantidade e leva
para o **Carrinho**, onde dá pra escanear mais lotes, editar quantidade,
remover, escolher o **Retiro de destino** (uma vez só, para a saída
inteira) e só então confirmar tudo de uma vez.

## Como funciona o offline

- Toda gravação (fazenda, item, lote, entrada, saída, ajuste, cadastro de
  usuário/retiro) é salva primeiro no próprio celular (IndexedDB), na
  hora, com ou sem sinal.
- Em segundo plano, o app tenta enviar cada gravação para o banco
  (Supabase). Se não conseguir, ela fica numa fila e é reenviada
  automaticamente assim que a conexão voltar — sem precisar reabrir o app.
- A **quantidade em estoque nunca é sobrescrita**: ela é sempre a soma de
  todas as movimentações daquele lote (e a soma de um item é a soma dos
  seus lotes). Por isso é seguro dois celulares darem baixa no mesmo lote
  offline, ao mesmo tempo — quando os dois sincronizarem, as duas saídas
  somam certinho, sem uma apagar a outra.
- Cadastro de fazenda/item/lote/usuário/retiro e edições usam "o último
  que sincronizar vale" — tranquilo aqui porque essas ações são raras
  comparadas a entrada/saída.
- **Fotos**: são comprimidas no próprio celular antes de salvar
  (redimensiona para no máximo ~480px e converte para JPEG), pra não pesar
  o armazenamento nem a sincronização.

## 1. Criar o projeto no Supabase (banco de dados)

1. Crie uma conta gratuita em [supabase.com](https://supabase.com) e um novo projeto.
2. Vá em **SQL Editor**, cole o conteúdo de `supabase/schema.sql` (deste
   projeto) e clique em **Run**. Isso cria as tabelas `fazendas`,
   `usuarios`, `itens`, `lotes`, `retiros`, `movimentacoes` e as views que
   calculam o estoque automaticamente.
3. Vá em **Project Settings → API** e copie a **Project URL** e a chave
   **anon public**.

> **Nota de segurança:** o login deste app é feito por código da fazenda +
> nome + código de 4 dígitos dentro do próprio app, não pelo sistema de
> contas do Supabase. As regras do banco liberam leitura/escrita para quem
> tiver a chave pública do projeto — adequado para uma ferramenta interna,
> mas **não publique a URL nem a chave em lugar público**. O isolamento
> entre fazendas e o controle "só Gestor cadastra usuário/retiro/item novo"
> são aplicados pela interface do app, não pelo banco — suficiente para uso
> interno, mas vale saber que não é uma trava a nível de banco de dados.

## 2. Rodar localmente (para testar antes de publicar)

Requer [Node.js](https://nodejs.org) instalado (versão 18 ou mais recente).

```bash
npm install
cp .env.example .env
# edite o .env e cole a URL e a chave anon do seu projeto Supabase
npm run dev
```

Abra o endereço que aparecer no terminal (algo como `http://localhost:5173`).

## 3. Publicar no GitHub + Vercel (para instalar no celular)

1. Crie um repositório novo no GitHub e suba este projeto:
   ```bash
   git init
   git add .
   git commit -m "Farm Stock - primeira versão"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/farm-stock.git
   git push -u origin main
   ```
2. Crie uma conta em [vercel.com](https://vercel.com) (pode entrar com o GitHub).
3. **Add New → Project**, escolha o repositório que você acabou de subir.
4. Em **Environment Variables**, adicione:
   - `VITE_SUPABASE_URL` = a URL do seu projeto Supabase
   - `VITE_SUPABASE_ANON_KEY` = a chave anon public
5. Clique em **Deploy**. Em cerca de um minuto você recebe um link
   (algo como `https://farm-stock.vercel.app`).

## 4. Instalar no celular

1. Abra o link da Vercel no navegador do celular (Chrome no Android, Safari no iPhone).
2. Android (Chrome): toque no menu (⋮) → **Adicionar à tela inicial** / **Instalar app**.
3. iPhone (Safari): toque no ícone de compartilhar → **Adicionar à Tela de Início**.
4. O app abre em tela cheia, com ícone próprio, e funciona offline a partir
   da segunda vez que for aberto (o navegador guarda os arquivos do app).

Repita esses passos em cada celular que vai usar o sistema — todos apontam
para o mesmo banco de dados e sincronizam entre si.

## 5. Primeiro uso

1. Ao abrir o app pela primeira vez, cadastre a **primeira fazenda**
   (nome + código de acesso). Combine esse código com a equipe daquela
   fazenda — é o que eles vão digitar toda vez que entrarem no app.
2. Em seguida, cadastre o **primeiro usuário** dessa fazenda — ele vira
   Gestor automaticamente. Gestores podem cadastrar novos itens, lotes,
   retiros e outros usuários. Operadores só dão entrada/saída em itens já
   cadastrados e consultam estoque/histórico.
3. Para atender uma fazenda diferente, use "+ Cadastrar nova fazenda" na
   tela inicial — cada uma fica completamente separada das demais.

## Estrutura do projeto

```
supabase/schema.sql    → schema do banco (rode no SQL Editor do Supabase)
src/db/supabase.js      → conexão com o Supabase
src/db/local.js         → banco local (IndexedDB) + fila de sincronização offline
src/ui/scanner.js       → leitor de código de barras/QR (câmera)
src/ui/app.js           → toda a interface (fazenda, login, telas, modais)
src/style.css           → visual do app
public/icons/           → ícones do app instalado (PWA)
public/logo-visao.png   → logo "Visão Agropecuária" mostrada no login
vite.config.js          → build + configuração do PWA (ícone, manifest, cache offline)
```

## Personalizar

- **Categorias e unidades de medida**: no início de `src/ui/app.js`, nas
  constantes `CATEGORIAS` e `UNIDADES`.
- **Dias de aviso de vencimento** (padrão: 30 dias antes): constante
  `EXPIRY_WARNING_DAYS` em `src/ui/app.js`.
- **Cores e ícone do app**: `src/style.css` (variáveis no topo do arquivo) e
  `public/icons/`.

## Próximos passos possíveis

- Trocar o PIN de 4 dígitos por hash (mais seguro caso o celular seja
  perdido) — hoje ele é salvo em texto simples no banco.
- Exportar relatórios agendados automaticamente (ex.: e-mail semanal).
- Alertas por WhatsApp/e-mail quando um item ficar abaixo do estoque
  mínimo ou perto de vencer.
- Isolamento de fazendas a nível de banco (RLS por fazenda_id com
  autenticação real), caso o número de fazendas atendidas cresça e o
  isolamento só na interface deixe de ser suficiente.
