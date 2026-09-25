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
    <main className="legal-page">
      <header className="legal-header">
        <Link href="/" className="live-brand" aria-label="OnlyLive — accueil">
          <span className="live-brand-mark" aria-hidden="true">OL</span>
          <span>OnlyLive</span>
        </Link>
        <Link href="/" className="legal-back">← Retour à l&apos;accueil</Link>
      </header>

      <div className="legal-heading">
        <p>Informations OnlyLive</p>
        <h1>{title}</h1>
        <span>{updatedNote}</span>
      </div>

      <div role="note" className="legal-draft-note">
        <strong>Document provisoire — ne pas utiliser en production.</strong> Ce texte est un
        modèle de structure généré pour préparer la publication de ce document. Il ne constitue
        pas un avis juridique et doit être relu, complété et validé par un avocat et/ou
        l&apos;expert-comptable d&apos;OnlyLive avant toute mise en ligne publique. Les passages
        marqués <code>[À COMPLÉTER]</code> nécessitent une décision ou une information que ce
        modèle n&apos;invente pas.
      </div>

      <article className="legal-content">{children}</article>

      <nav className="legal-navigation" aria-label="Documents légaux">
        <p>Autres documents</p>
        <ul>
          {LEGAL_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href}>{link.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}

export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="legal-section">
      <h2>{heading}</h2>
      <div>{children}</div>
    </section>
  );
}

export function ToFill({ children }: { children: React.ReactNode }) {
  return (
    <span className="legal-to-fill">
      [À COMPLÉTER : {children}]
    </span>
  );
}
