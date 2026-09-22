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
            décider la politique commerciale applicable lorsqu&apos;un client change simplement
            d&apos;avis. La loi n° 31-08 prévoit un régime particulier pour les prestations de
            loisirs fournies à une date déterminée, mais la rédaction définitive doit être validée
            par l&apos;avocat avant publication
          </ToFill>
        </p>
      </Section>

      <Section heading="2. Annulation ou report d'un événement">
        <p>
          La loi marocaine n° 31-08 prévoit à son article 40 qu&apos;en cas de défaut
          d&apos;exécution résultant de l&apos;indisponibilité du service commandé, le consommateur
          doit être informé et, le cas échéant, pouvoir être remboursé sans délai et au plus tard
          dans les quinze jours du paiement.
        </p>
        <p>
          <ToFill>
            faire valider l&apos;application exacte de cette règle à l&apos;annulation d&apos;un
            événement et décider séparément la politique applicable en cas de report : maintien du
            billet, possibilité de remboursement, délai et canal d&apos;information
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
          partiel.
        </p>
        <p>
          Le remboursement n&apos;est considéré comme effectif, et le statut de votre commande
          n&apos;est mis à jour, qu&apos;après confirmation du succès du remboursement par
          ChariPay. Le délai réel de réception des fonds dépend ensuite de la banque du client.
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
            canal officiel de demande de remboursement (email ou formulaire) et délai cible de
            réponse ; le remboursement lui-même est actuellement déclenché par un membre habilité
            de l&apos;équipe OnlyLive et non en libre-service par le client
          </ToFill>
        </p>
      </Section>

      <Section heading="6. Frais">
        <p>
          ChariPay indique publiquement que l&apos;opération de remboursement, totale ou partielle,
          est gratuite.
        </p>
        <p>
          <ToFill>
            confirmer avec ChariPay et l&apos;expert-comptable le traitement de la commission
            prélevée sur la transaction d&apos;origine et décider si un quelconque coût peut être
            retenu au client ; ne rien promettre au client avant cette confirmation
          </ToFill>
        </p>
      </Section>
    </LegalPage>
  );
}
