import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Nexus — Your private gateway',
  description:
    'A familiar place for a few good friends. Private channels, whispers, and a little nostalgia.',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
