import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Signal Deck — Solana Intelligence",
  description: "Paper-mode Solana wallet intelligence command center"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return <html lang="en"><body>{children}</body></html>;
}
