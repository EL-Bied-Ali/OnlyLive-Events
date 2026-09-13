"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { IScannerControls } from "@zxing/browser";

type ScannerDecision = "VALID" | "ALREADY_USED" | "INVALID" | "CANCELLED" | "WRONG_EVENT";

interface ScannerEvent {
  id: string;
  title: string;
  startsAt: string;
  venue: { name: string; city: string };
}

interface ScanResponse {
  decision: ScannerDecision;
  scannedAt: string;
  ticket: {
    categoryName: string;
    attendeeName: string | null;
    firstUsedAt: string | null;
  } | null;
}

const RESULT_COPY: Record<ScannerDecision, { title: string; message: string }> = {
  VALID: { title: "Entrée acceptée", message: "Le billet vient d’être validé." },
  ALREADY_USED: { title: "Déjà scanné", message: "Ce billet a déjà servi pour une entrée." },
  INVALID: { title: "Billet invalide", message: "Ce QR code ne correspond à aucun billet OnlyLive." },
  CANCELLED: { title: "Billet annulé", message: "Ce billet n’est plus valable." },
  WRONG_EVENT: { title: "Mauvais événement", message: "Ce billet appartient à un autre événement." },
};

function subscribeToConnectivity(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

const getOnlineSnapshot = () => navigator.onLine;
const getServerOnlineSnapshot = () => true;

export function ScannerClient({ staffName, events }: { staffName: string; events: ScannerEvent[] }) {
  const router = useRouter();
  const [eventId, setEventId] = useState(events[0]?.id ?? "");
  const [cameraActive, setCameraActive] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [history, setHistory] = useState<ScanResponse[]>([]);
  const online = useSyncExternalStore(subscribeToConnectivity, getOnlineSnapshot, getServerOnlineSnapshot);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const busyRef = useRef(false);

  const stopCamera = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setCameraActive(false);
  }, []);

  const submitToken = useCallback(async (validationToken: string) => {
    if (!eventId || busyRef.current || !navigator.onLine) return;
    busyRef.current = true;
    setProcessing(true);
    setRequestError(null);

    try {
      const response = await fetch("/api/scanner/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, validationToken: validationToken.trim() }),
      });
      if (response.status === 401) {
        router.replace("/scanner/login");
        router.refresh();
        return;
      }
      if (!response.ok) {
        setRequestError("Validation impossible. Réessayez sans laisser entrer le participant.");
        return;
      }

      const scan = (await response.json()) as ScanResponse;
      setResult(scan);
      setHistory((current) => [scan, ...current].slice(0, 5));
      navigator.vibrate?.(scan.decision === "VALID" ? 120 : [120, 80, 120]);
    } catch {
      setRequestError("Réseau indisponible. Aucun billet n’a été validé localement.");
    } finally {
      busyRef.current = false;
      setProcessing(false);
    }
  }, [eventId, router]);

  const startCamera = useCallback(async () => {
    if (!eventId || !online) return;
    stopCamera();
    setResult(null);
    setCameraError(null);
    setRequestError(null);

    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 100 });
      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } }, audio: false },
        videoRef.current ?? undefined,
        (decoded, _error, activeControls) => {
          if (!decoded || busyRef.current) return;
          activeControls.stop();
          controlsRef.current = null;
          setCameraActive(false);
          void submitToken(decoded.getText());
        },
      );
      controlsRef.current = controls;
      setCameraActive(true);
    } catch {
      setCameraError("Impossible d’ouvrir la caméra. Autorisez son accès ou saisissez le code manuellement.");
      setCameraActive(false);
    }
  }, [eventId, online, stopCamera, submitToken]);

  useEffect(() => {
    void navigator.serviceWorker?.register("/scanner-sw.js", { scope: "/scanner" }).catch(() => undefined);
    return () => {
      controlsRef.current?.stop();
    };
  }, []);

  function changeEvent(nextEventId: string) {
    stopCamera();
    setEventId(nextEventId);
    setResult(null);
    setHistory([]);
  }

  function submitManual(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const token = form.get("validationToken");
    if (typeof token === "string") {
      stopCamera();
      void submitToken(token);
      event.currentTarget.reset();
    }
  }

  const selectedEvent = events.find((event) => event.id === eventId);

  return (
    <main className="scanner-page">
      <header className="scanner-header">
        <div className="scanner-brand"><span className="admin-brand-mark" aria-hidden="true">OL</span><div><h1>Scanner</h1><small>{staffName}</small></div></div>
        <button type="button" onClick={async () => { await fetch("/api/admin/logout", { method: "POST" }); router.replace("/scanner/login"); router.refresh(); }}>Quitter</button>
      </header>

      <section className="scanner-event-picker">
        <label htmlFor="scanner-event">Événement contrôlé</label>
        <select id="scanner-event" value={eventId} onChange={(event) => changeEvent(event.target.value)} disabled={processing || events.length === 0}>
          {events.map((event) => <option key={event.id} value={event.id}>{event.title} · {event.venue.city}</option>)}
        </select>
        {selectedEvent && <small>{selectedEvent.venue.name} · {new Intl.DateTimeFormat("fr-MA", { dateStyle: "full", timeStyle: "short" }).format(new Date(selectedEvent.startsAt))}</small>}
      </section>

      {!online && <div className="scanner-offline" role="alert">Hors connexion — les validations sont bloquées pour éviter toute double entrée.</div>}
      {events.length === 0 && <div className="scanner-offline">Aucun événement contrôlable n’est configuré.</div>}

      <section className="scanner-camera-card">
        <video ref={videoRef} muted playsInline aria-label="Aperçu de la caméra" />
        <div className="scanner-frame" aria-hidden="true" />
        {!cameraActive && !processing && (
          <button className="scanner-start" type="button" onClick={() => void startCamera()} disabled={!eventId || !online}>
            {result ? "Scanner le billet suivant" : "Démarrer la caméra"}
          </button>
        )}
        {processing && <div className="scanner-processing">Vérification sécurisée…</div>}
      </section>

      {cameraError && <p className="scanner-error" role="alert">{cameraError}</p>}
      {requestError && <p className="scanner-error" role="alert">{requestError}</p>}

      {result && (
        <section className={`scanner-result scanner-result-${result.decision.toLowerCase()}`} aria-live="assertive">
          <span className="scanner-result-icon" aria-hidden="true">{result.decision === "VALID" ? "✓" : result.decision === "ALREADY_USED" ? "!" : "×"}</span>
          <div><p>{RESULT_COPY[result.decision].title}</p><h1>{RESULT_COPY[result.decision].message}</h1>
            {result.ticket && <small>{result.ticket.categoryName}{result.ticket.attendeeName ? ` · ${result.ticket.attendeeName}` : ""}
              {result.decision === "ALREADY_USED" && result.ticket.firstUsedAt
                ? ` · première entrée à ${new Intl.DateTimeFormat("fr-MA", { timeStyle: "medium" }).format(new Date(result.ticket.firstUsedAt))}`
                : ""}
            </small>}
          </div>
        </section>
      )}

      <details className="scanner-manual">
        <summary>Saisie manuelle</summary>
        <form onSubmit={submitManual}>
          <label htmlFor="validation-token">Code du billet</label>
          <div><input id="validation-token" name="validationToken" minLength={16} maxLength={256} autoComplete="off" required /><button type="submit" disabled={processing || !eventId || !online}>Vérifier</button></div>
        </form>
      </details>

      {history.length > 0 && <section className="scanner-history"><h2>Derniers contrôles</h2>{history.map((scan, index) => <div key={`${scan.scannedAt}-${index}`}><span className={`scanner-dot scanner-dot-${scan.decision.toLowerCase()}`} /><strong>{RESULT_COPY[scan.decision].title}</strong><small>{new Intl.DateTimeFormat("fr-MA", { timeStyle: "medium" }).format(new Date(scan.scannedAt))}</small></div>)}</section>}
    </main>
  );
}
