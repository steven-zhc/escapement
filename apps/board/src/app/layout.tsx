import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

/**
 * The typefaces the design asks for, self-hosted.
 *
 * The stylesheet named "IBM Plex Sans" from the start and nothing ever loaded
 * it, so every rule fell through to `system-ui` and the board looked like a
 * different design than the one it was written against.
 *
 * `next/font` rather than a `<link>` to Google: it copies the files into the
 * build, so the board still renders as designed on a machine with no network —
 * which is most of what a local operator console is for.
 */
const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lingtai",
  description: "Event-sourced scheduler for autonomous code agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
