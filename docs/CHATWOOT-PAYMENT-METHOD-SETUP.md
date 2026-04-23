# 📋 Setup Chatwoot — Custom Attributes `payment_method` e `purchase_value`

**Data**: 23/04/2026
**Objetivo**: Permitir rotear Purchase CAPI pro dataset Meta correto (evitar double counting)

---

## 🎯 Por quê

Meta não faz dedup cross-dataset. Se a mesma venda for enviada pros 2 datasets (Pixel LP + WAM), ela conta 2× no Gerenciador de Anúncios → ROAS inflado, CPA deflado, Andromeda AI otimiza com dados errados.

**Solução**: atendente marca *onde* a venda foi finalizada. Código roteia pra UM dataset apenas.

---

## 🛠️ Setup (fazer 1× no Chatwoot)

### Passo 1: Criar Custom Attribute `payment_method`

1. Vai em **Chatwoot** → **Settings** → **Custom Attributes**
2. Clica **"Add Custom Attribute"**
3. Preenche:
   - **Applies to**: `Conversation` (por venda, não por contato)
   - **Display Name**: `Método de Pagamento`
   - **Key**: `payment_method` (case-sensitive — **tem que ser exatamente isso**)
   - **Type**: `List`
   - **List Values** (exatamente 3):
     - `wa_link`
     - `presencial`
     - `outros`
   - **Description** (opcional): `Onde a venda foi finalizada: wa_link = cliente pagou pelo link WhatsApp; presencial = cliente pagou no salão (maquininha); outros = casos excepcionais`
4. **Save**

### Passo 2: Criar Custom Attribute `purchase_value`

1. Mesmo menu → **"Add Custom Attribute"**
2. Preenche:
   - **Applies to**: `Conversation`
   - **Display Name**: `Valor da Venda (R$)`
   - **Key**: `purchase_value` (exatamente)
   - **Type**: `Number`
   - **Description**: `Valor total da venda em reais. Aceita decimais (ex: 497.50 ou 1018.80)`
3. **Save**

---

## 📋 Instruções pra Atendente

### Quando marcar label `compra_realizada`:

**SEMPRE preencher os 2 campos abaixo na conversa** ANTES de aplicar a label:

1. **Método de Pagamento** — escolher da lista:
   - ✅ `wa_link` — cliente pagou pelo link de pagamento via WhatsApp (**padrão ~80% das vendas**)
   - ✅ `presencial` — cliente veio na clínica e pagou na maquininha
   - ✅ `outros` — casos excepcionais (PIX manual, transferência, etc)

2. **Valor da Venda (R$)** — número exato
   - Exemplos válidos: `497`, `1018.80`, `599.40`, `60`
   - **NÃO colocar R$, vírgula ou ponto de milhar** — só o número com ponto decimal

3. **Aplicar label** `compra_realizada`

### Se esquecer de preencher:
- Código tem **fallback automático**: default vai pro **WAM** (80% dos casos está certo)
- Mas a precisão cai de 100% → 80%. **Sempre preencha quando possível**.

---

## 🔧 Configuração Técnica (info pro dev)

### Env vars Vercel (já configuradas, só referência):
- `PURCHASE_ROUTING_ENABLED` — `1` (habilitado, default). Setar `0` pra rollback imediato.

### Lógica de roteamento (código):
```
1. payment_method='presencial' → Pixel LP (action_source=system_generated)
2. payment_method='wa_link'    → WAM (action_source=business_messaging)
3. payment_method='outros'     → Pixel LP (conservador)
4. Se SEM payment_method E ctwa_clid presente → WAM (inferência)
5. Se SEM payment_method E leadgen_id presente → WAM (inferência)
6. Fallback final → WAM (80% dos casos está certo)
```

### Arquivos afetados:
- `api/_lib/purchase-routing.js` — lib de decisão (testada 19/19 tests)
- `api/crm-webhook.js` — integra decisão antes dos sends Meta
- `tests/purchase-routing.test.js` — TDD

### Rollback de emergência:
Se algo der errado: Vercel dashboard → projeto `icelaser-landing` → Settings → Environment Variables → adicionar `PURCHASE_ROUTING_ENABLED=0`. Redeploy automático. Volta ao comportamento antigo (envia aos 2 datasets).

---

## 📊 Impacto esperado

### Antes (status atual)
- Cada Purchase conta 2× nas campanhas que trackam ambos datasets
- ROAS Creative Testing inflado ~2×
- Historical 7d: R$ 5.332 atribuído → real ~R$ 2.666

### Depois
- Purchase conta 1× em 1 dataset específico
- ROAS real = valor real
- Andromeda AI otimiza com dados limpos
- Attribution cross-device continua funcionando (Meta faz match por user_data)

---

## ✅ Validação pós-setup

Depois de criar os 2 custom attributes no Chatwoot:

1. Atendente fecha uma venda teste (real ou simulada)
2. Preenche `payment_method` e `purchase_value` na conversa
3. Aplica label `compra_realizada`
4. Dev verifica nos logs Vercel (`vercel logs`):
   ```
   [CRM-WEBHOOK ROUTING] target=wam reason=payment_method_wa_link payment_method="wa_link"
   [CRM-WEBHOOK] WAM SKIPPED não aparece (correto — ENVIOU pro WAM)
   [CRM-WEBHOOK] Pixel LP SKIPPED (routing → WAM)
   [WAM] ✅ Purchase received=1
   ```
5. Events Manager:
   - WAM dataset: 1 Purchase novo
   - Pixel LP dataset: 0 Purchase novo (não recebeu, correto)

---

## ⚠️ FAQ

**P: E se a venda usa cartão 1x presencial + parcelas via link WA?**
R: Marcar `presencial` (onde a decisão de compra aconteceu fisicamente).

**P: E se cliente veio via CTWA ad mas pagou presencial no salão?**
R: Marcar `presencial`. Meta atribui ao ad via matching de email/phone (não precisa do dataset "correto" pra attribution).

**P: Posso reconfigurar depois?**
R: Sim, zero problema. Custom attributes podem ser editados a qualquer momento sem afetar código.
