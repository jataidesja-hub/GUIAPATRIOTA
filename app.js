// ==========================================
// ESTADO GLOBAL DA APLICAÇÃO
// ==========================================
const STORAGE_KEY = 'guia_patriota_dados_v2';
const FIREBASE_CONFIG_KEY = 'guia_patriota_fb_config';

let prestadores = [];
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
  initMap();
  setupEventListeners();
  await carregarDadosIniciais();
  renderAll();
  fitAllMarkers();

  // Verificar se URL possui #admin
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

function criarIconePino(posicao) {
  const classeCor = posicao === 'cinza' ? 'cinza' : posicao === 'esquerda' ? 'esquerda' : 'direita';
  const tamanho = posicao === 'cinza' ? [28, 28] : [36, 36];
  const ancora = posicao === 'cinza' ? [14, 28] : [18, 36];
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

function setFilterPosicao(posicao) {
  filtroPosicao = posicao;
  atualizarBotoesFiltroPosicao();
  renderAll();
}

function atualizarBotoesFiltroPosicao() {
  // Desktop buttons
  const topTodos = document.getElementById('topFilterTodos');
  const topDireita = document.getElementById('topFilterDireita');
  const topEsquerda = document.getElementById('topFilterEsquerda');

  topTodos.className = 'filter-btn-top px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-2 ' +
    (filtroPosicao === 'todos' ? 'bg-white text-slate-900 shadow' : 'text-slate-300 hover:bg-slate-700/60');

  topDireita.className = 'filter-btn-top px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-2 ' +
    (filtroPosicao === 'direita' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30' : 'text-blue-300 hover:bg-slate-700/60');

  topEsquerda.className = 'filter-btn-top px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-2 ' +
    (filtroPosicao === 'esquerda' ? 'bg-red-600 text-white shadow-lg shadow-red-600/30' : 'text-red-300 hover:bg-slate-700/60');

  // Mobile buttons
  const mobTodos = document.getElementById('mobFilterTodos');
  const mobDireita = document.getElementById('mobFilterDireita');
  const mobEsquerda = document.getElementById('mobFilterEsquerda');

  mobTodos.className = 'py-1.5 px-2 rounded-lg text-xs font-bold text-center transition ' +
    (filtroPosicao === 'todos' ? 'bg-white text-slate-900 shadow' : 'text-slate-600');

  mobDireita.className = 'py-1.5 px-2 rounded-lg text-xs font-bold text-center flex items-center justify-center gap-1 transition ' +
    (filtroPosicao === 'direita' ? 'bg-blue-600 text-white shadow' : 'text-blue-700');

  mobEsquerda.className = 'py-1.5 px-2 rounded-lg text-xs font-bold text-center flex items-center justify-center gap-1 transition ' +
    (filtroPosicao === 'esquerda' ? 'bg-red-600 text-white shadow' : 'text-red-700');
}

function obterPrestadoresAprovados() {
  return prestadores.filter((item) => item.status !== 'pendente');
}

function obterPrestadoresFiltrados() {
  return obterPrestadoresAprovados().filter((item) => {
    const matchPosicao = filtroPosicao === 'todos' || item.posicao === filtroPosicao;
    const matchServico = filtroTipoServico === 'todos' || item.tipoServico === filtroTipoServico;
    const textoItem = `${item.nome} ${item.tipoServico} ${item.servicos} ${item.endereco}`.toLowerCase();
    const matchBusca = !termoBusca || textoItem.includes(termoBusca);
    return matchPosicao && matchServico && matchBusca;
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
  renderSidebarList(filtrados);
  renderAdminList();
  lucide.createIcons();
}

function atualizarContadores() {
  const aprovados = obterPrestadoresAprovados();
  const pendentes = prestadores.filter((p) => p.status === 'pendente');
  const total = aprovados.length;
  const totalDireita = aprovados.filter((p) => p.posicao === 'direita').length;
  const totalEsquerda = aprovados.filter((p) => p.posicao === 'esquerda').length;

  document.getElementById('countTodosTop').textContent = total;
  document.getElementById('countDireitaTop').textContent = totalDireita;
  document.getElementById('countEsquerdaTop').textContent = totalEsquerda;

  document.getElementById('countTodosMob').textContent = total;
  document.getElementById('countDireitaMob').textContent = totalDireita;
  document.getElementById('countEsquerdaMob').textContent = totalEsquerda;

  document.getElementById('adminTotalCount').textContent = total;

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

function renderMarkers(lista) {
  markersLayer.clearLayers();
  markersById = {};

  lista.forEach((item) => {
    const lat = parseFloat(item.lat);
    const lng = parseFloat(item.lng);
    if (isNaN(lat) || isNaN(lng)) return;

    const isEsquerda = item.posicao === 'esquerda';
    const headerBg = isEsquerda
      ? 'bg-gradient-to-r from-red-600 to-red-700'
      : 'bg-gradient-to-r from-blue-600 to-blue-700';
    const badgeTexto = isEsquerda ? 'ESQUERDA • VERMELHO' : 'DIREITA • AZUL';
    const linkZap = formatarLinkWhatsapp(item.whatsapp, item.nome);
    const linkGoogleMaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.endereco || `${lat},${lng}`)}`;

    const popupHtml = `
      <div class="font-sans text-slate-800">
        <div class="${headerBg} text-white p-3.5">
          <span class="inline-block text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full bg-black/25 mb-1">
            ${badgeTexto}
          </span>
          <h3 class="font-bold text-base leading-snug">${escapeHtml(item.nome)}</h3>
          <p class="text-xs text-white/90 font-medium mt-0.5">${escapeHtml(item.tipoServico)}</p>
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
          <div class="pt-1 flex gap-2">
            <a
              href="${linkZap}"
              target="_blank"
              rel="noopener noreferrer"
              class="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 !text-white font-bold text-xs rounded-xl text-center flex items-center justify-center gap-1.5 shadow-sm no-underline transition"
            >
              <span>WhatsApp</span>
            </a>
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
      icon: criarIconePino(item.posicao)
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

  if (lista.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12 px-4">
        <div class="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
          <i data-lucide="map-pin-off" class="w-6 h-6"></i>
        </div>
        <h3 class="font-bold text-slate-700 text-sm">Nenhum prestador encontrado</h3>
        <p class="text-xs text-slate-500 mt-1">Tente alterar o filtro de cor (Direita/Esquerda) ou limpar a busca.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = lista
    .map((item) => {
      const isEsquerda = item.posicao === 'esquerda';
      const borderLeftColor = isEsquerda ? 'border-l-red-600' : 'border-l-blue-600';
      const badgeClass = isEsquerda
        ? 'bg-red-100 text-red-800 border-red-200'
        : 'bg-blue-100 text-blue-800 border-blue-200';
      const dotClass = isEsquerda ? 'bg-red-600' : 'bg-blue-600';
      const labelPosicao = isEsquerda ? 'Esquerda • Vermelho' : 'Direita • Azul';
      const linkZap = formatarLinkWhatsapp(item.whatsapp, item.nome);
      const foneFormatado = formatarTelefoneExibicao(item.whatsapp);
      const temMapa = !item.semEndereco && !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lng));
      const textoEndereco = item.endereco && item.endereco.trim()
        ? item.endereco
        : 'Prestador sem endereço fixo (Atendimento móvel / online)';

      return `
        <article
          id="card-${item.id}"
          class="provider-card bg-white rounded-2xl border border-slate-200 border-l-4 ${borderLeftColor} p-3.5 shadow-sm hover:shadow-md"
        >
          <div class="flex items-start justify-between gap-2 mb-1.5">
            <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${badgeClass}">
              <span class="w-2 h-2 rounded-full ${dotClass}"></span>
              ${labelPosicao}
            </span>
            <span class="text-[11px] font-semibold text-slate-600 bg-slate-100 px-2.5 py-0.5 rounded-lg truncate max-w-[170px]">
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

          <div class="flex items-center gap-2 mt-3 pt-2.5 border-t border-slate-100">
            ${
              temMapa
                ? `
            <button
              onclick="focarNoMapa('${item.id}')"
              class="flex-1 py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition"
            >
              <i data-lucide="navigation" class="w-3.5 h-3.5 text-slate-600"></i>
              <span>Ver no Mapa</span>
            </button>
            `
                : ''
            }

            <a
              href="${linkZap}"
              target="_blank"
              rel="noopener noreferrer"
              class="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 shadow-sm shadow-emerald-600/20 transition"
              title="Conversar no WhatsApp: ${escapeHtml(foneFormatado)}"
            >
              <i data-lucide="message-circle" class="w-3.5 h-3.5"></i>
              <span>WhatsApp</span>
            </a>
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
// PAINEL ADMINISTRATIVO (TELA ADM - FIREBASE AUTH)
// ==========================================
function isAdminAuthenticated() {
  return typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser !== null;
}

function openAdminAccess() {
  if (isAdminAuthenticated()) {
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
    closeAdminLoginModal();
    switchView('admin');
    mostrarToast('Autenticado com sucesso no Painel ADM!');
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
    adminPanel.classList.remove('hidden');
    adminPanel.classList.add('flex');
    badgeMode.textContent = 'Modo ADM';
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
  const posicao = document.querySelector('input[name="posicao"]:checked').value;
  const nome = document.getElementById('inputNome').value.trim();
  const tipoServico = document.getElementById('inputTipoServico').value.trim();
  const whatsapp = document.getElementById('inputWhatsapp').value.trim();
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
    posicao,
    whatsapp,
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
  document.getElementById('inputServicos').value = item.servicos;

  toggleSemEndereco(isSemEnd);
  document.getElementById('inputEndereco').value = item.endereco || '';
  document.getElementById('inputLat').value = temCoords ? item.lat : '';
  document.getElementById('inputLng').value = temCoords ? item.lng : '';

  const radio = document.querySelector(`input[name="posicao"][value="${item.posicao}"]`);
  if (radio) radio.checked = true;

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
          const isEsquerda = item.posicao === 'esquerda';
          const badgeCor = isEsquerda
            ? 'bg-red-100 text-red-800 border-red-200'
            : 'bg-blue-100 text-blue-800 border-blue-200';
          const labelCor = isEsquerda ? 'Esquerda • Vermelho' : 'Direita • Azul';
          const temCoords = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lng));
          const infoEnd = item.endereco && item.endereco.trim()
            ? item.endereco
            : 'Sem endereço fixo (Apenas lista)';

          return `
            <div class="p-3 bg-white rounded-xl border-2 border-amber-300 shadow-sm space-y-2">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <span class="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full border ${badgeCor} mb-1">
                    ${labelCor}
                  </span>
                  <h4 class="font-bold text-xs sm:text-sm text-slate-900">${escapeHtml(item.nome)}</h4>
                  <p class="text-[11px] font-semibold text-slate-600">${escapeHtml(item.tipoServico)} • ${escapeHtml(formatarTelefoneExibicao(item.whatsapp))}</p>
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
      const isEsquerda = item.posicao === 'esquerda';
      const corBolinha = isEsquerda ? 'bg-red-600' : 'bg-blue-600';
      const labelCor = isEsquerda ? 'Esquerda (Vermelho)' : 'Direita (Azul)';
      const infoEnd = item.endereco && item.endereco.trim()
        ? item.endereco
        : 'Sem endereço fixo (Apenas no menu lateral)';

      return `
        <div class="p-3 bg-white rounded-xl border border-slate-200 flex items-center justify-between gap-2 hover:border-slate-300 transition">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-full ${corBolinha} shrink-0"></span>
              <h4 class="font-bold text-xs text-slate-900 truncate">${escapeHtml(item.nome)}</h4>
            </div>
            <p class="text-[11px] text-slate-500 truncate mt-0.5">${escapeHtml(item.tipoServico)} • ${labelCor}</p>
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

          <div class="pt-1">
            <p class="text-[11px] font-bold text-slate-700 mb-1.5 text-center">Classificar este local como:</p>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                onclick="classificarPontoCinzaDireto(${idxOriginal}, 'direita')"
                class="py-2 px-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow flex items-center justify-center gap-1.5 transition"
              >
                <span class="w-2 h-2 rounded-full bg-white"></span>
                <span>Direita (Azul)</span>
              </button>

              <button
                type="button"
                onclick="classificarPontoCinzaDireto(${idxOriginal}, 'esquerda')"
                class="py-2 px-2.5 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-xl shadow flex items-center justify-center gap-1.5 transition"
              >
                <span class="w-2 h-2 rounded-full bg-white"></span>
                <span>Esquerda (Verm.)</span>
              </button>
            </div>
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

async function classificarPontoCinzaDireto(index, posicao) {
  if (!isAdminAuthenticated()) {
    mostrarToast('Faça login no Painel ADM primeiro.');
    return;
  }

  const item = comerciosLocaisCinza[index];
  if (!item) return;

  const inputZapPopup = document.getElementById(`zap-cinza-${index}`);
  const whatsappFinal = inputZapPopup ? inputZapPopup.value.trim() : (item.whatsapp || '');

  const novoItem = {
    id: String(Date.now()),
    nome: item.nome,
    tipoServico: item.tipoServico,
    servicos: item.servicos || item.tipoServico,
    endereco: item.endereco,
    semEndereco: false,
    posicao,
    whatsapp: whatsappFinal,
    lat: item.lat,
    lng: item.lng,
    status: 'aprovado',
    criadoEm: new Date().toISOString()
  };

  prestadores.unshift(novoItem);
  salvarDadosLocal();
  map.closePopup();
  renderAll();

  const labelPos = posicao === 'esquerda' ? 'Esquerda (Vermelho)' : 'Direita (Azul)';
  mostrarToast(`"${item.nome}" marcado como ${labelPos}!`);

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
  const whatsappFinal = inputZapPopup ? inputZapPopup.value.trim() : (item.whatsapp || '');

  resetAdminForm();
  toggleSemEndereco(false);
  document.getElementById('inputNome').value = item.nome || '';
  document.getElementById('inputTipoServico').value = item.tipoServico || '';
  document.getElementById('inputWhatsapp').value = formatarTelefoneExibicao(whatsappFinal);
  document.getElementById('inputServicos').value = item.servicos || '';
  document.getElementById('inputEndereco').value = item.endereco || '';
  definirCoordenadasFormulario(item.lat, item.lng);

  map.closePopup();
  document.getElementById('adminForm').scrollIntoView({ behavior: 'smooth' });
  mostrarToast('Dados preenchidos no formulário ADM! Escolha a cor e salve.');
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
