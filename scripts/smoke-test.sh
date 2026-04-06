#!/usr/bin/env bash
# smoke-test.sh — Verifica se a landing page da IceLaser está funcionando
# Uso: ./scripts/smoke-test.sh [URL]
# Exemplo: ./scripts/smoke-test.sh https://icelasers.com.br
# Default:  https://icelasers.com.br

URL="${1:-https://icelasers.com.br}"
PASS=0
FAIL=0

green()  { echo -e "\033[32m✅ $1\033[0m"; PASS=$((PASS+1)); }
red()    { echo -e "\033[31m❌ $1\033[0m"; FAIL=$((FAIL+1)); }
yellow() { echo -e "\033[33m⚠️  $1\033[0m"; }
bold()   { echo -e "\n\033[1m$1\033[0m"; }

check_contains() {
  local desc="$1"; local result="$2"; local expected="$3"
  if echo "$result" | grep -qE "$expected"; then
    green "$desc"
  else
    red "$desc (esperado: '$expected', obtido: '${result:0:100}')"
  fi
}

check_eq() {
  local desc="$1"; local result="$2"; local expected="$3"
  if [ "$result" = "$expected" ]; then
    green "$desc"
  else
    red "$desc (esperado: '$expected', obtido: '${result:0:100}')"
  fi
}

bold "🔍 IceLaser Smoke Test — $URL"
echo "$(date '+%d/%m/%Y %H:%M:%S')"

# 1. Health check da API (sem browser)
bold "1. API Health"
health=$(curl -sf "$URL/api/health" 2>/dev/null || echo "ERRO")
check_contains "GET /api/health retorna ok:true" "$health" '"ok":true'

# 2. Edge Config
bold "2. Edge Config"
config=$(curl -sf "$URL/api/config" 2>/dev/null || echo "ERRO")
check_contains "GET /api/config responde com dados" "$config" "urgencia|vagas|\{\"urgencia"

# 3. Abre a landing page
bold "3. Landing Page (browser)"
agent-browser open "$URL" 2>/dev/null
sleep 3

# Snapshot para verificar que a página carregou
snap=$(agent-browser snapshot 2>/dev/null || echo "")
check_contains "Página carregou e tem conteúdo" "$snap" "ref=|link|heading|button"

# 4. Elementos críticos via eval
bold "4. Elementos críticos"

title=$(agent-browser eval "document.title" 2>/dev/null || echo "")
check_contains "Title contém IceLaser/Laser" "$title" "[Ll]aser|IceLaser"

pixel=$(agent-browser eval "typeof fbq !== 'undefined' ? 'ok' : 'missing'" 2>/dev/null || echo "")
check_eq "Meta Pixel (fbq) carregou" "$pixel" "\"ok\""

tel_exists=$(agent-browser eval "!!document.getElementById('tel')" 2>/dev/null || echo "")
check_eq "Campo de telefone (#tel) existe" "$tel_exists" "true"

wa_btns=$(agent-browser eval "document.querySelectorAll('[href*=\"whatsapp\"]').length" 2>/dev/null || echo "0")
check_contains "Botões WhatsApp existem (>0)" "$wa_btns" "[1-9]"

vagas=$(agent-browser eval "document.getElementById('vagas')?.textContent || 'missing'" 2>/dev/null || echo "")
check_contains "Contador de vagas tem número" "$vagas" "[0-9]"

timer=$(agent-browser eval "document.getElementById('countdown-timer')?.textContent || 'missing'" 2>/dev/null || echo "")
check_contains "Countdown timer presente" "$timer" "[0-9]"

# 5. Form — verifica que o campo de nome existe
bold "5. Formulário"
nome_exists=$(agent-browser eval "!!document.getElementById('nome')" 2>/dev/null || echo "")
check_eq "Campo nome (#nome) existe" "$nome_exists" "true"

autocomplete_tel=$(agent-browser eval "document.getElementById('tel')?.getAttribute('autocomplete') || 'missing'" 2>/dev/null || echo "")
check_eq "Campo tel tem autocomplete=tel" "$autocomplete_tel" "\"tel\""

# 6. Performance básica
bold "6. Performance"
touch_action=$(agent-browser eval "
  const btn = document.querySelector('.btn-wa-hero');
  btn ? (getComputedStyle(btn).touchAction || 'none') : 'missing'
" 2>/dev/null || echo "")
check_contains "touch-action: manipulation no btn WA" "$touch_action" "manipulation"

reduced_motion=$(agent-browser eval "
  const style = document.querySelector('style');
  style?.textContent?.includes('prefers-reduced-motion') ? 'ok' : 'missing'
" 2>/dev/null || echo "")
check_contains "prefers-reduced-motion no CSS" "$reduced_motion" "ok"

# 7. Screenshot de evidência
bold "7. Screenshot"
SCREENSHOT="/tmp/icelaser-smoke-$(date '+%Y%m%d-%H%M%S').png"
if agent-browser screenshot "$SCREENSHOT" 2>/dev/null; then
  green "Screenshot salvo: $SCREENSHOT"
else
  yellow "Screenshot falhou (não crítico)"
fi

# Fecha o browser
agent-browser close 2>/dev/null || true

# Resultado final
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "\033[1mResultado: $PASS passou | $FAIL falhou\033[0m"
echo ""

if [ $FAIL -eq 0 ]; then
  echo -e "\033[32m\033[1m🚀 LP OK — tudo funcionando!\033[0m"
  exit 0
else
  echo -e "\033[31m\033[1m⚠️  $FAIL verificação(ões) falharam\033[0m"
  exit 1
fi
