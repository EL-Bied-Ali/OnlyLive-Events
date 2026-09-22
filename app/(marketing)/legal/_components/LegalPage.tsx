import Link from "next/link";

const LEGAL_LINKS = [
  { href: "/legal/mentions-legales", label: "Mentions légales" },
  { href: "/legal/conditions-generales", label: "Conditions générales de vente" },
  { href: "/legal/politique-de-confidentialite", label: "Politique de confidentialité" },
  { href: "/legal/politique-de-remboursement", label: "Politique de remboursement" },
] as const;

export function LegalPage({
  title,
  updatedNote,
  children,
}: {
  title: string;
  updatedNote: string;
  children: React.ReactNode;
}) {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 16px 96px" }}>
      <p style={{ marginBottom: 24 }}>
        <Link href="/" style={{ textDecoration: "none", opacity: 0.7 }}>
          ← Retour à l&apos;accueil
        </Link>
      </p>

      <div
        role="note"
        style={{
          border: "1px solid #7a5b00",
          background: "#3a2c00",
          color: "#ffd875",
          borderRadius: 8,
          padding: "12px 16px",
          marginBottom: 32,
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        <strong>Document provisoire — ne pas utiliser en production.</strong> Ce texte est un
        modèle de structure généré pour préparer la publication de ce document. Il ne constitue
        pas un avis juridique et doit être relu, complété et validé par un avocat et/ou
        l&apos;expert-comptable d&apos;OnlyLive avant toute mise en ligne publique. Les passages
        marqués <code>[À COMPLÉTER]</code> nécessitent une décision ou une information que ce
        modèle n&apos;invente pas.
      </div>

      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>{title}</h1>
      <p style={{ opacity: 0.7, marginBottom: 32, fontSize: 14 }}>{updatedNote}</p>

      <div style={{ display: "grid", gap: 20, lineHeight: 1.6 }}>{children}</div>

      <nav style={{ marginTop: 48, paddingTop: 24, borderTop: "1px solid #333" }}>
        <ul style={{ listStyle: "none", padding: 0, display: "flex", gap: 16, flexWrap: "wrap" }}>
          {LEGAL_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} style={{ fontSize: 14, opacity: 0.8 }}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}

export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{heading}</h2>
      <div style={{ opacity: 0.9 }}>{children}</div>
    </section>
  );
}

export function ToFill({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ background: "#3a2c00", color: "#ffd875", padding: "1px 6px", borderRadius: 4 }}>
      [À COMPLÉTER : {children}]
    </span>
  );
}
