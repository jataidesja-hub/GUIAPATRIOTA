# Guia Comercial & Prestadores de Serviços (Mapa Interativo)

Sistema web de mapeamento de endereços comerciais e prestadores de serviços com marcação por cores (**Azul = Direita** e **Vermelho = Esquerda**), filtros em tempo real, menu lateral com botão direto para o **WhatsApp**, **Tela de Acesso Livre** e **Painel ADM**.

## Funcionalidades
- **Mapa Interativo (Leaflet + OpenStreetMap + Nominatim)**:
  - Pinos **Azuis** para estabelecimentos marcados como **Direita**.
  - Pinos **Vermelhos** para estabelecimentos marcados como **Esquerda**.
  - Filtro rápido: **Todos**, **Direita (Azul)** ou **Esquerda (Vermelho)**.
- **Menu Lateral de Prestadores**:
  - Lista com Nome, Tipo de Serviço Prestado, Descrição dos Serviços, Endereço e Posicionamento.
  - Busca por texto e filtro por categoria de serviço.
  - Botão **WhatsApp** direto (`wa.me`) e botão **Ver no Mapa**.
- **Tela de ADM**:
  - Acesso autenticado via **Firebase Authentication (E-mail e Senha)** — nenhuma senha exposta no frontend.
  - Cadastro, edição e exclusão de locais (atualiza Mapa e Menu Lateral simultaneamente).
  - Localização automática por endereço ou **clique direto no mapa**.
  - Sincronização direta com o GitHub/Vercel via Token ou exportação/importação de `dados.json`.
