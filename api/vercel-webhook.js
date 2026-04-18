/**
 * /api/vercel-webhook — Receptor de Webhooks do Vercel
 * Verifica assinatura HMAC-SHA1, loga no Blob e envia email para eventos críticos
 *
 * Eventos tratados:
 *   deployment.error     → rollback automático + email
 *   deployment.rollback  → email confirmando rollback
 *   deployment.succeeded → log silencioso
 *   firewall.attack      → email urgente de ataque
 *   alerts.triggered     → email de anomalia com métricas
 *   flag.updated         → log silencioso
 *   budget.reached       → email de alerta de gasto
 */

import crypto from 'crypto';
import { put } from '@vercel/blob';
import { escapeHtml, sanitizeHeader, sanitizeUrl } from './_lib/security.js';

const EMAIL_FROM  = process.env.EMAIL_FROM  || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS  = process.env.EMAIL_PASS;
const EMAIL_TO    = (process.env.EMAIL_TO   || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');
const TEAM_ID     = 'team_u7joopjFzcvsDDpcxQX9Oktl';
const PROJECT_ID  = 'prj_K4SFQS6tZsB7ahf5Yny0RsqIPOwb';

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function sendEmail(subject, html) {
  if (!EMAIL_PASS) { console.warn('[EMAIL] EMAIL_PASS não configurado — email ignorado'); return; }
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_FROM, pass: EMAIL_PASS } });
  // sanitizeHeader obrigatório em subject — CVE-2026-32178 e CVE-2021-23400
  // mostram que CRLF em subject permite SMTP command injection (adicionar Bcc:,
  // RCPT TO:, etc). nodemailer valida address mas NÃO subject.
  await t.sendMail({
    from: `"IceLaser Bot" <${EMAIL_FROM}>`,
    to: EMAIL_TO.join(','),
    subject: sanitizeHeader(subject, 200),
    html,
  });
}

function agora() {
  return new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Recife', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Busca o último deploy READY de produção (excluindo o deploy com falha)
async function findLastGoodDeployment(failedDeployId) {
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) return null;

  const url = `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&target=production&state=READY&limit=10`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();

  const deployments = data.deployments || [];
  const good = deployments.find(d => d.uid !== failedDeployId);
  return good || null;
}

// Executa rollback para um deploy específico
async function executeRollback(targetDeployId) {
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) throw new Error('VERCEL_API_TOKEN não configurado');

  const url = `https://api.vercel.com/v9/projects/${PROJECT_ID}/rollback/${targetDeployId}?teamId=${TEAM_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  return await res.json();
}

async function handleEvent(event) {
  const { type, payload } = event;
  const ts = agora();
  const base = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px">`;
  const footer = `<p style="color:#aaa;font-size:12px;margin-top:24px">IceLaser — ${ts}</p></div>`;

  switch (type) {

    case 'deployment.error': {
      const failedId  = payload?.deployment?.id;
      // sanitizeUrl restringe href a http(s)/mailto/tel/whatsapp (previne
      // javascript:/data: XSS se Vercel payload fosse comprometido).
      const deployUrl = sanitizeUrl(payload?.links?.deployment) || '#';
      // escapeHtml + sanitizeHeader pra name (usado em body HTML + subject).
      const name      = escapeHtml(payload?.deployment?.name || 'icelaser-landing');
      const nameHeader = sanitizeHeader(payload?.deployment?.name || 'icelaser-landing', 100);
      const target    = escapeHtml(payload?.target || 'production');

      // Não faz rollback se o próprio deploy falho foi um rollback (evita loop infinito)
      const isRollback = payload?.deployment?.meta?.rollback === true;
      if (isRollback) {
        await sendEmail(
          `🚨 Rollback FALHOU — ${nameHeader}`,
          `${base}
            <h2 style="color:#e94560">🚨 O rollback automático também falhou</h2>
            <p>Intervenção manual necessária.</p>
            <a href="${deployUrl}" style="background:#e94560;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;margin-top:12px">Ver no dashboard</a>
          ${footer}`
        );
        break;
      }

      let rollbackMsg = 'Rollback automático não foi possível (sem deploy anterior disponível).';
      let rollbackOk  = false;

      try {
        const good = await findLastGoodDeployment(failedId);
        if (good) {
          await executeRollback(good.uid);
          // good.uid é alphanumérico Vercel-controlled, seguro; escapeHtml defesa extra.
          const goodUidShort = escapeHtml(String(good.uid).slice(0, 12));
          const goodDate = escapeHtml(new Date(good.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Recife' }));
          rollbackMsg = `✅ Rollback automático iniciado para o deploy anterior (<code>${goodUidShort}…</code> de ${goodDate}).`;
          rollbackOk  = true;
        }
      } catch (e) {
        rollbackMsg = `⚠️ Rollback automático falhou: ${escapeHtml(e.message)}`;
      }

      await sendEmail(
        `🚨 Deploy FALHOU — ${nameHeader}${rollbackOk ? ' (rollback iniciado)' : ''}`,
        `${base}
          <h2 style="color:#e94560">🚨 Deploy falhou — ${name}</h2>
          <p><strong>Ambiente:</strong> ${target}</p>
          <p><strong>Hora:</strong> ${ts}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
          <p>${rollbackMsg}</p>
          <a href="${deployUrl}" style="background:#e94560;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;margin-top:12px">Ver deploy no dashboard</a>
        ${footer}`
      );
      break;
    }

    case 'deployment.rollback': {
      // slice(0,12) + escapeHtml: double-layer defesa contra payloads anômalos.
      const fromShort = escapeHtml(String(payload?.fromDeploymentId || '?').slice(0, 12));
      const toShort   = escapeHtml(String(payload?.toDeploymentId   || '?').slice(0, 12));
      await sendEmail(
        `↩️ Rollback concluído — icelaser-landing`,
        `${base}
          <h2 style="color:#25D366">↩️ Site restaurado com sucesso</h2>
          <p>O rollback automático foi concluído. O site voltou ao deploy anterior.</p>
          <p><strong>De:</strong> <code>${fromShort}…</code></p>
          <p><strong>Para:</strong> <code>${toShort}…</code></p>
          <p><strong>Hora:</strong> ${ts}</p>
        ${footer}`
      );
      break;
    }

    case 'firewall.attack': {
      const proj = escapeHtml(payload?.projectSlug || 'icelaser-landing');
      const projHeader = sanitizeHeader(payload?.projectSlug || 'icelaser-landing', 100);
      await sendEmail(
        `🔴 ATAQUE DETECTADO — ${projHeader}`,
        `${base}
          <h2 style="color:#e94560">🔴 Ataque detectado e mitigado pelo Vercel WAF</h2>
          <p><strong>Projeto:</strong> ${proj}</p>
          <p><strong>Hora:</strong> ${ts}</p>
          <p>O Vercel detectou e bloqueou automaticamente.</p>
          <a href="https://vercel.com/thclaude33s-projects/icelaser-landing/security" style="background:#e94560;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;margin-top:12px">Ver Firewall Dashboard</a>
        ${footer}`
      );
      break;
    }

    case 'alerts.triggered': {
      const alerts  = payload?.alerts || [];
      // sanitizeUrl + fallback: previne javascript: href se payload comprometido.
      const dashUrl = sanitizeUrl(payload?.links?.observability)
        || 'https://vercel.com/thclaude33s-projects/icelaser-landing/observability';
      const proj    = escapeHtml(payload?.projectSlug || 'icelaser-landing');
      const linhas  = alerts.map(a =>
        `<tr>
          <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(a.title || a.type || '—')}</td>
          <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(a.metric || '—')}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;color:#e94560">${a.zscore != null ? escapeHtml(a.zscore.toFixed(1)) + 'σ' : '—'}</td>
          <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(String(a.count ?? '—'))}</td>
        </tr>`
      ).join('');
      await sendEmail(
        `⚠️ Alerta de performance — IceLaser`,
        `${base}
          <h2 style="color:#f59e0b">⚠️ Anomalia detectada</h2>
          <p><strong>Projeto:</strong> ${proj}</p>
          <table style="width:100%;border-collapse:collapse;margin-top:12px">
            <thead>
              <tr style="background:#1a1a2e;color:#fff">
                <th style="padding:8px;text-align:left">Alerta</th>
                <th style="padding:8px;text-align:left">Métrica</th>
                <th style="padding:8px;text-align:left">Z-score</th>
                <th style="padding:8px;text-align:left">Contagem</th>
              </tr>
            </thead>
            <tbody>${linhas || '<tr><td colspan="4" style="padding:8px">Sem detalhes</td></tr>'}</tbody>
          </table>
          <a href="${dashUrl}" style="background:#f59e0b;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;margin-top:16px">Ver Observability</a>
        ${footer}`
      );
      break;
    }

    case 'budget.reached': {
      await sendEmail(
        `💰 Limite de orçamento atingido — Vercel`,
        `${base}
          <h2 style="color:#f59e0b">💰 Limite de gasto atingido no Vercel</h2>
          <p>O projeto IceLaser atingiu o limite de orçamento configurado.</p>
          <p><strong>Hora:</strong> ${ts}</p>
          <a href="https://vercel.com/thclaude33s-projects/settings/billing" style="background:#f59e0b;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;margin-top:12px">Ver Billing</a>
        ${footer}`
      );
      break;
    }

    // Silenciosos — só logam no Blob
    case 'deployment.succeeded':
    case 'flag.updated':
    default:
      break;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);

  // Verifica assinatura HMAC-SHA1 (obrigatório — rejeita se segredo não configurado)
  const secret = process.env.VERCEL_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[WEBHOOK] VERCEL_WEBHOOK_SECRET não configurado — rejeitando request');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  const sig      = req.headers['x-vercel-signature'] || '';
  const expected = crypto.createHmac('sha1', secret).update(rawBody).digest('hex');
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Loga no Blob (assíncrono, não bloqueia a resposta).
  // access:'private' — webhooks contêm deploymentId, urls, projeto (não super sensível
  // mas não precisa ser público); seguindo mesmo pattern da 19ª pass (log-drain).
  // cacheControlMaxAge:0 — webhook logs não precisam CDN cache.
  const ts       = new Date().toISOString().replace(/[:.]/g, '-');
  // event.type pode conter caracteres exóticos se payload corrompido — sanitize pathname.
  const safeType = String(event.type || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const fileName = `webhooks/${safeType}/${ts}.json`;
  put(fileName, rawBody, {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: true,
    cacheControlMaxAge: 0,
  }).catch(() => {});

  // Processa o evento
  handleEvent(event).catch(err => console.error('[WEBHOOK]', event?.type, err.message));

  // Responde imediatamente (processamento é assíncrono)
  return res.status(200).json({ ok: true });
}
