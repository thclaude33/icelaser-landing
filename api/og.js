/**
 * /api/og — Gera OG Image dinâmica 1200x630
 * Uso: /api/og?titulo=Depilação+Laser&sub=Primeira+sessão+grátis
 * Cache: 24h no CDN
 */

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

export default function handler(req) {
  const { searchParams } = new URL(req.url);
  const titulo = (searchParams.get('titulo') || 'Depilação Laser Definitiva').slice(0, 80);
  const sub    = (searchParams.get('sub')    || 'Avaliação 100% gratuita — Recife, Graças').slice(0, 120);

  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 55%, #0f3460 100%)',
          fontFamily: 'sans-serif',
          padding: '60px',
          position: 'relative',
        },
        children: [
          // Badge topo
          {
            type: 'div',
            props: {
              style: {
                fontSize: 18,
                letterSpacing: 5,
                color: '#e94560',
                marginBottom: 28,
                textTransform: 'uppercase',
                fontWeight: 700,
              },
              children: '✨ ICELASER RECIFE',
            },
          },
          // Título principal
          {
            type: 'div',
            props: {
              style: {
                fontSize: 58,
                fontWeight: 900,
                color: '#ffffff',
                textAlign: 'center',
                lineHeight: 1.15,
                marginBottom: 24,
                maxWidth: 900,
              },
              children: titulo,
            },
          },
          // Subtítulo
          {
            type: 'div',
            props: {
              style: {
                fontSize: 26,
                color: '#a0b0c8',
                textAlign: 'center',
                marginBottom: 40,
                maxWidth: 700,
              },
              children: sub,
            },
          },
          // Badges de prova social
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                gap: 20,
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      background: 'rgba(255,255,255,0.1)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: 50,
                      padding: '10px 22px',
                      fontSize: 18,
                      color: '#fff',
                    },
                    children: '⭐ 5 estrelas Google',
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      background: 'rgba(255,255,255,0.1)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: 50,
                      padding: '10px 22px',
                      fontSize: 18,
                      color: '#fff',
                    },
                    children: '👥 3.000+ clientes',
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      background: 'rgba(233,69,96,0.15)',
                      border: '1px solid #e94560',
                      borderRadius: 50,
                      padding: '10px 22px',
                      fontSize: 18,
                      color: '#e94560',
                      fontWeight: 700,
                    },
                    children: '🎁 1ª sessão GRÁTIS',
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
      },
    }
  );
}
