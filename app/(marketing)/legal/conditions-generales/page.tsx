import type { Metadata } from "next";
import { LegalPage, Section, ToFill } from "../_components/LegalPage";

export const metadata: Metadata = {
  title: "Conditions générales de vente — OnlyLive",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Conditions générales de vente"
      updatedNote="Brouillon — non publié."
    >
      <Section heading="1. Objet">
        <p>
          Les présentes conditions générales de vente (CGV) régissent la vente de billets
          d&apos;événements live par OnlyLive directement à ses clients via ce site. OnlyLive est
          le vendeur des billets et le destinataire du paiement.
        </p>
      </Section>

      <Section heading="2. Billets et catégories">
        <p>
          Chaque événement propose plusieurs catégories de billets (par exemple VVIP, VIP,
          Gradins), réparties en phases de vente successives à prix et quantités distincts. Le
          prix et la disponibilité affichés au moment du paiement sont ceux qui s&apos;appliquent ;
          une réservation temporaire est mise de côté le temps du paiement puis libérée si le
          paiement n&apos;est pas finalisé.
        </p>
      </Section>

      <Section heading="3. Commande et paiement">
        <p>
          Un billet n&apos;est confirmé et généré qu&apos;après confirmation du paiement par notre
          prestataire de paiement (ChariPay). Le paiement par carte s&apos;effectue sur une page
          sécurisée fournie par ChariPay ; OnlyLive ne reçoit jamais votre numéro de carte ni votre
          CVV.
        </p>
      </Section>

      <Section heading="4. Livraison du billet">
        <p>
          Le billet est délivré par email dès confirmation du paiement et reste consultable depuis
          votre compte OnlyLive. Chaque billet comporte un code QR dont la validité est vérifiée
          par nos serveurs au moment du scan, et non par le contenu du billet lui-même.
        </p>
      </Section>

      <Section heading="5. Contrôle d'accès">
        <p>
          L&apos;accès à l&apos;événement est soumis à la présentation du billet et à la
          validation de son code QR par le personnel OnlyLive. Un billet déjà scanné, annulé, ou ne
          correspondant pas à l&apos;événement est refusé à l&apos;entrée.
        </p>
      </Section>

      <Section heading="6. Annulation, report, remboursement">
        <p>
          Voir la <a href="/legal/politique-de-remboursement">politique de remboursement</a>{" "}
          dédiée pour les conditions applicables en cas d&apos;annulation ou de report d&apos;un
          événement, ou de remboursement à la demande du client.
        </p>
      </Section>

      <Section heading="7. Limite de commande">
        <p>
          <ToFill>
            confirmer la limite d&apos;achat par client/événement affichée en pratique et toute
            règle anti-fraude/anti-revente à formaliser
          </ToFill>
        </p>
      </Section>

      <Section heading="8. Droit de rétractation">
        <p>
          <ToFill>
            confirmer avec l&apos;avocat si/dans quelle mesure un droit de rétractation
            s&apos;applique à la vente de billets d&apos;événements à date fixe en droit marocain
          </ToFill>
        </p>
      </Section>

      <Section heading="9. Responsabilité">
        <p>
          <ToFill>
            clauses de responsabilité (report/annulation d&apos;événement par l&apos;organisateur,
            force majeure, comportement du client à l&apos;événement) — à rédiger avec
            l&apos;avocat
          </ToFill>
        </p>
      </Section>

      <Section heading="10. Droit applicable et litiges">
        <p>
          <ToFill>
            droit applicable et modalités de résolution des litiges — à déterminer avec
            l&apos;avocat d&apos;OnlyLive
          </ToFill>
        </p>
      </Section>
    </LegalPage>
  );
}
