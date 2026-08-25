// ============================================================
// Camada de dados local — IndexedDB (via Dexie) + fila de sincronização.
//
// Regra de ouro deste app: TODA gravação (fazenda, item, lote, entrada,
// saída, ajuste, cadastrar/editar usuário/retiro) escreve primeiro aqui
// no celular, na hora, esteja online ou não. Depois, em segundo plano,
// o app tenta mandar essa gravação para o Supabase. Se não conseguir
// (sem sinal), ela fica guardada em `pendingOps` e é reenviada
// automaticamente quando a conexão voltar — sem precisar reabrir o app.
//
// A quantidade em estoque NUNCA é um número salvo: ela é sempre a soma
// das movimentações daquele lote (mesma fórmula usada nas views SQL
// `estoque_lote` / `estoque_item`, veja supabase/schema.sql). Isso é o
// que permite dois celulares diferentes darem baixa no mesmo lote
// offline, ao mesmo tempo, sem um "atropelar" o outro quando
// sincronizarem: cada movimentação é um registro novo e independente,
// nunca uma edição.
//
// Isolamento por fazenda: cada linha de usuarios/itens/lotes/retiros/
// movimentacoes tem um fazendaId. As funções de leitura aqui retornam
// TUDO que está no cache local (todas as fazendas que já passaram por
// este dispositivo); quem filtra pela fazenda do usuário logado é a
// camada de UI (src/ui/app.js), do mesmo jeito que o protótipo faz.
// ============================================================

import Dexie from 'dexie';
import { supabase } from './supabase.js';

export const db = new Dexie('farmStockDB');
db.version(1).stores({
  fazendas: 'id, codigo',
  usuarios: 'id, fazendaId, nome, ativo, perfil',
  itens: 'id, fazendaId, codigoItem, nome, categoria',
  lotes: 'id, fazendaId, itemId, codigoLote',
  retiros: 'id, fazendaId, nome, ativo',
  movimentacoes: 'id, fazendaId, loteId, itemId, tipo, usuarioId, retiroId, dataHora',
  pendingOps: '++localId, table, op, createdAt'
});

export function uid() {
  return crypto.randomUUID();
}
export function nowIso() {
  return new Date().toISOString();
}

/* ---------------- status de sincronização (para a UI mostrar um indicador) ---------------- */
const listeners = new Set();
const status = { online: navigator.onLine, syncing: false, pending: 0, lastSyncedAt: null, lastError: null };

function notify() { listeners.forEach(cb => cb({ ...status })); }
export function onSyncStatusChange(cb) { listeners.add(cb); cb({ ...status }); return () => listeners.delete(cb); }
async function refreshPendingCount() {
  status.pending = await db.pendingOps.count();
  notify();
}

window.addEventListener('online', () => { status.online = true; notify(); flushPending(); });
window.addEventListener('offline', () => { status.online = false; notify(); });

/* ---------------- mapeamento camelCase (app) <-> snake_case (Supabase) ---------------- */
const mappers = {
  fazendas: {
    toRow: f => ({ id: f.id, nome: f.nome, codigo: f.codigo, criado_em: f.criadoEm }),
    fromRow: r => ({ id: r.id, nome: r.nome, codigo: r.codigo, criadoEm: r.criado_em }),
  },
  usuarios: {
    toRow: u => ({ id: u.id, fazenda_id: u.fazendaId, nome: u.nome, pin: u.pin, perfil: u.perfil, ativo: u.ativo, criado_em: u.criadoEm }),
    fromRow: r => ({ id: r.id, fazendaId: r.fazenda_id, nome: r.nome, pin: r.pin, perfil: r.perfil, ativo: r.ativo, criadoEm: r.criado_em }),
  },
  itens: {
    toRow: i => ({
      id: i.id, fazenda_id: i.fazendaId, codigo_item: i.codigoItem, nome: i.nome, categoria: i.categoria,
      unidade: i.unidade, estoque_minimo: i.estoqueMinimo, foto: i.foto ?? null, criado_em: i.criadoEm
    }),
    fromRow: r => ({
      id: r.id, fazendaId: r.fazenda_id, codigoItem: r.codigo_item, nome: r.nome, categoria: r.categoria,
      unidade: r.unidade, estoqueMinimo: Number(r.estoque_minimo), foto: r.foto ?? null, criadoEm: r.criado_em
    }),
  },
  lotes: {
    toRow: l => ({ id: l.id, fazenda_id: l.fazendaId, item_id: l.itemId, codigo_lote: l.codigoLote, validade: l.validade, criado_em: l.criadoEm }),
    fromRow: r => ({ id: r.id, fazendaId: r.fazenda_id, itemId: r.item_id, codigoLote: r.codigo_lote, validade: r.validade, criadoEm: r.criado_em }),
  },
  retiros: {
    toRow: r => ({ id: r.id, fazenda_id: r.fazendaId, nome: r.nome, ativo: r.ativo, criado_em: r.criadoEm }),
    fromRow: r => ({ id: r.id, fazendaId: r.fazenda_id, nome: r.nome, ativo: r.ativo, criadoEm: r.criado_em }),
  },
  movimentacoes: {
    toRow: m => ({
      id: m.id, fazenda_id: m.fazendaId, lote_id: m.loteId, item_id: m.itemId, tipo: m.tipo,
      quantidade: m.quantidade, delta: m.delta ?? null, usuario_id: m.usuarioId,
      retiro_id: m.retiroId ?? null, retiro_nome_snapshot: m.retiroNomeSnapshot ?? null,
      item_nome_snapshot: m.itemNomeSnapshot, lote_codigo_snapshot: m.loteCodigoSnapshot,
      usuario_nome_snapshot: m.usuarioNomeSnapshot, observacao: m.observacao, data_hora: m.dataHora
    }),
    fromRow: r => ({
      id: r.id, fazendaId: r.fazenda_id, loteId: r.lote_id, itemId: r.item_id, tipo: r.tipo,
      quantidade: Number(r.quantidade), delta: r.delta === null ? null : Number(r.delta), usuarioId: r.usuario_id,
      retiroId: r.retiro_id ?? null, retiroNomeSnapshot: r.retiro_nome_snapshot ?? null,
      itemNomeSnapshot: r.item_nome_snapshot, loteCodigoSnapshot: r.lote_codigo_snapshot,
      usuarioNomeSnapshot: r.usuario_nome_snapshot, observacao: r.observacao, dataHora: r.data_hora
    }),
  },
};

/* ---------------- fila de gravações pendentes ---------------- */
async function enqueue(table, op, payload) {
  await db.pendingOps.add({ table, op, payload, createdAt: Date.now() });
  await refreshPendingCount();
  flushPending(); // tenta mandar agora; se falhar, fica na fila para a próxima tentativa
}

let flushing = false;
export async function flushPending() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  status.syncing = true; notify();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const next = await db.pendingOps.orderBy('createdAt').first();
      if (!next) break;
      const ok = await pushOne(next);
      if (!ok) break; // para na primeira falha (provavelmente caiu a conexão) e tenta de novo depois
      await db.pendingOps.delete(next.localId);
      await refreshPendingCount();
    }
    status.lastError = null;
    await pullAll();
    status.lastSyncedAt = nowIso();
  } finally {
    status.syncing = false;
    notify();
    flushing = false;
  }
}

async function pushOne({ table, op, payload }) {
  try {
    const row = mappers[table].toRow(payload);
    if (op === 'insert') {
      const { error } = await supabase.from(table).upsert(row, { onConflict: 'id' });
      if (error) throw error;
    } else if (op === 'update') {
      const { id, ...rest } = row;
      const { error } = await supabase.from(table).update(rest).eq('id', id);
      if (error) throw error;
    }
    return true;
  } catch (e) {
    status.lastError = e.message || String(e);
    return false;
  }
}

/* ---------------- puxar dados do servidor para o cache local ---------------- */
export async function pullAll() {
  try {
    const [
      { data: fazendas, error: e1 }, { data: usuarios, error: e2 }, { data: itens, error: e3 },
      { data: lotes, error: e4 }, { data: retiros, error: e5 }, { data: movs, error: e6 },
    ] = await Promise.all([
      supabase.from('fazendas').select('*'),
      supabase.from('usuarios').select('*'),
      supabase.from('itens').select('*'),
      supabase.from('lotes').select('*'),
      supabase.from('retiros').select('*'),
      supabase.from('movimentacoes').select('*').order('data_hora', { ascending: false }),
    ]);
    if (e1) throw e1; if (e2) throw e2; if (e3) throw e3; if (e4) throw e4; if (e5) throw e5; if (e6) throw e6;
    await db.transaction('rw', db.fazendas, db.usuarios, db.itens, db.lotes, db.retiros, db.movimentacoes, async () => {
      await db.fazendas.bulkPut(fazendas.map(mappers.fazendas.fromRow));
      await db.usuarios.bulkPut(usuarios.map(mappers.usuarios.fromRow));
      await db.itens.bulkPut(itens.map(mappers.itens.fromRow));
      await db.lotes.bulkPut(lotes.map(mappers.lotes.fromRow));
      await db.retiros.bulkPut(retiros.map(mappers.retiros.fromRow));
      await db.movimentacoes.bulkPut(movs.map(mappers.movimentacoes.fromRow));
    });
    return true;
  } catch (e) {
    status.lastError = e.message || String(e);
    return false;
  }
}

/* ---------------- API usada pela interface ---------------- */
// Todas essas funções: gravam local na hora (o app nunca espera a rede) e
// enfileiram o envio para o Supabase.

export async function criarFazenda(dados) {
  const fazenda = { id: uid(), criadoEm: nowIso(), ...dados };
  await db.fazendas.put(fazenda);
  await enqueue('fazendas', 'insert', fazenda);
  return fazenda;
}

export async function criarUsuario(dados) {
  const usuario = { id: uid(), ativo: true, criadoEm: nowIso(), ...dados };
  await db.usuarios.put(usuario);
  await enqueue('usuarios', 'insert', usuario);
  return usuario;
}
export async function atualizarUsuario(id, mudancas) {
  await db.usuarios.update(id, mudancas);
  const atual = await db.usuarios.get(id);
  await enqueue('usuarios', 'update', atual);
  return atual;
}

export async function criarItem(dados) {
  const item = { id: uid(), criadoEm: nowIso(), ...dados };
  await db.itens.put(item);
  await enqueue('itens', 'insert', item);
  return item;
}
export async function atualizarItem(id, mudancas) {
  await db.itens.update(id, mudancas);
  const atual = await db.itens.get(id);
  await enqueue('itens', 'update', atual);
  return atual;
}

export async function criarLote(dados) {
  const lote = { id: uid(), criadoEm: nowIso(), ...dados };
  await db.lotes.put(lote);
  await enqueue('lotes', 'insert', lote);
  return lote;
}
export async function atualizarLote(id, mudancas) {
  await db.lotes.update(id, mudancas);
  const atual = await db.lotes.get(id);
  await enqueue('lotes', 'update', atual);
  return atual;
}

export async function criarRetiro(dados) {
  const retiro = { id: uid(), ativo: true, criadoEm: nowIso(), ...dados };
  await db.retiros.put(retiro);
  await enqueue('retiros', 'insert', retiro);
  return retiro;
}
export async function atualizarRetiro(id, mudancas) {
  await db.retiros.update(id, mudancas);
  const atual = await db.retiros.get(id);
  await enqueue('retiros', 'update', atual);
  return atual;
}

export async function registrarMovimentacao(dados) {
  const mov = { id: uid(), dataHora: nowIso(), ...dados };
  await db.movimentacoes.put(mov);
  await enqueue('movimentacoes', 'insert', mov);
  return mov;
}

/* ---------------- leituras (sempre do cache local — instantâneo, funciona offline) ---------------- */
// Retornam TODOS os registros já sincronizados neste dispositivo; a UI
// filtra pela fazenda do usuário logado (fazendaId).
export async function listarFazendas() { return db.fazendas.toArray(); }
export async function listarUsuarios() { return db.usuarios.toArray(); }
export async function listarItens() { return db.itens.toArray(); }
export async function listarLotes() { return db.lotes.toArray(); }
export async function listarRetiros() { return db.retiros.toArray(); }
export async function listarMovimentacoes() { return db.movimentacoes.orderBy('dataHora').reverse().toArray(); }

/* ---------------- inicialização ---------------- */
export async function initSync() {
  await refreshPendingCount();
  // Primeira tentativa de sincronizar ao abrir o app (não bloqueia a tela:
  // a interface já lê do IndexedDB local enquanto isso roda em paralelo).
  flushPending();
  // Rede de segurança: tenta de novo periodicamente, caso o evento 'online'
  // do navegador não dispare (acontece às vezes em wi-fi instável de fazenda).
  setInterval(() => { if (navigator.onLine) flushPending(); }, 30000);
}
