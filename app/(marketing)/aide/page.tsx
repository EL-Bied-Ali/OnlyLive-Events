import Link from "next/link";
import { CustomerNav } from "@/components/CustomerNav";

const TOPICS = [
  {
    id: "paiement-debite",
    question: "J’ai été débité mais je ne vois pas de billet",
    answer: (
      <>
        <p>
          Un paiement peut être confirmé par notre prestataire quelques instants après le retour sur OnlyLive.
          Consultez <Link href="/mes-commandes">Mes commandes</Link> : si la commande affiche « Confirmation en
          cours », « Vérification supplémentaire en cours » ou « Traitement manuel en cours », le paiement a bien
          été reçu et le billet apparaîtra dès que la vérification est terminée — ne relancez pas un second
          paiement dans l’intervalle.
        </p>
        <p>Si ce statut persiste anormalement longtemps, contactez le support ci-dessous.</p>
      </>
    ),
  },
  {
    id: "billet-non-recu",
    question: "Je n’ai pas reçu l’email avec mon billet",
    answer: (
      <p>
        Si votre commande est confirmée et que les billets ont été émis, ils sont disponibles dans{" "}
        <Link href="/mes-billets">Mes billets</Link> — vérifiez aussi vos courriers indésirables, la livraison
        peut parfois prendre quelques minutes. Si votre commande est encore en cours de vérification, consultez{" "}
        <Link href="/mes-commandes">Mes commandes</Link> pour son statut.
      </p>
    ),
  },
  {
    id: "retrouver-billets",
    question: "Comment retrouver mes billets ?",
    answer: (
      <p>
        Connectez-vous et ouvrez <Link href="/mes-billets">Mes billets</Link> : tous vos billets à venir et
        passés y sont regroupés, avec un accès direct au QR de chacun.
      </p>
    ),
  },
  {
    id: "qr-ne-fonctionne-pas",
    question: "Le QR de mon billet ne fonctionne pas",
    answer: (
      <p>
        La page du billet indique son état enregistré (valide, déjà scanné, annulé) — actualisez-la si nécessaire,
        et augmentez la luminosité de votre écran pour faciliter le scan. Si votre billet est bien indiqué «
        valide » mais que le contrôle d’accès rencontre un problème, contactez le support avec la référence
        affichée sur la page du billet.
      </p>
    ),
  },
  {
    id: "evenement-annule",
    question: "L’événement est annulé ou reporté",
    answer: (
      <p>
        Les modalités applicables dépendent de la décision de l’organisateur et des conditions de vente associées
        à l’événement. Consultez votre commande dans <Link href="/mes-commandes">Mes commandes</Link> et les
        communications OnlyLive. En attendant, contactez le support ci-dessous — nous vous tiendrons informé
        individuellement.
      </p>
    ),
  },
  {
    id: "remboursement",
    question: "Je souhaite suivre ou demander un remboursement",
    answer: (
      <p>
        Si un remboursement a déjà été lancé, son statut apparaît sur{" "}
        <Link href="/mes-commandes">Mes commandes</Link>. Les conditions d’éligibilité à un remboursement doivent
        être confirmées par la politique applicable à l’événement concerné — contactez le support ci-dessous pour
        une demande.
      </p>
    ),
  },
  {
    id: "changer-coordonnees",
    question: "Je veux changer mon email ou mon numéro de téléphone",
    answer: (
      <p>
        Le téléphone se modifie directement dans <Link href="/mon-compte">Mon compte</Link>. Le changement
        d’adresse email n’est pas disponible en libre-service — contactez le support ci-dessous si cela bloque
        votre accès à votre compte.
      </p>
    ),
  },
];

export default function AidePage() {
  return (
    <main className="aide-page">
      <CustomerNav />

      <div className="aide-heading">
        <h1>Aide</h1>
        <p>Les questions les plus fréquentes sur vos commandes et vos billets OnlyLive.</p>
      </div>

      <section className="aide-topics">
        {TOPICS.map((topic) => (
          <article key={topic.id} className="aide-topic" aria-labelledby={`aide-${topic.id}`}>
            <h2 id={`aide-${topic.id}`}>{topic.question}</h2>
            <div className="aide-topic-answer">{topic.answer}</div>
          </article>
        ))}
      </section>

      <section className="aide-contact" aria-labelledby="aide-contact-title">
        <h2 id="aide-contact-title">Contacter le support</h2>
        <p>
          Instagram :{" "}
          <a href="https://www.instagram.com/onlylive.ma" target="_blank" rel="noreferrer">
            @onlylive.ma
          </a>
        </p>
      </section>
    </main>
  );
}
