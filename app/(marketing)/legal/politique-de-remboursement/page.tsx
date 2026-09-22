import type { Metadata } from "next";
import { LegalPage, Section, ToFill } from "../_components/LegalPage";

export const metadata: Metadata = {
  title: "Politique de remboursement — OnlyLive",
};

export default function RefundPolicyPage() {
  return (
    <LegalPage
      title="Politique de remboursement"
      updatedNote="Brouillon — non publié."
    >
      <Section heading="1. Principe général">
        <p>
          Sauf annulation ou report de l&apos;événement par son organisateur, la vente de billets
          est ferme et définitive. <ToFill>confirmer la position officielle d&apos;OnlyLive sur
          les demandes de remboursement pour simple changement d&apos;avis du client</ToFill>
        </p>
      </Section>

      <Section heading="2. Annulation ou report d'un événement">
        <p>
          Si un événement est annulé ou reporté par son organisateur, les détenteurs de billets
          sont informés par email et un remboursement (total ou partiel selon le cas) est initié
          par l&apos;équipe OnlyLive. <ToFill>confirmer le délai cible de traitement et si un
          billet peut être conservé pour la nouvelle date en cas de report</ToFill>
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
