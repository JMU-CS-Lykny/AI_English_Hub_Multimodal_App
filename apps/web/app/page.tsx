import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";

export default function HomePage() {
  return (
    <div className="page-shell h-screen min-h-screen flex flex-col">
      <SiteHeader />
      <main className="flex-1 min-h-0 overflow-auto">
        <section className="hero">
          <span className="hero-badge">EduTech · Việt Nam</span>
          <h1>AI English Hub</h1>
          <p>
            Học tiếng Anh thông minh với AI — cá nhân hóa cho người học Việt Nam.
          </p>
          <Link href="/login" className="btn btn-primary">
            Bắt đầu →
          </Link>
        </section>
      </main>
    </div>
  );
}
