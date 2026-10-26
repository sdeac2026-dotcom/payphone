import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PayPhone — Your phone number is your wallet",
  description:
    "Open, stateless crypto payment infrastructure. Accept any coin from anyone on earth with just their phone number. Rust engine, Next.js console, non-custodial by design.",
  keywords: [
    "crypto payments",
    "payment gateway",
    "phone number payments",
    "stablecoin API",
    "PayPhone",
    "open source",
  ],
  authors: [{ name: "PayPhone Contributors" }],
  openGraph: {
    title: "PayPhone — Your phone number is your wallet",
    description:
      "Accept crypto from anyone on earth with just their phone number. Stateless, non-custodial, open source.",
    siteName: "PayPhone",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen flex flex-col`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
