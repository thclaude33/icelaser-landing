# 🎯 V2 JP — Plano completo 6 ads NEW (3 IMG + 3 VID)

> Status: **PRONTO PARA APROVAÇÃO** — nada criado, tudo LIVE-validated.
> Estratégia: refresh creative pra atacar fadiga V1 JP (premium-jp concentrou 96% spend hoje + CPL R$47 vs baseline R$13).

---

## §1 IDs Bancarios (LIVE confirmado)

```
Ad Account:       act_26473489532272684 ("icelaser Bancarios")
Campaign V1:      120240879814810656 ("V1-JP-BANC-TRF | Traffic → IG Direct")
Adset V1:         120240881253850656 ("Bancários | Creative Testing — IG Direct (Page Nova)")
Page JP:          1077786125420191 ("Espaço Ice Laser Jp")
Instagram:        17841413126806618 (@espacoicelaser)
Pixel JP:         1386967056530127
WAM Dataset:      NONE (JP não tem WhatsApp ainda — chip pendente)
App ID:           940244045396548
Messenger Page:   102639299252970 (no tracking_specs, legacy/secondary)
Camp budget:      R$ 238/d
Camp objective:   OUTCOME_TRAFFIC
Adset destination: INSTAGRAM_DIRECT
Adset opt_goal:   CONVERSATIONS
```

## §2 Estrutura proposta — 2 opções

### Opção A — Adicionar 6 ads dentro adset V1 EXISTENTE ⭐ recomendado

- 6 ads novos somam aos 9 ATIVOS atuais (1 PAUSED hoje = premium-jp)
- Compartilha learning V1 (Andromeda já aprendeu o público)
- Mais rápido + zero risco de quebrar separação
- Após Andromeda explorar 3-7d, pausar V1 ads que não performam (manter top 3 + os 6 novos)

### Opção B — Criar nova campaign V2-JP-BANC paralela
- Espelha V3 Recife (paralelo challenger)
- Aprendizado independente (Andromeda do zero pros 6)
- Mais lento, mas comparável A/B
- Requer duplicar campaign+adset+budget

**Recomendo A** — JP volume é menor, perder learning V1 atrasa muito. Pode dividir budget naturalmente entre 15 ads no adset existente.

---

## §3 6 Ads spec — assets confirmados LIVE

### 3 IMGs (banner 1080x1920 — refresh visual vs 1080x1350 atual V1)

| # | slug | image_hash | Produto | Hook |
|---|---|---|---|---|
| 1 | v2-jp-01-rosto-img | `43f2a75627e7669fa8f3587999aabff2` | Rosto Completo R$49,90 | Self-care |
| 2 | v2-jp-02-virilha-axilas-img | `b60738bae30c0a7715371804468d3839` | Virilha+Axilas R$54,90 | Confidence |
| 3 | v2-jp-03-gluteos-img | `4af85382b4d2af8792666a9b81f18e0d` | Glúteos R$39,90 | Investment |

### 3 VIDs (reusam video_ids dos top performers V1 JP)

| # | slug | video_id | Produto | Hook | CPL ref 7d V1 |
|---|---|---|---|---|---|
| 4 | v2-jp-04-rosto-vid | `1630912668114526` | Rosto Completo | Pain→Solution | R$ 4,63 ⭐ campeão |
| 5 | v2-jp-05-virilha-axilas-vid | `951238960843103` | Virilha+Axilas | Comparison | R$ 12,51 |
| 6 | v2-jp-06-gluteos-vid | `1733468314671753` | Glúteos | Tech premium | R$ 19,80 |

**Por que esses 3 produtos?** Top 3 performers V1 7d (rosto, virilha-axilas, gluteos). Excluí pernas-completas (0 leads 7d) e premium-jp (já fadigado).

---

## §4 6 Copys NOVAS — hooks frescos (DIFERENTES dos V1 atuais)

### V1 atual hook fórmula (todas iguais)
> "Depilação a laser na clínica IceLaser Bancários — JP. Pacote X sessões por 12× R$ XX,XX. Avaliação..."

### V2 NEW — 6 hooks distintos

#### 1. IMG ROSTO — Self-care
> Sua pele merece esse cuidado. Adeus à irritação da cera no buço — Laser Rosto Completo: 10 sessões 12x R$ 49,90. IceLaser Bancários, JP. 💆‍♀️

#### 2. IMG VIRILHA+AXILAS — Confidence
> Aquela liberdade de usar biquíni e lingerie sem se preocupar com pelos. Virilha + Perianal + Axilas em 30 sessões 12x R$ 54,90. IceLaser JP. 👙

#### 3. IMG GLÚTEOS — Investment
> Cera por 5 anos = R$ 6.000 no salão. Laser Glúteos: 10 sessões 12x R$ 39,90 e acabou. Faz a conta. 💎

#### 4. VID ROSTO — Pain→Solution
> Cansada de pele irritada e pelos encravados depois da cera no buço? Laser Rosto Completo: 10 sessões e os pelos somem pra sempre. 12x R$ 49,90. IceLaser JP. 🌸

#### 5. VID VIRILHA+AXILAS — Comparison
> 5 anos no salão = mais de R$ 6.000 jogados na cera. Laser Virilha + Perianal + Axilas: 30 sessões 12x R$ 54,90 e nunca mais. IceLaser JP. 💎

#### 6. VID GLÚTEOS — Tech Premium
> Tecnologia Laser Crystal 3D Plus em João Pessoa. Glúteos lisos sem dor, com refrigeração ativa. 10 sessões 12x R$ 39,90. Avaliação grátis. ❄️

---

## §5 Receita 17 flags v25 (idêntica V3 Recife)

### IMG (17 flags)
```
GLOBAIS (7):  advantage_plus_creative, enhance_cta, generate_cta, pac_relaxation,
              profile_card, show_destination_blurbs, show_summary
IMAGE (5):    adapt_to_placement, image_templates, image_touchups, image_animation, multi_photo_to_video
TEXTO (3):    text_optimizations, text_overlay_translation, text_translation
ENGAGE (2):   inline_comment, biz_ai
```

### VID (17 flags)
```
GLOBAIS (7):  iguais
VIDEO (5):    video_auto_crop, ig_video_native_subtitle, video_highlights, video_to_image, translate_voiceover
TEXTO (3):    iguais
ENGAGE (2):   iguais
```

⚠️ Bug-aware: VIDs vão passar `image_hash` do banner correspondente (sem `image_url`) pra evitar 1443051. Meta provavelmente filtrará `biz_ai` + `text_translation` + `video_to_image` por eligibility (igual V3 Recife).

---

## §6 Tracking_specs canônico JP — 10 entries (LIVE de V1)

```python
TRACKING_SPECS_JP = [
    {"action.type":["onsite_conversion"]},
    {"action.type":["messenger"], "page":["102639299252970"]},
    {"action.type":["app_custom_event"], "application":["940244045396548"]},
    {"action.type":["leadgen_quality_conversion"], "fb_pixel":["1386967056530127"]},
    {"action.type":["offsite_conversion"], "fb_pixel":["1386967056530127"]},
    {"action.type":["onsite_conversion"], "conversion_id":[
        "25898324599844797","26476349858712174","26556605937302014","26573146235640954",
        "26618012821198719","26765404779759784","27080947944870719","27435006369436733",
        "35038941505749516","35200277926285878"
    ]},
    {"action.type":["post_interaction_gross"], "page":["1077786125420191"], "post":["<NEW_POST_ID>"]},
    {"action.type":["link_click"], "post":["<NEW_POST_ID>"], "post.wall":["1077786125420191"]},
    {"action.type":["one_pd_landing_page_view"], "post":["<NEW_POST_ID>"], "post.wall":["1077786125420191"]},
    {"action.type":["post_engagement"], "page":["1077786125420191"], "post":["<NEW_POST_ID>"]},
]
```

⚠️ JP **NÃO tem WAM dataset** (chip pendente) → tracking sem `offsite_conversion + WAM`. Apenas Pixel JP. 10 entries (vs 13 Recife).

---

## §7 Diff vs V3 Recife (referência)

| Spec | V3 Recife | V2 JP NEW |
|---|---|---|
| destination | WHATSAPP | **INSTAGRAM_DIRECT** |
| CTA | WHATSAPP_MESSAGE | **INSTAGRAM_MESSAGE** |
| Page | 111790301665816 | **1077786125420191** |
| IG | 17841440124641162 (@icelaserrecife) | **17841413126806618 (@espacoicelaser)** |
| Pixel | 2774496306216737 | **1386967056530127** |
| WAM | 967048725669499 | **NONE** |
| Conv IDs | 10 (Recife) | **10 (JP, diferentes)** |
| Tracking entries | 13 VID / 11 IMG | **10 VID & IMG** |
| Link CTA | api.whatsapp.com/send | **(sem — IG_DIRECT abre DM)** |
| Receita flags | 17 | 17 |
| objective camp | OUTCOME_ENGAGEMENT | OUTCOME_TRAFFIC (existente) |
| budget | R$ 117/d (CBO) | R$ 238/d (existente, compartilhado) |

---

## §8 Ordem de criação API (quando aprovado)

```
PRÉ-CHECK:
  ☐ Confirmação user "ativa" pra cada step

FASE 1 — CRIAÇÃO (PAUSED):
  Step 1. POST /act_26473489532272684/adcreatives × 3 IMG (link_data, image_hash, message)
          → retorna 3 creative_ids + 3 effective_object_story_ids (POST_IDs)
  Step 2. POST /act_X/adcreatives × 3 VID (video_data, video_id, image_hash, message — SEM image_url)
          → retorna 3 creative_ids + 3 POST_IDs
  Step 3. POST /act_X/ads × 6 (creative_id + adset_id 120240881253850656 + tracking_specs)
          → 6 ads PAUSED dentro do adset V1 existente

FASE 2 — QA:
  Step 4. GET /ad_id/previews × 2 amostras
  Step 5. GET tracking_specs counts (esperado 10 entries cada)
  Step 6. PARO pra você visualizar antes ativar

FASE 3 — ATIVAÇÃO (após "ativa"):
  Step 7. PATCH 6 ads status=ACTIVE
          (NÃO mexer em campaign nem adset — já estão ACTIVE)

PÓS-ATIVAÇÃO:
  Step 8. Monitorar 4-6h: Andromeda redistribui spend?
  Step 9. D+1: comparar CPL V2 ads vs V1 ads
  Step 10. D+3: decidir pausar V1 underperformers
```

---

## §9 Checklist pré-aprovação

| Check | Status |
|---|---|
| Conta Bancarios correta (act_26473489532272684) | ✅ |
| Page JP 1077786125420191 | ✅ |
| IG @espacoicelaser 17841413126806618 | ✅ |
| Pixel JP 1386967056530127 | ✅ |
| WAM NONE confirmado (chip JP pendente) | ✅ |
| 3 IMG hashes 1080x1920 banner valid | ✅ |
| 3 VID ids existentes em V1 confirmados | ✅ |
| 6 copys NOVAS escritas (hooks distintos V1) | ✅ |
| Receita 17 flags v25 | ✅ |
| Tracking 10 entries canônico V1 LIVE | ✅ |
| Adset V1 existente (não criar novo) | ✅ Opção A |
| destination INSTAGRAM_DIRECT (não WhatsApp) | ✅ |
| CTA INSTAGRAM_MESSAGE | ✅ |
| Status criação PAUSED | ✅ |
| Bug image_url+image_hash evitado | ✅ |
| ZERO criação API até user aprovar | ✅ |

---

## §10 Decisões pendentes pra você quando voltar

🔵 **Opção A vs B**: dentro adset V1 existente OU nova campaign V2-JP paralela?
   → Recomendo **A** (mais rápido, compartilha learning V1)

🔵 **6 copys aprovadas?** Quer ajustar alguma específica?

🔵 **3 produtos selecionados (rosto + virilha-axilas + gluteos)** OK?
   → Excluí pernas-completas (0 leads 7d) e premium (fadigado)

🔵 **Após aprovar**: eu executo Fase 1 (criar PAUSED) → mostra previews → você aprova ATIVAR → Fase 3

---

**Comando pra eu seguir**: "vai cria v2 jp" (ou "vai opção A" / "vai opção B")
**Comando pra ajustar**: me diz o que mudar
