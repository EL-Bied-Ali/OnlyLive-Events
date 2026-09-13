import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OnlyLive",
  description: "OnlyLive — billetterie officielle des événements live au Maroc",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
