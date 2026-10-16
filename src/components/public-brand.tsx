import Link from "next/link";

export function PublicBrand({ name = "Chatbeds x Google Calendar" }: { name?: string }) {
  return <Link href="/" className="brand public-brand" aria-label={`${name} home`}>
    <span className="brand-mark" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3.5" y="5.5" width="17" height="15" rx="3" stroke="currentColor" strokeWidth="1.6"/><path d="M8 3v5m8-5v5M4 11h16m-12 5 2 2 6-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg></span>
    <div><strong>{name}</strong><span>ChatBeds → Google Calendar</span></div>
  </Link>;
}

export function PublicHeader({ name }: { name: string }) {
  return <header className="topbar public-topbar"><PublicBrand name={name}/><nav className="public-nav" aria-label="Main navigation"><Link href="/setup">How it works</Link><Link href="/login" className="button secondary compact">Sign in <span aria-hidden="true">↗</span></Link></nav></header>;
}

export function PublicFooter({ name }: { name: string }) {
  return <footer className="public-footer"><div><strong>{name}</strong><span>One-way reservation synchronization.</span></div><nav aria-label="Footer navigation"><Link href="/setup">Hotel guide</Link><Link href="/support">Support</Link><Link href="/privacy">Privacy</Link></nav></footer>;
}
