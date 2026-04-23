# IceLaser Landing — Claude Context

## Visão Geral do Projeto

Landing page + API de integração para IceLaser Recife (depilação laser).
Repositório GitHub: `thclaude33/icelaser-landing` (branch `main`)

### 3 Projetos Vercel (TODOS devem ser deployados juntos a cada mudança)
| Projeto | URL | Status atual |
|---|---|---|
| `icelaser-landing` | `icelaser-landing.vercel.app` | ✅ READY — commit `9faefe5` |
| `icelaser-landing-c9in` | auto-deploy via GitHub | ✅ READY — commit `9faefe5` |
| `landing-page` | `landing-page-six-xi-77.vercel.app` | ✅ READY — commit `9faefe5` |

> **REGRA IMPORTANTE**: toda mudança no Vercel deve ser deployada nos 3 projetos.

---

## Arquitetura da API

Todas as rotas ficam em `api/` e são Vercel Serverless Functions com ESM (`"type": "module"` no package.json).

### Rotas principais
- `api/crm-webhook.js` — Recebe eventos do Chatwoot CRM → dispara eventos CAPI/Meta
- `api/track.js` — Tracking de eventos frontend → Meta CAPI
- `api/conversion.js` — Conversões de formulário → Meta CAPI
- `api/health.js` — Health check (`GET /api/health` → `{ ok: true }`)
- `api/vercel-webhook.js` — Webhook de deploy do Vercel
- `api/whatsapp.js` — Integração WhatsApp Business API
- `api/og.js` — Open Graph image generation
- `api/flags.js` / `api/flags-manifest.js` — Feature flags
- `api/log-drain.js` — Log drain do Vercel
- `api/config.js` — Configurações globais
- `api/cron/` — Jobs cron agendados

---

## CRM Webhook (`api/crm-webhook.js`) — CRÍTICO

### Bugs corrigidos

**commit `225bb98` (31/03/2026)** — Extração de conversa com payload flat:
```js
// ANTES (bug): retornava no_contact_data com payload flat do Chatwoot
const conversation = body.conversation || body.data || {};

// DEPOIS (correto): usa body como fallback quando Chatwoot envia payload flat
const conversation = body.conversation || body.data || body;
```

**commit `70f3621` (31/03/2026)** — Fallback de valor no evento Purchase:
```js
// ANTES (bug): enviava value: 0 quando purchase_value não configurado
const valor = parseFloat(customAttrs.purchase_value) || 0;

// DEPOIS (correto): usa R$497 como valor padrão do serviço
const valor = parseFloat(customAttrs.purchase_value) || 497;
```

### Como funciona
O Chatwoot envia `conversation_updated` com payload **flat** (o body IS a conversa).
O código extrai labels e dispara eventos Meta CAPI conforme mapeamento abaixo.

### Mapeamento Labels → Eventos CAPI
| Label no Chatwoot | Evento(s) Meta CAPI | Tipo |
|---|---|---|
| `desqualificado` / `❌ Desqualificado` | `Lead` | cold_lead |
| `lead_frio` / `🧊 Lead Frio` | `Lead` | cold_lead |
| `lead_quente` / `🔥 Lead Quente` | `Lead` + `CompleteRegistration` | hot_lead |
| `compra_realizada` / `💰 Compra Realizada` | `Lead` + `CompleteRegistration` + `InitiateCheckout` + `Purchase` | purchase |

### Nomes técnicos dos eventos Meta CAPI (Standard Events)
Todos os nomes são válidos: `Lead`, `CompleteRegistration`, `InitiateCheckout`, `Purchase`.
Endpoint: `https://graph.facebook.com/v25.0/{PIXEL_ID}/events`
Pixel ID: `2774496306216737`

### Observação: valor do Purchase
- `CompleteRegistration` tem fallback `value: 150.00` ✅
- `Purchase` usa `customAttrs.purchase_value` com fallback `|| 497` → valor padrão R$497 ✅

---

## Variáveis de Ambiente (Vercel)

### `landing-page`
| Variável | Ambientes | Status |
|---|---|---|
| `META_ACCESS_TOKEN` | Production + Preview | ✅ configurado |
| `CONVERSION_API_KEY` | All Environments | ✅ configurado |
| `CRON_SECRET` | All Environments | ✅ configurado |
| `EMAIL_PASS` | Production + Preview | ✅ configurado |
| `NODE_OPTIONS` | Production | ✅ configurado |

### `icelaser-landing`
| Variável | Ambientes | Status |
|---|---|---|
| `META_ACCESS_TOKEN` | Production and Preview | ✅ atualizado 31/03/2026 |
| `CONVERSION_API_KEY` | All Environments | ✅ configurado |
| `EMAIL_PASS` | Production + Preview | ✅ configurado |
| `NODE_OPTIONS` | Production | ✅ configurado |

---

## Histórico de Commits Relevantes

| Commit | Data | Descrição |
|---|---|---|
| `9faefe5` | 31/03/2026 | feat: index.html - sincroniza versão local completa (52KB) — WA hero CAPI, fbc, CompleteRegistration value/currency |
| `983f9b6` | 31/03/2026 | fix: crm-webhook - merge customAttrs contact+conversation, eventSourceUrl dinamico |
| `984ceff` | 31/03/2026 | fix: config.js - proximoDomingo() dinamico substitui data hardcoded |
| `d17b15b` | 31/03/2026 | feat: index.html - fbc cookie capture no page load (Parameter Setup Tool Meta) |
| `863b1c8` | 31/03/2026 | fix: track.js - custom_data CAPI + allowedOrigins + fbc coverage |
| `732f3e6` | 31/03/2026 | fix: index.html - value:0/currency:BRL no fbq CompleteRegistration |
| `70f3621` | 31/03/2026 | fix: add fallback value (\|\| 497) to Purchase CAPI event in crm-webhook |
| `dd12755` | 31/03/2026 | chore: add comment to health.js (trigger deploy landing-page) |
| `225bb98` | 31/03/2026 | fix: conversation extraction logic in CRM webhook (`\|\| body`) |
| `90059f0` | 31/03/2026 | fix: adiciona currency/value em eventos CompleteRegistration do CAPI |
| `9c60656` | 30/03/2026 | feat: api routes, ESM module type, config CORS fix, nodemailer patch |

---

## Pendências / TODO

- [x] ~~Adicionar fallback de valor no evento `Purchase` (ex: `|| 497`)~~ — feito em `70f3621`
- [x] ~~Mudar `META_ACCESS_TOKEN` do `icelaser-landing` para "All Environments"~~ — feito 31/03/2026
- [x] ~~**BUG CRÍTICO** `index.html`: `fbq('track', 'CompleteRegistration', ...)` sem `value`/`currency`~~ — corrigido em `732f3e6`
- [x] ~~**BUG CRÍTICO** `track.js`: CAPI payload sem `custom_data` → CompleteRegistration CAPI não envia `value`/`currency`~~ — corrigido em `863b1c8`
- [x] ~~**BUG MENOR** `track.js`: `allowedOrigins` não inclui `landing-page-six-xi-77.vercel.app`~~ — corrigido em `863b1c8`
- [x] ~~**BUG MENOR** `crm-webhook.js`: `event_source_url` hardcoded~~ — corrigido em `983f9b6` (dinâmico via `customAttrs.landing_url`)
- [x] ~~**INVESTIGAR** `crm-webhook.js`: `customAttrs` busca em `contact.custom_attributes`~~ — corrigido em `983f9b6` (merge contact + conversation attrs)
- [x] ~~**MELHORIA** fbc coverage~~ — implementado Parameter Setup Tool em `d17b15b` (captura fbclid no page load → cookie `_fbc`)
- [x] ~~**BUG MENOR** `config.js` fallback data hardcoded~~ — corrigido em `984ceff` (função `proximoDomingo()` dinâmica)
- [x] ~~**VERIFICAR** `BLOB_READ_WRITE_TOKEN` configurado nos 3 projetos Vercel~~ — verificado 31/03/2026: todos os 3 projetos têm o token ✅
- [x] ~~Commitar versão local completa do `index.html` (52KB)~~ — feito em `9faefe5` (31/03/2026)
- [ ] **META ACTION** Clicar em "Analisar eventos" no Events Manager → confirmar eventos personalizados para desbloquear uso em anúncios
- [ ] **VERIFICAR** Chatwoot: configurar webhook URL → `https://icelaser-landing.vercel.app/api/crm-webhook` com token CONVERSION_API_KEY no header
- [ ] Testar fluxo completo: Chatwoot label → webhook → CAPI → Meta Events Manager
- [ ] **AGUARDAR ~24h** diagnóstico Meta "CompleteRegistration sem value/currency" sumir — fixes deployados às ~14h de 31/03/2026

---

## Auditoria Completa — 31/03/2026

### Status dos Eventos na Meta (Pixel 2774496306216737)
| Evento | Total | Qualidade | Método | Observação |
|---|---|---|---|---|
| PageView | 1,7 mil | 3.0/10 | Navegador + Servidor | OK |
| ViewContent | 1,2 mil | — | Navegador | OK |
| Lead | 39 | 6.4/10 | Navegador + Servidor | ✅ |
| CompleteRegistration | 37 | 6.0/10 | Navegador + Servidor | ⚠️ 1 warning ativo |
| InitiateCheckout | 15 | — | Navegador | sem CAPI |
| Purchase | 8 | 3.8/10 | Servidor | qualidade baixa |

### Diagnóstico Meta Ativo
**"Envie informações de preço e moeda válidas para eventos de CompleteRegistration"**
- 100% dos eventos sem `value`/`currency` — afeta 7 conjuntos de anúncios
- Causa 1: `index.html` linha 986 — `fbq('track', 'CompleteRegistration', { status:'submitted' })` sem value/currency
- Causa 2: `track.js` linhas 273-282 — CAPI payload sem `custom_data` → sem value/currency no servidor
- Fix necessário: Adicionar `value:0, currency:'BRL'` em ambos

### Landing Page (31/03/2026)
- ✅ Carregando em todos os 3 domínios
- ✅ Pixel Meta carregando (ID 2774496306216737)
- ✅ Advanced Matching: reinit fbq com nome/telefone/país/cidade
- ✅ Edge Config funcionando: "3 vagas — domingo 05/04"
- ✅ Timer de urgência ativo
- ✅ Formulário funcional (nome + WhatsApp)
- ⚠️ `fbq CompleteRegistration` sem value/currency (diagnóstico ativo)

### Variáveis de Ambiente — Status Verificado
| Variável | icelaser-landing | landing-page | icelaser-landing-c9in |
|---|---|---|---|
| META_ACCESS_TOKEN | Prod + Preview ✅ | ✅ | ✅ |
| CONVERSION_API_KEY | All ✅ | All ✅ | All ✅ |
| EMAIL_PASS | Prod + Preview ✅ | ✅ | ✅ |
| CRON_SECRET | All ✅ | All ✅ | All ✅ |
| NODE_OPTIONS | Prod ✅ | Prod ✅ | Prod ✅ |
| BLOB_READ_WRITE_TOKEN | **✅ configurado** | **✅ configurado** | **✅ configurado** |
| EDGE_CONFIG | All ✅ | All ✅ | All ✅ |

> `BLOB_READ_WRITE_TOKEN` verificado em todos os 3 projetos em 31/03/2026 ✅

---

## Integração GitHub ↔ Vercel

Todos os 3 projetos estão conectados ao repo `thclaude33/icelaser-landing` (branch `main`).
Push na `main` dispara auto-deploy nos 3.

> **Atenção**: `landing-page` foi conectado ao GitHub em 31/03/2026. Antes disso, precisava de redeploy manual.
