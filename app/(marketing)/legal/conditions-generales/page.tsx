import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { legalDocumentsApproved } from "@/lib/legal/approval";
import { LegalPage, Section, ToFill } from "../_components/LegalPage";

export const metadata: Metadata = {
  title: "Conditions générales de vente — OnlyLive",
  robots: { index: false, follow: false },
};

export default function TermsPage() {
  if (!legalDocumentsApproved()) notFound();

  return (
    <LegalPage
      title="Conditions générales de vente"
      updatedNote="Brouillon — non publié."
    >
      <Section heading="1. Objet et vendeur">
        <p>
          Les présentes conditions générales de vente (CGV) ont vocation à régir la vente de
          billets d&apos;événements live via OnlyLive.
        </p>
        <p>
          L&apos;entité prévue pour exploiter OnlyLive est ONLYLIVE ENTERTAINMENT, SARL AU au
          capital de 100 000 MAD, siège social 59 Avenue Ibn Sina, Appartement n°11, Agdal, Rabat,
          RC Rabat n° 201789, ICE 004012555000024.
        </p>
        <p>
          <ToFill>
            confirmer avant publication que cette société est bien le vendeur contractuel des
            billets et le titulaire du compte marchand ChariPay de production
          </ToFill>
        </p>
      </Section>

      <Section heading="2. Billets et catégories">
        <p>
          Chaque événement propose plusieurs catégories de billets (par exemple VVIP, VIP,
          Gradins), réparties en phases de vente successives à prix et quantités distincts. Le
          prix et la disponibilité affichés au moment du paiement sont ceux qui s&apos;appliquent.
          Une réservation temporaire bloque les billets pendant le paiement. Elle n&apos;est
          libérée qu&apos;après expiration, échec ou annulation définitivement établis,
          conformément aux mécanismes de réconciliation avec notre prestataire de paiement — elle
          n&apos;est donc pas nécessairement libérée immédiatement au premier signe
          d&apos;inactivité, le temps de confirmer avec certitude qu&apos;aucun paiement n&apos;est
          en cours de traitement.
        </p>
      </Section>

      <Section heading="3. Commande et paiement">
        <p>
          Un billet n&apos;est confirmé et généré qu&apos;après confirmation du paiement par notre
          prestataire de paiement (ChariPay). Le paiement par carte s&apos;effectue sur une page
          sécurisée fournie par ChariPay ; OnlyLive ne reçoit jamais votre numéro de carte ni votre
          CVV.
        </p>
        <p>
          Avant le passage en production, le parcours de commande devra permettre au client
          d&apos;accéder facilement aux présentes CGV et de les accepter expressément avant la
          confirmation de la commande.
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
          La loi marocaine n° 31-08 prévoit à son article 42 un régime particulier pour les
          prestations de loisirs fournies à une date ou selon une périodicité déterminée : les
          articles 36 et 37 relatifs au droit de rétractation ne leur sont pas applicables.
        </p>
        <p>
          <ToFill>
            faire valider par l&apos;avocat que chaque catégorie de billet vendue par OnlyLive
            relève bien de cette qualification avant de transformer ce rappel juridique en clause
            définitive opposable au client
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
            l&apos;avocat sans écarter les règles impératives de protection du consommateur
          </ToFill>
        </p>
      </Section>
    </LegalPage>
  );
}
