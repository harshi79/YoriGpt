import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YoriGPT",
  description: "A little space for big ideas. YoriGPT chat interface preview.",
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
