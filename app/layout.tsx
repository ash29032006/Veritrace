import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Veritrace", template: "%s · Veritrace" },
  description: "Batch provenance and recall cascade engine",
};

export const viewport: Viewport = {
  themeColor: "#f4f0fd",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
