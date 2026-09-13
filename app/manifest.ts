import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OnlyLive Scanner",
    short_name: "OL Scanner",
    description: "Contrôle sécurisé des billets OnlyLive à l’entrée des événements.",
    start_url: "/scanner",
    display: "standalone",
    background_color: "#07090d",
    theme_color: "#ea2549",
    orientation: "portrait",
    icons: [
      {
        src: "/onlylive-scanner.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
