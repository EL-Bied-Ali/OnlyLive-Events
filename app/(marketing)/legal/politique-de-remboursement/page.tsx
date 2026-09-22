import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { legalDocumentsApproved } from "@/lib/legal/approval";
import { LegalPage, Section, ToFill } from "../_components/LegalPage";

export const metadata: Metadata = {
  title: "Politique de remboursement — OnlyLive",
  robots: { index: false, follow: false },
};

export default function RefundPolicyPage() {
  if (!legalDocumentsApproved()) notFound();

  return (
    <LegalPage
      title="Politique de remboursement"
      updatedNote="Brouillon — non publié."
    >
      <Section heading="1. Principe général">
        <p>
          <ToFill>
            position officielle d&apos;OnlyLive sur le caractère ferme et définitif (ou non) de la
            vente de billets, notamment en cas de simple changement d&apos;avis du client — cette
            page ne doit pas trancher cette question elle-même
          </ToFill>
        </p>
      </Section>

      <Section heading="2. Annulation ou report d'un événement">
        <p>
          <ToFill>
            engagement officiel d&apos;OnlyLive en cas d&apos;annulation ou de report d&apos;un
            événement par son organisateur (information des détenteurs de billets, remboursement
            total ou partiel, possibilité de conserver le billet pour une nouvelle date, délai
            cible) — à décider avec la direction/l&apos;avocat, cette page ne doit pas
            présenter un engagement non encore pris comme acquis
          </ToFill>
        </p>
        <p>
          Si un remboursement est décidé, sa mise en œuvre technique suit le processus décrit à la
          section 3 ci-dessous : il est initié par un membre habilité de l&apos;équipe OnlyLive
          depuis l&apos;interface d&apos;administration, jamais automatiquement par le système.
        </p>
      </Section>

      <Section heading="3. Comment un remboursement est traité">
        <p>
          Les remboursements sont initiés depuis l&apos;interface d&apos;administration OnlyLive et
          traités via ChariPay, notre prestataire de paiement. Un remboursement peut être total ou
          partiel. Son statut passe par les étapes suivantes : en attente, en cours de traitement,
          réussi, ou échoué.
        </p>
        <p>
          Le remboursement n&apos;est considéré comme effectif, et le statut de votre commande
          n&apos;est mis à jour, qu&apos;après confirmation du succès du remboursement par
          ChariPay — jamais sur la seule base d&apos;une action interne. Le délai réel de
          réception des fonds dépend ensuite de votre banque.
        </p>
      </Section>

      <Section heading="4. Billets remboursés">
        <p>
          Un billet ayant fait l&apos;objet d&apos;un remboursement total n&apos;est plus valide
          pour l&apos;accès à l&apos;événement.
        </p>
      </Section>

      <Section heading="5. Comment demander un remboursement">
        <p>
          <ToFill>
            canal officiel par lequel un client peut soumettre une demande de remboursement
            (email dédié, formulaire) et délai cible de réponse — le remboursement lui-même n&apos;est
            actuellement déclenché que par un membre habilité de l&apos;équipe OnlyLive, pas en
            libre-service par le client
          </ToFill>
        </p>
      </Section>

      <Section heading="6. Frais bancaires ou de plateforme">
        <p>
          <ToFill>
            confirmer si des frais sont retenus lors d&apos;un remboursement (frais de transaction
            ChariPay, frais bancaires) et, le cas échéant, qui les supporte
          </ToFill>
        </p>
      </Section>
    </LegalPage>
  );
}
