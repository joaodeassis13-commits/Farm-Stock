import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png', 'logo-visao.png'],
      manifest: {
        name: 'Farm Stock',
        short_name: 'Farm Stock',
        description: 'Controle de estoque de medicamentos e insumos da fazenda',
        theme_color: '#1f4b3a',
        background_color: '#eef1ea',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // App shell (HTML/CSS/JS) sempre disponível offline.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        // Dados do Supabase: tenta a rede primeiro; se falhar (offline),
        // usa a última resposta guardada. Os dados "de verdade" para uso
        // offline continuam vindo do IndexedDB local (ver src/db/local.js) —
        // isto aqui é só uma rede de segurança extra para leituras.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname.endsWith('supabase.co'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api-cache',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 }
            }
          }
        ]
      }
    })
  ]
});
