import type { Metadata, Viewport } from 'next';
import RegisterSW from '@/components/RegisterSW';
import './globals.css';

export const metadata: Metadata = {
  title: 'MusicMasher',
  description:
    'Drop an MP3, tap the tiles. A beat-synced rhythm game for any song.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#07031a',
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
