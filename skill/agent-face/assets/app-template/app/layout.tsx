import type { Metadata, Viewport } from "next";
import "./globals.css";

const description =
  "A talking, lip-syncing agent face — speak to your agent and watch a 12-emotion particle face reply in real time.";

const siteUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Agent Face",
  description,
  applicationName: "Agent Face",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-dark-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
  },
  openGraph: {
    title: "Agent Face",
    description,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Agent Face" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Face",
    description,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#07070a",
  width: "device-width",
  initialScale: 1,
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
