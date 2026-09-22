import type { Metadata } from "next";
import { LegalPage, Section, ToFill } from "../_components/LegalPage";

export const metadata: Metadata = {
  title: "Mentions légales — OnlyLive",
};

export default function LegalNoticePage() {
  return (
    <LegalPage title="Mentions légales" updatedNote="Brouillon — non publié.">
      <Section heading="1. Éditeur du site">
        <p>
          Le présent site est édité par <ToFill>raison sociale / forme juridique d&apos;OnlyLive</ToFill>,
          dont le siège social est situé <ToFill>adresse complète du siège social</ToFill>.
        </p>
        <p>
          Identifiant Commun de l&apos;Entreprise (ICE) : <ToFill>numéro ICE</ToFill>
          <br />
          Registre du commerce : <ToFill>numéro RC et ville d&apos;immatriculation</ToFill>
          <br />
          Identifiant fiscal : <ToFill>IF</ToFill>
        </p>
        <p>
          Directeur de la publication : <ToFill>nom du responsable légal</ToFill>
        </p>
        <p>
          Contact : <ToFill>adresse email de contact public</ToFill>, Instagram{" "}
          <a href="https://www.instagram.com/onlylive.ma" target="_blank" rel="noreferrer">
            @onlylive.ma
          </a>
        </p>
      </Section>

      <Section heading="2. Hébergement">
        <p>
          Le site est hébergé par Vercel Inc. (application) et la base de données est hébergée par
          Neon (PostgreSQL). <ToFill>confirmer si une mention d&apos;hébergeur détaillée est requise et ses coordonnées exactes</ToFill>.
        </p>
      </Section>

      <Section heading="3. Activité">
        <p>
          OnlyLive commercialise directement des billets pour des événements live (concerts,
          spectacles) au Maroc. OnlyLive est le vendeur des billets et le destinataire des
          paiements des clients.
        </p>
      </Section>

      <Section heading="4. Propriété intellectuelle">
        <p>
          <ToFill>
            clause standard de propriété intellectuelle sur les contenus du site (textes, visuels,
            marque OnlyLive) — à valider par l&apos;avocat
          </ToFill>
        </p>
      </Section>

      <Section heading="5. Paiement">
        <p>
          Les paiements par carte sont traités par ChariPay via une page de paiement hébergée par
          ChariPay. OnlyLive ne reçoit et ne conserve jamais le numéro de carte ni le cryptogramme
          visuel (CVV) de ses clients.
        </p>
      </Section>

      <Section heading="6. Droit applicable et juridiction">
        <p>
          <ToFill>
            droit applicable et tribunaux compétents en cas de litige — à déterminer avec
            l&apos;avocat d&apos;OnlyLive
          </ToFill>
        </p>
      </Section>

      <Section heading="7. Médiation / réclamations">
        <p>
          <ToFill>
            coordonnées de réclamation client et, le cas échéant, organisme de médiation
            applicable au Maroc
          </ToFill>
        </p>
      </Section>
    </LegalPage>
  );
}
