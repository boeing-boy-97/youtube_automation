import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { Shell } from '@/components/shell';

export const metadata: Metadata = {
  title: 'ClipForge AI',
  description: 'AI video repurposing and automatic social publishing',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
