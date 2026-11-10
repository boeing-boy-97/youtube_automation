import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { Shell } from '@/components/shell';

export const metadata: Metadata = {
  title: 'ClipForge AI',
  description: 'AI video repurposing and automatic social publishing',
  applicationName: 'ClipForge AI',
  formatDetection: { telephone: false },
};

// Mobile-first viewport: honour notches (viewportFit: cover) but never block pinch-zoom.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
