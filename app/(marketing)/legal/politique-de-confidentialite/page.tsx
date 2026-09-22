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
      <Section heading="1. Qui sommes-nous">
        <p>
          OnlyLive vend directement des billets pour des événements live au Maroc. Cette politique
          décrit les données personnelles que nous collectons lorsque vous créez un compte,
          achetez un billet, ou utilisez ce site, et comment elles sont utilisées.
        </p>
      </Section>

      <Section heading="2. Données que nous collectons">
        <p>Nous collectons notamment les informations suivantes :</p>
        <ul>
          <li>votre adresse email (nécessaire pour créer un compte et recevoir vos billets) ;</li>
          <li>votre nom, si vous choisissez de le renseigner ;</li>
          <li>votre numéro de téléphone, requis dès la création de votre compte ;</li>
          <li>
            l&apos;historique de vos commandes et billets sur OnlyLive (catégorie, événement,
            statut) ;
          </li>
          <li>
            un identifiant de scan lors du contrôle d&apos;accès à un événement (horodatage,
            résultat du scan), sans donnée personnelle supplémentaire encodée dans le billet
            lui-même ;
          </li>
          <li>
            des données techniques et de sécurité nécessaires au fonctionnement du service, à la
            prévention de la fraude et à la journalisation (par exemple : adresse IP utilisée pour
            limiter les tentatives de connexion, données de session/authentification, journal des
            événements de paiement, journal d&apos;audit interne).
          </li>
        </ul>
        <p>
          Nous ne collectons jamais votre numéro de carte bancaire ni votre cryptogramme visuel
          (CVV) : le paiement par carte est traité directement par ChariPay sur sa propre page de
          paiement sécurisée.
        </p>
      </Section>

      <Section heading="3. Pourquoi nous les utilisons">
        <ul>
          <li>créer et sécuriser votre compte ;</li>
          <li>traiter votre commande et générer vos billets ;</li>
          <li>vous envoyer les emails liés à votre commande (confirmation, billet, remboursement) ;</li>
          <li>contrôler la validité de votre billet à l&apos;entrée de l&apos;événement ;</li>
          <li>
            détecter et prévenir la fraude (par exemple, un billet déjà scanné) ;
          </li>
          <li>
            <ToFill>toute autre finalité de traitement à confirmer (marketing, statistiques, etc.)</ToFill>
          </li>
        </ul>
      </Section>

      <Section heading="4. Avec qui nous les partageons">
        <p>
          Nous partageons certaines données avec des prestataires strictement nécessaires au
          service :
        </p>
        <ul>
          <li>ChariPay (traitement du paiement) ;</li>
          <li>Resend (envoi des emails transactionnels) ;</li>
          <li>
            Vercel (hébergement de l&apos;application) et notre hébergeur de base de données ;{" "}
            <ToFill>confirmer l&apos;hébergeur de base de données réellement utilisé en
            production au moment de la mise en ligne</ToFill>
          </li>
          <li>le personnel OnlyLive habilité au contrôle d&apos;accès, lors d&apos;un événement.</li>
        </ul>
        <p>
          <ToFill>
            confirmer la position officielle d&apos;OnlyLive sur la vente/le partage de données
            personnelles à des tiers en dehors des prestataires listés ci-dessus (partenaires
            marketing, etc.) — cette page ne doit pas l&apos;affirmer sans validation
          </ToFill>
        </p>
      </Section>

      <Section heading="5. Durée de conservation">
        <p>
          <ToFill>
            durées de conservation précises par type de donnée (compte, commande, journal de scan),
            à définir avec l&apos;expert-comptable au regard des obligations comptables et fiscales
            marocaines
          </ToFill>
        </p>
      </Section>

      <Section heading="6. Vos droits">
        <p>
          <ToFill>
            liste des droits applicables (accès, rectification, suppression, opposition) et
            procédure pour les exercer, à confirmer au regard de la loi marocaine 09-08 relative à
            la protection des données à caractère personnel et des exigences de la CNDP
          </ToFill>
        </p>
        <p>
          <ToFill>
            déterminer si une déclaration ou une autorisation auprès de la CNDP est requise pour
            ces traitements et, le cas échéant, en renseigner la référence
          </ToFill>
        </p>
      </Section>

      <Section heading="7. Sécurité">
        <p>
          Les mots de passe sont stockés sous forme hachée et ne sont jamais consultables en clair.
          Les billets contiennent un jeton de validation imprévisible et aucune donnée personnelle
          ni identifiant de base de données séquentiel.
        </p>
      </Section>

      <Section heading="8. Contact">
        <p>
          Pour toute question relative à vos données personnelles :{" "}
          <ToFill>adresse email dédiée aux demandes de confidentialité</ToFill>
        </p>
      </Section>
    </LegalPage>
  );
}
