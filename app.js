// ==========================================
// ESTADO GLOBAL DA APLICAÇÃO
// ==========================================
const STORAGE_KEY = 'guia_patriota_dados_v2';
const ADMIN_AUTH_KEY = 'guia_patriota_admin_logged';
const ADMIN_PASS_KEY = 'guia_patriota_admin_pass';
const GITHUB_CONFIG_KEY = 'guia_patriota_gh_config';

let prestadores = [];
let filtroPosicao = 'todos'; // 'todos' | 'direita' | 'esquerda'
let filtroTipoServico = 'todos';
let termoBusca = '';
let map = null;
let markersLayer = null;
let markersById = {};
let tempPickMarker = null;
let isPickingOnMap = false;
let currentMode = 'public'; // 'public' | 'admin'
let activeProviderId = null;

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

  // Camada de mapa limpa e moderna (CartoDB Voyager / OSM)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);

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
  const classeCor = posicao === 'esquerda' ? 'esquerda' : 'direita';
  return L.divIcon({
    className: 'custom-pin-wrapper',
    html: `
      <div class="marker-pin ${classeCor}">
        <div class="marker-pin-inner"></div>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 36],
    popupAnchor: [0, -34]
  });
}

// ==========================================
// CARREGAMENTO E PERSISTÊNCIA DE DADOS
// ==========================================
async function carregarDadosIniciais() {
  const salvosLocal = localStorage.getItem(STORAGE_KEY);

  if (salvosLocal) {
    try {
      prestadores = JSON.parse(salvosLocal);
      if (Array.isArray(prestadores) && prestadores.length > 0) {
        return;
      }
    } catch (err) {
      console.error('Erro ao ler localStorage:', err);
    }
  }

  try {
    const resp = await fetch(`./dados.json?t=${Date.now()}`);
    if (resp.ok) {
      const dadosJson = await resp.json();
      if (Array.isArray(dadosJson)) {
        prestadores = dadosJson;
        salvarDadosLocal();
      }
    }
  } catch (err) {
    console.warn('Usando lista inicial padrão:', err);
  }
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

function obterPrestadoresFiltrados() {
  return prestadores.filter((item) => {
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
  renderSidebarList(filtrados);
  renderAdminList();
  lucide.createIcons();
}

function atualizarContadores() {
  const total = prestadores.length;
  const totalDireita = prestadores.filter((p) => p.posicao === 'direita').length;
  const totalEsquerda = prestadores.filter((p) => p.posicao === 'esquerda').length;

  document.getElementById('countTodosTop').textContent = total;
  document.getElementById('countDireitaTop').textContent = totalDireita;
  document.getElementById('countEsquerdaTop').textContent = totalEsquerda;

  document.getElementById('countTodosMob').textContent = total;
  document.getElementById('countDireitaMob').textContent = totalDireita;
  document.getElementById('countEsquerdaMob').textContent = totalEsquerda;

  document.getElementById('adminTotalCount').textContent = total;
}

function atualizarSelectCategorias() {
  const select = document.getElementById('serviceTypeFilter');
  const valorAtual = select.value;
  const categorias = [...new Set(prestadores.map((p) => p.tipoServico).filter(Boolean))].sort();

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
            <i data-lucide="map-pin" class="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5"></i>
            <span class="leading-tight">${escapeHtml(item.endereco)}</span>
          </div>

          <div class="flex items-center gap-2 mt-3 pt-2.5 border-t border-slate-100">
            <button
              onclick="focarNoMapa('${item.id}')"
              class="flex-1 py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition"
            >
              <i data-lucide="navigation" class="w-3.5 h-3.5 text-slate-600"></i>
              <span>Ver no Mapa</span>
            </button>

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
// PAINEL ADMINISTRATIVO (TELA ADM)
// ==========================================
function openAdminAccess() {
  const isLogged = sessionStorage.getItem(ADMIN_AUTH_KEY) === 'true';
  if (isLogged) {
    switchView('admin');
  } else {
    document.getElementById('modalAdminLogin').classList.remove('hidden');
    document.getElementById('inputAdminPassword').value = '';
    document.getElementById('loginErrorMsg').classList.add('hidden');
    setTimeout(() => document.getElementById('inputAdminPassword').focus(), 100);
  }
}

function closeAdminLoginModal() {
  document.getElementById('modalAdminLogin').classList.add('hidden');
}

function handleAdminLogin(e) {
  e.preventDefault();
  const passInput = document.getElementById('inputAdminPassword').value;
  const savedPass = localStorage.getItem(ADMIN_PASS_KEY) || 'admin123';

  if (passInput === savedPass) {
    sessionStorage.setItem(ADMIN_AUTH_KEY, 'true');
    closeAdminLoginModal();
    switchView('admin');
    mostrarToast('Bem-vindo ao Painel ADM!');
  } else {
    document.getElementById('loginErrorMsg').classList.remove('hidden');
  }
}

function switchView(mode) {
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
  } else {
    adminPanel.classList.add('hidden');
    adminPanel.classList.remove('flex');
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

// ==========================================
// CRUD DO ADMINISTRADOR (SALVAR, EDITAR, EXCLUIR)
// ==========================================
async function saveProvider(e) {
  e.preventDefault();

  const id = document.getElementById('providerId').value;
  const posicao = document.querySelector('input[name="posicao"]:checked').value;
  const nome = document.getElementById('inputNome').value.trim();
  const tipoServico = document.getElementById('inputTipoServico').value.trim();
  const whatsapp = document.getElementById('inputWhatsapp').value.trim();
  const servicos = document.getElementById('inputServicos').value.trim();
  const endereco = document.getElementById('inputEndereco').value.trim();
  const lat = parseFloat(document.getElementById('inputLat').value);
  const lng = parseFloat(document.getElementById('inputLng').value);

  if (isNaN(lat) || isNaN(lng)) {
    mostrarToast('Localize o endereço ou clique no mapa para definir as coordenadas.');
    return;
  }

  const novoItem = {
    id: id || String(Date.now()),
    nome,
    tipoServico,
    servicos,
    endereco,
    posicao,
    whatsapp,
    lat,
    lng,
    criadoEm: new Date().toISOString()
  };

  if (id) {
    const index = prestadores.findIndex((p) => p.id === id);
    if (index !== -1) {
      prestadores[index] = novoItem;
    }
    mostrarToast('Cadastro atualizado no Mapa e na Lista!');
  } else {
    prestadores.unshift(novoItem);
    mostrarToast('Novo endereço comercial adicionado no Mapa e na Lista!');
  }

  salvarDadosLocal();
  removerPinoTemporario();
  resetAdminForm();
  renderAll();
  focarNoMapa(novoItem.id);

  // Se o token do GitHub estiver configurado, sincroniza automaticamente
  const ghConfig = obterConfigGitHub();
  if (ghConfig && ghConfig.token) {
    await syncToGitHubNow(true);
  }
}

function editarPrestador(id) {
  const item = prestadores.find((p) => p.id === id);
  if (!item) return;

  document.getElementById('providerId').value = item.id;
  document.getElementById('inputNome').value = item.nome;
  document.getElementById('inputTipoServico').value = item.tipoServico;
  document.getElementById('inputWhatsapp').value = formatarTelefoneExibicao(item.whatsapp);
  document.getElementById('inputServicos').value = item.servicos;
  document.getElementById('inputEndereco').value = item.endereco;
  document.getElementById('inputLat').value = item.lat;
  document.getElementById('inputLng').value = item.lng;

  const radio = document.querySelector(`input[name="posicao"][value="${item.posicao}"]`);
  if (radio) radio.checked = true;

  document.getElementById('formTitle').innerHTML = `
    <i data-lucide="edit-3" class="w-4 h-4 text-amber-600"></i>
    <span>Editando: ${escapeHtml(item.nome)}</span>
  `;
  document.getElementById('lblSubmitBtn').textContent = 'Salvar Alterações';
  document.getElementById('btnCancelEdit').classList.remove('hidden');

  definirCoordenadasFormulario(item.lat, item.lng);
  map.flyTo([item.lat, item.lng], 16);
  document.getElementById('adminForm').scrollIntoView({ behavior: 'smooth' });
  lucide.createIcons();
}

async function excluirPrestador(id) {
  const item = prestadores.find((p) => p.id === id);
  if (!item) return;

  if (!confirm(`Deseja realmente remover "${item.nome}" do mapa e da lista lateral?`)) {
    return;
  }

  prestadores = prestadores.filter((p) => p.id !== id);
  salvarDadosLocal();
  renderAll();
  mostrarToast('Cadastro removido com sucesso.');

  const ghConfig = obterConfigGitHub();
  if (ghConfig && ghConfig.token) {
    await syncToGitHubNow(true);
  }
}

function resetAdminForm() {
  document.getElementById('adminForm').reset();
  document.getElementById('providerId').value = '';
  document.getElementById('formTitle').innerHTML = `
    <i data-lucide="plus-circle" class="w-4 h-4 text-blue-600"></i>
    <span>Novo Cadastro no Mapa & Lista</span>
  `;
  document.getElementById('lblSubmitBtn').textContent = 'Salvar no Mapa e Menu Lateral';
  document.getElementById('btnCancelEdit').classList.add('hidden');
  removerPinoTemporario();
  lucide.createIcons();
}

function renderAdminList() {
  const container = document.getElementById('adminProvidersList');
  if (!container) return;

  if (prestadores.length === 0) {
    container.innerHTML = `<p class="text-xs text-slate-400 text-center py-4">Nenhum cadastro ativo.</p>`;
    return;
  }

  container.innerHTML = prestadores
    .map((item) => {
      const isEsquerda = item.posicao === 'esquerda';
      const corBolinha = isEsquerda ? 'bg-red-600' : 'bg-blue-600';
      const labelCor = isEsquerda ? 'Esquerda (Vermelho)' : 'Direita (Azul)';

      return `
        <div class="p-3 bg-white rounded-xl border border-slate-200 flex items-center justify-between gap-2 hover:border-slate-300 transition">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-full ${corBolinha} shrink-0"></span>
              <h4 class="font-bold text-xs text-slate-900 truncate">${escapeHtml(item.nome)}</h4>
            </div>
            <p class="text-[11px] text-slate-500 truncate mt-0.5">${escapeHtml(item.tipoServico)} • ${labelCor}</p>
            <p class="text-[11px] text-slate-400 truncate">${escapeHtml(item.endereco)}</p>
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

function obterConfigGitHub() {
  try {
    return JSON.parse(localStorage.getItem(GITHUB_CONFIG_KEY) || '{}');
  } catch {
    return {};
  }
}

function openCloudConfigModal() {
  const cfg = obterConfigGitHub();
  document.getElementById('inputGithubRepo').value = cfg.repo || 'jataidesja-hub/GUIAPATRIOTA';
  document.getElementById('inputGithubToken').value = cfg.token || '';
  document.getElementById('inputNewAdminPass').value = localStorage.getItem(ADMIN_PASS_KEY) || 'admin123';
  document.getElementById('modalCloudConfig').classList.remove('hidden');
}

function closeCloudConfigModal() {
  document.getElementById('modalCloudConfig').classList.add('hidden');
}

function saveCloudConfig(e) {
  e.preventDefault();
  const repo = document.getElementById('inputGithubRepo').value.trim();
  const token = document.getElementById('inputGithubToken').value.trim();
  const newPass = document.getElementById('inputNewAdminPass').value.trim();

  localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify({ repo, token }));
  if (newPass) {
    localStorage.setItem(ADMIN_PASS_KEY, newPass);
  }
  closeCloudConfigModal();
  mostrarToast('Configurações salvas!');
}

async function syncToGitHubNow(silencioso = false) {
  const repo = (document.getElementById('inputGithubRepo')?.value || obterConfigGitHub().repo || 'jataidesja-hub/GUIAPATRIOTA').trim();
  const token = (document.getElementById('inputGithubToken')?.value || obterConfigGitHub().token || '').trim();

  if (!token) {
    if (!silencioso) {
      mostrarToast('Informe seu GitHub Personal Access Token primeiro.');
    }
    return;
  }

  try {
    if (!silencioso) mostrarToast('Publicando dados no GitHub / Vercel...');
    const apiUrl = `https://api.github.com/repos/${repo}/contents/dados.json`;

    // 1. Buscar SHA atual do arquivo dados.json
    let sha = undefined;
    const getResp = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json'
      }
    });
    if (getResp.ok) {
      const fileData = await getResp.json();
      sha = fileData.sha;
    }

    // 2. Codificar JSON em Base64 UTF-8
    const conteudoJson = JSON.stringify(prestadores, null, 2);
    const base64Content = btoa(unescape(encodeURIComponent(conteudoJson)));

    const putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Atualização de prestadores via Painel ADM',
        content: base64Content,
        sha
      })
    });

    if (putResp.ok) {
      mostrarToast('Publicado no GitHub! A Vercel atualizará em instantes.');
    } else {
      mostrarToast('Erro ao publicar no GitHub. Verifique o Token.');
    }
  } catch (err) {
    console.error(err);
    mostrarToast('Falha de conexão ao sincronizar com GitHub.');
  }
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
