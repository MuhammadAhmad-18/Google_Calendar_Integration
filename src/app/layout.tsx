import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Chatbeds x Google Calendar", description: "Connect ChatBeds reservations to Google Calendar with secure property connections and one-way synchronization.", robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
