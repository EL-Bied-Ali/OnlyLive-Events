import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { legalDocumentsApproved } from "@/lib/legal/approval";
import { LegalPage, Section, ToFill } from "../_components/LegalPage";

export const metadata: Metadata = {
  title: "Politique de confidentialité — OnlyLive",
  robots: { index: false, follow: false },
};

export default function PrivacyPolicyPage() {
  if (!legalDocumentsApproved()) notFound();

  return (
    <LegalPage title="Politique de confidentialité" updatedNote="Brouillon — non publié.">
      <Section heading="1. Responsable du traitement">
        <p>
          Le responsable du traitement envisagé pour OnlyLive est ONLYLIVE ENTERTAINMENT, SARL AU
          au capital de 100 000 MAD, siège social 59 Avenue Ibn Sina, Appartement n°11, Agdal,
          Rabat, RC Rabat n° 201789, ICE 004012555000024.
        </p>
        <p>
          <ToFill>
            confirmer avant publication que cette société est bien l&apos;entité qui exploite le
            site et détermine les finalités et moyens des traitements de données décrits ci-dessous
          </ToFill>
        </p>
      </Section>

      <Section heading="2. Données que nous collectons">
        <p>Nous collectons notamment les informations suivantes :</p>
        <ul>
          <li>votre adresse email (nécessaire pour créer un compte et recevoir vos billets) ;</li>
          <li>votre nom ;</li>
          <li>votre numéro de téléphone, requis lors de la création de votre compte ;</li>
          <li>
            l&apos;historique de vos commandes et billets sur OnlyLive (catégorie, événement,
            statut) ;
          </li>
          <li>
            des informations liées au contrôle d&apos;accès (horodatage et résultat du scan) ;
          </li>
          <li>
            des données techniques et de sécurité nécessaires au fonctionnement du service, à la
            prévention de la fraude et à la journalisation, par exemple l&apos;adresse IP utilisée
            pour limiter certaines tentatives, les données de session/authentification, les
            événements de paiement et les journaux d&apos;audit.
          </li>
        </ul>
        <p>
          Nous ne collectons jamais votre numéro de carte bancaire ni votre cryptogramme visuel
          (CVV) : la saisie des données de carte intervient sur la page de paiement hébergée par
          ChariPay.
        </p>
      </Section>

      <Section heading="3. Finalités">
        <ul>
          <li>créer et sécuriser votre compte ;</li>
          <li>traiter votre commande et générer vos billets ;</li>
          <li>vous envoyer les communications transactionnelles liées à votre commande ;</li>
          <li>contrôler la validité de votre billet à l&apos;entrée de l&apos;événement ;</li>
          <li>détecter et prévenir la fraude et les utilisations abusives du service ;</li>
          <li>
            <ToFill>
              confirmer toute finalité supplémentaire envisagée, notamment marketing ou
              statistiques, avant de collecter ou réutiliser les données à cette fin
            </ToFill>
          </li>
        </ul>
      </Section>

      <Section heading="4. Destinataires et prestataires">
        <p>
          Certaines données sont communiquées aux prestataires nécessaires au fonctionnement du
          service :
        </p>
        <ul>
          <li>ChariPay, pour le traitement des paiements ;</li>
          <li>Resend, pour l&apos;envoi des emails transactionnels ;</li>
          <li>Vercel, pour l&apos;hébergement de l&apos;application ;</li>
          <li>
            Neon, pour l&apos;hébergement de la base de données de production (région AWS
            us-east-1, États-Unis) ;
          </li>
          <li>le personnel OnlyLive habilité au contrôle d&apos;accès lors des événements.</li>
        </ul>
        <p>
          <ToFill>
            confirmer qu&apos;aucun autre partage n&apos;est prévu, notamment avec des partenaires
            marketing, ou documenter précisément ces destinataires et finalités s&apos;ils existent
          </ToFill>
        </p>
      </Section>

      <Section heading="5. Transferts de données à l'étranger">
        <p>
          L&apos;hébergement ou la transmission de données personnelles vers des prestataires
          situés à l&apos;étranger nécessite d&apos;être documenté dans le dossier CNDP applicable.
        </p>
        <p>
          <ToFill>
            après choix définitif de l&apos;infrastructure de production, renseigner les
            prestataires, pays destinataires et références CNDP du traitement de base et du ou des
            transferts à l&apos;étranger
          </ToFill>
        </p>
      </Section>

      <Section heading="6. Durée de conservation">
        <p>
          <ToFill>
            définir les durées de conservation par catégorie de données (compte, commandes,
            justificatifs comptables, paiements, journaux de sécurité, scans et audit) avec
            l&apos;avocat et l&apos;expert-comptable ; ne pas appliquer une durée unique à toutes
            les données
          </ToFill>
        </p>
      </Section>

      <Section heading="7. Vos droits">
        <p>
          Conformément à la loi marocaine n° 09-08, les personnes concernées disposent notamment
          d&apos;un droit d&apos;accès et de rectification des données les concernant ainsi que,
          pour des motifs légitimes, d&apos;un droit d&apos;opposition au traitement.
        </p>
        <p>
          Pour exercer ces droits :{" "}
          <ToFill>adresse email ou service dédié aux demandes relatives aux données personnelles</ToFill>
        </p>
        <p>
          <ToFill>
            renseigner le numéro du récépissé de déclaration / de l&apos;autorisation délivré par
            la CNDP une fois la formalité accomplie
          </ToFill>
        </p>
      </Section>

      <Section heading="8. Formalités CNDP">
        <p>
          Au regard des traitements actuellement prévus dans l&apos;application et sous réserve
          qu&apos;aucune donnée sensible, numéro de CIN ou traitement soumis à autorisation ne soit
          ajouté, les lignes directrices de la CNDP orientent vers une déclaration préalable du
          traitement. L&apos;hébergement ou la transmission de données à l&apos;étranger nécessite
          en outre la formalité de transfert correspondante.
        </p>
        <p>
          <ToFill>
            faire déposer et valider les formalités CNDP avant mise en production, puis reporter
            leurs références dans les mentions de collecte et cette politique
          </ToFill>
        </p>
      </Section>

      <Section heading="9. Sécurité">
        <p>
          Les mots de passe sont stockés sous forme hachée et ne sont jamais consultables en clair.
          Les billets contiennent un jeton de validation imprévisible et aucune donnée personnelle
          directement lisible dans leur code QR.
        </p>
      </Section>

      <Section heading="10. Contact">
        <p>
          Pour toute question relative aux données personnelles :{" "}
          <ToFill>adresse email dédiée aux demandes de confidentialité</ToFill>
        </p>
      </Section>
    </LegalPage>
  );
}
