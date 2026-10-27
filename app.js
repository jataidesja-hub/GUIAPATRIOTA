// ==========================================
// ESTADO GLOBAL DA APLICAÇÃO
// ==========================================
const STORAGE_KEY = 'guia_patriota_dados_v2';
const FIREBASE_CONFIG_KEY = 'guia_patriota_fb_config';
const MASTER_ADMIN_EMAIL = 'jataides.ja@gmail.com';
const PROPAGANDAS_LOCAL_KEY = 'guia_patriota_propagandas_v1';

let prestadores = [];
let propagandas = [];
let unsubscribePropagandas = null;
let indicePropagandaRotacao = 0;
let filtroPosicao = 'todos'; // 'todos' | 'direita' | 'esquerda'
let filtroTipoServico = 'todos';
let termoBusca = '';
let map = null;
let markersLayer = null;
let grayMarkersLayer = null;
let markersById = {};
let comerciosLocaisCinza = [];
let mostrarPontosCinzas = true;
let tempPickMarker = null;
let isPickingOnMap = false;
let currentMode = 'public'; // 'public' | 'admin'
let activeProviderId = null;

// Firebase Firestore state
let db = null;
let unsubscribeFirestore = null;
let isFirebaseConnected = false;

// ==========================================
// INICIALIZAÇÃO
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();
  initPwaInstaller();
  initMap();
  setupEventListeners();
  await carregarDadosIniciais();
  await registrarAcessoVisita();
  iniciarMonitoramentoPropagandas();
  renderAll();
  fitAllMarkers();

  // Verificar se URL possui #admin (aguarda estado do Firebase Auth restaurar sessão)
  if (typeof firebase !== 'undefined' && firebase.auth) {
    firebase.auth().onAuthStateChanged((user) => {
      aplicarPermissoesRoleAdmin();
      if (window.location.hash === '#admin' && user) {
        switchView('admin');
      }
    });
  }
  if (window.location.hash === '#admin') {
    openAdminAccess();
  }
});

// ==========================================
// MAPA (LEAFLET + OPENSTREETMAP)
// ==========================================
function initMap() {
  map = L.map('map', {
    zoomControl: false,
    center: [-9.4035, -40.5020],
    zoom: 13
  });

  // Posicionar controle de zoom no canto inferior direito
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Camada de mapa oficial OpenStreetMap (100% gratuita e sem chave de API)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
  grayMarkersLayer = L.layerGroup();

  // Evento de clique no mapa (usado no modo ADM para escolher ponto exato)
  map.on('click', async (e) => {
    if (currentMode === 'admin' && (isPickingOnMap || document.getElementById('adminPanel') && !document.getElementById('adminPanel').classList.contains('hidden'))) {
      if (!isPickingOnMap) return;
      const { lat, lng } = e.latlng;
      definirCoordenadasFormulario(lat, lng);
      toggleMapPickMode(false);
      await buscarEnderecoReverso(lat, lng);
    }
  });
}

function criarIconePino(tipo) {
  const classeCor = tipo === 'cinza' ? 'cinza' : 'direita';
  const tamanho = tipo === 'cinza' ? [28, 28] : [36, 36];
  const ancora = tipo === 'cinza' ? [14, 28] : [18, 36];
  return L.divIcon({
    className: 'custom-pin-wrapper',
    html: `
      <div class="marker-pin ${classeCor}">
        <div class="marker-pin-inner"></div>
      </div>
    `,
    iconSize: tamanho,
    iconAnchor: ancora,
    popupAnchor: [0, -28]
  });
}

// ==========================================
// CARREGAMENTO E PERSISTÊNCIA DE DADOS (FIREBASE + LOCAL)
// ==========================================
function obterConfigFirebaseAtiva() {
  const fromFile = window.FIREBASE_CONFIG || {};
  if (fromFile.apiKey && fromFile.projectId) {
    return fromFile;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(FIREBASE_CONFIG_KEY) || '{}');
    if (saved.apiKey && saved.projectId) {
      return saved;
    }
  } catch (e) {
    console.warn(e);
  }
  return null;
}

function atualizarIndicadorFirebase(conectado) {
  isFirebaseConnected = conectado;
  const dot = document.getElementById('firebaseStatusDot');
  const txt = document.getElementById('firebaseStatusText');
  if (!dot || !txt) return;

  if (conectado) {
    dot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
    txt.textContent = 'Firebase Online';
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-amber-400';
    txt.textContent = 'Configurar Firebase';
  }
}

const IDS_EXEMPLO_ANTIGOS = new Set(['1', '2', '3', '4', '5']);

async function atualizarDadosFirebaseManualmente() {
  const btn = document.getElementById('btnAtualizarPendentes');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="refresh-cw" class="w-3.5 h-3.5 animate-spin text-amber-700"></i><span>Atualizando...</span>`;
    lucide.createIcons();
  }

  try {
    if (!db) {
      await inicializarFirebase();
    }
    if (db) {
      const snapshot = await db.collection('prestadores').get();
      const docs = [];
      snapshot.forEach((doc) => {
        if (!IDS_EXEMPLO_ANTIGOS.has(String(doc.id))) {
          docs.push({ id: doc.id, ...doc.data() });
        }
      });
      docs.sort((a, b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')));
      prestadores = docs;
      salvarDadosLocal();
      renderAll();

      const pendentesCount = prestadores.filter((p) => p.status === 'pendente').length;
      mostrarToast(
        pendentesCount > 0
          ? `Lista atualizada! Você tem ${pendentesCount} ${pendentesCount === 1 ? 'cadastro pendente' : 'cadastros pendentes'}.`
          : 'Lista atualizada! Nenhuma nova solicitação pendente.'
      );
    }
  } catch (err) {
    console.error('Erro ao atualizar manualmente:', err);
    mostrarToast('Erro ao consultar o Firebase.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      lucide.createIcons();
    }
  }
}

async function inicializarFirebase() {
  const config = obterConfigFirebaseAtiva();
  if (!config || typeof firebase === 'undefined') {
    atualizarIndicadorFirebase(false);
    return false;
  }

  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(config);
    }
    db = firebase.firestore();

    if (unsubscribeFirestore) {
      unsubscribeFirestore();
    }
    if (unsubscribePropagandas) {
      unsubscribePropagandas();
    }

    // Listener em tempo real de propagandas / destaques no topo
    unsubscribePropagandas = db.collection('propagandas').onSnapshot(
      (snapPromo) => {
        const listaP = [];
        snapPromo.forEach((doc) => {
          listaP.push({ id: doc.id, ...doc.data() });
        });
        listaP.sort((a, b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')));
        propagandas = listaP;
        localStorage.setItem(PROPAGANDAS_LOCAL_KEY, JSON.stringify(propagandas));
        renderPropagandaTopo();
        renderSidebarList(obterPrestadoresFiltrados());
        renderListaPropagandasMaster();
        lucide.createIcons();
      },
      (err) => console.warn('Aviso propagandas:', err)
    );

    return new Promise((resolve) => {
      let resolvedFirst = false;
      unsubscribeFirestore = db.collection('prestadores').onSnapshot(
        async (snapshot) => {
          const docs = [];
          const exemplosParaApagar = [];

          snapshot.forEach((doc) => {
            if (IDS_EXEMPLO_ANTIGOS.has(String(doc.id))) {
              exemplosParaApagar.push(String(doc.id));
            } else {
              docs.push({ id: doc.id, ...doc.data() });
            }
          });

          // Remove definitivamente do Firebase apenas os 5 itens de exemplo antigos caso ainda existam
          if (exemplosParaApagar.length > 0) {
            exemplosParaApagar.forEach((exId) => {
              db.collection('prestadores').doc(exId).delete().catch(() => {});
            });
          }

          // Ordenar mais recentes primeiro
          docs.sort((a, b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')));

          prestadores = docs;
          salvarDadosLocal();

          atualizarIndicadorFirebase(true);
          renderAll();
          if (!resolvedFirst) {
            resolvedFirst = true;
            resolve(true);
          }
        },
        (err) => {
          console.error('Erro no listener do Firestore:', err);
          atualizarIndicadorFirebase(false);
          if (!resolvedFirst) {
            resolvedFirst = true;
            resolve(false);
          }
        }
      );
    });
  } catch (err) {
    console.error('Erro ao inicializar Firebase:', err);
    atualizarIndicadorFirebase(false);
    return false;
  }
}

async function carregarDadosIniciais() {
  // Limpa do cache local os 5 exemplos antigos, mantendo apenas cadastros reais
  const salvosLocal = localStorage.getItem(STORAGE_KEY);
  if (salvosLocal) {
    try {
      const parsed = JSON.parse(salvosLocal);
      if (Array.isArray(parsed)) {
        prestadores = parsed.filter((item) => !IDS_EXEMPLO_ANTIGOS.has(String(item.id)));
        salvarDadosLocal();
      }
    } catch (err) {
      console.error('Erro ao ler localStorage:', err);
    }
  }

  // Conecta ao Firebase (fonte oficial dos dados)
  await inicializarFirebase();
}

function salvarDadosLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prestadores));
}

// ==========================================
// EVENTOS E FILTROS
// ==========================================
function setupEventListeners() {
  const searchInput = document.getElementById('searchInput');
  const serviceTypeFilter = document.getElementById('serviceTypeFilter');
  const btnToggleSidebar = document.getElementById('btnToggleSidebar');
  const btnCloseSidebarMobile = document.getElementById('btnCloseSidebarMobile');
  const inputWhatsapp = document.getElementById('inputWhatsapp');
  const inputBuscaRadar = document.getElementById('inputBuscaRadar');

  if (inputBuscaRadar) {
    inputBuscaRadar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        carregarComerciosLocaisRadar(true);
      }
    });
  }

  searchInput.addEventListener('input', (e) => {
    termoBusca = e.target.value.trim().toLowerCase();
    document.getElementById('btnClearSearch').classList.toggle('hidden', !termoBusca);
    renderAll();
  });

  serviceTypeFilter.addEventListener('change', (e) => {
    filtroTipoServico = e.target.value;
    renderAll();
  });

  btnToggleSidebar.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebarPrestadores');
    const isHidden = sidebar.classList.contains('-translate-x-full');
    toggleSidebar(isHidden);
  });

  btnCloseSidebarMobile.addEventListener('click', () => {
    toggleSidebar(false);
  });

  // Máscara simples de telefone/WhatsApp no formulário ADM
  inputWhatsapp.addEventListener('input', (e) => {
    let v = e.target.value.replace(/\D/g, '');
    if (v.startsWith('55') && v.length > 11) {
      v = v.slice(2);
    }
    if (v.length > 11) v = v.slice(0, 11);
    if (v.length > 6) {
      e.target.value = `(${v.slice(0, 2)}) ${v.slice(2, 7)}-${v.slice(7)}`;
    } else if (v.length > 2) {
      e.target.value = `(${v.slice(0, 2)}) ${v.slice(2)}`;
    } else if (v.length > 0) {
      e.target.value = `(${v}`;
    }
  });
}

function toggleSidebar(show) {
  const sidebar = document.getElementById('sidebarPrestadores');
  if (show) {
    sidebar.classList.remove('-translate-x-full');
  } else {
    sidebar.classList.add('-translate-x-full');
  }
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  termoBusca = '';
  document.getElementById('btnClearSearch').classList.add('hidden');
  renderAll();
}

function obterPrestadoresAprovados() {
  return prestadores.filter((item) => item.status !== 'pendente');
}

function obterPrestadoresFiltrados() {
  return obterPrestadoresAprovados().filter((item) => {
    const matchServico = filtroTipoServico === 'todos' || item.tipoServico === filtroTipoServico;
    const textoItem = `${item.nome} ${item.tipoServico} ${item.servicos} ${item.endereco} ${item.instagram || ''}`.toLowerCase();
    const matchBusca = !termoBusca || textoItem.includes(termoBusca);
    return matchServico && matchBusca;
  });
}

// ==========================================
// RENDERIZAÇÃO GERAL (MAPA + SIDEBAR + ADM)
// ==========================================
function renderAll() {
  atualizarContadores();
  atualizarSelectCategorias();
  const filtrados = obterPrestadoresFiltrados();
  renderMarkers(filtrados);
  renderGrayMarkers();
  renderPropagandaTopo();
  renderSidebarList(filtrados);
  renderAdminList();
  lucide.createIcons();
}

function atualizarContadores() {
  const aprovados = obterPrestadoresAprovados();
  const pendentes = prestadores.filter((p) => p.status === 'pendente');
  const total = aprovados.length;

  const elTop = document.getElementById('countTodosTop');
  if (elTop) elTop.textContent = total;

  const elAdminTotal = document.getElementById('adminTotalCount');
  if (elAdminTotal) elAdminTotal.textContent = total;

  const badgePendentesAdmin = document.getElementById('adminPendentesCount');
  if (badgePendentesAdmin) {
    badgePendentesAdmin.textContent = `${pendentes.length} ${pendentes.length === 1 ? 'pendente' : 'pendentes'}`;
  }

  const badgeTop = document.getElementById('badgeTopPendentes');
  if (badgeTop) {
    badgeTop.textContent = pendentes.length;
    badgeTop.classList.toggle('hidden', pendentes.length === 0);
  }
}

function atualizarSelectCategorias() {
  const select = document.getElementById('serviceTypeFilter');
  const valorAtual = select.value;
  const aprovados = obterPrestadoresAprovados();
  const categorias = [...new Set(aprovados.map((p) => p.tipoServico).filter(Boolean))].sort();

  select.innerHTML = `<option value="todos">Todos os tipos de serviço (${categorias.length})</option>`;
  categorias.forEach((cat) => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);
  });

  if (categorias.includes(valorAtual)) {
    select.value = valorAtual;
  } else {
    select.value = 'todos';
    filtroTipoServico = 'todos';
  }
}

function formatarLinkWhatsapp(numero, nome) {
  let limpo = String(numero || '').replace(/\D/g, '');
  if (!limpo.startsWith('55') && limpo.length >= 10) {
    limpo = '55' + limpo;
  }
  const msg = encodeURIComponent(`Olá ${nome}! Encontrei seu contato no Guia Comercial e gostaria de mais informações.`);
  return `https://wa.me/${limpo}?text=${msg}`;
}

function formatarTelefoneExibicao(numero) {
  let v = String(numero || '').replace(/\D/g, '');
  if (v.startsWith('55') && v.length > 11) v = v.slice(2);
  if (v.length === 11) return `(${v.slice(0, 2)}) ${v.slice(2, 7)}-${v.slice(7)}`;
  if (v.length === 10) return `(${v.slice(0, 2)}) ${v.slice(2, 6)}-${v.slice(6)}`;
  return numero;
}

function formatarLinkInstagram(ig) {
  if (!ig) return '';
  let limpo = String(ig).trim();
  if (!limpo) return '';
  if (limpo.startsWith('http://') || limpo.startsWith('https://')) {
    return limpo;
  }
  limpo = limpo
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '')
    .trim();
  return limpo ? `https://www.instagram.com/${limpo}` : '';
}

function renderMarkers(lista) {
  markersLayer.clearLayers();
  markersById = {};

  lista.forEach((item) => {
    const lat = parseFloat(item.lat);
    const lng = parseFloat(item.lng);
    if (isNaN(lat) || isNaN(lng)) return;

    const temZap = Boolean(String(item.whatsapp || '').replace(/\D/g, ''));
    const linkZap = formatarLinkWhatsapp(item.whatsapp, item.nome);
    const linkIg = formatarLinkInstagram(item.instagram);
    const linkGoogleMaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.endereco || `${lat},${lng}`)}`;

    const popupHtml = `
      <div class="font-sans text-slate-800">
        <div class="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-3.5">
          <span class="inline-block text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full bg-black/25 mb-1">
            ${escapeHtml(item.tipoServico)}
          </span>
          <h3 class="font-bold text-base leading-snug">${escapeHtml(item.nome)}</h3>
        </div>
        <div class="p-3.5 space-y-2.5 bg-white">
          <div>
            <p class="text-[11px] font-bold uppercase text-slate-400">Serviços Prestados</p>
            <p class="text-xs text-slate-700 leading-relaxed mt-0.5">${escapeHtml(item.servicos)}</p>
          </div>
          <div>
            <p class="text-[11px] font-bold uppercase text-slate-400">Endereço Comercial</p>
            <p class="text-xs text-slate-600 mt-0.5">${escapeHtml(item.endereco)}</p>
          </div>
          <div class="pt-1 flex flex-wrap gap-1.5">
            ${
              temZap
                ? `
            <a
              href="${linkZap}"
              target="_blank"
              rel="noopener noreferrer"
              onclick="registrarCliqueWhatsapp()"
              class="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 !text-white font-bold text-xs rounded-xl text-center flex items-center justify-center gap-1.5 shadow-sm no-underline transition"
            >
              <span>WhatsApp</span>
            </a>
            `
                : ''
            }
            ${
              linkIg
                ? `
            <a
              href="${linkIg}"
              target="_blank"
              rel="noopener noreferrer"
              class="flex-1 py-2 px-3 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 !text-white font-bold text-xs rounded-xl text-center flex items-center justify-center gap-1.5 shadow-sm no-underline transition"
            >
              <span>Instagram</span>
            </a>
            `
                : ''
            }
            <a
              href="${linkGoogleMaps}"
              target="_blank"
              rel="noopener noreferrer"
              class="py-2 px-3 bg-slate-100 hover:bg-slate-200 !text-slate-700 font-semibold text-xs rounded-xl flex items-center justify-center no-underline transition"
              title="Abrir rota no Google Maps"
            >
              <span>Rota</span>
            </a>
          </div>
        </div>
      </div>
    `;

    const marker = L.marker([lat, lng], {
      icon: criarIconePino('padrao')
    }).bindPopup(popupHtml);

    marker.on('click', () => {
      destacarCardNaLista(item.id);
    });

    markersLayer.addLayer(marker);
    markersById[item.id] = marker;
  });
}

function renderSidebarList(lista) {
  const container = document.getElementById('providersList');
  const lblCount = document.getElementById('lblResultCount');
  lblCount.textContent = `${lista.length} ${lista.length === 1 ? 'prestador' : 'prestadores'}`;

  const promosAtivas = obterPropagandasAtivasAgora();
  const htmlPromosSidebar = promosAtivas
    .map((promo) => {
      const temZap = Boolean(String(promo.whatsapp || '').replace(/\D/g, ''));
      const linkZap = formatarLinkWhatsapp(promo.whatsapp, promo.nome);
      const linkIg = formatarLinkInstagram(promo.instagram);

      return `
        <article class="promo-blink-card rounded-2xl p-3.5 shadow-md space-y-2">
          <div class="flex items-center justify-between gap-2">
            <span class="promo-blink-badge inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase text-white shadow">
              🔥 DESTAQUE PATROCINADO
            </span>
            <span class="text-[11px] font-bold text-amber-900 bg-amber-200/70 px-2 py-0.5 rounded-lg truncate max-w-[150px]">
              ${escapeHtml(promo.categoria || 'Destaque')}
            </span>
          </div>

          <h3 class="font-extrabold text-slate-950 text-base leading-snug">
            ${escapeHtml(promo.nome)}
          </h3>

          <p class="text-xs font-medium text-slate-800 leading-relaxed">
            ${escapeHtml(promo.texto)}
          </p>

          <div class="flex flex-wrap items-center gap-2 pt-1.5">
            ${
              temZap
                ? `
            <a
              href="${linkZap}"
              target="_blank"
              rel="noopener noreferrer"
              onclick="registrarCliqueWhatsapp()"
              class="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 shadow-sm transition"
            >
              <i data-lucide="message-circle" class="w-3.5 h-3.5"></i>
              <span>WhatsApp</span>
            </a>
            `
                : ''
            }
            ${
              linkIg
                ? `
            <a
              href="${linkIg}"
              target="_blank"
              rel="noopener noreferrer"
              class="flex-1 py-2 px-3 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 shadow-sm transition"
            >
              <i data-lucide="instagram" class="w-3.5 h-3.5"></i>
              <span>Instagram</span>
            </a>
            `
                : ''
            }
          </div>
        </article>
      `;
    })
    .join('');

  if (lista.length === 0) {
    container.innerHTML =
      htmlPromosSidebar +
      `
      <div class="text-center py-12 px-4">
        <div class="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
          <i data-lucide="map-pin-off" class="w-6 h-6"></i>
        </div>
        <h3 class="font-bold text-slate-700 text-sm">Nenhum prestador encontrado</h3>
        <p class="text-xs text-slate-500 mt-1">Tente selecionar outra categoria ou limpar a busca.</p>
      </div>
    `;
    return;
  }

  container.innerHTML =
    htmlPromosSidebar +
    lista
      .map((item) => {
      const temZap = Boolean(String(item.whatsapp || '').replace(/\D/g, ''));
      const linkZap = formatarLinkWhatsapp(item.whatsapp, item.nome);
      const linkIg = formatarLinkInstagram(item.instagram);
      const foneFormatado = formatarTelefoneExibicao(item.whatsapp);
      const temMapa = !item.semEndereco && !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lng));
      const textoEndereco = item.endereco && item.endereco.trim()
        ? item.endereco
        : 'Prestador sem endereço fixo (Atendimento móvel / online)';

      return `
        <article
          id="card-${item.id}"
          class="provider-card bg-white rounded-2xl border border-slate-200 border-l-4 border-l-blue-600 p-3.5 shadow-sm hover:shadow-md"
        >
          <div class="flex items-start justify-between gap-2 mb-1.5">
            <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-blue-800 border border-blue-200">
              <i data-lucide="briefcase" class="w-3 h-3 text-blue-600"></i>
              ${escapeHtml(item.tipoServico)}
            </span>
          </div>

          <h3 class="font-bold text-slate-900 text-base leading-snug">
            ${escapeHtml(item.nome)}
          </h3>

          <p class="text-xs text-slate-600 mt-1 line-clamp-2 leading-relaxed">
            ${escapeHtml(item.servicos)}
          </p>

          <div class="flex items-start gap-1.5 text-xs text-slate-500 mt-2">
            <i data-lucide="${temMapa ? 'map-pin' : 'user-check'}" class="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5"></i>
            <span class="leading-tight">${escapeHtml(textoEndereco)}</span>
          </div>

          <div class="flex flex-wrap items-center gap-2 mt-3 pt-2.5 border-t border-slate-100">
            ${
              temMapa
                ? `
            <button
              onclick="focarNoMapa('${item.id}')"
              class="flex-1 py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition"
            >
              <i data-lucide="navigation" class="w-3.5 h-3.5 text-slate-600"></i>
              <span>Mapa</span>
            </button>
            `
                : ''
            }

            ${
              temZap
                ? `
            <a
              href="${linkZap}"
              target="_blank"
              rel="noopener noreferrer"
              onclick="registrarCliqueWhatsapp()"
              class="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 shadow-sm shadow-emerald-600/20 transition"
              title="Conversar no WhatsApp: ${escapeHtml(foneFormatado)}"
            >
              <i data-lucide="message-circle" class="w-3.5 h-3.5"></i>
              <span>WhatsApp</span>
            </a>
            `
                : ''
            }

            ${
              linkIg
                ? `
            <a
              href="${linkIg}"
              target="_blank"
              rel="noopener noreferrer"
              class="flex-1 py-2 px-3 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 shadow-sm shadow-pink-600/20 transition"
              title="Abrir Instagram"
            >
              <i data-lucide="instagram" class="w-3.5 h-3.5"></i>
              <span>Instagram</span>
            </a>
            `
                : ''
            }
          </div>
        </article>
      `;
    })
    .join('');
}

function focarNoMapa(id) {
  const item = prestadores.find((p) => p.id === id);
  if (!item) return;

  // Em telas mobile, fecha a sidebar para exibir o mapa
  if (window.innerWidth < 1024) {
    toggleSidebar(false);
  }

  const lat = parseFloat(item.lat);
  const lng = parseFloat(item.lng);
  if (!isNaN(lat) && !isNaN(lng)) {
    map.flyTo([lat, lng], 16, { duration: 0.8 });
    const marker = markersById[id];
    if (marker) {
      setTimeout(() => marker.openPopup(), 400);
    }
  }
  destacarCardNaLista(id);
}

function destacarCardNaLista(id) {
  activeProviderId = id;
  document.querySelectorAll('.provider-card').forEach((el) => {
    el.classList.remove('active-card-direita', 'active-card-esquerda');
  });

  const item = prestadores.find((p) => p.id === id);
  const card = document.getElementById(`card-${id}`);
  if (card && item) {
    card.classList.add(item.posicao === 'esquerda' ? 'active-card-esquerda' : 'active-card-direita');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function fitAllMarkers() {
  const filtrados = obterPrestadoresFiltrados();
  const coords = filtrados
    .map((p) => [parseFloat(p.lat), parseFloat(p.lng)])
    .filter(([lat, lng]) => !isNaN(lat) && !isNaN(lng));

  if (coords.length > 0) {
    const bounds = L.latLngBounds(coords);
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
  }
}

// ==========================================
// PAINEL ADMINISTRATIVO (TELA ADM - FIREBASE AUTH: MASTER vs ADM NORMAL)
// ==========================================
function isAdminAuthenticated() {
  return typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser !== null;
}

function isMasterAdmin() {
  if (!isAdminAuthenticated()) return false;
  const email = String(firebase.auth().currentUser.email || '').trim().toLowerCase();
  return email === MASTER_ADMIN_EMAIL;
}

function aplicarPermissoesRoleAdmin() {
  const master = isMasterAdmin();
  const badgeMaster = document.getElementById('badgeMasterRole');
  const btnPromo = document.getElementById('btnMasterPropaganda');
  const btnRel = document.getElementById('btnMasterRelatorio');
  const btnDash = document.getElementById('btnMasterDashboard');
  const btnCloud = document.getElementById('btnMasterCloudConfig');
  const lblSub = document.getElementById('lblAdminRoleSubtitle');

  if (badgeMaster) badgeMaster.classList.toggle('hidden', !master);
  if (btnPromo) {
    btnPromo.classList.toggle('hidden', !master);
    btnPromo.classList.toggle('flex', master);
  }
  if (btnRel) {
    btnRel.classList.toggle('hidden', !master);
    btnRel.classList.toggle('flex', master);
  }
  if (btnDash) {
    btnDash.classList.toggle('hidden', !master);
    btnDash.classList.toggle('flex', master);
  }
  if (btnCloud) {
    btnCloud.classList.toggle('hidden', !master);
    btnCloud.classList.toggle('flex', master);
  }
  if (lblSub && isAdminAuthenticated()) {
    const emailAtual = firebase.auth().currentUser.email || '';
    lblSub.textContent = master
      ? `ADM Master (${emailAtual})`
      : `ADM Padrão (${emailAtual})`;
  }
}

function openAdminAccess() {
  if (isAdminAuthenticated()) {
    aplicarPermissoesRoleAdmin();
    switchView('admin');
  } else {
    document.getElementById('modalAdminLogin').classList.remove('hidden');
    document.getElementById('inputAdminPassword').value = '';
    document.getElementById('loginErrorMsg').classList.add('hidden');
    setTimeout(() => document.getElementById('inputAdminEmail').focus(), 100);
  }
}

function closeAdminLoginModal() {
  document.getElementById('modalAdminLogin').classList.add('hidden');
}

async function handleAdminLogin(e) {
  e.preventDefault();
  const email = document.getElementById('inputAdminEmail').value.trim();
  const passInput = document.getElementById('inputAdminPassword').value;
  const errorEl = document.getElementById('loginErrorMsg');
  const btnSubmit = document.getElementById('btnLoginSubmit');

  errorEl.classList.add('hidden');
  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Autenticando...';

  try {
    await firebase.auth().signInWithEmailAndPassword(email, passInput);
    aplicarPermissoesRoleAdmin();
    closeAdminLoginModal();
    switchView('admin');
    mostrarToast(isMasterAdmin() ? 'Bem-vindo, ADM Master!' : 'Autenticado no Painel ADM!');
  } catch (err) {
    console.error('Erro de autenticação:', err);
    errorEl.textContent = 'E-mail ou senha incorretos no Firebase Authentication.';
    errorEl.classList.remove('hidden');
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Entrar no Painel';
  }
}

async function handleAdminLogout() {
  try {
    if (typeof firebase !== 'undefined' && firebase.auth) {
      await firebase.auth().signOut();
    }
  } catch (err) {
    console.error(err);
  }
  closeAdminDashboard();
  closeAdminPropagandaModal();
  switchView('public');
  mostrarToast('Sessão encerrada.');
}

function switchView(mode) {
  if (mode === 'admin' && !isAdminAuthenticated()) {
    openAdminAccess();
    return;
  }
  currentMode = mode;
  const adminPanel = document.getElementById('adminPanel');
  const badgeMode = document.getElementById('badgeModeIndicator');
  const btnViewPublic = document.getElementById('btnViewPublic');
  const btnViewAdmin = document.getElementById('btnViewAdmin');

  if (mode === 'admin') {
    aplicarPermissoesRoleAdmin();
    adminPanel.classList.remove('hidden');
    adminPanel.classList.add('flex');
    badgeMode.textContent = isMasterAdmin() ? 'ADM MASTER' : 'Modo ADM';
    badgeMode.className = 'text-[11px] font-semibold uppercase px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30';
    btnViewPublic.classList.remove('hidden');
    btnViewPublic.classList.add('flex');
    btnViewAdmin.classList.add('hidden');
    window.location.hash = 'admin';
    if (mostrarPontosCinzas && !map.hasLayer(grayMarkersLayer)) {
      grayMarkersLayer.addTo(map);
    }
    if (comerciosLocaisCinza.length === 0) {
      setTimeout(() => carregarComerciosLocaisRadar(false), 350);
    } else {
      renderGrayMarkers();
    }
  } else {
    adminPanel.classList.add('hidden');
    adminPanel.classList.remove('flex');
    if (map.hasLayer(grayMarkersLayer)) {
      map.removeLayer(grayMarkersLayer);
    }
    toggleMapPickMode(false);
    removerPinoTemporario();
    badgeMode.textContent = 'Acesso Livre';
    badgeMode.className = 'text-[11px] font-semibold uppercase px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    btnViewPublic.classList.add('hidden');
    btnViewPublic.classList.remove('flex');
    btnViewAdmin.classList.remove('hidden');
    if (window.location.hash === '#admin') {
      history.replaceState(null, null, ' ');
    }
  }

  setTimeout(() => {
    map.invalidateSize();
  }, 250);
}

// ==========================================
// GEOCODING (BUSCAR ENDEREÇO NO MAPA E CLICAR NO MAPA)
// ==========================================
async function buscarEnderecoNoMapa() {
  const endereco = document.getElementById('inputEndereco').value.trim();
  if (!endereco) {
    mostrarToast('Digite o endereço comercial primeiro para localizar no mapa.');
    document.getElementById('inputEndereco').focus();
    return;
  }

  const btn = document.getElementById('btnGeocode');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span>Buscando...</span>`;

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(endereco)}`;
    const resp = await fetch(url, {
      headers: { 'Accept-Language': 'pt-BR' }
    });
    const dados = await resp.json();

    if (Array.isArray(dados) && dados.length > 0) {
      const lat = parseFloat(dados[0].lat);
      const lng = parseFloat(dados[0].lon);
      definirCoordenadasFormulario(lat, lng);
      map.flyTo([lat, lng], 16);
      mostrarToast('Endereço localizado no mapa!');
    } else {
      mostrarToast('Endereço não encontrado automaticamente. Clique em "Marcar ponto no mapa"!');
    }
  } catch (err) {
    console.error(err);
    mostrarToast('Erro ao buscar endereço. Use o clique no mapa.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    lucide.createIcons();
  }
}

async function buscarEnderecoReverso(lat, lng) {
  const inputEnd = document.getElementById('inputEndereco');
  if (inputEnd.value.trim() !== '') return; // Não sobrescreve se o ADM já digitou

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
    const resp = await fetch(url, {
      headers: { 'Accept-Language': 'pt-BR' }
    });
    const data = await resp.json();
    if (data && data.display_name) {
      const addr = data.address || {};
      const rua = addr.road || addr.pedestrian || '';
      const numero = addr.house_number || 'S/N';
      const bairro = addr.suburb || addr.neighbourhood || addr.city_district || '';
      const cidade = addr.city || addr.town || addr.municipality || '';
      const estado = addr.state || '';
      const montado = [
        rua ? `${rua}, ${numero}` : '',
        bairro,
        cidade ? `${cidade} - ${estado}` : ''
      ].filter(Boolean).join(' - ');

      inputEnd.value = montado || data.display_name;
    }
  } catch (err) {
    console.warn('Reverse geocode falhou:', err);
  }
}

function toggleMapPickMode(ativar) {
  isPickingOnMap = ativar;
  const banner = document.getElementById('mapPickBanner');
  if (ativar) {
    banner.classList.remove('hidden');
    document.body.classList.add('map-pick-cursor');
    // Em telas menores, recolhe temporariamente o painel para clicar no mapa
    if (window.innerWidth < 1024) {
      document.getElementById('adminPanel').classList.add('hidden');
    }
  } else {
    banner.classList.add('hidden');
    document.body.classList.remove('map-pick-cursor');
    if (currentMode === 'admin') {
      document.getElementById('adminPanel').classList.remove('hidden');
    }
  }
}

function definirCoordenadasFormulario(lat, lng) {
  const latFixed = Number(lat).toFixed(6);
  const lngFixed = Number(lng).toFixed(6);
  document.getElementById('inputLat').value = latFixed;
  document.getElementById('inputLng').value = lngFixed;

  removerPinoTemporario();
  tempPickMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: 'custom-pin-wrapper',
      html: `<div class="marker-pin temp-pin"><div class="marker-pin-inner"></div></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 36]
    })
  }).addTo(map);
}

function removerPinoTemporario() {
  if (tempPickMarker) {
    map.removeLayer(tempPickMarker);
    tempPickMarker = null;
  }
}

function toggleSemEndereco(semEndereco) {
  const bloco = document.getElementById('blocoCamposEndereco');
  const aviso = document.getElementById('avisoSemEndereco');
  const chk = document.getElementById('inputSemEndereco');
  if (chk) chk.checked = Boolean(semEndereco);

  if (semEndereco) {
    bloco.classList.add('hidden');
    aviso.classList.remove('hidden');
    document.getElementById('inputEndereco').value = '';
    document.getElementById('inputLat').value = '';
    document.getElementById('inputLng').value = '';
    toggleMapPickMode(false);
    removerPinoTemporario();
  } else {
    bloco.classList.remove('hidden');
    aviso.classList.add('hidden');
  }
}

// ==========================================
// CRUD DO ADMINISTRADOR (SALVAR, EDITAR, EXCLUIR)
// ==========================================
async function saveProvider(e) {
  e.preventDefault();
  if (!isAdminAuthenticated()) {
    mostrarToast('Acesso negado: faça login no Firebase Auth primeiro.');
    openAdminAccess();
    return;
  }

  const id = document.getElementById('providerId').value;
  const nome = document.getElementById('inputNome').value.trim();
  const tipoServico = document.getElementById('inputTipoServico').value.trim();
  const whatsapp = document.getElementById('inputWhatsapp').value.trim();
  const instagram = (document.getElementById('inputInstagram')?.value || '').trim();
  const servicos = document.getElementById('inputServicos').value.trim();
  const chkSemEnd = document.getElementById('inputSemEndereco')?.checked || false;
  const endereco = chkSemEnd ? '' : document.getElementById('inputEndereco').value.trim();
  const rawLat = parseFloat(document.getElementById('inputLat').value);
  const rawLng = parseFloat(document.getElementById('inputLng').value);
  const temCoordenadas = !chkSemEnd && !isNaN(rawLat) && !isNaN(rawLng);

  const novoItem = {
    id: id || String(Date.now()),
    nome,
    tipoServico,
    servicos,
    endereco,
    semEndereco: !temCoordenadas && !endereco,
    whatsapp,
    instagram,
    lat: temCoordenadas ? rawLat : null,
    lng: temCoordenadas ? rawLng : null,
    status: 'aprovado',
    criadoEm: new Date().toISOString()
  };

  if (id) {
    const index = prestadores.findIndex((p) => p.id === id);
    if (index !== -1) {
      prestadores[index] = novoItem;
    }
    mostrarToast('Cadastro atualizado!');
  } else {
    prestadores.unshift(novoItem);
    mostrarToast(temCoordenadas ? 'Adicionado no Mapa e na Lista!' : 'Prestador sem endereço fixo adicionado na Lista!');
  }

  salvarDadosLocal();
  removerPinoTemporario();
  resetAdminForm();
  renderAll();
  if (temCoordenadas) {
    focarNoMapa(novoItem.id);
  } else {
    destacarCardNaLista(novoItem.id);
  }

  // Salva diretamente no Firebase Firestore se conectado
  if (db && isFirebaseConnected) {
    try {
      await db.collection('prestadores').doc(String(novoItem.id)).set(novoItem);
      mostrarToast('Salvo em tempo real no Firebase!');
    } catch (err) {
      console.error('Erro ao salvar no Firebase:', err);
      mostrarToast('Salvo localmente (erro de permissão no Firebase).');
    }
  }
}

function editarPrestador(id) {
  const item = prestadores.find((p) => p.id === id);
  if (!item) return;

  const temCoords = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lng));
  const isSemEnd = Boolean(item.semEndereco) || (!temCoords && !item.endereco);

  document.getElementById('providerId').value = item.id;
  document.getElementById('inputNome').value = item.nome;
  document.getElementById('inputTipoServico').value = item.tipoServico;
  document.getElementById('inputWhatsapp').value = formatarTelefoneExibicao(item.whatsapp);
  if (document.getElementById('inputInstagram')) {
    document.getElementById('inputInstagram').value = item.instagram || '';
  }
  document.getElementById('inputServicos').value = item.servicos;

  toggleSemEndereco(isSemEnd);
  document.getElementById('inputEndereco').value = item.endereco || '';
  document.getElementById('inputLat').value = temCoords ? item.lat : '';
  document.getElementById('inputLng').value = temCoords ? item.lng : '';

  document.getElementById('formTitle').innerHTML = `
    <i data-lucide="edit-3" class="w-4 h-4 text-amber-600"></i>
    <span>Editando: ${escapeHtml(item.nome)}</span>
  `;
  document.getElementById('lblSubmitBtn').textContent = 'Salvar Alterações';
  document.getElementById('btnCancelEdit').classList.remove('hidden');

  if (temCoords) {
    definirCoordenadasFormulario(item.lat, item.lng);
    map.flyTo([item.lat, item.lng], 16);
  } else {
    removerPinoTemporario();
  }
  document.getElementById('adminForm').scrollIntoView({ behavior: 'smooth' });
  lucide.createIcons();
}

async function excluirPrestador(id) {
  if (!isAdminAuthenticated()) {
    mostrarToast('Acesso negado: faça login no Firebase Auth primeiro.');
    openAdminAccess();
    return;
  }
  const item = prestadores.find((p) => p.id === id);
  if (!item) return;

  if (!confirm(`Deseja realmente remover "${item.nome}" do mapa e da lista lateral?`)) {
    return;
  }

  prestadores = prestadores.filter((p) => p.id !== id);
  salvarDadosLocal();
  renderAll();
  mostrarToast('Cadastro removido com sucesso.');

  if (db && isFirebaseConnected) {
    try {
      await db.collection('prestadores').doc(String(id)).delete();
    } catch (err) {
      console.error('Erro ao excluir no Firebase:', err);
    }
  }
}

function resetAdminForm() {
  document.getElementById('adminForm').reset();
  document.getElementById('providerId').value = '';
  toggleSemEndereco(false);
  document.getElementById('formTitle').innerHTML = `
    <i data-lucide="plus-circle" class="w-4 h-4 text-blue-600"></i>
    <span>Novo Cadastro no Mapa & Lista</span>
  `;
  document.getElementById('lblSubmitBtn').textContent = 'Salvar no Mapa e Menu Lateral';
  document.getElementById('btnCancelEdit').classList.add('hidden');
  removerPinoTemporario();
  lucide.createIcons();
}

function copiarLinkCadastro() {
  const url = new URL('./cadastro.html', window.location.href).href;
  navigator.clipboard.writeText(url).then(() => {
    mostrarToast('Link de cadastro copiado! Envie para os prestadores.');
  }).catch(() => {
    prompt('Copie o link de cadastro abaixo:', url);
  });
}

function usarMinhaLocalizacaoADM() {
  if (!navigator.geolocation) {
    mostrarToast('Seu navegador não suporta geolocalização.');
    return;
  }
  mostrarToast('Obtendo sua localização pelo GPS...');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      toggleSemEndereco(false);
      definirCoordenadasFormulario(lat, lng);
      map.flyTo([lat, lng], 17);
      await buscarEnderecoReverso(lat, lng);
      mostrarToast('Localização atual aplicada!');
    },
    () => {
      mostrarToast('Não foi possível acessar seu GPS. Permita a localização no navegador.');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function aprovarCadastroPendente(id) {
  if (!isAdminAuthenticated()) {
    mostrarToast('Faça login no Painel ADM primeiro.');
    return;
  }

  const index = prestadores.findIndex((p) => p.id === id);
  if (index === -1) return;

  prestadores[index].status = 'aprovado';
  const aprovado = prestadores[index];

  salvarDadosLocal();
  renderAll();
  mostrarToast(`"${aprovado.nome}" aprovado e publicado no Mapa & Lista!`);

  if (db && isFirebaseConnected) {
    try {
      await db.collection('prestadores').doc(String(id)).set(aprovado);
    } catch (err) {
      console.error('Erro ao aprovar no Firebase:', err);
    }
  }
}

async function reprovarCadastroPendente(id) {
  if (!isAdminAuthenticated()) {
    mostrarToast('Faça login no Painel ADM primeiro.');
    return;
  }

  const item = prestadores.find((p) => p.id === id);
  if (!item) return;

  if (!confirm(`Deseja REPROVAR e excluir a solicitação de "${item.nome}"?`)) {
    return;
  }

  prestadores = prestadores.filter((p) => p.id !== id);
  salvarDadosLocal();
  renderAll();
  mostrarToast('Solicitação reprovada e removida.');

  if (db && isFirebaseConnected) {
    try {
      await db.collection('prestadores').doc(String(id)).delete();
    } catch (err) {
      console.error('Erro ao reprovar no Firebase:', err);
    }
  }
}

function visualizarPendenteNoMapa(id) {
  const item = prestadores.find((p) => p.id === id);
  if (!item) return;
  const lat = parseFloat(item.lat);
  const lng = parseFloat(item.lng);
  if (!isNaN(lat) && !isNaN(lng)) {
    definirCoordenadasFormulario(lat, lng);
    map.flyTo([lat, lng], 16);
  }
}

function renderAdminList() {
  const containerPendentes = document.getElementById('adminPendentesList');
  const container = document.getElementById('adminProvidersList');
  if (!container) return;

  const pendentes = prestadores.filter((p) => p.status === 'pendente');
  const aprovados = obterPrestadoresAprovados();

  if (containerPendentes) {
    if (pendentes.length === 0) {
      containerPendentes.innerHTML = `<p class="text-[11px] text-amber-800/70 text-center py-2">Nenhuma solicitação aguardando aprovação.</p>`;
    } else {
      containerPendentes.innerHTML = pendentes
        .map((item) => {
          const temCoords = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lng));
          const infoEnd = item.endereco && item.endereco.trim()
            ? item.endereco
            : 'Sem endereço fixo (Apenas lista)';
          const igInfo = item.instagram ? ` • IG: ${item.instagram}` : '';

          return `
            <div class="p-3 bg-white rounded-xl border-2 border-amber-300 shadow-sm space-y-2">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <span class="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full border bg-blue-50 text-blue-800 border-blue-200 mb-1">
                    ${escapeHtml(item.tipoServico)}
                  </span>
                  <h4 class="font-bold text-xs sm:text-sm text-slate-900">${escapeHtml(item.nome)}</h4>
                  <p class="text-[11px] font-semibold text-slate-600">${escapeHtml(formatarTelefoneExibicao(item.whatsapp))}${escapeHtml(igInfo)}</p>
                </div>
                ${
                  temCoords
                    ? `<button onclick="visualizarPendenteNoMapa('${item.id}')" class="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[11px] font-bold shrink-0">Ver Ponto</button>`
                    : ''
                }
              </div>

              <p class="text-xs text-slate-600 bg-slate-50 p-2 rounded-lg border border-slate-100">${escapeHtml(item.servicos)}</p>
              <p class="text-[11px] text-slate-500">${escapeHtml(infoEnd)}</p>

              <div class="flex items-center gap-1.5 pt-1">
                <button
                  onclick="aprovarCadastroPendente('${item.id}')"
                  class="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1 shadow-sm transition"
                >
                  <i data-lucide="check" class="w-3.5 h-3.5"></i>
                  <span>Aprovar</span>
                </button>
                <button
                  onclick="editarPrestador('${item.id}')"
                  class="py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl transition"
                  title="Editar antes de aprovar"
                >
                  <span>Editar</span>
                </button>
                <button
                  onclick="reprovarCadastroPendente('${item.id}')"
                  class="py-2 px-3 bg-red-100 hover:bg-red-200 text-red-700 font-bold text-xs rounded-xl flex items-center justify-center gap-1 transition"
                >
                  <i data-lucide="x" class="w-3.5 h-3.5"></i>
                  <span>Reprovar</span>
                </button>
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  if (aprovados.length === 0) {
    container.innerHTML = `<p class="text-xs text-slate-400 text-center py-4">Nenhum cadastro ativo.</p>`;
    return;
  }

  container.innerHTML = aprovados
    .map((item) => {
      const infoEnd = item.endereco && item.endereco.trim()
        ? item.endereco
        : 'Sem endereço fixo (Apenas no menu lateral)';
      const igInfo = item.instagram ? ` • ${item.instagram}` : '';

      return `
        <div class="p-3 bg-white rounded-xl border border-slate-200 flex items-center justify-between gap-2 hover:border-slate-300 transition">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-full bg-blue-600 shrink-0"></span>
              <h4 class="font-bold text-xs text-slate-900 truncate">${escapeHtml(item.nome)}</h4>
            </div>
            <p class="text-[11px] text-slate-500 truncate mt-0.5">${escapeHtml(item.tipoServico)}${escapeHtml(igInfo)}</p>
            <p class="text-[11px] text-slate-400 truncate">${escapeHtml(infoEnd)}</p>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button
              onclick="editarPrestador('${item.id}')"
              class="p-2 rounded-lg bg-slate-100 hover:bg-blue-50 text-slate-600 hover:text-blue-600 transition"
              title="Editar"
            >
              <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
            </button>
            <button
              onclick="excluirPrestador('${item.id}')"
              class="p-2 rounded-lg bg-slate-100 hover:bg-red-50 text-slate-600 hover:text-red-600 transition"
              title="Excluir"
            >
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

// ==========================================
// EXPORTAR / IMPORTAR JSON E SINCRONIZAÇÃO GITHUB
// ==========================================
function exportarDadosJSON() {
  const dataStr = JSON.stringify(prestadores, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dados.json';
  a.click();
  URL.revokeObjectURL(url);
  mostrarToast('Arquivo dados.json exportado!');
}

function importarDadosJSON(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const json = JSON.parse(e.target.result);
      if (Array.isArray(json)) {
        prestadores = json;
        salvarDadosLocal();
        renderAll();
        fitAllMarkers();
        mostrarToast(`${json.length} cadastros importados com sucesso!`);
      } else {
        mostrarToast('Formato de arquivo inválido.');
      }
    } catch (err) {
      mostrarToast('Erro ao ler o arquivo JSON.');
    }
  };
  reader.readAsText(file);
}

function openCloudConfigModal() {
  const cfg = obterConfigFirebaseAtiva() || {};
  document.getElementById('fbApiKey').value = cfg.apiKey || '';
  document.getElementById('fbProjectId').value = cfg.projectId || '';
  document.getElementById('fbAuthDomain').value = cfg.authDomain || '';
  document.getElementById('fbAppId').value = cfg.appId || '';
  document.getElementById('modalCloudConfig').classList.remove('hidden');
}

function closeCloudConfigModal() {
  document.getElementById('modalCloudConfig').classList.add('hidden');
}

async function saveCloudConfig(e) {
  e.preventDefault();
  const apiKey = document.getElementById('fbApiKey').value.trim();
  const projectId = document.getElementById('fbProjectId').value.trim();
  const authDomain = document.getElementById('fbAuthDomain').value.trim() || `${projectId}.firebaseapp.com`;
  const appId = document.getElementById('fbAppId').value.trim();

  if (apiKey && projectId) {
    localStorage.setItem(
      FIREBASE_CONFIG_KEY,
      JSON.stringify({ apiKey, projectId, authDomain, appId })
    );
  }

  closeCloudConfigModal();
  const ok = await inicializarFirebase();
  if (ok) {
    mostrarToast('Firebase conectado em tempo real!');
  } else {
    mostrarToast('Configurações salvas!');
  }
}

async function enviarLocaisParaFirebase() {
  if (!db || !isFirebaseConnected) {
    mostrarToast('Conecte o Firebase primeiro preenchendo apiKey e projectId.');
    return;
  }
  try {
    for (const item of prestadores) {
      await db.collection('prestadores').doc(String(item.id)).set(item);
    }
    mostrarToast(`${prestadores.length} cadastros sincronizados no Firebase!`);
  } catch (err) {
    console.error(err);
    mostrarToast('Erro ao sincronizar no Firebase. Verifique as regras do Firestore.');
  }
}

// ==========================================
// RADAR DE COMÉRCIOS E RESTAURANTES LOCAIS (PONTOS CINZAS - ADM)
// ==========================================
function togglePontosCinzasVisiveis(visivel) {
  mostrarPontosCinzas = Boolean(visivel);
  if (!grayMarkersLayer || !map) return;

  if (mostrarPontosCinzas && currentMode === 'admin') {
    if (!map.hasLayer(grayMarkersLayer)) {
      grayMarkersLayer.addTo(map);
    }
    renderGrayMarkers();
  } else {
    if (map.hasLayer(grayMarkersLayer)) {
      map.removeLayer(grayMarkersLayer);
    }
  }
}

function filtrarRadarRapido(termo) {
  const input = document.getElementById('inputBuscaRadar');
  if (!input) return;
  input.value = termo === 'todos' ? '' : termo;
  carregarComerciosLocaisRadar(true);
}

function mapearCategoriaOSM(tags = {}) {
  const t = tags.amenity || tags.shop || tags.office || tags.tourism || tags.craft || '';
  const mapa = {
    restaurant: 'Alimentação e Restaurantes',
    fast_food: 'Alimentação e Restaurantes',
    cafe: 'Alimentação e Restaurantes',
    bar: 'Alimentação e Restaurantes',
    pub: 'Alimentação e Restaurantes',
    ice_cream: 'Alimentação e Restaurantes',
    bakery: 'Alimentação e Padaria',
    supermarket: 'Comércio e Supermercados',
    convenience: 'Comércio e Conveniência',
    pharmacy: 'Saúde e Farmácias',
    clinic: 'Saúde, Médicos e Dentistas',
    doctors: 'Saúde, Médicos e Dentistas',
    dentist: 'Saúde, Médicos e Dentistas',
    hospital: 'Saúde, Médicos e Dentistas',
    veterinary: 'Pet Shop e Veterinária',
    pet: 'Pet Shop e Veterinária',
    car_repair: 'Mecânica e Automotivo',
    car_wash: 'Mecânica e Automotivo',
    car_parts: 'Mecânica e Automotivo',
    fuel: 'Posto de Combustível',
    clothes: 'Comércio e Lojas',
    shoes: 'Comércio e Lojas',
    electronics: 'Tecnologia e Informática',
    mobile_phone: 'Tecnologia e Informática',
    computer: 'Tecnologia e Informática',
    hairdresser: 'Beleza e Barbearia',
    beauty: 'Beleza e Barbearia',
    hardware: 'Construção, Reforma e Elétrica',
    doityourself: 'Construção, Reforma e Elétrica',
    lawyer: 'Advocacia e Jurídico',
    accountant: 'Contabilidade e Consultoria',
    hotel: 'Hotelaria e Turismo'
  };
  return mapa[t] || 'Comércio e Serviços Locais';
}

function formatarEnderecoTagsOSM(tags = {}, fallbackCidade = 'Juazeiro-BA / Petrolina-PE') {
  const rua = tags['addr:street'] || '';
  const num = tags['addr:housenumber'] || '';
  const bairro = tags['addr:suburb'] || tags['addr:neighbourhood'] || '';
  const cidade = tags['addr:city'] || '';
  const partes = [
    rua ? (num ? `${rua}, ${num}` : rua) : '',
    bairro,
    cidade
  ].filter(Boolean);
  return partes.length > 0 ? partes.join(' - ') : fallbackCidade;
}

async function carregarComerciosLocaisRadar(exibirNotificacao = true) {
  const btn = document.getElementById('btnBuscarRadar');
  const termo = (document.getElementById('inputBuscaRadar')?.value || '').trim();
  const originalHtml = btn ? btn.innerHTML : '';

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span>Buscando...</span>`;
  }

  try {
    const b = map.getBounds();
    const south = Math.max(b.getSouth(), map.getCenter().lat - 0.06);
    const north = Math.min(b.getNorth(), map.getCenter().lat + 0.06);
    const west = Math.max(b.getWest(), map.getCenter().lng - 0.06);
    const east = Math.min(b.getEast(), map.getCenter().lng + 0.06);

    let resultados = [];

    if (termo) {
      // Busca direcionada via Nominatim na região visível do mapa
      const viewbox = `${west},${north},${east},${south}`;
      const urlNom = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&extratags=1&limit=40&bounded=1&viewbox=${viewbox}&q=${encodeURIComponent(termo)}`;
      const resp = await fetch(urlNom, { headers: { 'Accept-Language': 'pt-BR' } });
      const data = await resp.json();

      if (Array.isArray(data)) {
        resultados = data.map((item) => {
          const addr = item.address || {};
          const extra = item.extratags || {};
          const nomeLocal = item.name || (item.display_name ? item.display_name.split(',')[0] : termo);
          const rua = addr.road || addr.pedestrian || '';
          const numero = addr.house_number || '';
          const bairro = addr.suburb || addr.neighbourhood || '';
          const cidade = addr.city || addr.town || addr.municipality || '';
          const endCurto = [
            rua ? (numero ? `${rua}, ${numero}` : rua) : '',
            bairro,
            cidade
          ].filter(Boolean).join(' - ') || item.display_name;

          return {
            nome: nomeLocal,
            tipoServico: mapearCategoriaOSM({ [item.class]: item.type }),
            servicos: `Estabelecimento comercial (${termo}).`,
            endereco: endCurto,
            whatsapp: extra.phone || extra['contact:phone'] || extra['contact:whatsapp'] || '',
            lat: parseFloat(item.lat),
            lng: parseFloat(item.lon)
          };
        });
      }
    } else {
      // Busca ampla de comércios, restaurantes, clínicas, oficinas e lojas via Overpass API
      const overpassQuery = `
        [out:json][timeout:15];
        (
          node["amenity"~"restaurant|fast_food|cafe|bar|bakery|pharmacy|clinic|doctors|dentist|car_repair|fuel|veterinary"](${south},${west},${north},${east});
          node["shop"](${south},${west},${north},${east});
          way["amenity"~"restaurant|fast_food|cafe|bar|bakery|pharmacy|clinic|doctors|dentist|car_repair"](${south},${west},${north},${east});
          way["shop"~"supermarket|mall|convenience|clothes|hardware|car_repair|bakery|beauty|hairdresser"](${south},${west},${north},${east});
        );
        out center 180;
      `;

      const resp = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: overpassQuery
      });
      const json = await resp.json();

      if (json && Array.isArray(json.elements)) {
        resultados = json.elements
          .filter((el) => el.tags && el.tags.name)
          .map((el) => {
            const tags = el.tags;
            const lat = el.lat || (el.center && el.center.lat);
            const lng = el.lon || (el.center && el.center.lon);
            const cat = mapearCategoriaOSM(tags);
            const fone = tags['contact:whatsapp'] || tags['contact:phone'] || tags.phone || '';
            const subtipo = tags.cuisine || tags.shop || tags.amenity || 'Comércio local';

            return {
              nome: tags.name,
              tipoServico: cat,
              servicos: `Atendimento comercial e serviços (${subtipo}).`,
              endereco: formatarEnderecoTagsOSM(tags),
              whatsapp: fone,
              lat: parseFloat(lat),
              lng: parseFloat(lng)
            };
          })
          .filter((r) => !isNaN(r.lat) && !isNaN(r.lng));
      }
    }

    comerciosLocaisCinza = resultados;
    renderGrayMarkers();

    if (exibirNotificacao) {
      mostrarToast(`${comerciosLocaisCinza.length} comércios/restaurantes locais carregados em cinza!`);
    }
  } catch (err) {
    console.error('Erro ao buscar comércios locais:', err);
    if (exibirNotificacao) {
      mostrarToast('Não foi possível carregar o radar agora. Tente aproximar o mapa.');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      lucide.createIcons();
    }
  }
}

function jaEstaCadastrado(ponto) {
  return prestadores.some((p) => {
    const mesmoNome = p.nome && ponto.nome && p.nome.trim().toLowerCase() === ponto.nome.trim().toLowerCase();
    const latP = parseFloat(p.lat);
    const lngP = parseFloat(p.lng);
    const mesmaCoord = !isNaN(latP) && !isNaN(lngP) &&
      Math.abs(latP - ponto.lat) < 0.00025 &&
      Math.abs(lngP - ponto.lng) < 0.00025;
    return mesmoNome || mesmaCoord;
  });
}

function renderGrayMarkers() {
  if (!grayMarkersLayer) return;
  grayMarkersLayer.clearLayers();

  const badgeCinza = document.getElementById('badgeCountCinza');
  const naoClassificados = comerciosLocaisCinza.filter((item) => !jaEstaCadastrado(item));

  if (badgeCinza) {
    badgeCinza.textContent = `${naoClassificados.length} locais`;
  }

  if (currentMode !== 'admin' || !mostrarPontosCinzas) return;

  naoClassificados.forEach((item) => {
    const idxOriginal = comerciosLocaisCinza.indexOf(item);
    const foneLimpo = formatarTelefoneExibicao(item.whatsapp || '');

    const popupHtml = `
      <div class="font-sans text-slate-800">
        <div class="bg-slate-700 text-white p-3.5">
          <span class="inline-block text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-900/60 text-slate-200 mb-1">
            PONTO LOCAL • NÃO CLASSIFICADO
          </span>
          <h3 class="font-bold text-base leading-snug">${escapeHtml(item.nome)}</h3>
          <p class="text-xs text-slate-200 font-medium mt-0.5">${escapeHtml(item.tipoServico)}</p>
        </div>

        <div class="p-3.5 space-y-2.5 bg-white">
          <div>
            <p class="text-[11px] font-bold uppercase text-slate-400">Endereço</p>
            <p class="text-xs text-slate-600 mt-0.5">${escapeHtml(item.endereco)}</p>
          </div>

          <div>
            <label class="block text-[11px] font-bold uppercase text-slate-500 mb-1">WhatsApp / Telefone (Opcional)</label>
            <input
              type="text"
              id="zap-cinza-${idxOriginal}"
              value="${escapeHtml(foneLimpo)}"
              placeholder="(87) 99999-9999"
              class="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs"
            />
          </div>

          <div>
            <label class="block text-[11px] font-bold uppercase text-slate-500 mb-1">Instagram (Opcional)</label>
            <input
              type="text"
              id="ig-cinza-${idxOriginal}"
              placeholder="@instagram"
              class="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs"
            />
          </div>

          <div class="pt-1">
            <button
              type="button"
              onclick="classificarPontoCinzaDireto(${idxOriginal})"
              class="w-full py-2.5 px-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow flex items-center justify-center gap-1.5 transition"
            >
              <span>Adicionar ao Guia Agora</span>
            </button>
          </div>

          <button
            type="button"
            onclick="preencherFormularioComPontoCinza(${idxOriginal})"
            class="w-full py-1.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs rounded-xl text-center transition"
          >
            Editar detalhes no formulário antes de salvar
          </button>
        </div>
      </div>
    `;

    const marker = L.marker([item.lat, item.lng], {
      icon: criarIconePino('cinza')
    }).bindPopup(popupHtml);

    grayMarkersLayer.addLayer(marker);
  });
}

async function classificarPontoCinzaDireto(index) {
  if (!isAdminAuthenticated()) {
    mostrarToast('Faça login no Painel ADM primeiro.');
    return;
  }

  const item = comerciosLocaisCinza[index];
  if (!item) return;

  const inputZapPopup = document.getElementById(`zap-cinza-${index}`);
  const inputIgPopup = document.getElementById(`ig-cinza-${index}`);
  const whatsappFinal = inputZapPopup ? inputZapPopup.value.trim() : (item.whatsapp || '');
  const instagramFinal = inputIgPopup ? inputIgPopup.value.trim() : '';

  const novoItem = {
    id: String(Date.now()),
    nome: item.nome,
    tipoServico: item.tipoServico,
    servicos: item.servicos || item.tipoServico,
    endereco: item.endereco,
    semEndereco: false,
    whatsapp: whatsappFinal,
    instagram: instagramFinal,
    lat: item.lat,
    lng: item.lng,
    status: 'aprovado',
    criadoEm: new Date().toISOString()
  };

  prestadores.unshift(novoItem);
  salvarDadosLocal();
  map.closePopup();
  renderAll();

  mostrarToast(`"${item.nome}" adicionado ao Guia!`);

  if (db && isFirebaseConnected) {
    try {
      await db.collection('prestadores').doc(String(novoItem.id)).set(novoItem);
    } catch (err) {
      console.error('Erro ao salvar no Firebase:', err);
    }
  }
}

function preencherFormularioComPontoCinza(index) {
  const item = comerciosLocaisCinza[index];
  if (!item) return;

  const inputZapPopup = document.getElementById(`zap-cinza-${index}`);
  const inputIgPopup = document.getElementById(`ig-cinza-${index}`);
  const whatsappFinal = inputZapPopup ? inputZapPopup.value.trim() : (item.whatsapp || '');
  const instagramFinal = inputIgPopup ? inputIgPopup.value.trim() : '';

  resetAdminForm();
  toggleSemEndereco(false);
  document.getElementById('inputNome').value = item.nome || '';
  document.getElementById('inputTipoServico').value = item.tipoServico || '';
  document.getElementById('inputWhatsapp').value = formatarTelefoneExibicao(whatsappFinal);
  if (document.getElementById('inputInstagram')) {
    document.getElementById('inputInstagram').value = instagramFinal;
  }
  document.getElementById('inputServicos').value = item.servicos || '';
  document.getElementById('inputEndereco').value = item.endereco || '';
  definirCoordenadasFormulario(item.lat, item.lng);

  map.closePopup();
  document.getElementById('adminForm').scrollIntoView({ behavior: 'smooth' });
  mostrarToast('Dados preenchidos no formulário ADM!');
}

// ==========================================
// DASHBOARD & ESTATÍSTICAS DE ACESSOS E CADASTROS (ADM)
// ==========================================
const ANALYTICS_LOCAL_KEY = 'guia_patriota_analytics_v1';
let dadosEstatisticas = {
  totalGeral: 0,
  cliquesWhatsapp: 0,
  porDia: {},
  porMes: {}
};

function obterChaveDiaHoje(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function obterChaveMesAtual(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function carregarAnalyticsLocal() {
  try {
    const salvo = JSON.parse(localStorage.getItem(ANALYTICS_LOCAL_KEY) || '{}');
    if (salvo && typeof salvo === 'object') {
      dadosEstatisticas = {
        totalGeral: Number(salvo.totalGeral || 0),
        cliquesWhatsapp: Number(salvo.cliquesWhatsapp || 0),
        porDia: salvo.porDia || {},
        porMes: salvo.porMes || {}
      };
    }
  } catch (e) {
    console.warn(e);
  }
}

function salvarAnalyticsLocal() {
  localStorage.setItem(ANALYTICS_LOCAL_KEY, JSON.stringify(dadosEstatisticas));
}

function extrairEstatisticasBlindadas(remoto = {}) {
  const blindado = remoto.historicoBlindado || {};
  const porDiaMerged = { ...(remoto.porDia || {}) };
  Object.entries(blindado.porDia || {}).forEach(([k, v]) => {
    porDiaMerged[k] = Math.max(Number(porDiaMerged[k] || 0), Number(v || 0));
  });

  const porMesMerged = { ...(remoto.porMes || {}) };
  Object.entries(blindado.porMes || {}).forEach(([k, v]) => {
    porMesMerged[k] = Math.max(Number(porMesMerged[k] || 0), Number(v || 0));
  });

  let somaDias = 0;
  Object.entries(porDiaMerged).forEach(([diaKey, v]) => {
    const n = Number(v || 0);
    somaDias += n;
    const mKey = String(diaKey).slice(0, 7);
    if (mKey) {
      porMesMerged[mKey] = Math.max(Number(porMesMerged[mKey] || 0), 0);
    }
  });

  const totalGeral = Math.max(
    Number(remoto.totalGeral || 0),
    Number(blindado.totalGeral || 0),
    somaDias
  );
  const cliquesWhatsapp = Math.max(
    Number(remoto.cliquesWhatsapp || 0),
    Number(blindado.cliquesWhatsapp || 0)
  );

  return {
    totalGeral,
    cliquesWhatsapp,
    porDia: porDiaMerged,
    porMes: porMesMerged
  };
}

async function registrarAcessoVisita() {
  carregarAnalyticsLocal();

  const hoje = obterChaveDiaHoje();
  const mes = obterChaveMesAtual();
  const jaContouSessao = sessionStorage.getItem('guia_sessao_contabilizada') === 'true';

  if (db) {
    try {
      const docRef = db.collection('estatisticas').doc('acessos');

      // Usa incremento atômico no servidor (FieldValue.increment) para NUNCA sobrescrever nem zerar contadores
      if (!jaContouSessao) {
        const inc = firebase.firestore.FieldValue.increment(1);
        sessionStorage.setItem('guia_sessao_contabilizada', 'true');
        await docRef.set(
          {
            totalGeral: inc,
            porDia: { [hoje]: inc },
            porMes: { [mes]: inc },
            historicoBlindado: {
              totalGeral: inc,
              porDia: { [hoje]: inc },
              porMes: { [mes]: inc }
            }
          },
          { merge: true }
        );
      }

      const snap = await docRef.get();
      if (snap.exists) {
        dadosEstatisticas = extrairEstatisticasBlindadas(snap.data() || {});
        salvarAnalyticsLocal();
      }
      return;
    } catch (err) {
      console.warn('Analytics local fallback:', err);
    }
  }

  if (!jaContouSessao) {
    dadosEstatisticas.totalGeral += 1;
    dadosEstatisticas.porDia[hoje] = Number(dadosEstatisticas.porDia[hoje] || 0) + 1;
    dadosEstatisticas.porMes[mes] = Number(dadosEstatisticas.porMes[mes] || 0) + 1;
    sessionStorage.setItem('guia_sessao_contabilizada', 'true');
    salvarAnalyticsLocal();
  }
}

async function registrarCliqueWhatsapp() {
  carregarAnalyticsLocal();
  dadosEstatisticas.cliquesWhatsapp = Number(dadosEstatisticas.cliquesWhatsapp || 0) + 1;
  salvarAnalyticsLocal();

  if (db) {
    try {
      const inc = firebase.firestore.FieldValue.increment(1);
      await db.collection('estatisticas').doc('acessos').set(
        {
          cliquesWhatsapp: inc,
          historicoBlindado: {
            cliquesWhatsapp: inc
          }
        },
        { merge: true }
      );
    } catch (e) {
      console.warn(e);
    }
  }
}

let unsubscribeEstatisticas = null;

async function openAdminDashboard() {
  if (!isMasterAdmin()) {
    mostrarToast('Acesso ao Dashboard restrito ao ADM Master.');
    return;
  }

  document.getElementById('modalAdminDashboard').classList.remove('hidden');

  if (db) {
    try {
      if (unsubscribeEstatisticas) {
        unsubscribeEstatisticas();
      }
      unsubscribeEstatisticas = db.collection('estatisticas').doc('acessos').onSnapshot((snap) => {
        if (snap.exists) {
          dadosEstatisticas = extrairEstatisticasBlindadas(snap.data() || {});
          salvarAnalyticsLocal();
          renderDashboardData();
          lucide.createIcons();
        }
      });
    } catch (e) {
      console.warn(e);
    }
  }

  renderDashboardData();
  lucide.createIcons();
}

function closeAdminDashboard() {
  if (unsubscribeEstatisticas) {
    unsubscribeEstatisticas();
    unsubscribeEstatisticas = null;
  }
  document.getElementById('modalAdminDashboard').classList.add('hidden');
}

function formatarNomeMes(chaveMes) {
  const [ano, mes] = String(chaveMes).split('-');
  const nomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const idx = parseInt(mes, 10) - 1;
  return `${nomes[idx] || mes}/${ano}`;
}

function renderDashboardData() {
  const hoje = obterChaveDiaHoje();
  const mesAtual = obterChaveMesAtual();

  // Garante consistência entre soma diária, mensal e total geral
  let somaTodosDias = 0;
  const somaPorMesCalculada = {};
  Object.entries(dadosEstatisticas.porDia || {}).forEach(([diaKey, valor]) => {
    const num = Number(valor || 0);
    somaTodosDias += num;
    const mKey = String(diaKey).slice(0, 7);
    if (mKey) {
      somaPorMesCalculada[mKey] = (somaPorMesCalculada[mKey] || 0) + num;
    }
  });

  // 1. Calcular acessos últimos 7 dias
  let soma7Dias = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = obterChaveDiaHoje(d);
    soma7Dias += Number(dadosEstatisticas.porDia[k] || 0);
  }

  const acessosHoje = Number(dadosEstatisticas.porDia[hoje] || 0);
  const acessosMes = Math.max(
    Number(dadosEstatisticas.porMes[mesAtual] || 0),
    Number(somaPorMesCalculada[mesAtual] || 0)
  );
  const acessosTotal = Math.max(Number(dadosEstatisticas.totalGeral || 0), somaTodosDias);
  const cliquesZap = Number(dadosEstatisticas.cliquesWhatsapp || 0);

  document.getElementById('dashAcessosHoje').textContent = acessosHoje;
  document.getElementById('dashLabelHoje').textContent = `Dia ${hoje.split('-').reverse().slice(0, 2).join('/')}`;
  document.getElementById('dashAcessos7Dias').textContent = soma7Dias;
  document.getElementById('dashAcessosMes').textContent = acessosMes;
  document.getElementById('dashLabelMes').textContent = formatarNomeMes(mesAtual);
  document.getElementById('dashAcessosTotal').textContent = acessosTotal;
  document.getElementById('dashCliquesZap').textContent = cliquesZap;

  // 2. Estatísticas de Cadastros
  const aprovados = obterPrestadoresAprovados();
  const pendentes = prestadores.filter((p) => p.status === 'pendente');
  const totalCad = aprovados.length;

  const comMapa = aprovados.filter((p) => !p.semEndereco && !isNaN(parseFloat(p.lat)) && !isNaN(parseFloat(p.lng))).length;
  const semMapa = totalCad - comMapa;

  document.getElementById('dashCadTotal').textContent = totalCad;
  if (document.getElementById('dashCadComMapa')) {
    document.getElementById('dashCadComMapa').textContent = comMapa;
  }
  if (document.getElementById('dashCadSemMapa')) {
    document.getElementById('dashCadSemMapa').textContent = semMapa;
  }
  document.getElementById('dashCadPendentes').textContent = pendentes.length;

  // 3. Gráfico de Barras dos Últimos 14 Dias
  const dias14 = [];
  let maxDia = 1;
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const chave = obterChaveDiaHoje(d);
    const val = Number(dadosEstatisticas.porDia[chave] || 0);
    if (val > maxDia) maxDia = val;
    const labelCurta = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    dias14.push({ chave, labelCurta, val });
  }

  const chartEl = document.getElementById('dashChartDiario');
  chartEl.innerHTML = dias14
    .map((item) => {
      const alturaPct = Math.max(8, Math.round((item.val / maxDia) * 100));
      const isHoje = item.chave === hoje;
      const barColor = isHoje ? 'bg-indigo-600' : 'bg-indigo-400/80 hover:bg-indigo-500';
      return `
        <div class="flex-1 min-w-[34px] flex flex-col items-center justify-end h-full group">
          <span class="text-[10px] font-bold text-slate-700 mb-1">${item.val}</span>
          <div class="w-full max-w-[28px] rounded-t-lg transition-all ${barColor}" style="height: ${alturaPct}%"></div>
          <span class="text-[10px] font-semibold ${isHoje ? 'text-indigo-700 font-extrabold' : 'text-slate-400'} mt-1.5">${item.labelCurta}</span>
        </div>
      `;
    })
    .join('');

  // 4. Histórico de Acessos por Mês
  const mesesChaves = [...new Set([...Object.keys(dadosEstatisticas.porMes || {}), ...Object.keys(somaPorMesCalculada)])].sort().reverse();
  if (!mesesChaves.includes(mesAtual)) mesesChaves.unshift(mesAtual);
  const listaMensalEl = document.getElementById('dashListaMensal');
  listaMensalEl.innerHTML = mesesChaves
    .map((mKey) => {
      const qtd = Math.max(Number(dadosEstatisticas.porMes[mKey] || 0), Number(somaPorMesCalculada[mKey] || 0));
      return `
        <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs">
          <span class="font-bold text-slate-700">${formatarNomeMes(mKey)}</span>
          <span class="font-extrabold text-indigo-600 bg-indigo-50 px-2.5 py-0.5 rounded-full border border-indigo-200">${qtd} acessos</span>
        </div>
      `;
    })
    .join('');

  // 5. Cadastros por Categoria / Tipo de Serviço
  const mapaCategorias = {};
  aprovados.forEach((p) => {
    const cat = p.tipoServico || 'Outros';
    if (!mapaCategorias[cat]) {
      mapaCategorias[cat] = { total: 0 };
    }
    mapaCategorias[cat].total += 1;
  });

  const listaCatOrdenada = Object.entries(mapaCategorias).sort((a, b) => b[1].total - a[1].total);
  const catEl = document.getElementById('dashCategoriasList');
  if (listaCatOrdenada.length === 0) {
    catEl.innerHTML = `<p class="text-xs text-slate-400 py-4 text-center">Nenhum cadastro aprovado ainda.</p>`;
  } else {
    catEl.innerHTML = listaCatOrdenada
      .map(([nomeCat, info]) => {
        return `
          <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2 text-xs">
            <span class="font-bold text-slate-800 truncate">${escapeHtml(nomeCat)}</span>
            <span class="px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-800 font-extrabold text-[11px] shrink-0">${info.total} ${info.total === 1 ? 'cadastro' : 'cadastros'}</span>
          </div>
        `;
      })
      .join('');
  }

  // 6. Novos Cadastros por Dia / Mês
  const cadPorDia = {};
  prestadores.forEach((p) => {
    const dataIso = String(p.criadoEm || '').slice(0, 10) || hoje;
    cadPorDia[dataIso] = (cadPorDia[dataIso] || 0) + 1;
  });

  const diasCadOrdenados = Object.entries(cadPorDia).sort((a, b) => b[0].localeCompare(a[0]));
  const cadPeriodoEl = document.getElementById('dashCadastrosPeriodo');
  if (diasCadOrdenados.length === 0) {
    cadPeriodoEl.innerHTML = `<p class="text-xs text-slate-400 py-4 text-center">Sem registros de datas de cadastro.</p>`;
  } else {
    cadPeriodoEl.innerHTML = diasCadOrdenados
      .map(([diaIso, qtd]) => {
        const formatado = diaIso.split('-').reverse().join('/');
        return `
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs">
            <span class="font-semibold text-slate-700">Data: <strong>${formatado}</strong></span>
            <span class="font-extrabold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">+${qtd} ${qtd === 1 ? 'cadastro' : 'cadastros'}</span>
          </div>
        `;
      })
      .join('');
  }
}

// ==========================================
// INSTALADOR DO APP MOBILE (PWA - ANDROID & IPHONE)
// ==========================================
let deferredInstallPrompt = null;

function isRunningStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent || '');
}

function initPwaInstaller() {
  // Registra Service Worker para habilitar instalação nativa no Android / Chrome
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service Worker aviso:', err);
    });
  }

  const btnInstalar = document.getElementById('btnInstalarApp');
  if (isRunningStandalone() && btnInstalar) {
    btnInstalar.classList.add('hidden');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btnNativo = document.getElementById('btnDispararPromptNativo');
    if (btnNativo) {
      btnNativo.classList.remove('hidden');
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    closeInstallAppModal();
    if (btnInstalar) btnInstalar.classList.add('hidden');
    mostrarToast('Aplicativo instalado com sucesso no seu aparelho!');
  });
}

async function abrirInstaladorMobile() {
  // Se estiver no Android/Chrome e o prompt nativo já estiver disponível, dispara direto ou abre o modal
  if (deferredInstallPrompt && !isIosDevice()) {
    try {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredInstallPrompt = null;
        return;
      }
    } catch (err) {
      console.warn(err);
    }
  }

  // Abre modal selecionando automaticamente a aba do sistema do usuário (iPhone ou Android)
  selecionarAbaInstalador(isIosDevice() ? 'ios' : 'android');
  document.getElementById('modalInstallApp').classList.remove('hidden');
  lucide.createIcons();
}

function selecionarAbaInstalador(aba) {
  const tabAndroid = document.getElementById('tabBtnAndroid');
  const tabIos = document.getElementById('tabBtnIos');
  const boxAndroid = document.getElementById('boxInstallAndroid');
  const boxIos = document.getElementById('boxInstallIos');

  if (aba === 'ios') {
    tabIos.className = 'py-2 px-3 rounded-xl text-xs font-bold bg-white text-slate-900 shadow flex items-center justify-center gap-1.5 transition';
    tabAndroid.className = 'py-2 px-3 rounded-xl text-xs font-bold text-slate-600 flex items-center justify-center gap-1.5 transition';
    boxIos.classList.remove('hidden');
    boxAndroid.classList.add('hidden');
  } else {
    tabAndroid.className = 'py-2 px-3 rounded-xl text-xs font-bold bg-white text-slate-900 shadow flex items-center justify-center gap-1.5 transition';
    tabIos.className = 'py-2 px-3 rounded-xl text-xs font-bold text-slate-600 flex items-center justify-center gap-1.5 transition';
    boxAndroid.classList.remove('hidden');
    boxIos.classList.add('hidden');
  }
}

async function instalarNativoAndroid() {
  if (!deferredInstallPrompt) {
    mostrarToast('Siga os 3 passos abaixo no menu do seu navegador.');
    return;
  }
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    deferredInstallPrompt = null;
    closeInstallAppModal();
  }
}

function closeInstallAppModal() {
  document.getElementById('modalInstallApp').classList.add('hidden');
}

// ==========================================
// SISTEMA DE PROPAGANDA / DESTAQUE NO TOPO PISCANDO (EXCLUSIVO MASTER)
// ==========================================
function iniciarMonitoramentoPropagandas() {
  try {
    const salvas = JSON.parse(localStorage.getItem(PROPAGANDAS_LOCAL_KEY) || '[]');
    if (Array.isArray(salvas) && propagandas.length === 0) {
      propagandas = salvas;
    }
  } catch (e) {
    console.warn(e);
  }

  // Verifica expiração e alterna propagandas a cada 7 segundos
  setInterval(() => {
    indicePropagandaRotacao++;
    renderPropagandaTopo();
  }, 7000);
}

function obterPropagandasAtivasAgora() {
  const agora = Date.now();
  return propagandas.filter((p) => {
    if (p.ativa === false) return false;
    const exp = new Date(p.expiraEm).getTime();
    return !isNaN(exp) && exp > agora;
  });
}

function formatarTempoRestante(expiraEmIso) {
  const diff = new Date(expiraEmIso).getTime() - Date.now();
  if (isNaN(diff) || diff <= 0) return 'Expirada';

  const minTotal = Math.floor(diff / 60000);
  const dias = Math.floor(minTotal / 1440);
  const horas = Math.floor((minTotal % 1440) / 60);
  const mins = minTotal % 60;

  if (dias > 0) return `${dias}d ${horas}h restantes`;
  if (horas > 0) return `${horas}h ${mins}min restantes`;
  return `${Math.max(1, mins)} min restantes`;
}

function renderPropagandaTopo() {
  const bar = document.getElementById('topPropagandaBar');
  if (!bar) return;

  const ativas = obterPropagandasAtivasAgora();
  if (ativas.length === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  const promo = ativas[indicePropagandaRotacao % ativas.length];
  const temZap = Boolean(String(promo.whatsapp || '').replace(/\D/g, ''));
  const linkZap = formatarLinkWhatsapp(promo.whatsapp, promo.nome);
  const linkIg = formatarLinkInstagram(promo.instagram);

  bar.classList.remove('hidden');
  bar.innerHTML = `
    <div class="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        <span class="promo-blink-badge px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase text-white shrink-0 shadow">
          🔥 DESTAQUE
        </span>
        <div class="min-w-0 flex-1 truncate">
          <span class="font-extrabold text-xs sm:text-sm text-slate-950">${escapeHtml(promo.nome)}</span>
          <span class="text-xs font-bold text-amber-950 mx-1.5">•</span>
          <span class="text-xs font-semibold text-slate-900">${escapeHtml(promo.texto)}</span>
        </div>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        ${
          temZap
            ? `
        <a
          href="${linkZap}"
          target="_blank"
          rel="noopener noreferrer"
          onclick="registrarCliqueWhatsapp()"
          class="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-lg shadow flex items-center gap-1 transition"
        >
          <span>WhatsApp</span>
        </a>
        `
            : ''
        }
        ${
          linkIg
            ? `
        <a
          href="${linkIg}"
          target="_blank"
          rel="noopener noreferrer"
          class="px-3 py-1 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white font-extrabold text-xs rounded-lg shadow flex items-center gap-1 transition"
        >
          <span>Instagram</span>
        </a>
        `
            : ''
        }
      </div>
    </div>
  `;
}

function openAdminPropagandaModal() {
  if (!isMasterAdmin()) {
    mostrarToast('Acesso restrito ao ADM Master.');
    return;
  }

  // Popula select de prestadores existentes para facilitar preenchimento
  const select = document.getElementById('selectPrestadorParaPromo');
  if (select) {
    const aprovados = obterPrestadoresAprovados();
    select.innerHTML = `<option value="">-- Selecionar um prestador já cadastrado (ou digite abaixo) --</option>`;
    aprovados.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.nome} (${p.tipoServico})`;
      select.appendChild(opt);
    });
  }

  renderListaPropagandasMaster();
  document.getElementById('modalAdminPropaganda').classList.remove('hidden');
  lucide.createIcons();
}

function closeAdminPropagandaModal() {
  const modal = document.getElementById('modalAdminPropaganda');
  if (modal) modal.classList.add('hidden');
}

function preencherPromoComPrestador(id) {
  if (!id) return;
  const item = prestadores.find((p) => String(p.id) === String(id));
  if (!item) return;

  document.getElementById('promoNome').value = item.nome || '';
  document.getElementById('promoCategoria').value = item.tipoServico || '';
  document.getElementById('promoTexto').value = item.servicos || '';
  document.getElementById('promoWhatsapp').value = formatarTelefoneExibicao(item.whatsapp || '');
  document.getElementById('promoInstagram').value = item.instagram || '';
}

async function salvarPropagandaMaster(e) {
  e.preventDefault();
  if (!isMasterAdmin()) {
    mostrarToast('Apenas o ADM Master pode criar propagandas.');
    return;
  }

  const nome = document.getElementById('promoNome').value.trim();
  const categoria = document.getElementById('promoCategoria').value.trim();
  const texto = document.getElementById('promoTexto').value.trim();
  const whatsapp = document.getElementById('promoWhatsapp').value.trim();
  const instagram = document.getElementById('promoInstagram').value.trim();
  const valorTempo = Math.max(1, parseInt(document.getElementById('promoTempoValor').value, 10) || 1);
  const unidade = document.getElementById('promoTempoUnidade').value;

  let msDuracao = valorTempo * 86400000; // padrão dias
  if (unidade === 'minutos') msDuracao = valorTempo * 60000;
  else if (unidade === 'horas') msDuracao = valorTempo * 3600000;

  const agora = Date.now();
  const expiraEm = new Date(agora + msDuracao).toISOString();

  const novaPromo = {
    id: String(agora),
    nome,
    categoria,
    texto,
    whatsapp,
    instagram,
    duracaoTexto: `${valorTempo} ${unidade}`,
    criadoEm: new Date(agora).toISOString(),
    expiraEm,
    ativa: true
  };

  propagandas.unshift(novaPromo);
  localStorage.setItem(PROPAGANDAS_LOCAL_KEY, JSON.stringify(propagandas));
  document.getElementById('formPropagandaMaster').reset();
  document.getElementById('promoTempoValor').value = '7';
  document.getElementById('promoTempoUnidade').value = 'dias';

  renderAll();
  renderListaPropagandasMaster();
  mostrarToast(`Propaganda de "${nome}" ativada no topo por ${valorTempo} ${unidade}!`);

  if (db && isFirebaseConnected) {
    try {
      await db.collection('propagandas').doc(novaPromo.id).set(novaPromo);
    } catch (err) {
      console.error('Erro ao salvar propaganda no Firebase:', err);
    }
  }
}

async function excluirPropagandaMaster(id) {
  if (!isMasterAdmin()) return;
  if (!confirm('Deseja remover esta propaganda?')) return;

  propagandas = propagandas.filter((p) => String(p.id) !== String(id));
  localStorage.setItem(PROPAGANDAS_LOCAL_KEY, JSON.stringify(propagandas));
  renderAll();
  renderListaPropagandasMaster();
  mostrarToast('Propaganda removida.');

  if (db && isFirebaseConnected) {
    try {
      await db.collection('propagandas').doc(String(id)).delete();
    } catch (err) {
      console.error('Erro ao excluir propaganda:', err);
    }
  }
}

function renderListaPropagandasMaster() {
  const container = document.getElementById('listaPropagandasMaster');
  if (!container) return;

  if (propagandas.length === 0) {
    container.innerHTML = `<p class="text-xs text-slate-400 text-center py-4 bg-white rounded-2xl border border-slate-200">Nenhuma propaganda cadastrada no momento.</p>`;
    return;
  }

  container.innerHTML = propagandas
    .map((p) => {
      const tempoStr = formatarTempoRestante(p.expiraEm);
      const isAtiva = tempoStr !== 'Expirada' && p.ativa !== false;
      const badgeStatus = isAtiva
        ? `<span class="px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300">Ativa • ${tempoStr}</span>`
        : `<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-200 text-slate-600">Expirada</span>`;

      return `
        <div class="p-3.5 bg-white rounded-2xl border ${isAtiva ? 'border-amber-400' : 'border-slate-200'} flex items-center justify-between gap-3 shadow-sm">
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <h5 class="font-extrabold text-sm text-slate-900">${escapeHtml(p.nome)}</h5>
              ${badgeStatus}
            </div>
            <p class="text-xs text-slate-600 truncate">${escapeHtml(p.categoria)} — ${escapeHtml(p.texto)}</p>
          </div>
          <button
            type="button"
            onclick="excluirPropagandaMaster('${p.id}')"
            class="p-2 rounded-xl bg-red-50 hover:bg-red-100 text-red-600 transition shrink-0"
            title="Excluir Propaganda"
          >
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>
      `;
    })
    .join('');
}

// ==========================================
// RELATÓRIO DE EMPRESAS POR CATEGORIA (EXCLUSIVO ADM MASTER)
// ==========================================
function openAdminRelatorioModal() {
  if (!isMasterAdmin()) {
    mostrarToast('Acesso restrito ao ADM Master.');
    return;
  }

  // Popula o select de categorias disponíveis
  const selectCat = document.getElementById('filtroRelatorioCategoria');
  if (selectCat) {
    const atual = selectCat.value || 'todas';
    const cats = [...new Set(prestadores.map((p) => (p.tipoServico || 'Sem Categoria').trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'pt-BR')
    );
    selectCat.innerHTML = `<option value="todas">Todas as Categorias (${cats.length})</option>`;
    cats.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      selectCat.appendChild(opt);
    });
    if (cats.includes(atual)) selectCat.value = atual;
  }

  renderRelatorioMaster();
  document.getElementById('modalAdminRelatorio').classList.remove('hidden');
  lucide.createIcons();
}

function closeAdminRelatorioModal() {
  const modal = document.getElementById('modalAdminRelatorio');
  if (modal) modal.classList.add('hidden');
}

function obterDadosAgrupadosRelatorio() {
  const catFiltro = document.getElementById('filtroRelatorioCategoria')?.value || 'todas';
  const statusFiltro = document.getElementById('filtroRelatorioStatus')?.value || 'aprovados';
  const buscaFiltro = (document.getElementById('filtroRelatorioBusca')?.value || '').trim().toLowerCase();

  const filtrados = prestadores.filter((p) => {
    const statusItem = p.status === 'pendente' ? 'pendente' : 'aprovado';
    if (statusFiltro === 'aprovados' && statusItem !== 'aprovado') return false;
    if (statusFiltro === 'pendentes' && statusItem !== 'pendente') return false;

    const catItem = (p.tipoServico || 'Sem Categoria').trim();
    if (catFiltro !== 'todas' && catItem !== catFiltro) return false;

    if (buscaFiltro) {
      const texto = `${p.nome || ''} ${catItem} ${p.servicos || ''} ${p.whatsapp || ''} ${p.instagram || ''} ${p.endereco || ''}`.toLowerCase();
      if (!texto.includes(buscaFiltro)) return false;
    }

    return true;
  });

  // Agrupa por categoria em ordem alfabética, e empresas em ordem alfabética dentro de cada categoria
  const grupos = {};
  filtrados.forEach((p) => {
    const cat = (p.tipoServico || 'Sem Categoria').trim();
    if (!grupos[cat]) grupos[cat] = [];
    grupos[cat].push(p);
  });

  const categoriasOrdenadas = Object.keys(grupos).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  categoriasOrdenadas.forEach((cat) => {
    grupos[cat].sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
  });

  return {
    filtrados,
    grupos,
    categoriasOrdenadas
  };
}

function renderRelatorioMaster() {
  const { filtrados, grupos, categoriasOrdenadas } = obterDadosAgrupadosRelatorio();

  const comZap = filtrados.filter((p) => String(p.whatsapp || '').replace(/\D/g, '').length >= 8).length;
  const comInsta = filtrados.filter((p) => String(p.instagram || '').trim().length > 0).length;

  const elTotalEmp = document.getElementById('relTotalEmpresas');
  const elTotalCat = document.getElementById('relTotalCategorias');
  const elTotalZap = document.getElementById('relTotalComZap');
  const elTotalInsta = document.getElementById('relTotalComInsta');

  if (elTotalEmp) elTotalEmp.textContent = filtrados.length;
  if (elTotalCat) elTotalCat.textContent = categoriasOrdenadas.length;
  if (elTotalZap) elTotalZap.textContent = comZap;
  if (elTotalInsta) elTotalInsta.textContent = comInsta;

  const container = document.getElementById('relatorioConteudoCategorias');
  if (!container) return;

  if (categoriasOrdenadas.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center bg-white rounded-2xl border border-slate-200">
        <p class="text-sm font-bold text-slate-600">Nenhuma empresa encontrada para os filtros selecionados.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = categoriasOrdenadas
    .map((cat) => {
      const lista = grupos[cat];
      const linhasHtml = lista
        .map((p, idx) => {
          const telExibicao = formatarTelefoneExibicao(p.whatsapp) || 'Não informado';
          const instaRaw = String(p.instagram || '').trim();
          const instaExibicao = instaRaw ? (instaRaw.startsWith('@') || instaRaw.startsWith('http') ? instaRaw : `@${instaRaw}`) : '—';
          const enderecoExibicao = p.semEndereco || !p.endereco ? 'Sem endereço fixo (Atendimento móvel / online)' : p.endereco;
          const dataCad = p.criadoEm ? String(p.criadoEm).slice(0, 10).split('-').reverse().join('/') : '—';
          const statusBadge =
            p.status === 'pendente'
              ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">Pendente</span>`
              : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">Aprovado</span>`;

          return `
            <tr class="border-t border-slate-100 hover:bg-slate-50/80 transition">
              <td class="py-2.5 px-3 text-xs font-bold text-slate-400">${idx + 1}</td>
              <td class="py-2.5 px-3">
                <div class="font-extrabold text-xs sm:text-sm text-slate-900">${escapeHtml(p.nome)}</div>
                <div class="mt-0.5">${statusBadge}</div>
              </td>
              <td class="py-2.5 px-3 text-xs text-slate-700 max-w-xs">${escapeHtml(p.servicos || '—')}</td>
              <td class="py-2.5 px-3 text-xs font-bold text-emerald-700 whitespace-nowrap">${escapeHtml(telExibicao)}</td>
              <td class="py-2.5 px-3 text-xs font-semibold text-pink-600">${escapeHtml(instaExibicao)}</td>
              <td class="py-2.5 px-3 text-xs text-slate-600 max-w-xs">${escapeHtml(enderecoExibicao)}</td>
              <td class="py-2.5 px-3 text-[11px] text-slate-400 whitespace-nowrap">${escapeHtml(dataCad)}</td>
            </tr>
          `;
        })
        .join('');

      return `
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div class="px-4 py-3 bg-slate-900 text-white flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
              <h3 class="font-extrabold text-sm uppercase tracking-wide">${escapeHtml(cat)}</h3>
            </div>
            <span class="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-emerald-500 text-slate-950">
              ${lista.length} ${lista.length === 1 ? 'empresa' : 'empresas'}
            </span>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="bg-slate-100 text-[11px] font-extrabold uppercase text-slate-600">
                  <th class="py-2 px-3 w-10">#</th>
                  <th class="py-2 px-3">Empresa / Prestador</th>
                  <th class="py-2 px-3">Serviços / Especialidades</th>
                  <th class="py-2 px-3">WhatsApp / Número</th>
                  <th class="py-2 px-3">Instagram</th>
                  <th class="py-2 px-3">Endereço / Atendimento</th>
                  <th class="py-2 px-3">Data</th>
                </tr>
              </thead>
              <tbody>
                ${linhasHtml}
              </tbody>
            </table>
          </div>
        </div>
      `;
    })
    .join('');
}

function exportarRelatorioCSV() {
  if (!isMasterAdmin()) return;

  const { filtrados, grupos, categoriasOrdenadas } = obterDadosAgrupadosRelatorio();
  if (filtrados.length === 0) {
    mostrarToast('Nenhum dado para exportar.');
    return;
  }

  const limparCampoCSV = (val) => {
    const str = String(val ?? '').replace(/\r?\n|\r/g, ' ').replace(/"/g, '""').trim();
    return `"${str}"`;
  };

  const cabecalho = [
    'Categoria',
    'Nome da Empresa / Prestador',
    'Servicos Oferecidos',
    'WhatsApp / Telefone',
    'Instagram',
    'Endereco',
    'Modalidade',
    'Status',
    'Data de Cadastro'
  ].map(limparCampoCSV).join(';');

  const linhas = [cabecalho];

  categoriasOrdenadas.forEach((cat) => {
    grupos[cat].forEach((p) => {
      const tel = formatarTelefoneExibicao(p.whatsapp) || p.whatsapp || '';
      const insta = String(p.instagram || '').trim();
      const endereco = p.semEndereco || !p.endereco ? 'Sem endereco fixo (Atendimento movel)' : p.endereco;
      const modalidade = p.semEndereco ? 'Sem Endereco Fixo' : 'Com Endereco no Mapa';
      const status = p.status === 'pendente' ? 'Pendente' : 'Aprovado';
      const dataCad = p.criadoEm ? String(p.criadoEm).slice(0, 10).split('-').reverse().join('/') : '';

      linhas.push(
        [
          cat,
          p.nome || '',
          p.servicos || '',
          tel,
          insta,
          endereco,
          modalidade,
          status,
          dataCad
        ].map(limparCampoCSV).join(';')
      );
    });
  });

  // Adiciona BOM UTF-8 (\uFEFF) para abrir perfeitamente acentuado no Microsoft Excel
  const conteudoCSV = '\uFEFF' + linhas.join('\r\n');
  const blob = new Blob([conteudoCSV], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const hoje = obterChaveDiaHoje().split('-').reverse().join('-');
  link.href = url;
  link.download = `relatorio_empresas_por_categoria_${hoje}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  mostrarToast('Planilha Excel/CSV baixada com sucesso!');
}

function copiarRelatorioTexto() {
  if (!isMasterAdmin()) return;

  const { filtrados, grupos, categoriasOrdenadas } = obterDadosAgrupadosRelatorio();
  if (filtrados.length === 0) {
    mostrarToast('Nenhum dado para copiar.');
    return;
  }

  const hoje = obterChaveDiaHoje().split('-').reverse().join('/');
  const blocos = [
    `📊 *RELATÓRIO GERAL DE EMPRESAS E PRESTADORES POR CATEGORIA*`,
    `📅 Gerado em: ${hoje} | Total: ${filtrados.length} empresas em ${categoriasOrdenadas.length} categorias`,
    `================================================`
  ];

  categoriasOrdenadas.forEach((cat) => {
    const lista = grupos[cat];
    blocos.push(`\n📂 *${cat.toUpperCase()} (${lista.length})*`);
    blocos.push(`------------------------------------------------`);
    lista.forEach((p, idx) => {
      const tel = formatarTelefoneExibicao(p.whatsapp) || 'Não informado';
      const insta = String(p.instagram || '').trim();
      const end = p.semEndereco || !p.endereco ? 'Atendimento móvel / Sem endereço fixo' : p.endereco;
      blocos.push(`${idx + 1}. *${p.nome}*`);
      if (p.servicos) blocos.push(`   🛠️ Serviços: ${p.servicos}`);
      blocos.push(`   📱 WhatsApp: ${tel}`);
      if (insta) blocos.push(`   📸 Instagram: ${insta}`);
      blocos.push(`   📍 Endereço: ${end}`);
    });
  });

  const textoFinal = blocos.join('\n');
  navigator.clipboard
    .writeText(textoFinal)
    .then(() => mostrarToast('Relatório completo copiado para a área de transferência!'))
    .catch(() => mostrarToast('Não foi possível copiar automaticamente.'));
}

function imprimirRelatorioPDF() {
  if (!isMasterAdmin()) return;

  const { filtrados, grupos, categoriasOrdenadas } = obterDadosAgrupadosRelatorio();
  if (filtrados.length === 0) {
    mostrarToast('Nenhum dado para imprimir.');
    return;
  }

  const hoje = obterChaveDiaHoje().split('-').reverse().join('/');
  const secoesHtml = categoriasOrdenadas
    .map((cat) => {
      const lista = grupos[cat];
      const linhas = lista
        .map((p, idx) => {
          const tel = formatarTelefoneExibicao(p.whatsapp) || 'Não informado';
          const insta = String(p.instagram || '').trim() || '—';
          const end = p.semEndereco || !p.endereco ? 'Sem endereço fixo (Atendimento móvel)' : p.endereco;
          return `
            <tr>
              <td>${idx + 1}</td>
              <td><strong>${escapeHtml(p.nome)}</strong></td>
              <td>${escapeHtml(p.servicos || '—')}</td>
              <td>${escapeHtml(tel)}</td>
              <td>${escapeHtml(insta)}</td>
              <td>${escapeHtml(end)}</td>
            </tr>
          `;
        })
        .join('');

      return `
        <div class="cat-block">
          <div class="cat-header">
            <span>${escapeHtml(cat)}</span>
            <span>${lista.length} ${lista.length === 1 ? 'empresa' : 'empresas'}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th style="width: 32px;">#</th>
                <th style="width: 22%;">Empresa / Prestador</th>
                <th style="width: 26%;">Serviços Oferecidos</th>
                <th style="width: 15%;">WhatsApp / Número</th>
                <th style="width: 14%;">Instagram</th>
                <th>Endereço / Atendimento</th>
              </tr>
            </thead>
            <tbody>
              ${linhas}
            </tbody>
          </table>
        </div>
      `;
    })
    .join('');

  const win = window.open('', '_blank');
  if (!win) {
    mostrarToast('Permita pop-ups no navegador para gerar o PDF / Impressão.');
    return;
  }

  win.document.write(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <title>Relatório de Empresas por Categoria - ${hoje}</title>
      <style>
        body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; margin: 24px; font-size: 12px; }
        .top-header { border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-end; }
        .top-header h1 { margin: 0 0 4px 0; font-size: 20px; }
        .top-header p { margin: 0; color: #475569; font-size: 12px; }
        .cat-block { margin-bottom: 22px; page-break-inside: avoid; }
        .cat-header { background: #0f172a; color: #fff; padding: 8px 12px; font-weight: bold; font-size: 13px; text-transform: uppercase; display: flex; justify-content: space-between; border-radius: 6px 6px 0 0; }
        table { width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; }
        th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; vertical-align: top; font-size: 11px; }
        th { background: #f1f5f9; font-weight: bold; text-transform: uppercase; font-size: 10px; color: #334155; }
        tr:nth-child(even) td { background: #f8fafc; }
        @media print {
          body { margin: 10mm; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
      <div class="top-header">
        <div>
          <h1>Relatório Geral de Empresas e Prestadores por Categoria</h1>
          <p>Guia Comercial &amp; Serviços — Juazeiro-BA e Petrolina-PE</p>
        </div>
        <div style="text-align: right;">
          <p><strong>Data:</strong> ${hoje}</p>
          <p><strong>Total:</strong> ${filtrados.length} empresas em ${categoriasOrdenadas.length} categorias</p>
        </div>
      </div>
      ${secoesHtml}
      <script>
        window.onload = function() { window.print(); };
      <\/script>
    </body>
    </html>
  `);
  win.document.close();
}

// ==========================================
// UTILITÁRIOS
// ==========================================
function mostrarToast(msg) {
  const toast = document.getElementById('toastNotification');
  document.getElementById('toastText').textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3800);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
