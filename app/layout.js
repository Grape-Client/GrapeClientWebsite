export const metadata = {
  title: 'Grape',
  description: 'Grape: write Java scripts for Minecraft, inject them into the game, and manage clients and mods in one window.',
  icons: { icon: '/grape/logo.png' },
};

export const viewport = { themeColor: '#0e0e0e' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
