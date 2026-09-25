import Link from "next/link";
import { CustomerNav } from "@/components/CustomerNav";
import { ToFill } from "@/app/(marketing)/legal/_components/LegalPage";

const TOPICS = [
  {
    id: "paiement-debite",
    question: "J’ai été débité mais je ne vois pas de billet",
    answer: (
      <>
        <p>
          Un paiement peut être confirmé par notre prestataire quelques instants après le retour sur OnlyLive.
          Consultez <Link href="/mes-commandes">Mes commandes</Link> : si la commande affiche « Vérification en
          cours » ou « Traitement manuel en cours », le paiement a bien été reçu et le billet apparaîtra dès que
          la vérification est terminée — ne relancez pas un second paiement dans l’intervalle.
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
        Vos billets sont toujours disponibles directement dans <Link href="/mes-billets">Mes billets</Link>, que
        l’email soit arrivé ou non — vérifiez aussi vos courriers indésirables, la livraison peut parfois prendre
        quelques minutes.
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
        Le QR reflète l’état réel de votre billet au moment où vous le consultez (valide, déjà scanné, annulé) —
        augmentez la luminosité de votre écran pour faciliter le scan. Si votre billet est bien indiqué « valide »
        mais que le contrôle d’accès rencontre un problème, contactez le support avec la référence affichée sur la
        page du billet.
      </p>
    ),
  },
  {
    id: "evenement-annule",
    question: "L’événement est annulé ou reporté",
    answer: (
      <p>
        <ToFill>procédure exacte de remboursement/report en cas d’annulation, à valider avant publication</ToFill>.
        En attendant, contactez le support ci-dessous — nous vous tiendrons informé individuellement.
      </p>
    ),
  },
  {
    id: "remboursement",
    question: "Je souhaite suivre ou demander un remboursement",
    answer: (
      <p>
        L’état de tout remboursement associé à une commande est visible sur{" "}
        <Link href="/mes-commandes">Mes commandes</Link>. Pour une demande de remboursement,{" "}
        <ToFill>conditions et délais exacts de remboursement</ToFill>.
      </p>
    ),
  },
  {
    id: "changer-coordonnees",
    question: "Je veux changer mon email ou mon numéro de téléphone",
    answer: (
      <p>
        Le téléphone se modifie directement dans <Link href="/mon-compte">Mon compte</Link>. Le changement
        d’adresse email n’est pas encore disponible en libre-service — contactez le support ci-dessous pour qu’il
        soit mis à jour.
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
          {" · "}
          Email : <ToFill>adresse email publique de support OnlyLive</ToFill>
        </p>
      </section>
    </main>
  );
}
