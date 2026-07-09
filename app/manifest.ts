import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'MusicMasher',
    short_name: 'MusicMasher',
    description: 'Drop a song, tap the tiles — a beat-synced rhythm game.',
    start_url: '/',
    display: 'fullscreen',
    orientation: 'portrait',
    background_color: '#07031a',
    theme_color: '#07031a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
