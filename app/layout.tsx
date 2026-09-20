import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Japlan",
  description: "Everywhere, together.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
