import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { legalDocumentsApproved } from "@/lib/legal/approval";
import { LegalPage, Section, ToFill } from "../_components/LegalPage";

export const metadata: Metadata = {
  title: "Mentions légales — OnlyLive",
  robots: { index: false, follow: false },
};

export default function LegalNoticePage() {
  if (!legalDocumentsApproved()) notFound();

  return (
    <LegalPage title="Mentions légales" updatedNote="Brouillon — non publié.">
      <Section heading="1. Éditeur du site">
        <p>
          Le présent site est édité par ONLYLIVE ENTERTAINMENT, société à responsabilité limitée à
          associé unique (SARL AU) au capital social de 100 000 MAD, dont le siège social est situé
          au 59 Avenue Ibn Sina, Appartement n°11, Agdal, Rabat, Maroc.
        </p>
        <p>
          Identifiant Commun de l&apos;Entreprise (ICE) : 004012555000024
          <br />
          Registre du commerce : RC Rabat n° 201789
          <br />
          Identifiant fiscal : <ToFill>IF — à récupérer auprès de la DGI / du dossier fiscal</ToFill>
          <br />
          Taxe professionnelle :{" "}
          <ToFill>référence TP, si elle doit figurer dans les documents publiés</ToFill>
        </p>
        <p>Gérant : Amine El Bied.</p>
        <p>
          Directeur de la publication :{" "}
          <ToFill>confirmer si le gérant assume aussi cette fonction ou désigner le responsable</ToFill>
        </p>
        <p>
          Contact : <ToFill>adresse email publique OnlyLive</ToFill> ·{" "}
          <ToFill>numéro de téléphone de contact / réclamation</ToFill> · Instagram{" "}
          <a href="https://www.instagram.com/onlylive.ma" target="_blank" rel="noreferrer">
            @onlylive.ma
          </a>
        </p>
      </Section>

      <Section heading="2. Hébergement">
        <p>
          Le site est hébergé par Vercel Inc. (application).{" "}
          <ToFill>
            confirmer l&apos;hébergeur de base de données réellement utilisé en production, sa
            région/pays d&apos;hébergement et les coordonnées à publier le cas échéant
          </ToFill>
        </p>
      </Section>

      <Section heading="3. Activité">
        <p>
          L&apos;activité enregistrée de ONLYLIVE ENTERTAINMENT comprend l&apos;événementiel et la
          prestation de services.
        </p>
        <p>
          <ToFill>
            confirmer avant publication que ONLYLIVE ENTERTAINMENT est bien l&apos;entité
            contractante qui vend les billets, détient le compte marchand ChariPay de production
            et reçoit les paiements clients
          </ToFill>
        </p>
      </Section>

      <Section heading="4. Propriété intellectuelle">
        <p>
          <ToFill>
            clause de propriété intellectuelle sur les contenus du site, les visuels et la marque
            OnlyLive — à valider avec l&apos;avocat, notamment la titularité de la marque et des
            contenus utilisés pour chaque événement
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
            droit applicable et modalités de résolution des litiges — à valider par l&apos;avocat
            au regard notamment des règles impératives de protection du consommateur
          </ToFill>
        </p>
      </Section>

      <Section heading="7. Réclamations">
        <p>
          <ToFill>
            adresse email et numéro de téléphone officiels pour les réclamations clients, ainsi que
            toute procédure de médiation ou de règlement amiable finalement retenue
          </ToFill>
        </p>
      </Section>
    </LegalPage>
  );
}
