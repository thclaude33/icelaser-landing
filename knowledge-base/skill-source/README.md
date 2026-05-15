# Skill Source — Bia Vendedora Premium IceLaser

Source canônico LOCAL da skill Anthropic `skill_01VmKCpBmg717nKmCAWgnUYS`.

Mantemos cópia versionada aqui pra:
1. Auditar conteúdo deployed em produção sem precisar probe LIVE
2. Edit + re-upload de novas versões controlado
3. Cron `bia-skill-refresh.js` weekly diff source vs production (alerta drift)

## Estrutura

```
skill-source/
├── README.md                          (este arquivo)
└── bia-vendedora-premium-icelaser/    (root estrutura ZIP)
    └── SKILL.md                        (master file, 13,801 bytes, 283 linhas v4)
```

**Hoje SKILL.md é monolítico (v4)**. Plano original previa 9 chunks separados (persona.md, pricing_reference.md, etc) — consolidados em 1 file.

## State LIVE (15/05/2026)

- skill_id: `skill_01VmKCpBmg717nKmCAWgnUYS`
- display_title: `Bia Vendedora Premium IceLaser`
- latest_version (Anthropic): `1778656778530150` (v4)
- created v4: `2026-05-13T07:19:39Z`
- Agent ref: Coord `agent_018zZxrjHftuiePCuJEUNTqL` v38 (wire up cravado 15/05)

## SKILL UPDATE FLOW (quando Vitória aprovar nova doutrina)

### Pré-requisitos
- `ANTHROPIC_API_KEY_ICELASER` no `.env`
- Beta header: `anthropic-beta: skills-2025-10-02`
- Skill já existe (não cria nova — apenas adiciona nova version)

### Passos

**1. Editar local**

```bash
cd "/Users/grupoice/Desktop/claude/vs code/landing-page/knowledge-base/skill-source"
# Editar bia-vendedora-premium-icelaser/SKILL.md (manter frontmatter YAML)
# Bump version no frontmatter: version: 5.0.0 (ou semver apropriado)
```

**2. Re-zipar preservando estrutura**

```bash
cd "/Users/grupoice/Desktop/claude/vs code/landing-page/knowledge-base/skill-source"
rm -f /tmp/bia-vendedora-premium-icelaser.zip
zip -r /tmp/bia-vendedora-premium-icelaser.zip bia-vendedora-premium-icelaser/
unzip -l /tmp/bia-vendedora-premium-icelaser.zip  # verify estrutura
```

**3. Upload nova version via API**

```bash
KEY=$(grep "^ANTHROPIC_API_KEY_ICELASER=" "/Users/grupoice/Desktop/claude/vs code/.env" | cut -d= -f2-)
curl -X POST "https://api.anthropic.com/v1/skills/skill_01VmKCpBmg717nKmCAWgnUYS/versions" \
  -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: skills-2025-10-02" \
  -F "files[]=@/tmp/bia-vendedora-premium-icelaser.zip" \
  -F "description=v5 — descrever mudanças aqui (ex: ban frase X, novo P8 masculino, etc)"
```

**4. Verificar nova version registrada**

```bash
curl -sS "https://api.anthropic.com/v1/skills/skill_01VmKCpBmg717nKmCAWgnUYS/versions" \
  -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: skills-2025-10-02" | python3 -m json.tool | head -20
```

Esperado: novo entry no topo com `created_at` recente.

**5. Agent picks up auto (sem PATCH Coord)**

`agent.skills[0].version = 'latest'` → Anthropic auto-resolve pra nova version no próximo session.

Se mudou estrutura interna do ZIP (ex: agora tem chunks/), atualizar comando `unzip` no Coord prompt:
```
PATCH Coord vN → vN+1 trocando bash `unzip -p ZIP SKILL.md`
por `unzip -p ZIP 'bia-vendedora-premium-icelaser/*.md'`
```

**6. Smoke validação**

```bash
# Criar session probe + verificar tool_use[0] = unzip + content novo presente
# (ver landing-page/api/bia-direct.js Bearer auth pra dispatch fácil)
```

**7. Update SAB Reference v3.X + Goldfish vYY documentando mudança**

Cravar:
- O que mudou na doutrina (sem skill content sensível em SAB — só diff resumido)
- Quem aprovou (Vitória / CD)
- Data + smoke result
- Atualizar `latest_version` em SAB Reference

## Rollback

Se nova version quebrar produção:

```bash
# Listar versions
curl -sS "https://api.anthropic.com/v1/skills/skill_01VmKCpBmg717nKmCAWgnUYS/versions" \
  -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: skills-2025-10-02" | python3 -m json.tool

# Pegar version anterior (versão NUMÉRICA, ex: 1778656778530150)
OLD_VER="1778656778530150"

# PATCH Coord apontando pra version específica (não 'latest')
# Body skills: [{skill_id: ..., type: 'custom', version: OLD_VER}]
```

Plus: documentar incident em audit-log + Goldfish.

## Diff weekly (FASE 4 cron — opcional)

Cron `api/cron/bia-skill-refresh.js` roda weekly (`30 2 * * *` cravado em `vercel.json`). Refactor:

1. Fetch latest version content via probe session (mesma técnica FASE 0 dump)
2. Compare SHA256 com `skill-source/bia-vendedora-premium-icelaser/SKILL.md` local
3. Se diverge → email alerta `[BIA-SKILL-DRIFT]` (igual padrão FASE 1 sendCriticalAlertOnce, bucket 4h)
4. CD/User vê email → sincroniza (production divergiu OU source local stale)

Pattern defense-in-depth: Vitória pode ter feito upload via API SEM passar pelo flow local. Esse cron pega drift silencioso.
