import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Blog Automation Studio', template: '%s · Blog Automation Studio' },
  description: 'Private local dashboard for research-led WordPress drafts.',
  robots: { index: false, follow: false },
};

// Applies the saved/OS theme before paint to avoid a flash.
const themeScript = `(function(){try{var t=localStorage.getItem('bas-theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
