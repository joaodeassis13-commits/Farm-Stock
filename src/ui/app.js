import {
  initSync, onSyncStatusChange, uid, nowIso,
  listarFazendas, listarUsuarios, listarItens, listarLotes, listarRetiros, listarMovimentacoes,
  criarFazenda, criarUsuario, atualizarUsuario, criarItem, atualizarItem, criarLote, atualizarLote,
  criarRetiro, atualizarRetiro, registrarMovimentacao,
} from '../db/local.js';
import { startScanner, stopScanner } from './scanner.js';

/* ================= DIAGNÓSTICO DE ERROS (mostra na tela em vez de só no console) ================= */
function showFatalError(msg){
  let banner = document.getElementById('fatalError');
  if(!banner){
    banner = document.createElement('div');
    banner.id = 'fatalError';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#a13f2b;color:#fff;padding:10px 14px;font-size:12px;font-family:monospace;white-space:pre-wrap;word-break:break-word;box-shadow:0 2px 10px rgba(0,0,0,.3);';
    document.body.appendChild(banner);
  }
  banner.textContent = '⚠ Erro no app — copie este texto e envie: ' + msg;
}
window.addEventListener('error', (e)=>{
  if(!e.message || e.message==='Script error.' || e.message==='Script error'){
    console.warn('Erro externo sem detalhe (ignorado, não afeta o app):', { filename: e.filename, lineno: e.lineno, colno: e.colno });
    return;
  }
  showFatalError(e.message + ' (linha ' + e.lineno + ')');
});
window.addEventListener('unhandledrejection', (e)=>{ showFatalError((e.reason && e.reason.message) || String(e.reason) || 'Erro desconhecido (promise)'); });

/* ================= STATE ================= */
const State = {
  fazendas: [], usuarios: [], itens: [], lotes: [], movimentacoes: [], retiros: [],
  currentUser: null,
  screen: 'inicio',
  pinBuffer: '', pinTargetUser: null, pinError: false,
  loading: true,
  toastTimer: null,
  scanMode: null,
  modalOpen: false,
  estoqueSearch: '', estoqueFilter: 'todos',
  histFilters: { tipo: 'todos', usuario: 'todos', retiro: 'todos', busca: '' },
  relFilters: { dataIni: '', dataFim: '', tipo: 'todos' },
  syncStatus: { online: navigator.onLine, syncing: false, pending: 0 },
  carrinho: [],
  carrinhoRetiroId: '',
  carrinhoObs: '',
  loginFazendaId: null,
  loginModoNovaFazenda: false,
};

const EXPIRY_WARNING_DAYS = 30;
const CATEGORIAS = ['Antibiótico','Anti-inflamatório','Vermífugo','Vacina','Vitamínico / Suplemento','Hormônio / Reprodução','Material de curativo','Antisséptico','Ferramenta / Utensílio','Outros'];
const UNIDADES = ['un','ml','L','mg','g','kg','comp','dose','frasco','caixa','ampola'];

/* ================= DATA ================= */
async function refreshData() {
  const [fazendas, usuarios, itens, lotes, retiros, movimentacoes] = await Promise.all([
    listarFazendas(), listarUsuarios(), listarItens(), listarLotes(), listarRetiros(), listarMovimentacoes(),
  ]);
  State.fazendas = fazendas; State.usuarios = usuarios; State.itens = itens; State.lotes = lotes;
  State.retiros = retiros; State.movimentacoes = movimentacoes;
}

function handleSyncStatus(s) {
  State.syncStatus = s;
  if (!State.currentUser) { refreshData(); return; }
  if (State.modalOpen) { updateSyncBarDom(s); return; }
  if (!s.syncing) { refreshData().then(() => softRefreshScreen()); }
  else { updateSyncBarDom(s); }
}

/* ================= HELPERS ================= */
function isGestor(){ return !!(State.currentUser && State.currentUser.perfil==='gestor'); }
function fzId(){ return State.currentUser ? State.currentUser.fazendaId : null; }
function itensDaFazenda(){ return State.itens.filter(i=>i.fazendaId===fzId()); }
function lotesDaFazenda(){ return State.lotes.filter(l=>l.fazendaId===fzId()); }
function movimentacoesDaFazenda(){ return State.movimentacoes.filter(m=>m.fazendaId===fzId()); }
function retirosDaFazenda(){ return State.retiros.filter(r=>r.fazendaId===fzId()); }
function usuariosDaFazenda(){ return State.usuarios.filter(u=>u.fazendaId===fzId()); }

function daysUntil(dateStr){
  if(!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr+'T00:00:00');
  return Math.round((d-today)/(1000*60*60*24));
}
function loteExpiryStatus(lote){
  if(!lote || !lote.validade) return null;
  const dias = daysUntil(lote.validade);
  if(dias<0) return 'vencido';
  if(dias<=EXPIRY_WARNING_DAYS) return 'vencendo';
  return 'ok';
}
function fmtValidade(dateStr){ if(!dateStr) return null; return new Date(dateStr+'T00:00:00').toLocaleDateString('pt-BR'); }
function fmtDateTime(iso){ const d=new Date(iso); return d.toLocaleDateString('pt-BR')+' às '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }
function fmtNum(n){ const v=Number(n); return (Math.round(v*100)/100).toLocaleString('pt-BR'); }
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showToast(msg){
  clearTimeout(State.toastTimer);
  let t = document.getElementById('toast');
  if(!t){ t=document.createElement('div'); t.id='toast'; t.className='toast'; document.getElementById('app').appendChild(t); }
  t.textContent = msg; t.classList.remove('hidden');
  State.toastTimer = setTimeout(()=>{ t.classList.add('hidden'); }, 2600);
}

/* Lê um arquivo de imagem, redimensiona e comprime antes de guardar (evita fotos gigantes) */
function readAndCompressImage(file, maxDim=480, quality=0.72){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>{
      const img = new Image();
      img.onload = ()=>{
        let w = img.width, h = img.height;
        if(w>h){ if(w>maxDim){ h=Math.round(h*maxDim/w); w=maxDim; } }
        else { if(h>maxDim){ w=Math.round(w*maxDim/h); h=maxDim; } }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = ()=> reject(new Error('Não foi possível ler a imagem.'));
      img.src = reader.result;
    };
    reader.onerror = ()=> reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}
function renderPhotoField(fieldId, currentFoto){
  return `
  <div class="field">
    <label>Foto do item (opcional, ajuda quem tem dificuldade de leitura)</label>
    <div class="photo-upload">
      <div class="photo-preview" id="${fieldId}Preview">${currentFoto? `<img src="${currentFoto}" alt="">` : `<span class="photo-placeholder">📷</span>`}</div>
      <div class="photo-actions">
        <input type="file" accept="image/*" capture="environment" id="${fieldId}Input" class="hidden">
        <button type="button" class="btn btn-outline" id="${fieldId}Btn">Tirar / escolher foto</button>
        <button type="button" class="btn btn-ghost ${currentFoto?'':'hidden'}" id="${fieldId}RemoveBtn">Remover foto</button>
      </div>
    </div>
  </div>`;
}
function wirePhotoField(fieldId, initialFoto){
  let foto = initialFoto || null;
  const input = document.getElementById(fieldId+'Input');
  const btn = document.getElementById(fieldId+'Btn');
  const removeBtn = document.getElementById(fieldId+'RemoveBtn');
  const preview = document.getElementById(fieldId+'Preview');
  if(btn) btn.onclick = ()=> input.click();
  if(input) input.onchange = async ()=>{
    const file = input.files && input.files[0];
    if(!file) return;
    try{
      foto = await readAndCompressImage(file);
      preview.innerHTML = `<img src="${foto}" alt="">`;
      if(removeBtn) removeBtn.classList.remove('hidden');
    }catch(e){ showToast('Não foi possível usar essa imagem.'); }
    input.value = '';
  };
  if(removeBtn) removeBtn.onclick = ()=>{
    foto = null;
    preview.innerHTML = `<span class="photo-placeholder">📷</span>`;
    removeBtn.classList.add('hidden');
  };
  return { getFoto: ()=> foto };
}

/* ================= CÁLCULO DE ESTOQUE (item = soma dos lotes; lote = soma das movimentações) ================= */
function calcularQuantidadeLote(loteId){
  return State.movimentacoes.reduce((total,m)=>{
    if(m.loteId!==loteId) return total;
    if(m.tipo==='entrada') return total + Number(m.quantidade);
    if(m.tipo==='saida') return total - Number(m.quantidade);
    if(m.tipo==='ajuste') return total + Number(m.delta||0);
    return total;
  }, 0);
}
function calcularQuantidadeItem(itemId){
  return State.movimentacoes.reduce((total,m)=>{
    if(m.itemId!==itemId) return total;
    if(m.tipo==='entrada') return total + Number(m.quantidade);
    if(m.tipo==='saida') return total - Number(m.quantidade);
    if(m.tipo==='ajuste') return total + Number(m.delta||0);
    return total;
  }, 0);
}
function itensComEstoque(){
  return itensDaFazenda().map(i=> ({ ...i, quantidade: calcularQuantidadeItem(i.id) }));
}
function lotesDoItem(itemId){
  return lotesDaFazenda().filter(l=>l.itemId===itemId).map(l=> ({ ...l, quantidade: calcularQuantidadeLote(l.id) }));
}
function lotesComEstoque(){
  return lotesDaFazenda().map(l=> ({ ...l, quantidade: calcularQuantidadeLote(l.id) }));
}
function itemExpiryStatus(itemId){
  const lotes = lotesDoItem(itemId).filter(l=>l.quantidade>0 && l.validade);
  if(lotes.length===0) return null;
  let pior = null, piorDias = Infinity;
  lotes.forEach(l=>{
    const est = loteExpiryStatus(l);
    const dias = daysUntil(l.validade);
    if(est==='vencido'){ pior='vencido'; if(dias<piorDias) piorDias=dias; }
    else if(est==='vencendo' && pior!=='vencido'){ pior='vencendo'; if(dias<piorDias) piorDias=dias; }
  });
  return pior ? { status: pior, dias: piorDias } : null;
}

/* ================= SYNC BAR ================= */
function renderSyncBar(s){
  if(!s.online) return `<div id="syncBar" class="sync-bar offline">📴 Sem conexão — as alterações são enviadas quando a rede voltar${s.pending? ' · '+s.pending+' pendente'+(s.pending>1?'s':''):''}</div>`;
  if(s.syncing || s.pending>0) return `<div id="syncBar" class="sync-bar">🔄 Sincronizando${s.pending? ' · '+s.pending+' pendente'+(s.pending>1?'s':''):''}…</div>`;
  return `<div id="syncBar" class="sync-bar hidden"></div>`;
}
function updateSyncBarDom(s){
  const el = document.getElementById('syncBar');
  if(!el) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = renderSyncBar(s);
  el.replaceWith(wrap.firstElementChild);
}

/* ================= RENDER ROOT ================= */
function render(){
  const app = document.getElementById('app');
  if(State.loading){
    app.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;color:var(--ink-soft);font-size:13.5px;">Carregando…</div>`;
    return;
  }
  if(!State.currentUser){
    app.innerHTML = renderLogin();
    attachLoginEvents();
    return;
  }
  app.innerHTML = `
    ${renderTopbar()}
    ${renderSyncBar(State.syncStatus)}
    <main class="screen" id="screenRoot"></main>
    ${renderBottomNav()}
  `;
  const root = document.getElementById('screenRoot');
  if(State.screen==='inicio') root.innerHTML = renderInicio();
  if(State.screen==='estoque') root.innerHTML = renderEstoque();
  if(State.screen==='historico') root.innerHTML = renderHistorico();
  if(State.screen==='usuarios' && isGestor()) root.innerHTML = renderUsuarios();
  if(State.screen==='retiros' && isGestor()) root.innerHTML = renderRetiros();
  if(State.screen==='relatorios') root.innerHTML = renderRelatorios();
  attachScreenEvents();
}

function softRefreshScreen(){
  const root = document.getElementById('screenRoot');
  if(!root) return;
  const active = document.activeElement;
  const activeId = active && active.id ? active.id : null;
  const selStart = active && active.selectionStart!=null ? active.selectionStart : null;
  if(State.screen==='inicio') root.innerHTML = renderInicio();
  else if(State.screen==='estoque') root.innerHTML = renderEstoque();
  else if(State.screen==='historico') root.innerHTML = renderHistorico();
  else if(State.screen==='usuarios' && isGestor()) root.innerHTML = renderUsuarios();
  else if(State.screen==='retiros' && isGestor()) root.innerHTML = renderRetiros();
  else if(State.screen==='relatorios') root.innerHTML = renderRelatorios();
  attachScreenEvents();
  updateSyncBarDom(State.syncStatus);
  if(activeId){ const el=document.getElementById(activeId); if(el){ el.focus(); if(selStart!=null && el.setSelectionRange){ try{ el.setSelectionRange(selStart,selStart); }catch(e){} } } }
}

/* ================= LOGIN ================= */
function renderLogin(){
  if(!State.loginFazendaId){
    if(State.loginModoNovaFazenda){
      return `
      <div id="screen-login">
        <div class="login-hero"><img class="cross-big" src="/icons/icon-192.png" alt="Farm Stock"><h1>Farm Stock</h1><p>Controle de estoque de medicamentos e insumos</p></div>
        <div class="card">
          <h3 style="margin-top:0;font-size:15px;">Cadastrar nova fazenda</h3>
          <p style="font-size:12.5px;color:var(--ink-soft);margin-top:-6px;">Cada fazenda tem seus próprios itens, usuários e retiros — nenhuma vê os dados da outra.</p>
          <div class="field"><label>Nome da fazenda</label><input id="fzNome" placeholder="Ex.: Fazenda Santa Rita"></div>
          <div class="field"><label>Código de acesso da fazenda</label><input id="fzCodigo" placeholder="Ex.: SANTARITA" class="mono"></div>
          <p style="font-size:11.5px;color:var(--ink-soft);margin-top:-8px;">Esse código é o que os usuários dessa fazenda vão digitar para entrar. Combine com a equipe e evite espaços.</p>
          <button type="button" class="btn btn-primary" id="fzCriarBtn">Cadastrar fazenda</button>
        </div>
        <div style="margin-top:14px;text-align:center;"><button class="btn btn-ghost" id="fzVoltarBtn">← Já tenho o código de uma fazenda</button></div>
      </div>`;
    }
    return `
    <div id="screen-login">
      <div class="login-hero"><img class="cross-big" src="/icons/icon-192.png" alt="Farm Stock"><h1>Farm Stock</h1><p>Controle de estoque de medicamentos e insumos</p></div>
      <div class="card">
        <h3 style="margin-top:0;font-size:15px;">Entrar na fazenda</h3>
        <div class="field"><label>Código da fazenda</label><input id="fzCodigo" placeholder="Ex.: SANTARITA" class="mono"></div>
        <button type="button" class="btn btn-primary" id="fzEntrarBtn">Entrar</button>
      </div>
      <div style="margin-top:16px;text-align:center;"><button class="btn btn-ghost" id="fzNovaBtn">+ Cadastrar nova fazenda</button></div>
      <div style="position:fixed;left:50%;bottom:40px;transform:translateX(-50%);text-align:center;z-index:5;pointer-events:none;width:125px;">
        <p style="font-size:10.5px;color:var(--ink-soft);margin:0 0 4px;font-weight:500;">Uma solução criada por</p>
        <img src="/logo-visao.png" alt="Visão Agropecuária" style="width:125px;height:auto;opacity:.55;pointer-events:none;display:block;">
      </div>
    </div>`;
  }
  const fazenda = State.fazendas.find(f=>f.id===State.loginFazendaId);
  if(State.pinTargetUser){
    const u = State.pinTargetUser;
    const dots = [0,1,2,3].map(i=>`<span class="${i<State.pinBuffer.length?'filled':''}"></span>`).join('');
    return `
    <div id="screen-login">
      <div class="login-hero">
        <img class="cross-big" src="/icons/icon-192.png" alt="Farm Stock">
        <h1>Farm Stock</h1>
        <p>${fazenda? escapeHtml(fazenda.nome) : ''}</p>
      </div>
      <div class="pin-wrap">
        <div class="pin-user">${escapeHtml(u.nome)}</div>
        <div class="pin-hint">Digite seu código de 4 dígitos</div>
        <div class="pin-dots ${State.pinError?'err':''}">${dots}</div>
        <div class="pad">
          ${[1,2,3,4,5,6,7,8,9].map(n=>`<button data-pin="${n}">${n}</button>`).join('')}
          <button class="wide" data-action="pin-cancel">voltar</button>
          <button data-pin="0">0</button>
          <button class="wide" data-action="pin-back">apagar</button>
        </div>
      </div>
    </div>`;
  }
  const usuariosFazenda = State.usuarios.filter(u=>u.fazendaId===State.loginFazendaId);
  const ativos = usuariosFazenda.filter(u=>u.ativo!==false);
  return `
  <div id="screen-login">
    <div class="login-hero">
      <img class="cross-big" src="/icons/icon-192.png" alt="Farm Stock">
      <h1>Farm Stock</h1>
      <p>${fazenda? escapeHtml(fazenda.nome) : ''}</p>
    </div>
    ${ativos.length===0 ? `
      <div class="card">
        <h3 style="margin-top:0;font-size:15px;">Cadastre o primeiro usuário desta fazenda</h3>
        <p style="font-size:12.5px;color:var(--ink-soft);margin-top:-6px;">Toda entrada e saída fica registrada em nome de quem estiver logado.</p>
        ${renderNovoUsuarioForm('login', State.loginFazendaId)}
      </div>
    ` : `
      <div class="card">
        <h3 style="margin-top:0;font-size:15px;">Quem está usando o sistema?</h3>
        <div class="field"><label>Seu nome</label><input id="loginNomeInput" placeholder="Digite seu nome" autocomplete="off"></div>
        <div id="loginNomeErr"></div>
        <button type="button" class="btn btn-primary" id="loginNomeBtn">Continuar</button>
      </div>
      <p style="font-size:11.5px;color:var(--ink-soft);text-align:center;margin-top:18px;">Seu nome não está cadastrado? Peça a um Gestor desta fazenda para cadastrar seu acesso.</p>
    `}
    <div style="text-align:center;margin-top:18px;"><button class="btn btn-ghost" id="fzTrocarBtn">← Trocar de fazenda</button></div>
  </div>`;
}
function renderNovoUsuarioForm(context, fazendaId){
  const isFirstUser = State.usuarios.filter(u=>u.fazendaId===fazendaId).length===0;
  const submitLabel = context==='login' ? 'Cadastrar e entrar' : 'Cadastrar usuário';
  const showPerfilSelect = !isFirstUser && context==='usuarios';
  return `
  <div id="formNovoUsuario" data-context="${context}" data-first="${isFirstUser?'1':'0'}" data-fazenda="${fazendaId}">
    <div class="field"><label>Nome</label><input id="nuNome" placeholder="Nome completo"></div>
    <div class="field"><label>Código de acesso (4 dígitos)</label><input id="nuPin" inputmode="numeric" maxlength="4" placeholder="0000"></div>
    <div class="field">
      <label>Perfil</label>
      ${isFirstUser? `
        <input value="Gestor" disabled>
        <div style="font-size:11.5px;color:var(--ink-soft);margin-top:5px;">O primeiro usuário de cada fazenda é sempre Gestor.</div>
      ` : showPerfilSelect ? `
        <select id="nuPerfil">
          <option value="operador">Operador — dá entrada e saída</option>
          <option value="gestor">Gestor — também cadastra, corrige estoque e gerencia usuários</option>
        </select>
      ` : `
        <input value="Operador" disabled>
      `}
    </div>
    <button type="button" id="nuSubmitBtn" class="btn btn-primary">${submitLabel}</button>
  </div>`;
}
function attachLoginEvents(){
  const fzEntrarBtn = document.getElementById('fzEntrarBtn');
  if(fzEntrarBtn) fzEntrarBtn.onclick = ()=>{
    const codigo = document.getElementById('fzCodigo').value.trim();
    if(!codigo){ showToast('Informe o código da fazenda.'); return; }
    const fazenda = State.fazendas.find(f=>f.codigo.toLowerCase()===codigo.toLowerCase());
    if(!fazenda){ showToast('Código de fazenda não encontrado.'); return; }
    State.loginFazendaId = fazenda.id; render();
  };
  const fzNovaBtn = document.getElementById('fzNovaBtn');
  if(fzNovaBtn) fzNovaBtn.onclick = ()=>{ State.loginModoNovaFazenda = true; render(); };
  const fzVoltarBtn = document.getElementById('fzVoltarBtn');
  if(fzVoltarBtn) fzVoltarBtn.onclick = ()=>{ State.loginModoNovaFazenda = false; render(); };
  const fzCriarBtn = document.getElementById('fzCriarBtn');
  if(fzCriarBtn) fzCriarBtn.onclick = async ()=>{
    const nome = document.getElementById('fzNome').value.trim();
    const codigo = document.getElementById('fzCodigo').value.trim();
    if(!nome){ showToast('Informe o nome da fazenda.'); return; }
    if(!codigo){ showToast('Informe o código de acesso da fazenda.'); return; }
    if(State.fazendas.some(f=>f.codigo.toLowerCase()===codigo.toLowerCase())){ showToast('Já existe uma fazenda com esse código.'); return; }
    const fazenda = await criarFazenda({ nome, codigo });
    await refreshData();
    State.loginModoNovaFazenda = false;
    State.loginFazendaId = fazenda.id;
    render();
  };
  const fzTrocarBtn = document.getElementById('fzTrocarBtn');
  if(fzTrocarBtn) fzTrocarBtn.onclick = ()=>{ State.loginFazendaId = null; State.loginModoNovaFazenda = false; render(); };

  const loginNomeBtn = document.getElementById('loginNomeBtn');
  const loginNomeInput = document.getElementById('loginNomeInput');
  const buscarUsuario = ()=>{
    const nome = loginNomeInput.value.trim();
    const errBox = document.getElementById('loginNomeErr');
    if(!nome){ errBox.innerHTML = `<div class="scan-error">Digite seu nome.</div>`; return; }
    const usuariosFazenda = State.usuarios.filter(u=>u.fazendaId===State.loginFazendaId && u.ativo!==false);
    const encontrado = usuariosFazenda.find(u=>u.nome.toLowerCase()===nome.toLowerCase());
    if(!encontrado){ errBox.innerHTML = `<div class="scan-error">Nome não encontrado nesta fazenda. Confira a digitação ou peça a um Gestor para cadastrar seu acesso.</div>`; return; }
    State.pinTargetUser = encontrado; State.pinBuffer=''; State.pinError=false; render();
  };
  if(loginNomeBtn) loginNomeBtn.onclick = buscarUsuario;
  if(loginNomeInput){
    loginNomeInput.focus();
    loginNomeInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); buscarUsuario(); } });
  }
  attachFormNovoUsuario();
  document.querySelectorAll('[data-pin]').forEach(el=>{
    el.onclick = ()=>{
      if(State.pinBuffer.length>=4) return;
      State.pinBuffer += el.dataset.pin;
      State.pinError = false;
      if(State.pinBuffer.length===4){
        if(State.pinBuffer === State.pinTargetUser.pin){
          State.currentUser = State.pinTargetUser;
          State.pinTargetUser = null; State.pinBuffer=''; State.screen='inicio';
          render();
          return;
        } else {
          State.pinError = true;
          render();
          setTimeout(()=>{ State.pinBuffer=''; render(); }, 500);
          return;
        }
      }
      render();
    };
  });
  const back = document.querySelector('[data-action="pin-back"]');
  if(back) back.onclick = ()=>{ State.pinBuffer = State.pinBuffer.slice(0,-1); State.pinError=false; render(); };
  const cancel = document.querySelector('[data-action="pin-cancel"]');
  if(cancel) cancel.onclick = ()=>{ State.pinTargetUser=null; State.pinBuffer=''; render(); };
}
function attachFormNovoUsuario(){
  const f = document.getElementById('formNovoUsuario');
  const btn = document.getElementById('nuSubmitBtn');
  if(!f || !btn) return;
  const submit = async ()=>{
    const nome = document.getElementById('nuNome').value.trim();
    const pin = document.getElementById('nuPin').value.trim();
    const fazendaId = f.dataset.fazenda;
    if(!nome || !/^[0-9]{4}$/.test(pin)){ showToast('Informe nome e um código de 4 dígitos.'); return; }
    if(State.usuarios.some(u=>u.fazendaId===fazendaId && u.nome.toLowerCase()===nome.toLowerCase() && u.ativo!==false)){ showToast('Já existe um usuário ativo com esse nome nesta fazenda.'); return; }
    const isFirstUser = f.dataset.first==='1';
    const perfilSel = document.getElementById('nuPerfil');
    const perfil = isFirstUser ? 'gestor' : (perfilSel ? perfilSel.value : 'operador');
    const novo = await criarUsuario({ fazendaId, nome, pin, perfil });
    await refreshData();
    const ctx = f.dataset.context;
    if(ctx==='login'){ State.currentUser = novo; State.screen='inicio'; render(); }
    else { render(); showToast('Usuário cadastrado.'); }
  };
  btn.onclick = submit;
  ['nuNome','nuPin'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); submit(); } });
  });
}

/* ================= TOPBAR / NAV ================= */
function renderTopbar(){
  const fazenda = State.fazendas.find(f=>f.id===State.currentUser.fazendaId);
  return `
  <header class="topbar">
    <div class="brand">
      <img class="cross" src="/icons/icon-192.png" alt="Farm Stock">
      <div class="titles">
        <div class="t1">${escapeHtml(fazenda ? fazenda.nome : 'Farm Stock')}</div>
        <div class="t2">${escapeHtml(State.currentUser.nome)} · ${State.currentUser.perfil==='gestor'?'Gestor':'Operador'}</div>
      </div>
    </div>
    <button class="icon-btn" data-action="goto-relatorios" title="Relatórios">📄</button>
    ${isGestor()? `<button class="icon-btn" data-action="goto-retiros" title="Retiros">📍</button>`:''}
    ${isGestor()? `<button class="icon-btn" data-action="goto-usuarios" title="Usuários">👤</button>`:''}
    <button class="icon-btn" data-action="logout" title="Sair">⎋</button>
  </header>`;
}
function renderBottomNav(){
  const items = [
    {k:'inicio', ic:'⌂', lb:'Início'}, {k:'entrada', ic:'↓', lb:'Entrada'},
    {k:'saida', ic:'↑', lb:'Saída'}, {k:'estoque', ic:'▤', lb:'Estoque'}, {k:'historico', ic:'≡', lb:'Histórico'},
  ];
  return `<nav class="bottomnav">${items.map(it=>`
    <button class="${State.screen===it.k?'active':''}" data-nav="${it.k}"><span class="ic">${it.ic}</span>${it.lb}</button>
  `).join('')}</nav>`;
}

/* ================= INÍCIO ================= */
function renderInicio(){
  const itens = itensComEstoque();
  const total = itens.length;
  const baixo = itens.filter(i=>Number(i.quantidade) <= Number(i.estoqueMinimo));
  const lotesAlerta = lotesComEstoque()
    .filter(l=> l.quantidade>0 && (loteExpiryStatus(l)==='vencido' || loteExpiryStatus(l)==='vencendo'))
    .sort((a,b)=> daysUntil(a.validade) - daysUntil(b.validade));
  const recentes = [...movimentacoesDaFazenda()].sort((a,b)=> new Date(b.dataHora)-new Date(a.dataHora)).slice(0,5);
  return `
  <div class="stat-grid">
    <div class="stat"><div class="num">${total}</div><div class="lbl">itens cadastrados</div></div>
    <div class="stat ${baixo.length?'warn':''}"><div class="num">${baixo.length}</div><div class="lbl">estoque baixo</div></div>
    <div class="stat ${lotesAlerta.length?'warn':''}"><div class="num">${lotesAlerta.length}</div><div class="lbl">lotes vencendo/vencidos</div></div>
  </div>
  <div class="section-title">Ações rápidas</div>
  <div class="btn-row">
    <button class="btn btn-primary" data-nav="entrada">↓ Entrada</button>
    <button class="btn btn-rust" data-nav="saida">↑ Saída</button>
  </div>
  ${lotesAlerta.length? `
    <div class="section-title">Lotes vencendo ou vencidos</div>
    ${lotesAlerta.slice(0,6).map(l=> loteAlertCardHtml(l)).join('')}
  ` : ''}
  ${baixo.length? `
    <div class="section-title">Estoque baixo</div>
    ${baixo.slice(0,6).map(i=> itemCardHtml(i)).join('')}
    ${baixo.length>6? `<div style="text-align:center;margin-top:6px;"><button class="btn btn-ghost" data-nav="estoque">Ver todos</button></div>`:''}
  ` : ''}
  <div class="section-title">Últimas movimentações</div>
  ${recentes.length===0? emptyState('≡','Nenhuma movimentação ainda','Registre uma entrada ou saída para começar.') :
    `<div class="card">${recentes.map(m=>histRowHtml(m)).join('')}</div>`}
  `;
}
function itemCardHtml(item){
  const low = Number(item.quantidade) <= Number(item.estoqueMinimo);
  const est = itemExpiryStatus(item.id);
  const estBadge = est? (est.status==='vencido' ? `<span class="badge badge-vencido">Lote vencido</span>` : `<span class="badge badge-vencendo">Lote vence em ${est.dias}d</span>`) : '';
  const photoHtml = item.foto ? `<img src="${item.foto}" alt="">` : `<span>💊</span>`;
  return `
  <div class="tag-card ${low?'low':''}" data-action="open-item" data-id="${item.id}">
    <div class="tc-photo">${photoHtml}</div>
    <div class="tc-main">
      <div class="tc-name">${escapeHtml(item.nome)}</div>
      <div class="tc-sub">${escapeHtml(item.categoria)} · <span class="mono">${escapeHtml(item.codigoItem)}</span>${estBadge? ' · '+estBadge:''}</div>
    </div>
    <div class="tc-qty"><div class="n">${fmtNum(item.quantidade)}</div><div class="u">${escapeHtml(item.unidade)}</div></div>
  </div>`;
}
function loteAlertCardHtml(lote){
  const item = State.itens.find(i=>i.id===lote.itemId);
  const est = loteExpiryStatus(lote);
  const badge = est==='vencido' ? `<span class="badge badge-vencido">Vencido</span>` : `<span class="badge badge-vencendo">Vence em ${daysUntil(lote.validade)}d</span>`;
  return `
  <div class="tag-card" data-action="open-item" data-id="${lote.itemId}">
    <div class="tc-photo">${item && item.foto? `<img src="${item.foto}" alt="">` : `<span>📦</span>`}</div>
    <div class="tc-main">
      <div class="tc-name">${escapeHtml(item? item.nome : 'Item removido')}</div>
      <div class="tc-sub">Lote <span class="mono">${escapeHtml(lote.codigoLote)}</span> · ${badge}</div>
    </div>
    <div class="tc-qty"><div class="n">${fmtNum(lote.quantidade)}</div><div class="u">${item?escapeHtml(item.unidade):''}</div></div>
  </div>`;
}
function histRowHtml(m){
  const item = State.itens.find(x=>x.id===m.itemId);
  const nome = item ? item.nome : (m.itemNomeSnapshot || 'Item removido');
  const u = State.usuarios.find(x=>x.id===m.usuarioId);
  const uNome = u ? u.nome : (m.usuarioNomeSnapshot || '—');
  const badgeClass = m.tipo==='entrada'?'badge-entrada':(m.tipo==='saida'?'badge-saida':'badge-ajuste');
  const badgeLabel = m.tipo==='entrada'?'Entrada':(m.tipo==='saida'?'Saída':'Ajuste');
  const sign = m.tipo==='saida' ? '−' : (m.tipo==='entrada' ? '+' : (m.delta<0?'−':'+'));
  const retiroTxt = m.retiroNomeSnapshot ? ' · Retiro: '+escapeHtml(m.retiroNomeSnapshot) : '';
  const loteTxt = m.loteCodigoSnapshot ? ' · Lote: '+escapeHtml(m.loteCodigoSnapshot) : '';
  return `
  <div class="hist-row">
    <div class="hr-main">
      <div class="hr-name">${escapeHtml(nome)}</div>
      <div class="hr-meta"><span class="badge ${badgeClass}">${badgeLabel}</span> &nbsp;${escapeHtml(uNome)} · ${fmtDateTime(m.dataHora)}${loteTxt}${retiroTxt}${m.observacao? ' · '+escapeHtml(m.observacao):''}</div>
    </div>
    <div class="hr-qty">${sign}${fmtNum(Math.abs(m.quantidade))}</div>
  </div>`;
}
function emptyState(glyph,title,sub){ return `<div class="empty"><div class="glyph">${glyph}</div><div style="font-weight:700;">${title}</div><p>${sub}</p></div>`; }

/* ================= ESTOQUE ================= */
function renderEstoque(){
  const q = State.estoqueSearch.toLowerCase();
  let list = itensComEstoque().filter(i=> i.nome.toLowerCase().includes(q) || i.codigoItem.toLowerCase().includes(q) || i.categoria.toLowerCase().includes(q));
  if(State.estoqueFilter==='baixo') list = list.filter(i=>Number(i.quantidade)<=Number(i.estoqueMinimo));
  if(State.estoqueFilter==='vencimento') list = list.filter(i=> !!itemExpiryStatus(i.id));
  list = list.sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
  const todosItens = itensComEstoque();
  const countBaixo = todosItens.filter(i=>Number(i.quantidade)<=Number(i.estoqueMinimo)).length;
  const countVenc = todosItens.filter(i=> !!itemExpiryStatus(i.id)).length;
  return `
  <div class="searchbar"><span class="sic">⌕</span><input id="estoqueSearchInput" placeholder="Buscar por nome, código do item ou categoria" value="${escapeHtml(State.estoqueSearch)}"></div>
  <div class="filter-row">
    <button class="chip ${State.estoqueFilter==='todos'?'active':''}" data-estfilter="todos">Todos (${todosItens.length})</button>
    <button class="chip ${State.estoqueFilter==='baixo'?'active':''}" data-estfilter="baixo">Estoque baixo (${countBaixo})</button>
    <button class="chip ${State.estoqueFilter==='vencimento'?'active':''}" data-estfilter="vencimento">Vencendo/vencido (${countVenc})</button>
  </div>
  ${list.length===0? emptyState('▤','Nada por aqui','Nenhum item corresponde à busca, ou o estoque ainda está vazio. Registre uma entrada para cadastrar o primeiro item.') : list.map(i=>itemCardHtml(i)).join('')}
  `;
}

/* ================= HISTÓRICO ================= */
function renderHistorico(){
  const f = State.histFilters;
  let list = [...movimentacoesDaFazenda()].sort((a,b)=> new Date(b.dataHora)-new Date(a.dataHora));
  if(f.tipo!=='todos') list = list.filter(m=>m.tipo===f.tipo);
  if(f.usuario!=='todos') list = list.filter(m=>m.usuarioId===f.usuario);
  if(f.retiro!=='todos') list = list.filter(m=>m.retiroId===f.retiro);
  if(f.busca){
    const q = f.busca.toLowerCase();
    list = list.filter(m=>{
      const item = State.itens.find(x=>x.id===m.itemId);
      const nome = item? item.nome : (m.itemNomeSnapshot||'');
      const loteCod = m.loteCodigoSnapshot||'';
      return nome.toLowerCase().includes(q) || loteCod.toLowerCase().includes(q);
    });
  }
  const movsFazenda = movimentacoesDaFazenda();
  const usuariosComMov = usuariosDaFazenda().filter(u=> movsFazenda.some(m=>m.usuarioId===u.id));
  const retirosComMov = retirosDaFazenda().filter(r=> movsFazenda.some(m=>m.retiroId===r.id));
  return `
  <div class="searchbar"><span class="sic">⌕</span><input id="histSearchInput" placeholder="Buscar por item ou código do lote" value="${escapeHtml(f.busca)}"></div>
  <div class="filter-row">
    <button class="chip ${f.tipo==='todos'?'active':''}" data-histtipo="todos">Todos</button>
    <button class="chip ${f.tipo==='entrada'?'active':''}" data-histtipo="entrada">Entradas</button>
    <button class="chip ${f.tipo==='saida'?'active':''}" data-histtipo="saida">Saídas</button>
    <button class="chip ${f.tipo==='ajuste'?'active':''}" data-histtipo="ajuste">Ajustes</button>
  </div>
  <div class="field" style="margin-bottom:10px;">
    <select id="histUsuarioSelect">
      <option value="todos">Todos os usuários</option>
      ${usuariosComMov.map(u=>`<option value="${u.id}" ${f.usuario===u.id?'selected':''}>${escapeHtml(u.nome)}</option>`).join('')}
    </select>
  </div>
  ${retirosComMov.length? `
  <div class="field" style="margin-bottom:14px;">
    <select id="histRetiroSelect">
      <option value="todos">Todos os retiros</option>
      ${retirosComMov.map(r=>`<option value="${r.id}" ${f.retiro===r.id?'selected':''}>${escapeHtml(r.nome)}</option>`).join('')}
    </select>
  </div>` : ''}
  ${list.length===0? emptyState('≡','Nenhuma movimentação encontrada','Ajuste os filtros ou registre uma entrada/saída.') : `<div class="card">${list.map(m=>histRowHtml(m)).join('')}</div>`}
  `;
}

/* ================= USUÁRIOS ================= */
function renderUsuarios(){
  const daFazenda = usuariosDaFazenda();
  const ativos = daFazenda.filter(u=>u.ativo!==false);
  const inativos = daFazenda.filter(u=>u.ativo===false);
  return `
  <div class="section-title">Usuários ativos</div>
  ${ativos.map(u=>`
    <div class="tag-card" style="flex-wrap:wrap;">
      <div class="tc-main">
        <div class="tc-name">${escapeHtml(u.nome)}${u.id===State.currentUser.id?' <span style="color:var(--ink-soft);font-weight:500;font-size:12px;">(você)</span>':''}</div>
        <div class="tc-sub"><span class="badge badge-perfil ${u.perfil==='operador'?'operador':''}">${u.perfil==='gestor'?'Gestor':'Operador'}</span></div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <select data-action="mudar-perfil" data-id="${u.id}" style="padding:7px 8px;border-radius:8px;border:1px solid var(--line);font-size:12px;">
          <option value="operador" ${u.perfil==='operador'?'selected':''}>Operador</option>
          <option value="gestor" ${u.perfil==='gestor'?'selected':''}>Gestor</option>
        </select>
        ${u.id!==State.currentUser.id? `<button class="btn btn-ghost" style="width:auto;padding:8px 12px;font-size:12px;" data-action="desativar-usuario" data-id="${u.id}">Desativar</button>`:''}
      </div>
    </div>
  `).join('')}
  ${inativos.length? `
    <div class="section-title">Usuários desativados</div>
    ${inativos.map(u=>`
      <div class="tag-card" style="opacity:.6;">
        <div class="tc-main"><div class="tc-name">${escapeHtml(u.nome)}</div><div class="tc-sub">Desativado</div></div>
        <button class="btn btn-ghost" style="width:auto;padding:8px 12px;font-size:12px;" data-action="reativar-usuario" data-id="${u.id}">Reativar</button>
      </div>
    `).join('')}
  ` : ''}
  <div class="section-title">Cadastrar usuário</div>
  <div class="card">${renderNovoUsuarioForm('usuarios', fzId())}</div>
  `;
}

/* ================= RETIROS ================= */
function renderRetiros(){
  const daFazenda = retirosDaFazenda();
  const ativos = daFazenda.filter(r=>r.ativo!==false);
  const inativos = daFazenda.filter(r=>r.ativo===false);
  return `
  <p style="font-size:12.5px;color:var(--ink-soft);margin-top:0;">Retiros são os destinos que aparecem no carrinho de saída. Só um Gestor pode cadastrar um retiro novo.</p>
  <div class="section-title" style="margin-top:0;">Retiros ativos</div>
  ${ativos.length===0? emptyState('📍','Nenhum retiro cadastrado','Cadastre o primeiro retiro no formulário abaixo.') : ativos.map(r=>`
    <div class="tag-card">
      <div class="tc-main"><div class="tc-name">${escapeHtml(r.nome)}</div></div>
      <button class="btn btn-ghost" style="width:auto;padding:8px 12px;font-size:12px;" data-action="desativar-retiro" data-id="${r.id}">Desativar</button>
    </div>
  `).join('')}
  ${inativos.length? `
    <div class="section-title">Retiros desativados</div>
    ${inativos.map(r=>`
      <div class="tag-card" style="opacity:.6;">
        <div class="tc-main"><div class="tc-name">${escapeHtml(r.nome)}</div><div class="tc-sub">Desativado</div></div>
        <button class="btn btn-ghost" style="width:auto;padding:8px 12px;font-size:12px;" data-action="reativar-retiro" data-id="${r.id}">Reativar</button>
      </div>
    `).join('')}
  ` : ''}
  <div class="section-title">Cadastrar retiro</div>
  <div class="card">
    <div class="field"><label>Nome do retiro</label><input id="novoRetiroNome" placeholder="Ex.: Retiro Sede, Retiro da Serra…"></div>
    <button type="button" class="btn btn-primary" id="novoRetiroBtn">Cadastrar retiro</button>
  </div>
  `;
}

/* ================= RELATÓRIOS ================= */
function renderRelatorios(){
  const f = State.relFilters;
  return `
  <div class="section-title" style="margin-top:0;">Estoque atual (por lote)</div>
  <div class="card rel-card">
    <h3>Exportar estoque</h3>
    <p>Gera uma lista com todos os lotes, código do item, quantidade e validade.</p>
    <div class="btn-row">
      <button class="btn btn-outline" id="exportEstoqueCsv">Exportar CSV</button>
      <button class="btn btn-outline" id="printEstoque">Gerar PDF</button>
    </div>
  </div>
  <div class="section-title">Histórico de movimentações</div>
  <div class="card rel-card">
    <h3>Exportar histórico</h3>
    <p>Filtre por período e tipo antes de exportar.</p>
    <div class="rel-grid">
      <div class="field" style="margin-bottom:0;"><label>De</label><input type="date" id="relDataIni" value="${f.dataIni}"></div>
      <div class="field" style="margin-bottom:0;"><label>Até</label><input type="date" id="relDataFim" value="${f.dataFim}"></div>
    </div>
    <div class="field">
      <label>Tipo</label>
      <select id="relTipo">
        <option value="todos" ${f.tipo==='todos'?'selected':''}>Todos</option>
        <option value="entrada" ${f.tipo==='entrada'?'selected':''}>Entradas</option>
        <option value="saida" ${f.tipo==='saida'?'selected':''}>Saídas</option>
        <option value="ajuste" ${f.tipo==='ajuste'?'selected':''}>Ajustes</option>
      </select>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline" id="exportHistCsv">Exportar CSV</button>
      <button class="btn btn-outline" id="printHist">Gerar PDF</button>
    </div>
  </div>
  `;
}
function filteredHistForReport(){
  const f = State.relFilters;
  let list = [...movimentacoesDaFazenda()];
  if(f.tipo!=='todos') list = list.filter(m=>m.tipo===f.tipo);
  if(f.dataIni) list = list.filter(m=> new Date(m.dataHora) >= new Date(f.dataIni+'T00:00:00'));
  if(f.dataFim) list = list.filter(m=> new Date(m.dataHora) <= new Date(f.dataFim+'T23:59:59'));
  return list.sort((a,b)=> new Date(b.dataHora)-new Date(a.dataHora));
}
function csvEscape(v){ const s=String(v??''); if(/[;"\n]/.test(s)) return '"'+s.replace(/"/g,'""')+'"'; return s; }
function downloadCSV(filename, rows){
  const csv = rows.map(r=>r.map(csvEscape).join(';')).join('\r\n');
  const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function exportEstoqueCsv(){
  const rows = [['Código do item','Nome do item','Categoria','Código do lote','Unidade','Quantidade do lote','Estoque mínimo (item)','Validade do lote','Situação']];
  lotesComEstoque().sort((a,b)=>a.codigoLote.localeCompare(b.codigoLote,'pt-BR')).forEach(l=>{
    const item = State.itens.find(i=>i.id===l.itemId);
    if(!item) return;
    const est = loteExpiryStatus(l);
    const situacao = [];
    if(calcularQuantidadeItem(item.id) <= Number(item.estoqueMinimo)) situacao.push('Item com estoque baixo');
    if(est==='vencido') situacao.push('Vencido');
    if(est==='vencendo') situacao.push('Vence em breve');
    rows.push([item.codigoItem, item.nome, item.categoria, l.codigoLote, item.unidade, fmtNum(l.quantidade), fmtNum(item.estoqueMinimo), l.validade?fmtValidade(l.validade):'', situacao.join(', ')||'OK']);
  });
  downloadCSV('estoque-farmstock-'+new Date().toISOString().slice(0,10)+'.csv', rows);
}
function exportHistCsv(){
  const list = filteredHistForReport();
  const rows = [['Data/Hora','Tipo','Código do item','Item','Código do lote','Quantidade','Usuário','Retiro','Observação']];
  list.forEach(m=>{
    const item = State.itens.find(x=>x.id===m.itemId);
    const nome = item? item.nome : (m.itemNomeSnapshot||'Item removido');
    const codItem = item? item.codigoItem : '';
    const u = State.usuarios.find(x=>x.id===m.usuarioId);
    const uNome = u? u.nome : (m.usuarioNomeSnapshot||'');
    const tipoLabel = m.tipo==='entrada'?'Entrada':(m.tipo==='saida'?'Saída':'Ajuste');
    rows.push([fmtDateTime(m.dataHora), tipoLabel, codItem, nome, m.loteCodigoSnapshot||'', fmtNum(m.quantidade), uNome, m.retiroNomeSnapshot||'', m.observacao||'']);
  });
  downloadCSV('historico-farmstock-'+new Date().toISOString().slice(0,10)+'.csv', rows);
}
function printReport(title, headers, rows){
  const area = document.getElementById('printArea');
  area.innerHTML = `
    <h1>${escapeHtml(title)}</h1>
    <p style="font-size:12px;color:#555;">Gerado em ${new Date().toLocaleString('pt-BR')}</p>
    <table><thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
  `;
  window.print();
}
function printEstoqueReport(){
  const rows = [];
  lotesComEstoque().sort((a,b)=>a.codigoLote.localeCompare(b.codigoLote,'pt-BR')).forEach(l=>{
    const item = State.itens.find(i=>i.id===l.itemId);
    if(!item) return;
    const est = loteExpiryStatus(l);
    const situacao = [];
    if(calcularQuantidadeItem(item.id) <= Number(item.estoqueMinimo)) situacao.push('Item com estoque baixo');
    if(est==='vencido') situacao.push('Vencido');
    if(est==='vencendo') situacao.push('Vence em breve');
    rows.push([item.codigoItem, item.nome, l.codigoLote, `${fmtNum(l.quantidade)} ${item.unidade}`, l.validade?fmtValidade(l.validade):'—', situacao.join(', ')||'OK']);
  });
  printReport('Estoque por lote — Farm Stock', ['Cód. item','Nome','Cód. lote','Quantidade','Validade','Situação'], rows);
}
function printHistReport(){
  const list = filteredHistForReport();
  const rows = list.map(m=>{
    const item = State.itens.find(x=>x.id===m.itemId);
    const nome = item? item.nome : (m.itemNomeSnapshot||'Item removido');
    const u = State.usuarios.find(x=>x.id===m.usuarioId);
    const uNome = u? u.nome : (m.usuarioNomeSnapshot||'');
    const tipoLabel = m.tipo==='entrada'?'Entrada':(m.tipo==='saida'?'Saída':'Ajuste');
    return [fmtDateTime(m.dataHora), tipoLabel, nome, m.loteCodigoSnapshot||'', fmtNum(m.quantidade), uNome, m.retiroNomeSnapshot||'', m.observacao||''];
  });
  printReport('Histórico de movimentações — Farm Stock', ['Data/Hora','Tipo','Item','Lote','Quantidade','Usuário','Retiro','Observação'], rows);
}

/* ================= EVENT WIRING (app shell) ================= */
function attachScreenEvents(){
  document.querySelectorAll('[data-nav]').forEach(el=>{
    el.onclick = ()=>{
      const k = el.dataset.nav;
      if(k==='entrada'){ openScannerFlow(k); return; }
      if(k==='saida'){ if(State.carrinho.length>0){ openCarrinho(); } else { openScannerFlow('saida'); } return; }
      State.screen = k; render();
    };
  });
  const gotoU = document.querySelector('[data-action="goto-usuarios"]');
  if(gotoU) gotoU.onclick = ()=>{ if(isGestor()){ State.screen='usuarios'; render(); } };
  const gotoRet = document.querySelector('[data-action="goto-retiros"]');
  if(gotoRet) gotoRet.onclick = ()=>{ if(isGestor()){ State.screen='retiros'; render(); } };
  const gotoR = document.querySelector('[data-action="goto-relatorios"]');
  if(gotoR) gotoR.onclick = ()=>{ State.screen='relatorios'; render(); };
  const logout = document.querySelector('[data-action="logout"]');
  if(logout) logout.onclick = ()=>{ State.currentUser=null; render(); };

  document.querySelectorAll('[data-action="open-item"]').forEach(el=>{ el.onclick = ()=> openItemDetail(el.dataset.id); });

  const estSearch = document.getElementById('estoqueSearchInput');
  if(estSearch){ estSearch.oninput = ()=>{ State.estoqueSearch = estSearch.value; softRefreshScreen(); }; }
  document.querySelectorAll('[data-estfilter]').forEach(el=>{ el.onclick = ()=>{ State.estoqueFilter = el.dataset.estfilter; render(); }; });

  const histSearch = document.getElementById('histSearchInput');
  if(histSearch){ histSearch.oninput = ()=>{ State.histFilters.busca = histSearch.value; softRefreshScreen(); }; }
  document.querySelectorAll('[data-histtipo]').forEach(el=>{ el.onclick = ()=>{ State.histFilters.tipo = el.dataset.histtipo; render(); }; });
  const histUserSel = document.getElementById('histUsuarioSelect');
  if(histUserSel){ histUserSel.onchange = ()=>{ State.histFilters.usuario = histUserSel.value; render(); }; }
  const histRetiroSel = document.getElementById('histRetiroSelect');
  if(histRetiroSel){ histRetiroSel.onchange = ()=>{ State.histFilters.retiro = histRetiroSel.value; render(); }; }

  document.querySelectorAll('[data-action="desativar-usuario"]').forEach(el=>{
    el.onclick = async ()=>{
      const u = State.usuarios.find(x=>x.id===el.dataset.id);
      if(u.perfil==='gestor'){
        const outrosGestoresAtivos = State.usuarios.some(x=>x.id!==u.id && x.fazendaId===u.fazendaId && x.perfil==='gestor' && x.ativo!==false);
        if(!outrosGestoresAtivos){ showToast('Precisa haver ao menos um Gestor ativo.'); return; }
      }
      await atualizarUsuario(u.id, { ativo:false }); await refreshData(); render();
    };
  });
  document.querySelectorAll('[data-action="reativar-usuario"]').forEach(el=>{
    el.onclick = async ()=>{ await atualizarUsuario(el.dataset.id, { ativo:true }); await refreshData(); render(); };
  });
  document.querySelectorAll('[data-action="mudar-perfil"]').forEach(el=>{
    el.onchange = async ()=>{
      const u = State.usuarios.find(x=>x.id===el.dataset.id);
      if(u.perfil==='gestor' && el.value==='operador'){
        const outrosGestoresAtivos = State.usuarios.some(x=>x.id!==u.id && x.fazendaId===u.fazendaId && x.perfil==='gestor' && x.ativo!==false);
        if(!outrosGestoresAtivos){ showToast('Precisa haver ao menos um Gestor ativo.'); el.value='gestor'; return; }
      }
      await atualizarUsuario(u.id, { perfil: el.value }); await refreshData(); render();
      showToast(`${u.nome} agora é ${el.value==='gestor'?'Gestor':'Operador'}.`);
    };
  });

  document.querySelectorAll('[data-action="desativar-retiro"]').forEach(el=>{
    el.onclick = async ()=>{ await atualizarRetiro(el.dataset.id, { ativo:false }); await refreshData(); render(); };
  });
  document.querySelectorAll('[data-action="reativar-retiro"]').forEach(el=>{
    el.onclick = async ()=>{ await atualizarRetiro(el.dataset.id, { ativo:true }); await refreshData(); render(); };
  });
  const novoRetiroBtn = document.getElementById('novoRetiroBtn');
  if(novoRetiroBtn) novoRetiroBtn.onclick = async ()=>{
    const nomeEl = document.getElementById('novoRetiroNome');
    const nome = nomeEl.value.trim();
    if(!nome){ showToast('Informe o nome do retiro.'); return; }
    if(retirosDaFazenda().some(r=>r.nome.toLowerCase()===nome.toLowerCase() && r.ativo!==false)){ showToast('Já existe um retiro ativo com esse nome.'); return; }
    await criarRetiro({ fazendaId: fzId(), nome }); await refreshData(); render();
    showToast('Retiro cadastrado.');
  };

  const relDataIni = document.getElementById('relDataIni');
  if(relDataIni) relDataIni.onchange = ()=>{ State.relFilters.dataIni = relDataIni.value; };
  const relDataFim = document.getElementById('relDataFim');
  if(relDataFim) relDataFim.onchange = ()=>{ State.relFilters.dataFim = relDataFim.value; };
  const relTipo = document.getElementById('relTipo');
  if(relTipo) relTipo.onchange = ()=>{ State.relFilters.tipo = relTipo.value; };
  const expEstCsv = document.getElementById('exportEstoqueCsv'); if(expEstCsv) expEstCsv.onclick = exportEstoqueCsv;
  const expHistCsv = document.getElementById('exportHistCsv'); if(expHistCsv) expHistCsv.onclick = exportHistCsv;
  const prEst = document.getElementById('printEstoque'); if(prEst) prEst.onclick = printEstoqueReport;
  const prHist = document.getElementById('printHist'); if(prHist) prHist.onclick = printHistReport;

  attachFormNovoUsuario();
}

/* ================= MODAL HELPERS ================= */
function openModal(html, {center=false, onClose=null} = {}){
  closeModal();
  State.modalOpen = true;
  const back = document.createElement('div');
  back.className = 'modal-backdrop' + (center?' center':'');
  back.id = 'modalBackdrop';
  back.innerHTML = `<div class="modal-sheet">${html}</div>`;
  back.onclick = (e)=>{ if(e.target===back){ if(onClose) onClose(); closeModal(); } };
  document.getElementById('app').appendChild(back);
  return back;
}
function closeModal(){
  const b = document.getElementById('modalBackdrop');
  if(b) b.remove();
  stopScanner();
  State.modalOpen = false;
}

/* ================= SCANNER (Código do lote) ================= */
function openScannerFlow(mode){
  State.scanMode = mode;
  const title = mode==='entrada' ? 'Entrada — ler código do lote' : 'Adicionar ao carrinho — ler código do lote';
  const modal = openModal(`
    <div class="modal-head"><h2>${title}</h2><button class="modal-close" data-action="close-scan">✕</button></div>
    <div id="reader"></div>
    <div id="scanErrorBox"></div>
    <div class="scan-fallback">
      <p>Aponte a câmera para o código de barras ou QR Code do lote (a embalagem física). Se a câmera não estiver disponível, digite o código:</p>
      <div class="field" style="margin-bottom:8px;"><input id="manualCodeInput" placeholder="Código do lote" class="mono"></div>
      <button class="btn btn-outline" id="manualCodeBtn">Buscar código digitado</button>
    </div>
  `, { onClose: ()=>{ State.scanMode=null; } });
  modal.querySelector('[data-action="close-scan"]').onclick = ()=>{
    State.scanMode=null;
    if(mode==='saida'){ closeModal(); openCarrinho(); } else { closeModal(); }
  };
  document.getElementById('manualCodeBtn').onclick = ()=>{
    const v = document.getElementById('manualCodeInput').value.trim();
    if(!v){ showToast('Digite um código.'); return; }
    handleScanResult(v);
  };
  document.getElementById('manualCodeInput').addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); document.getElementById('manualCodeBtn').click(); } });

  startScanner({
    elementId: 'reader',
    onResult: (text)=> handleScanResult(text),
    onError: ()=> setScanError('Não foi possível acessar a câmera. Use a busca manual abaixo.'),
  });
}
function setScanError(msg){ const box = document.getElementById('scanErrorBox'); if(box) box.innerHTML = `<div class="scan-error">${msg}</div>`; }

async function handleScanResult(codigoLote){
  await stopScanner();
  try{ if(navigator.vibrate) navigator.vibrate(60); }catch(e){}
  const lote = State.lotes.find(l=>l.codigoLote===codigoLote && l.fazendaId===fzId());
  if(State.scanMode==='entrada'){
    if(lote){ openEntradaLoteConfirm(lote); }
    else if(isGestor()){ openNovoLotePasso1(codigoLote); }
    else { closeModal(); showToast('Lote não cadastrado. Peça a um Gestor para cadastrá-lo.'); }
  } else if(State.scanMode==='saida'){
    if(lote){ openCarrinhoAddItem(lote); }
    else { showToast('Código de lote não encontrado no estoque.'); openCarrinho(); }
  }
}

/* --- Entrada: lote já existente --- */
function openEntradaLoteConfirm(lote){
  const item = State.itens.find(i=>i.id===lote.itemId);
  if(!item){ showToast('Item deste lote não foi encontrado.'); return; }
  const qtdAtual = calcularQuantidadeLote(lote.id);
  const modal = openModal(`
    <div class="modal-head"><h2>Confirmar entrada</h2><button class="modal-close" data-action="close">✕</button></div>
    <div class="product-preview">
      <div class="pp-photo">${item.foto? `<img src="${item.foto}" alt="">` : `<span>💊</span>`}</div>
      <div class="pp-main">
        <div class="pp-name">${escapeHtml(item.nome)}</div>
        <div class="pp-sub">Cód. item <span class="mono">${escapeHtml(item.codigoItem)}</span> · Lote <span class="mono">${escapeHtml(lote.codigoLote)}</span>${lote.validade? ' · Val.: '+fmtValidade(lote.validade):''}</div>
      </div>
      <div class="pp-stock">${fmtNum(qtdAtual)} ${escapeHtml(item.unidade)}<br><span style="font-weight:400;font-size:11px;color:var(--ink-soft);">neste lote</span></div>
    </div>
    <div class="field"><label>Quantidade a adicionar (${escapeHtml(item.unidade)})</label></div>
    <div class="stepper"><button data-step="-1">−</button><input id="entQty" class="mono" value="1" inputmode="decimal"><button data-step="1">+</button></div>
    <div class="field"><label>Validade deste lote (opcional — atualiza a validade)</label><input id="entValidade" type="date" value="${lote.validade||''}"></div>
    <div class="field"><label>Observação (opcional)</label><input id="entObs" placeholder="Ex.: nota fiscal, fornecedor…"></div>
    <button class="btn btn-primary" id="entConfirmBtn">Registrar entrada</button>
  `, { center:true });
  modal.querySelector('[data-action="close"]').onclick = closeModal;
  const qtyInput = document.getElementById('entQty');
  modal.querySelectorAll('[data-step]').forEach(b=>{ b.onclick = ()=>{ let v=parseFloat(qtyInput.value.replace(',','.'))||0; v=Math.max(0, v+parseFloat(b.dataset.step)); qtyInput.value=v; }; });
  document.getElementById('entConfirmBtn').onclick = async ()=>{
    const v = parseFloat(qtyInput.value.replace(',','.'));
    if(!v || v<=0){ showToast('Informe uma quantidade válida.'); return; }
    const novaValidade = document.getElementById('entValidade').value;
    if(novaValidade && novaValidade !== lote.validade){ await atualizarLote(lote.id, { validade: novaValidade }); }
    const obs = document.getElementById('entObs').value.trim();
    await registrarMovimentacao({
      fazendaId: fzId(), loteId: lote.id, itemId: item.id, loteCodigoSnapshot: lote.codigoLote, itemNomeSnapshot: item.nome, tipo:'entrada',
      quantidade: v, usuarioId: State.currentUser.id, usuarioNomeSnapshot: State.currentUser.nome, observacao: obs || null
    });
    await refreshData();
    closeModal(); State.screen='inicio'; render();
    showToast(`Entrada registrada: +${fmtNum(v)} ${item.unidade} de ${item.nome} (lote ${lote.codigoLote}).`);
  };
}

/* --- Entrada: código de lote novo — passo 1: buscar/escolher o item --- */
function openNovoLotePasso1(codigoLote){
  const modal = openModal(`
    <div class="modal-head"><h2>Lote novo</h2><button class="modal-close" data-action="close">✕</button></div>
    <div class="step-hint">Código de lote <strong class="mono">${escapeHtml(codigoLote)}</strong> ainda não está cadastrado. Busque o item ao qual este lote pertence, pelo nome ou pelo código.</div>
    <div class="field"><label>Nome ou código do item</label><input id="niSearch" placeholder="Digite para buscar…" autocomplete="off"></div>
    <div id="niSuggestions"></div>
    <button type="button" class="btn btn-outline" id="niNovoItemBtn" style="margin-top:4px;">+ Cadastrar novo item</button>
  `, { center:true });
  modal.querySelector('[data-action="close"]').onclick = closeModal;

  const searchInput = document.getElementById('niSearch');
  const suggestionsBox = document.getElementById('niSuggestions');
  function buscarItens(q){
    const query = q.trim().toLowerCase();
    if(!query) return [];
    return itensDaFazenda().filter(i=> i.nome.toLowerCase().includes(query) || i.codigoItem.toLowerCase().includes(query)).slice(0,6);
  }
  function renderSuggestions(){
    const query = searchInput.value.trim();
    if(!query){ suggestionsBox.innerHTML = ''; return; }
    const matches = buscarItens(query);
    if(matches.length===0){
      suggestionsBox.innerHTML = `<p style="font-size:12px;color:var(--ink-soft);margin:10px 0 4px;">Nenhum item encontrado com "${escapeHtml(query)}". Você pode cadastrar um item novo abaixo.</p>`;
      return;
    }
    suggestionsBox.innerHTML = `<div style="margin-top:10px;">` + matches.map(i=>`
      <button type="button" class="userchip" data-action="select-item" data-id="${i.id}" style="margin-bottom:8px;">
        <div class="un">${escapeHtml(i.nome)}</div>
        <div class="us">Cód. item <span class="mono">${escapeHtml(i.codigoItem)}</span> · ${escapeHtml(i.categoria)}</div>
      </button>
    `).join('') + `</div>`;
    suggestionsBox.querySelectorAll('[data-action="select-item"]').forEach(btn=>{
      btn.onclick = ()=>{
        const item = State.itens.find(x=>x.id===btn.dataset.id);
        if(item) openNovoLotePasso2ItemExistente(item, codigoLote);
      };
    });
  }
  searchInput.oninput = renderSuggestions;
  searchInput.addEventListener('keydown', (e)=>{
    if(e.key==='Enter'){
      e.preventDefault();
      const matches = buscarItens(searchInput.value);
      const exato = itensDaFazenda().find(i=>i.codigoItem.toLowerCase()===searchInput.value.trim().toLowerCase());
      if(exato){ openNovoLotePasso2ItemExistente(exato, codigoLote); }
      else if(matches.length===1){ openNovoLotePasso2ItemExistente(matches[0], codigoLote); }
    }
  });
  searchInput.focus();

  document.getElementById('niNovoItemBtn').onclick = ()=>{ openNovoItemComLote(searchInput.value.trim(), codigoLote); };
}
/* --- Entrada: lote novo para um item que já existe --- */
function openNovoLotePasso2ItemExistente(item, codigoLote){
  const modal = openModal(`
    <div class="modal-head"><h2>Novo lote</h2><button class="modal-close" data-action="close">✕</button></div>
    <div class="product-preview">
      <div class="pp-photo">${item.foto? `<img src="${item.foto}" alt="">` : `<span>💊</span>`}</div>
      <div class="pp-main">
        <div class="pp-name">${escapeHtml(item.nome)}</div>
        <div class="pp-sub">Cód. item <span class="mono">${escapeHtml(item.codigoItem)}</span> · Novo lote <span class="mono">${escapeHtml(codigoLote)}</span></div>
      </div>
    </div>
    <div class="field"><label>Quantidade inicial deste lote (${escapeHtml(item.unidade)})</label><input id="nlQtd" class="mono" inputmode="decimal" value="1"></div>
    <div class="field"><label>Validade deste lote (opcional)</label><input id="nlValidade" type="date"></div>
    <button class="btn btn-primary" id="nlConfirmBtn">Cadastrar lote e dar entrada</button>
  `, { center:true });
  modal.querySelector('[data-action="close"]').onclick = closeModal;
  document.getElementById('nlConfirmBtn').onclick = async ()=>{
    const qtd = parseFloat(document.getElementById('nlQtd').value.replace(',','.'));
    const validade = document.getElementById('nlValidade').value || null;
    if(!qtd || qtd<0){ showToast('Informe uma quantidade inicial válida.'); return; }
    const lote = await criarLote({ fazendaId: fzId(), itemId: item.id, codigoLote, validade });
    await registrarMovimentacao({
      fazendaId: fzId(), loteId: lote.id, itemId: item.id, loteCodigoSnapshot: lote.codigoLote, itemNomeSnapshot: item.nome, tipo:'entrada',
      quantidade: qtd, usuarioId: State.currentUser.id, usuarioNomeSnapshot: State.currentUser.nome, observacao: 'Novo lote'
    });
    await refreshData();
    closeModal(); State.screen='inicio'; render();
    showToast(`Lote ${codigoLote} cadastrado com ${fmtNum(qtd)} ${item.unidade} para ${item.nome}.`);
  };
}
/* --- Entrada: item novo + primeiro lote --- */
function openNovoItemComLote(sugestaoCodigoItem, codigoLote){
  const modal = openModal(`
    <div class="modal-head"><h2>Novo item</h2><button class="modal-close" data-action="close">✕</button></div>
    <div class="step-hint">Nenhum item encontrado. Cadastre o item e o primeiro lote (<strong class="mono">${escapeHtml(codigoLote)}</strong>) de uma vez.</div>
    <div class="field"><label>Código do item</label><input id="cpCodigoItem" placeholder="Ex.: MED-014" class="mono" value="${escapeHtml(sugestaoCodigoItem||'')}"></div>
    <div class="field"><label>Nome do item</label><input id="cpNome" placeholder="Ex.: Oxitetraciclina 200mg"></div>
    <div class="field"><label>Categoria</label><select id="cpCategoria">${CATEGORIAS.map(c=>`<option>${c}</option>`).join('')}</select></div>
    <div class="field"><label>Unidade</label><select id="cpUnidade">${UNIDADES.map(u=>`<option>${u}</option>`).join('')}</select></div>
    <div class="field"><label>Estoque mínimo (alerta)</label><input id="cpMin" class="mono" inputmode="decimal" value="0"></div>
    ${renderPhotoField('cpFoto', null)}
    <div class="section-title" style="margin-top:18px;">Primeiro lote</div>
    <div class="field"><label>Quantidade inicial deste lote</label><input id="cpQtd" class="mono" inputmode="decimal" value="1"></div>
    <div class="field"><label>Validade deste lote (opcional)</label><input id="cpValidade" type="date"></div>
    <button class="btn btn-primary" id="cpConfirmBtn">Cadastrar item, lote e dar entrada</button>
  `, { center:true });
  modal.querySelector('[data-action="close"]').onclick = closeModal;
  const fotoField = wirePhotoField('cpFoto', null);
  document.getElementById('cpConfirmBtn').onclick = async ()=>{
    const codigoItem = document.getElementById('cpCodigoItem').value.trim();
    const nome = document.getElementById('cpNome').value.trim();
    const categoria = document.getElementById('cpCategoria').value;
    const unidade = document.getElementById('cpUnidade').value;
    const min = parseFloat(document.getElementById('cpMin').value.replace(',','.'))||0;
    const qtd = parseFloat(document.getElementById('cpQtd').value.replace(',','.'));
    const validade = document.getElementById('cpValidade').value || null;
    if(!codigoItem){ showToast('Informe o código do item.'); return; }
    if(!nome){ showToast('Informe o nome do item.'); return; }
    if(itensDaFazenda().some(i=>i.codigoItem.toLowerCase()===codigoItem.toLowerCase())){ showToast('Já existe um item com esse código.'); return; }
    if(!qtd || qtd<0){ showToast('Informe uma quantidade inicial válida.'); return; }
    const item = await criarItem({ fazendaId: fzId(), codigoItem, nome, categoria, unidade, estoqueMinimo: min, foto: fotoField.getFoto() });
    const lote = await criarLote({ fazendaId: fzId(), itemId: item.id, codigoLote, validade });
    await registrarMovimentacao({
      fazendaId: fzId(), loteId: lote.id, itemId: item.id, loteCodigoSnapshot: lote.codigoLote, itemNomeSnapshot: item.nome, tipo:'entrada',
      quantidade: qtd, usuarioId: State.currentUser.id, usuarioNomeSnapshot: State.currentUser.nome, observacao: 'Cadastro inicial do item e do lote'
    });
    await refreshData();
    closeModal(); State.screen='inicio'; render();
    showToast(`"${nome}" cadastrado com ${fmtNum(qtd)} ${unidade} (lote ${codigoLote}).`);
  };
}

/* ================= CARRINHO (Saída) ================= */
function qtyPickerHtml(item, lote, qtyValue){
  const qtdLote = calcularQuantidadeLote(lote.id);
  return `
    ${item.foto? `<div style="width:100%;max-height:180px;border-radius:12px;overflow:hidden;margin-bottom:14px;background:var(--surface-2);"><img src="${item.foto}" alt="" style="width:100%;height:180px;object-fit:contain;display:block;"></div>` : ''}
    <div class="product-preview">
      <div class="pp-photo">${item.foto? `<img src="${item.foto}" alt="">` : `<span>💊</span>`}</div>
      <div class="pp-main">
        <div class="pp-name">${escapeHtml(item.nome)}</div>
        <div class="pp-sub">Lote <span class="mono">${escapeHtml(lote.codigoLote)}</span>${lote.validade? ' · Val.: '+fmtValidade(lote.validade):''}</div>
      </div>
      <div class="pp-stock">${fmtNum(qtdLote)} ${escapeHtml(item.unidade)}<br><span style="font-weight:400;font-size:11px;color:var(--ink-soft);">disponível neste lote</span></div>
    </div>
    <div class="field"><label>Quantidade (${escapeHtml(item.unidade)})</label></div>
    <div class="stepper">
      <button data-step="-1">−</button>
      <input id="cqQty" class="mono" value="${qtyValue}" inputmode="decimal">
      <button data-step="1">+</button>
    </div>
    <div id="cqErr"></div>
  `;
}
function wireQtyStepper(){
  const qtyInput = document.getElementById('cqQty');
  document.querySelectorAll('[data-step]').forEach(b=>{
    b.onclick = ()=>{ let v = parseFloat(qtyInput.value.replace(',','.'))||0; v = Math.max(0, v + parseFloat(b.dataset.step)); qtyInput.value = v; };
  });
}
function openCarrinhoAddItem(lote){
  const item = State.itens.find(i=>i.id===lote.itemId);
  if(!item){ showToast('Item deste lote não encontrado.'); openCarrinho(); return; }
  const qtdLote = calcularQuantidadeLote(lote.id);
  const jaNoCarrinho = State.carrinho.find(i=>i.loteId===lote.id);
  const modal = openModal(`
    <div class="modal-head"><h2>Adicionar ao carrinho</h2><button class="modal-close" data-action="close">✕</button></div>
    ${qtyPickerHtml(item, lote, jaNoCarrinho? jaNoCarrinho.quantidade : 1)}
    <button class="btn btn-primary" id="cqConfirmBtn">Adicionar ao carrinho</button>
  `, { center:true, onClose: ()=> openCarrinho() });
  modal.querySelector('[data-action="close"]').onclick = ()=> openCarrinho();
  wireQtyStepper();
  document.getElementById('cqConfirmBtn').onclick = ()=>{
    const v = parseFloat(document.getElementById('cqQty').value.replace(',','.'));
    const errBox = document.getElementById('cqErr');
    if(!v || v<=0){ errBox.innerHTML = `<div class="scan-error">Informe uma quantidade válida.</div>`; return; }
    if(v > qtdLote){ errBox.innerHTML = `<div class="scan-error">Quantidade maior que o disponível neste lote (${fmtNum(qtdLote)} ${item.unidade}).</div>`; return; }
    if(jaNoCarrinho){ jaNoCarrinho.quantidade = v; } else { State.carrinho.push({ loteId: lote.id, quantidade: v }); }
    try{ if(navigator.vibrate) navigator.vibrate(40); }catch(e){}
    openCarrinho();
  };
}
function openCarrinhoEditItem(loteId){
  const cartItem = State.carrinho.find(i=>i.loteId===loteId);
  const lote = State.lotes.find(l=>l.id===loteId);
  const item = lote ? State.itens.find(i=>i.id===lote.itemId) : null;
  if(!cartItem || !lote || !item) return;
  const qtdLote = calcularQuantidadeLote(lote.id);
  const modal = openModal(`
    <div class="modal-head"><h2>Editar quantidade</h2><button class="modal-close" data-action="close">✕</button></div>
    ${qtyPickerHtml(item, lote, cartItem.quantidade)}
    <button class="btn btn-primary" id="cqConfirmBtn">Salvar</button>
  `, { center:true, onClose: ()=> openCarrinho() });
  modal.querySelector('[data-action="close"]').onclick = ()=> openCarrinho();
  wireQtyStepper();
  document.getElementById('cqConfirmBtn').onclick = ()=>{
    const v = parseFloat(document.getElementById('cqQty').value.replace(',','.'));
    const errBox = document.getElementById('cqErr');
    if(!v || v<=0){ errBox.innerHTML = `<div class="scan-error">Informe uma quantidade válida.</div>`; return; }
    if(v > qtdLote){ errBox.innerHTML = `<div class="scan-error">Quantidade maior que o disponível neste lote (${fmtNum(qtdLote)} ${item.unidade}).</div>`; return; }
    cartItem.quantidade = v;
    openCarrinho();
  };
}
function openCarrinho(){
  const retirosAtivos = retirosDaFazenda().filter(r=>r.ativo!==false);
  const itens = State.carrinho.map(ci=>{
    const lote = State.lotes.find(l=>l.id===ci.loteId);
    const item = lote ? State.itens.find(i=>i.id===lote.itemId) : null;
    return { ...ci, lote, item };
  }).filter(ci=> ci.lote && ci.item);
  const modal = openModal(`
    <div class="modal-head"><h2>Carrinho de saída</h2><button class="modal-close" data-action="close">✕</button></div>
    <div class="field">
      <label>Retiro de destino</label>
      <select id="carRetiro">
        <option value="">Selecione o retiro…</option>
        ${retirosAtivos.map(r=>`<option value="${r.id}" ${State.carrinhoRetiroId===r.id?'selected':''}>${escapeHtml(r.nome)}</option>`).join('')}
        ${isGestor()? `<option value="__novo__" ${State.carrinhoRetiroId==='__novo__'?'selected':''}>+ Cadastrar novo retiro…</option>` : ''}
      </select>
      ${isGestor()? `<div id="carNovoRetiroWrap" class="hidden" style="margin-top:8px;"><input id="carNovoRetiroNome" placeholder="Nome do novo retiro"></div>` : `<p style="font-size:11.5px;color:var(--ink-soft);margin-top:6px;">Não encontrou o retiro? Peça a um Gestor para cadastrar.</p>`}
    </div>
    <div class="section-title" style="margin-top:0;">Itens no carrinho (${itens.length})</div>
    ${itens.length===0? emptyState('🛒','Carrinho vazio','Toque em "Adicionar item" para escanear o primeiro lote.') :
      itens.map(ci=>`
        <div class="tag-card" style="flex-wrap:wrap;">
          <div class="tc-photo">${ci.item.foto? `<img src="${ci.item.foto}" alt="">`:`<span>💊</span>`}</div>
          <div class="tc-main">
            <div class="tc-name">${escapeHtml(ci.item.nome)}</div>
            <div class="tc-sub">Lote <span class="mono">${escapeHtml(ci.lote.codigoLote)}</span></div>
          </div>
          <button class="btn btn-ghost" style="width:auto;padding:8px 10px;font-size:13px;" data-action="edit-cart-item" data-id="${ci.loteId}">${fmtNum(ci.quantidade)} ${escapeHtml(ci.item.unidade)} ✎</button>
          <button class="btn btn-ghost" style="width:auto;padding:8px 10px;font-size:13px;color:var(--rust);" data-action="remove-cart-item" data-id="${ci.loteId}">✕</button>
        </div>
      `).join('')
    }
    <button type="button" class="btn btn-outline" id="carAddItemBtn" style="margin:6px 0 16px;">+ Adicionar item</button>
    <div class="field"><label>Observação (opcional, vale para toda a saída)</label><input id="carObs" placeholder="Ex.: animal, finalidade…" value="${escapeHtml(State.carrinhoObs||'')}"></div>
    <div id="carErr"></div>
    <button class="btn btn-rust" id="carConfirmBtn">Confirmar saída${itens.length? ' — '+itens.length+' '+(itens.length===1?'item':'itens'):''}</button>
    ${itens.length? `<button type="button" class="btn btn-ghost" style="margin-top:8px;" id="carLimparBtn">Limpar carrinho</button>` : ''}
  `, { center:true });
  modal.querySelector('[data-action="close"]').onclick = closeModal;

  const retiroSel = document.getElementById('carRetiro');
  const novoRetiroWrap = document.getElementById('carNovoRetiroWrap');
  retiroSel.onchange = ()=>{
    State.carrinhoRetiroId = retiroSel.value;
    if(novoRetiroWrap){
      if(retiroSel.value==='__novo__'){ novoRetiroWrap.classList.remove('hidden'); document.getElementById('carNovoRetiroNome').focus(); }
      else { novoRetiroWrap.classList.add('hidden'); }
    }
  };
  const obsInput = document.getElementById('carObs');
  if(obsInput) obsInput.oninput = ()=>{ State.carrinhoObs = obsInput.value; };

  modal.querySelectorAll('[data-action="edit-cart-item"]').forEach(el=>{ el.onclick = ()=> openCarrinhoEditItem(el.dataset.id); });
  modal.querySelectorAll('[data-action="remove-cart-item"]').forEach(el=>{
    el.onclick = ()=>{ State.carrinho = State.carrinho.filter(i=>i.loteId!==el.dataset.id); openCarrinho(); };
  });
  document.getElementById('carAddItemBtn').onclick = ()=> openScannerFlow('saida');
  const limparBtn = document.getElementById('carLimparBtn');
  if(limparBtn) limparBtn.onclick = ()=>{ State.carrinho = []; State.carrinhoObs=''; State.carrinhoRetiroId=''; openCarrinho(); };

  document.getElementById('carConfirmBtn').onclick = async ()=>{
    const errBox = document.getElementById('carErr');
    errBox.innerHTML = '';
    if(State.carrinho.length===0){ errBox.innerHTML = `<div class="scan-error">Adicione ao menos um item ao carrinho.</div>`; return; }
    let retiroId = retiroSel.value;
    let retiroNome = '';
    if(!retiroId){ errBox.innerHTML = `<div class="scan-error">Selecione o retiro de destino.</div>`; return; }
    if(retiroId==='__novo__'){
      if(!isGestor()){ errBox.innerHTML = `<div class="scan-error">Somente um Gestor pode cadastrar um novo retiro.</div>`; return; }
      const nomeNovo = document.getElementById('carNovoRetiroNome').value.trim();
      if(!nomeNovo){ errBox.innerHTML = `<div class="scan-error">Informe o nome do novo retiro.</div>`; return; }
      const existente = retirosDaFazenda().find(r=>r.nome.toLowerCase()===nomeNovo.toLowerCase() && r.ativo!==false);
      if(existente){ retiroId = existente.id; retiroNome = existente.nome; }
      else {
        const novoRetiro = await criarRetiro({ fazendaId: fzId(), nome: nomeNovo });
        retiroId = novoRetiro.id; retiroNome = novoRetiro.nome;
      }
    } else {
      const r = State.retiros.find(x=>x.id===retiroId);
      if(!r){ errBox.innerHTML = `<div class="scan-error">Retiro inválido.</div>`; return; }
      retiroNome = r.nome;
    }
    for(const ci of State.carrinho){
      const lote = State.lotes.find(l=>l.id===ci.loteId);
      if(!lote){ errBox.innerHTML = `<div class="scan-error">Um lote do carrinho não existe mais. Remova-o para continuar.</div>`; return; }
      const qtdLote = calcularQuantidadeLote(lote.id);
      if(Number(ci.quantidade) > qtdLote){
        const item = State.itens.find(i=>i.id===lote.itemId);
        errBox.innerHTML = `<div class="scan-error">${escapeHtml(item?item.nome:'Item')} (lote ${escapeHtml(lote.codigoLote)}): quantidade maior que o disponível (${fmtNum(qtdLote)}).</div>`;
        return;
      }
    }
    const obs = (document.getElementById('carObs').value || '').trim();
    for(const ci of State.carrinho){
      const lote = State.lotes.find(l=>l.id===ci.loteId);
      const item = State.itens.find(i=>i.id===lote.itemId);
      await registrarMovimentacao({
        fazendaId: fzId(), loteId: lote.id, itemId: item.id, loteCodigoSnapshot: lote.codigoLote, itemNomeSnapshot: item.nome, tipo:'saida',
        quantidade: Number(ci.quantidade), usuarioId: State.currentUser.id, usuarioNomeSnapshot: State.currentUser.nome,
        retiroId, retiroNomeSnapshot: retiroNome, observacao: obs || null
      });
    }
    await refreshData();
    const totalItens = State.carrinho.length;
    State.carrinho = []; State.carrinhoObs=''; State.carrinhoRetiroId='';
    closeModal();
    State.screen='inicio';
    render();
    showToast(`Saída registrada: ${totalItens} ${totalItens===1?'item':'itens'} para ${retiroNome}.`);
  };
}

/* ================= DETALHE / EDIÇÃO DE ITEM E LOTES ================= */
function openItemDetail(itemId){
  const item = State.itens.find(i=>i.id===itemId);
  if(!item) return;
  const quantidade = calcularQuantidadeItem(item.id);
  const lotes = lotesDoItem(item.id).sort((a,b)=>{
    const da = a.validade? new Date(a.validade) : new Date('9999-12-31');
    const db = b.validade? new Date(b.validade) : new Date('9999-12-31');
    return da-db;
  });
  const hist = movimentacoesDaFazenda().filter(m=>m.itemId===itemId).sort((a,b)=> new Date(b.dataHora)-new Date(a.dataHora)).slice(0,8);
  const modal = openModal(`
    <div class="modal-head"><h2>${escapeHtml(item.nome)}</h2><button class="modal-close" data-action="close">✕</button></div>
    <div class="product-preview">
      <div class="pp-photo">${item.foto? `<img src="${item.foto}" alt="">`:`<span>💊</span>`}</div>
      <div class="pp-main">
        <div class="pp-sub">${escapeHtml(item.categoria)} · Cód. item <span class="mono">${escapeHtml(item.codigoItem)}</span></div>
      </div>
      <div class="pp-stock">${fmtNum(quantidade)} ${escapeHtml(item.unidade)}</div>
    </div>
    ${isGestor()? `<div class="btn-row" style="margin-bottom:18px;"><button class="btn btn-outline" id="editItemBtn">Editar item</button></div>` : ''}
    <div class="section-title" style="margin-top:0;">Lotes deste item (${lotes.length})</div>
    ${lotes.length===0? emptyState('📦','Nenhum lote','Este item ainda não tem nenhum lote registrado.') : `
      <div class="card">
        ${lotes.map(l=>{
          const est = loteExpiryStatus(l);
          const badge = est==='vencido'? `<span class="badge badge-vencido">Vencido</span>` : est==='vencendo'? `<span class="badge badge-vencendo">Vence em ${daysUntil(l.validade)}d</span>` : '';
          return `
          <div class="lote-row">
            <div class="lr-main">
              <div class="lr-code">${escapeHtml(l.codigoLote)}</div>
              <div class="lr-meta">${l.validade? 'Validade: '+fmtValidade(l.validade):'Sem validade informada'}${badge? ' · '+badge:''}</div>
            </div>
            <div class="lr-qty">${fmtNum(l.quantidade)} ${escapeHtml(item.unidade)}</div>
            ${isGestor()? `<button class="btn btn-ghost" style="width:auto;padding:7px 10px;font-size:12px;" data-action="editar-lote" data-id="${l.id}">Corrigir</button>`:''}
          </div>`;
        }).join('')}
      </div>
    `}
    <div class="section-title">Últimas movimentações</div>
    ${hist.length===0? emptyState('≡','Sem movimentações','Ainda não há entradas ou saídas registradas para este item.') : `<div class="card">${hist.map(m=>histRowHtml(m)).join('')}</div>`}
  `, { center:true });
  modal.querySelector('[data-action="close"]').onclick = closeModal;
  const editBtn = document.getElementById('editItemBtn');
  if(editBtn) editBtn.onclick = ()=> openEditItem(item);
  modal.querySelectorAll('[data-action="editar-lote"]').forEach(el=>{
    el.onclick = ()=>{ const lote = State.lotes.find(l=>l.id===el.dataset.id); if(lote) openEditLote(lote, item); };
  });
}

function openEditItem(item){
  const modal = openModal(`
    <div class="modal-head"><h2>Editar item</h2><button class="modal-close" data-action="close">✕</button></div>
    <div class="field"><label>Código do item</label><input id="eiCodigo" class="mono" value="${escapeHtml(item.codigoItem)}"></div>
    <div class="field"><label>Nome</label><input id="eiNome" value="${escapeHtml(item.nome)}"></div>
    <div class="field"><label>Categoria</label><select id="eiCategoria">${CATEGORIAS.map(c=>`<option ${c===item.categoria?'selected':''}>${c}</option>`).join('')}</select></div>
    <div class="field"><label>Unidade</label><select id="eiUnidade">${UNIDADES.map(u=>`<option ${u===item.unidade?'selected':''}>${u}</option>`).join('')}</select></div>
    <div class="field"><label>Estoque mínimo (alerta)</label><input id="eiMin" class="mono" inputmode="decimal" value="${item.estoqueMinimo}"></div>
    ${renderPhotoField('eiFoto', item.foto)}
    <button class="btn btn-primary" id="eiSaveBtn">Salvar alterações</button>
  `, { center:true });
  modal.querySelector('[data-action="close"]').onclick = closeModal;
  const fotoField = wirePhotoField('eiFoto', item.foto);
  document.getElementById('eiSaveBtn').onclick = async ()=>{
    const codigoItem = document.getElementById('eiCodigo').value.trim();
    const nome = document.getElementById('eiNome').value.trim();
    const categoria = document.getElementById('eiCategoria').value;
    const unidade = document.getElementById('eiUnidade').value;
    const min = parseFloat(document.getElementById('eiMin').value.replace(',','.'))||0;
    if(!codigoItem){ showToast('Informe o código do item.'); return; }
    if(!nome){ showToast('Informe o nome do item.'); return; }
    if(itensDaFazenda().some(i=>i.id!==item.id && i.codigoItem.toLowerCase()===codigoItem.toLowerCase())){ showToast('Já existe outro item com esse código.'); return; }
    await atualizarItem(item.id, { codigoItem, nome, categoria, unidade, estoqueMinimo: min, foto: fotoField.getFoto() });
    await refreshData();
    closeModal();
    openItemDetail(item.id);
    showToast('Item atualizado.');
  };
}

function openEditLote(lote, item){
  const qtdAtual = calcularQuantidadeLote(lote.id);
  const modal = openModal(`
    <div class="modal-head"><h2>Corrigir lote</h2><button class="modal-close" data-action="close">✕</button></div>
    <p style="font-size:12.5px;color:var(--ink-soft);margin-top:-8px;">Lote <code class="inline">${escapeHtml(lote.codigoLote)}</code> de ${escapeHtml(item.nome)}.</p>
    <div class="field"><label>Quantidade em estoque neste lote (correção manual)</label><input id="elQtd" class="mono" inputmode="decimal" value="${qtdAtual}"></div>
    <div class="field"><label>Validade deste lote (opcional)</label><input id="elValidade" type="date" value="${lote.validade||''}"></div>
    <button class="btn btn-primary" id="elSaveBtn">Salvar alterações</button>
  `, { center:true });
  modal.querySelector('[data-action="close"]').onclick = closeModal;
  document.getElementById('elSaveBtn').onclick = async ()=>{
    const novaQtd = parseFloat(document.getElementById('elQtd').value.replace(',','.'));
    const validade = document.getElementById('elValidade').value || null;
    if(isNaN(novaQtd) || novaQtd<0){ showToast('Quantidade inválida.'); return; }
    const delta = novaQtd - qtdAtual;
    await atualizarLote(lote.id, { validade });
    if(delta !== 0){
      await registrarMovimentacao({
        fazendaId: fzId(), loteId: lote.id, itemId: item.id, loteCodigoSnapshot: lote.codigoLote, itemNomeSnapshot: item.nome, tipo:'ajuste',
        quantidade: Math.abs(delta), delta, usuarioId: State.currentUser.id, usuarioNomeSnapshot: State.currentUser.nome, observacao: 'Correção manual de estoque do lote'
      });
    }
    await refreshData();
    closeModal();
    openItemDetail(item.id);
    showToast('Lote atualizado.');
  };
}

/* ================= INIT ================= */
async function boot(){
  onSyncStatusChange(handleSyncStatus);
  await initSync();
  await refreshData();
  State.loading = false;
  render();
}
boot();
