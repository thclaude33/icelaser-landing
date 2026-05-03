/**
 * IceLaser LP V2 JPA Conversion — tracking + form wire-up
 *
 * Replica fluxo do index.html atual (icelasers.com.br):
 *  - Pixel Meta + Advanced Matching (CAPI dedup via event_id)
 *  - CAPI server-side (/api/track) — Lead + CompleteRegistration
 *  - Edge Config urgencia (vagas + data)
 *  - Vercel Analytics customEvents
 *  - Countdown meia-noite BRT
 *  - WhatsApp deep-link (iOS/Android/web fallback)
 *
 * Tag-format: [LP3-FORM] Olá, vi o anúncio... — segue regex
 *   \[LP[0-9]+(?:-[A-Z0-9]+)*\] do Chatwoot/Kommo
 */

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════
  // CONFIG
  // ════════════════════════════════════════════════════════════════
  window._PIXEL_ID = '1386967056530127'; // IceLaser João Pessoa (Bancários)
  const WA_PHONE = '5583982071540';
  const FORM_TAG = '[LP3-FORM]';
  const FORM_MSG = 'Olá, vi o anúncio e acabei de preencher o formulário pra avaliação.';
  let submitting = false;

  // ════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════
  function getCookie(name) {
    const m = document.cookie.split('; ').find((row) => row.startsWith(name + '='));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
  }

  // Normaliza telefone BR — pra Pixel browser e CAPI server gerarem mesmo sha256.
  // FIX 03/05 v7 (A2): bug com DDDs começando em 5 (51/53/54 RS, 55 SC).
  // Antes: digits.startsWith('5') === false → DDDs com 5 caíam no fallback raw sem 55+
  // Agora: check explícito startsWith('55') pra prefixar quando ausente.
  window._normalizePhoneBR = function normalizePhoneBR(phone) {
    if (!phone) return null;
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length === 11 && !digits.startsWith('55')) return '55' + digits;
    if (digits.length === 10) return '55' + digits;
    if (digits.length === 13 && digits.startsWith('55')) return digits;
    if (digits.length === 12 && digits.startsWith('55')) return digits;
    return digits.length >= 10 ? digits : null;
  };

  function getAdData(key) {
    try {
      const u = new URLSearchParams(location.search);
      return u.get(key) || sessionStorage.getItem('ad_' + key) || null;
    } catch (_) {
      return null;
    }
  }
  function getOrigemFallback() {
    if (location.search.includes('fbclid=') || getCookie('_fbc')) return 'facebook';
    if (document.referrer.includes('instagram.com')) return 'instagram';
    if (document.referrer.includes('facebook.com') || document.referrer.includes('fb.com')) return 'facebook';
    if (document.referrer.includes('google')) return 'google';
    return 'direto';
  }

  // FIX 03/05 v7 (A3): wa.me link já roteia nativamente pro app no mobile.
  // Antes: 2 redirects (whatsapp://+wa.me) causavam race condition iOS Safari/in-app.
  // Agora: 1 navigation pra wa.me — Meta/WhatsApp resolvem deep-link automaticamente.
  function openWhatsApp(msgEncoded) {
    window.location.href = 'https://wa.me/' + WA_PHONE + '?text=' + msgEncoded;
  }

  // FIX 03/05 v7 (A4+A5): sendBeacon retorna false quando payload >64KB ou
  // tab fechando race. Antes: ignorávamos return — events perdidos silent.
  // Agora: warn em console pra observability + outer catch logando.
  function sendCapi(payload) {
    try {
      const url = '/api/track';
      const body = JSON.stringify(payload);
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(function (err) {
        try {
          const sent = navigator.sendBeacon &&
            navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
          if (!sent) {
            console.warn('[CAPI] sendBeacon rejected — event lost', payload.event_name || '?');
          }
        } catch (e) {
          console.warn('[CAPI] beacon fallback failed', e && e.message);
        }
      });
    } catch (e) {
      console.warn('[CAPI] send failed', e && e.message);
    }
  }
  window.sendCapi = sendCapi;

  function trackEvent(name, props) {
    try {
      if (window.va && typeof window.va === 'function') {
        window.va('event', { name, data: props || {} });
      }
    } catch (e) {
      console.warn('[VA] trackEvent failed', e && e.message);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // FORM SUBMIT — handleLead
  // ════════════════════════════════════════════════════════════════
  window.handleLead = function handleLead(event) {
    event.preventDefault();
    if (submitting) return false;

    const form = event.target;
    const elNome = form.elements.nome;
    const elWa = form.elements.wa;
    const elEmail = form.elements.email;
    const elArea = form.elements.area;

    const nome = (elNome.value || '').trim();
    const tel = (elWa.value || '').trim();
    const email = (elEmail.value || '').trim().toLowerCase();
    const area = (elArea && elArea.value) || '';

    let valid = true;
    const nomeParts = nome.split(/\s+/).filter((p) => p.length > 0);
    if (!nome || nomeParts.length < 2) {
      elNome.classList.add('invalid');
      elNome.setAttribute('aria-invalid', 'true');
      valid = false;
    } else {
      elNome.classList.remove('invalid');
      elNome.removeAttribute('aria-invalid');
    }
    if (tel.replace(/\D/g, '').length < 10) {
      elWa.classList.add('invalid');
      elWa.setAttribute('aria-invalid', 'true');
      valid = false;
    } else {
      elWa.classList.remove('invalid');
      elWa.removeAttribute('aria-invalid');
    }
    const emailValid = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailValid) {
      elEmail.classList.add('invalid');
      elEmail.setAttribute('aria-invalid', 'true');
      valid = false;
    } else {
      elEmail.classList.remove('invalid');
      elEmail.removeAttribute('aria-invalid');
    }

    if (!valid) {
      const firstInvalid = elNome.getAttribute('aria-invalid') === 'true' ? elNome
        : elWa.getAttribute('aria-invalid') === 'true' ? elWa
        : elEmail;
      firstInvalid.focus();
      return false;
    }

    submitting = true;
    const submitBtn = document.getElementById('lead-form-submit');
    const originalBtnLabel = submitBtn ? submitBtn.textContent : null;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.style.opacity = '0.6';
      submitBtn.style.cursor = 'wait';
      submitBtn.textContent = 'Enviando…';
    }

    // FIX 03/05 v7 (A1): se Pixel/CAPI/WA throw, submitting fica true e usuário
    // trava sem poder reenviar. Safety net: reset após 8s se ainda submitting,
    // E reset on visibilitychange (caso volte de WhatsApp e queira reenviar).
    function resetSubmitState() {
      submitting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.style.opacity = '';
        submitBtn.style.cursor = '';
        if (originalBtnLabel != null) submitBtn.textContent = originalBtnLabel;
      }
    }
    setTimeout(function () { if (submitting) resetSubmitState(); }, 8000);

    const eventId = 'ev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    const fbp = getCookie('_fbp');
    const fbc = getCookie('_fbc');

    const origemFB = getOrigemFallback();
    const utm = {
      utm_source: getAdData('utm_source') || origemFB,
      utm_medium: getAdData('utm_medium') || (origemFB !== 'direto' ? 'cpc' : undefined),
      utm_campaign: getAdData('utm_campaign') || (origemFB === 'facebook' || origemFB === 'instagram' ? 'sem-utm (Meta Ads)' : undefined),
      utm_content: getAdData('utm_content') || undefined,
      utm_term: getAdData('utm_term') || undefined,
      ad_id: getAdData('ad_id') || undefined,
      ad_name: getAdData('ad_name') || undefined,
      adset_id: getAdData('adset_id') || undefined,
      adset_name: getAdData('adset_name') || undefined,
      campaign_id: getAdData('campaign_id') || undefined,
      campaign_name: getAdData('campaign_name') || (origemFB === 'facebook' || origemFB === 'instagram' ? 'Meta Ads (sem url_tags)' : undefined),
      placement: getAdData('placement') || undefined,
      site_source_name: getAdData('site_source_name') || undefined,
      platform: getAdData('platform') || undefined,
      referrer: document.referrer || undefined,
    };

    const bodyHeight = Math.max(1, document.body.scrollHeight);
    const qualData = {
      screen_width: screen.width,
      screen_height: screen.height,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      referrer: document.referrer || undefined,
      time_on_page: Math.round(performance.now() / 1000),
      scroll_depth: Math.min(100, Math.round(((window.scrollY + window.innerHeight) / bodyHeight) * 100)),
      area_interesse: area || undefined,
      lp_version: 'v2-jpa-conversion',
    };

    const capiData = {
      nome,
      telefone: tel,
      ...(email && { email }),
      event_source_url: location.href,
      client_user_agent: navigator.userAgent,
      fbp,
      fbc,
      ...utm,
      ...qualData,
    };

    // === ADVANCED MATCHING ===
    try {
      const phNormalized = window._normalizePhoneBR(tel);
      const fnPart = nomeParts[0].toLowerCase();
      const lnPart = nomeParts.length > 1 ? nomeParts[nomeParts.length - 1].toLowerCase() : undefined;
      const externalId = email || phNormalized || undefined;
      if (window.fbq) {
        fbq('init', window._PIXEL_ID, {
          em: email || undefined,
          ph: phNormalized,
          fn: fnPart,
          ln: lnPart,
          external_id: externalId,
          country: 'br',
          st: 'pb',
          ct: 'joao pessoa',
          zp: '58051',
          ge: 'f',
        });
      }
      try {
        if (email) localStorage.setItem('ice_em', email);
        if (phNormalized) localStorage.setItem('ice_ph', phNormalized);
        if (fnPart) localStorage.setItem('ice_fn', fnPart);
        if (lnPart) localStorage.setItem('ice_ln', lnPart);
      } catch (_) {}
    } catch (ex) {
      console.warn('[PIXEL AM] re-init failed', ex && ex.message);
    }

    // === PIXEL EVENTS ===
    try {
      if (window.fbq) {
        fbq('track', 'Lead',
          { content_name: 'Avaliacao Gratuita LP V2 JPA', content_category: 'depilacao_laser', value: 0, currency: 'BRL' },
          { eventID: eventId }
        );
        fbq('track', 'CompleteRegistration',
          { content_name: 'Form Submitted V2 JPA', content_category: 'depilacao_laser', value: 0, currency: 'BRL' },
          { eventID: eventId + '_cr' }
        );
      }
    } catch (_) {}

    // === CAPI server-side ===
    window.sendCapi({ event_name: 'Lead', event_id: eventId, ...capiData });
    window.sendCapi({ event_name: 'CompleteRegistration', event_id: eventId + '_cr', ...capiData });

    // === Vercel Analytics ===
    trackEvent('Lead Submit V2 JPA', { lp: 'v2-conversion', area_interesse: area, source: origemFB });

    // === SUCCESS UI + WhatsApp redirect ===
    const msg = encodeURIComponent(
      FORM_TAG + ' ' + FORM_MSG + '\n\n' +
      '*Nome:* ' + nome + '\n' +
      '*WhatsApp:* ' + tel +
      (area ? ('\n*Área de interesse:* ' + area) : '')
    );

    if (submitBtn) {
      submitBtn.textContent = '✓ Enviado! Abrindo WhatsApp…';
      submitBtn.style.background = '#25D366';
    }

    // Reduz vagas dynamic
    document.querySelectorAll('[data-vagas]').forEach((el) => {
      const cur = parseInt(el.textContent, 10) || 3;
      if (cur > 1) el.textContent = String(cur - 1);
    });

    setTimeout(function () { openWhatsApp(msg); }, 350);

    return false;
  };

  // ════════════════════════════════════════════════════════════════
  // EDGE CONFIG — Urgência dinâmica
  // ════════════════════════════════════════════════════════════════
  (async function loadConfig() {
    try {
      const r = await fetch('/api/config');
      if (!r.ok) return;
      const { urgencia_vagas, urgencia_data } = await r.json();
      const safeData = String(urgencia_data || '').replace(/[^\wÀ-ÿ \/\-]/g, '');
      const safeVagas = String(urgencia_vagas || '').replace(/[^\d]/g, '');

      const VAGAS_RE = /(\d+)(?=\s+vagas\s+gratuitas)/g;
      const VALIDO_RE = /válido até [^\s,—.]+ ?[^\s,—.]*/g;
      const targets = document.querySelectorAll('.urgency-bar, [data-urgency]');
      targets.forEach((el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (safeVagas && VAGAS_RE.test(node.nodeValue)) {
            node.nodeValue = node.nodeValue.replace(VAGAS_RE, safeVagas);
            VAGAS_RE.lastIndex = 0;
          }
          if (safeData && VALIDO_RE.test(node.nodeValue)) {
            node.nodeValue = node.nodeValue.replace(VALIDO_RE, 'válido até ' + safeData);
            VALIDO_RE.lastIndex = 0;
          }
        }
      });
    } catch (_) {}
  })();

  // ════════════════════════════════════════════════════════════════
  // SCROLL OBSERVER — Lead Form viewed
  // ════════════════════════════════════════════════════════════════
  (function () {
    const form = document.getElementById('lead-form');
    if (!form) return;
    let tracked = false;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !tracked) {
          tracked = true;
          trackEvent('Scroll ao Formulario V2 JPA');
          obs.disconnect();
        }
      },
      { threshold: 0.5 }
    );
    obs.observe(form);
  })();

  // ════════════════════════════════════════════════════════════════
  // COUNTDOWN — meia-noite BRT
  // FIX 03/05 v7 (A6+A18+A19): try/catch evita que Intl/DOM throw quebre o
  // tick. prefers-reduced-motion respeitado: pausa em motion-safe quando
  // usuário sinaliza redução. visibilitychange pausa quando tab oculta
  // (economiza CPU mobile/bateria).
  // ════════════════════════════════════════════════════════════════
  (function () {
    const timerEls = document.querySelectorAll('[data-countdown], #countdown-timer');
    if (timerEls.length === 0) return;

    const reducedMotion = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function updateAll() {
      try {
        const fmt = new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Recife',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
        const parts = fmt.formatToParts(new Date());
        const h = +parts.find((p) => p.type === 'hour').value;
        const m = +parts.find((p) => p.type === 'minute').value;
        const s = +parts.find((p) => p.type === 'second').value;
        const totalSec = h * 3600 + m * 60 + s;
        const remaining = Math.max(0, 24 * 3600 - totalSec);

        const hh = String(Math.floor(remaining / 3600)).padStart(2, '0');
        const mm = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
        const ss = String(remaining % 60).padStart(2, '0');

        timerEls.forEach((el) => {
          const fmtStr = el.dataset.countdownFormat || 'HH:MM:SS';
          if (fmtStr === 'split') {
            const hSlot = el.querySelector('.h');
            const mSlot = el.querySelector('.m');
            const sSlot = el.querySelector('.s');
            if (hSlot) hSlot.textContent = hh;
            if (mSlot) mSlot.textContent = mm;
            if (sSlot) sSlot.textContent = ss;
          } else {
            el.textContent = hh + ':' + mm + ':' + ss;
          }
        });
      } catch (e) {
        console.warn('[countdown] tick failed', e && e.message);
      }
    }

    updateAll();

    let intervalId = setInterval(updateAll, reducedMotion ? 60000 : 1000);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearInterval(intervalId);
        intervalId = null;
      } else if (!intervalId) {
        updateAll();
        intervalId = setInterval(updateAll, reducedMotion ? 60000 : 1000);
      }
    });
  })();

  // ════════════════════════════════════════════════════════════════
  // INTERCEPTOR GLOBAL — Lead CAPI fire on WhatsApp button clicks
  // ════════════════════════════════════════════════════════════════
  document.addEventListener('click', function (ev) {
    const a = ev.target.closest('a[href*="wa.me"]');
    if (!a) return;

    const href = a.href || '';
    const tagMatch = decodeURIComponent(href).match(/\[LP[0-9]+(?:-[A-Z0-9]+)*\]/);
    const tag = tagMatch ? tagMatch[0] : '[LP-UNKNOWN]';

    // event_name: 'Contact' (não 'Lead') — wa.me click é INTENT, não conversão.
    // 'Lead' fica reservado pra form submit (handleLead). Match com LP atual
    // que só dispara Lead em form submit também.
    const eventId = 'ev_wa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

    try {
      if (window.fbq) {
        fbq('track', 'Contact',
          { content_name: 'WhatsApp Click ' + tag, content_category: 'whatsapp_cta', value: 0, currency: 'BRL' },
          { eventID: eventId }
        );
      }
    } catch (_) {}

    const fbp = getCookie('_fbp');
    const fbc = getCookie('_fbc');
    const origemFB = getOrigemFallback();
    sendCapi({
      event_name: 'Contact',
      event_id: eventId,
      event_source_url: location.href,
      client_user_agent: navigator.userAgent,
      fbp,
      fbc,
      utm_source: getAdData('utm_source') || origemFB,
      cta_tag: tag,
      cta_text: (a.innerText || '').trim().slice(0, 60),
      lp_version: 'v2-jpa-conversion',
    });

    trackEvent('WA Click ' + tag, { tag, lp: 'v2-jpa-conversion' });
  }, true);

})();
