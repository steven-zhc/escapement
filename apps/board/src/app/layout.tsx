import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Escapement",
  description: "Event-sourced scheduler for autonomous code agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
