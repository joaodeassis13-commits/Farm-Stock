-- ============================================================
-- Farm Stock — schema Supabase (Postgres)
-- Execute este arquivo inteiro no SQL Editor do seu projeto Supabase.
--
-- Modelo de dados:
--   FAZENDA — cada cliente/fazenda tem seu próprio "espaço", isolado
--   das demais. Todo o resto (usuários, itens, lotes, movimentações,
--   retiros) pertence a uma fazenda (fazenda_id).
--
--   ITEM — um produto genérico (ex.: "Oxitetraciclina 200mg"), com um
--   Código do item cadastrado manualmente pelo Gestor.
--
--   LOTE — um lote físico de um item, identificado pelo Código do
--   lote (o código de barras/QR da embalagem). Um item pode ter
--   vários lotes; cada lote tem sua própria validade.
--
--   A quantidade em estoque NUNCA é um número salvo: é sempre a soma
--   das movimentações daquele lote (e a soma de um item = soma de
--   todos os seus lotes). Isso é o que torna o app seguro para uso
--   offline em vários celulares ao mesmo tempo: cada movimentação é
--   um registro independente que só soma, nunca sobrescreve.
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- FAZENDAS ----------
create table if not exists fazendas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  codigo text not null unique,        -- código de acesso digitado no login
  criado_em timestamptz not null default now()
);

-- ---------- USUÁRIOS ----------
create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  fazenda_id uuid not null references fazendas(id),
  nome text not null,
  pin text not null,                  -- código de 4 dígitos, ver nota de segurança no README
  perfil text not null check (perfil in ('operador','gestor')) default 'operador',
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
create index if not exists idx_usuarios_fazenda on usuarios(fazenda_id);

-- ---------- ITENS ----------
create table if not exists itens (
  id uuid primary key default gen_random_uuid(),
  fazenda_id uuid not null references fazendas(id),
  codigo_item text not null,          -- código cadastrado manualmente pelo Gestor
  nome text not null,
  categoria text not null,
  unidade text not null,
  estoque_minimo numeric not null default 0,
  foto text,                          -- imagem em base64 (comprimida no celular antes de enviar)
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (fazenda_id, codigo_item)
);
create index if not exists idx_itens_fazenda on itens(fazenda_id);

-- ---------- LOTES ----------
create table if not exists lotes (
  id uuid primary key default gen_random_uuid(),
  fazenda_id uuid not null references fazendas(id),
  item_id uuid not null references itens(id),
  codigo_lote text not null,          -- código de barras/QR físico do lote
  validade date,
  criado_em timestamptz not null default now(),
  unique (fazenda_id, codigo_lote)
);
create index if not exists idx_lotes_fazenda on lotes(fazenda_id);
create index if not exists idx_lotes_item on lotes(item_id);

-- ---------- RETIROS ----------
-- Destinos de uma saída (ex.: "Retiro Sede", "Retiro da Serra"). Só Gestor cadastra.
create table if not exists retiros (
  id uuid primary key default gen_random_uuid(),
  fazenda_id uuid not null references fazendas(id),
  nome text not null,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
create index if not exists idx_retiros_fazenda on retiros(fazenda_id);

-- ---------- MOVIMENTAÇÕES ----------
-- id é gerado no celular (uuid) no momento do registro, não no servidor.
-- Isso permite gravar offline e sincronizar depois sem duplicar nem perder nada:
-- ao sincronizar, o app tenta inserir; se o id já existe, o Postgres ignora (idempotente).
create table if not exists movimentacoes (
  id uuid primary key,
  fazenda_id uuid not null references fazendas(id),
  lote_id uuid not null references lotes(id),
  item_id uuid not null references itens(id),
  tipo text not null check (tipo in ('entrada','saida','ajuste')),
  quantidade numeric not null,        -- sempre positivo; o sinal é resolvido pela view abaixo
  delta numeric,                      -- usado só em 'ajuste': pode ser positivo ou negativo
  usuario_id uuid not null references usuarios(id),
  retiro_id uuid references retiros(id),          -- só preenchido em saídas
  retiro_nome_snapshot text,
  item_nome_snapshot text,            -- nome do item no momento do registro (histórico legível)
  lote_codigo_snapshot text,          -- código do lote no momento do registro
  usuario_nome_snapshot text,
  observacao text,
  data_hora timestamptz not null default now(),
  criado_em timestamptz not null default now()
);
create index if not exists idx_mov_fazenda on movimentacoes(fazenda_id);
create index if not exists idx_mov_lote on movimentacoes(lote_id);
create index if not exists idx_mov_item on movimentacoes(item_id);
create index if not exists idx_mov_usuario on movimentacoes(usuario_id);
create index if not exists idx_mov_retiro on movimentacoes(retiro_id);
create index if not exists idx_mov_data on movimentacoes(data_hora desc);

-- ---------- ESTOQUE (calculado) ----------
create or replace view estoque_lote as
select
  lote_id,
  sum(
    case
      when tipo = 'entrada' then quantidade
      when tipo = 'saida'   then -quantidade
      when tipo = 'ajuste'  then coalesce(delta, 0)
      else 0
    end
  ) as quantidade
from movimentacoes
group by lote_id;

create or replace view estoque_item as
select
  item_id,
  sum(
    case
      when tipo = 'entrada' then quantidade
      when tipo = 'saida'   then -quantidade
      when tipo = 'ajuste'  then coalesce(delta, 0)
      else 0
    end
  ) as quantidade
from movimentacoes
group by item_id;

-- Views prontas para consulta: lote/item já com a quantidade somada.
create or replace view lotes_com_estoque as
select l.*, coalesce(e.quantidade, 0) as quantidade
from lotes l
left join estoque_lote e on e.lote_id = l.id;

create or replace view itens_com_estoque as
select i.*, coalesce(e.quantidade, 0) as quantidade
from itens i
left join estoque_item e on e.item_id = i.id;

-- ============================================================
-- ROW LEVEL SECURITY
-- O login é feito dentro do próprio app (código da fazenda + nome +
-- PIN de 4 dígitos), não pelo sistema de autenticação do Supabase.
-- Por isso as políticas abaixo liberam leitura/escrita para quem
-- tiver a chave "anon" do projeto (a mesma chave pública usada pelo
-- app). O isolamento entre fazendas é feito pelo próprio app
-- (filtrando tudo por fazenda_id) — não é uma trava a nível de banco.
-- Veja a nota de segurança no README antes de publicar o app.
-- ============================================================
alter table fazendas enable row level security;
alter table usuarios enable row level security;
alter table itens enable row level security;
alter table lotes enable row level security;
alter table retiros enable row level security;
alter table movimentacoes enable row level security;

create policy "fazendas: leitura publica" on fazendas for select using (true);
create policy "fazendas: escrita publica" on fazendas for insert with check (true);

create policy "usuarios: leitura publica" on usuarios for select using (true);
create policy "usuarios: escrita publica" on usuarios for insert with check (true);
create policy "usuarios: atualizacao publica" on usuarios for update using (true);

create policy "itens: leitura publica" on itens for select using (true);
create policy "itens: escrita publica" on itens for insert with check (true);
create policy "itens: atualizacao publica" on itens for update using (true);

create policy "lotes: leitura publica" on lotes for select using (true);
create policy "lotes: escrita publica" on lotes for insert with check (true);
create policy "lotes: atualizacao publica" on lotes for update using (true);

create policy "retiros: leitura publica" on retiros for select using (true);
create policy "retiros: escrita publica" on retiros for insert with check (true);
create policy "retiros: atualizacao publica" on retiros for update using (true);

create policy "movimentacoes: leitura publica" on movimentacoes for select using (true);
create policy "movimentacoes: escrita publica" on movimentacoes for insert with check (true);

-- Mantém atualizado_em em dia quando um item é editado
create or replace function set_atualizado_em()
returns trigger as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_itens_atualizado_em on itens;
create trigger trg_itens_atualizado_em
  before update on itens
  for each row execute function set_atualizado_em();
