# StroyCo — édition horreur (version serveur)

Le site marche toujours seul (fichier HTML). Hébergé avec ce stack, il débloque en plus :

| Fonction | Service |
|---|---|
| Voix réaliste en français (Piper, ralentie + réverb + voix doublée grave) | `voice` (CPU) |
| Il comprend ce que tu dis (Whisper `small`, int8) et te répond / avertit / screamer | `voice` (GPU) |
| Notifications après fermeture de la page (« REVIENS ICI »…) | `api` + `sw.js` |
| « Frappe deux fois si tu es seul », cri capturé et rejoué | page (micro, rien côté serveur) |
| Assistant Stroy et planche Ouija pilotés par un petit LLM (optionnel) | Ollama, via `api` |

```
web   (nginx)      :8080 → sert la page + sw.js, proxy /api → api
api   (Node/TS)    push, proxy /api/tts et /api/stt, limite de débit par IP
voice (Python)     faster-whisper (GPU) + Piper (CPU)
```

## Prérequis

- Docker + Docker Compose
- Pilote NVIDIA **≥ 550** sur l’hôte (image CUDA 12.4) et **nvidia-container-toolkit**
  - test : `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`
- Un sous-domaine en **HTTPS** (obligatoire : micro, caméra, service worker et push refusent le HTTP)

## Lancer

Les images sont construites par GitHub Actions à chaque push sur `main` et publiées sur GHCR :
`ghcr.io/destroycom/stroyco-horror-web`, `-api`, `-voice` (tags `latest`, `sha-xxxxxxx`, et `x.y.z` pour les tags `vx.y.z`).

```bash
cp .env.example .env        # mets ton mail dans VAPID_CONTACT
docker compose pull
docker compose up -d
docker compose logs -f voice   # doit afficher : Whisper small sur cuda (int8)
```

Mise à jour : `docker compose pull && docker compose up -d`.
Construire en local à la place : `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

Au premier démarrage, Whisper télécharge le modèle (~480 Mo) dans le volume `whisper-models`.


Ensuite, fais pointer ton reverse proxy HTTPS (Nginx Proxy Manager, Traefik, Caddy…) vers `http://<ton-serveur>:8080`.
Aucune config spéciale : pas de WebSocket.

## Petit GPU (4 Go de VRAM)

- `small` en `int8` : ~1 Go de VRAM, environ 1 s par phrase. Recommandé.
- `medium` tient en int8 (~2,5 Go) mais 2 à 3 fois plus lent : la réponse arrive trop tard pour faire peur.
- Sur les cartes anciennes (génération Pascal), garde `int8` : le `float16` y est très lent.
- Si le GPU n’est pas trouvé, le service repasse tout seul sur CPU (log « repli CPU »). Dans ce cas, mets `WHISPER_MODEL=base`.

## Réglages (`.env`)

- `PIPER_VOICE` (build local uniquement, l’image GHCR embarque `fr_FR-tom-medium`) : autre voix française, chemin dans [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/fr/fr_FR) sans extension (ex. `fr/fr_FR/gilles/low/fr_FR-gilles-low`). Rebuild : `docker compose -f docker-compose.yml -f docker-compose.build.yml build voice`.
- `PIPER_LENGTH_SCALE` : 1.0 normal, 1.2 lent (défaut), 1.4 très lent.

## LLM (optionnel)

L'assistant Stroy et la planche Ouija peuvent répondre avec un petit modèle via [Ollama](https://ollama.com).
Sans `OLLAMA_URL`, ils utilisent des réponses écrites à la main (et c'est aussi le repli si Ollama ne répond pas en 14 s).

- Tu as déjà un Ollama : mets son adresse dans `OLLAMA_URL` (le conteneur `api` doit pouvoir le joindre : même réseau Docker ou IP de l'hôte).
- Sinon : `docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d`, puis `docker exec stroyco-horror-ollama ollama pull qwen2.5:1.5b`.
- Le modèle doit comprendre le français. Défaut : `qwen2.5:1.5b` (~1,2 Go, tient avec Whisper sur un GPU 4 Go). `qwen2.5:3b` (~2,3 Go) parle mieux français si le GPU a la place.
- `LLM_TIMEOUT` : temps laissé au modèle pour répondre, en secondes (vide = 25). Pendant l'attente, la planchette erre sur les lettres et l'assistant fait patienter ; au-delà, réponses écrites à la main.
- Contexte limité à 1024 tokens (les échanges sont courts) pour garder le cache mémoire petit.

## Notifications push

- Abonnement fait quand le visiteur accepte les notifications (étape 2 de « Configure ton espace »).
- À la fermeture de la page (seulement si le visiteur a dépassé 30 % du site), 3 notifications : à 30 s, 3 min, 15 min. Annulées dès qu’il revient.
- 6 notifications maximum par abonné au total, puis il est retiré. Bouton « Ne plus recevoir » sur chaque notification.
- Abonnés gardés en mémoire seulement (un redémarrage de `api` les efface). Clés VAPID gardées dans le volume `api-data`.
- Chrome doit tourner (même en arrière-plan) pour les recevoir.

## Vie privée

- L’audio envoyé à `/api/stt` est transcrit en mémoire puis oublié. Rien n’est écrit sur disque, rien n’est journalisé.
- Photo, position, cri et voix enregistrés restent dans le navigateur du visiteur.
- `/api/tts` et `/api/stt` sont limités par IP (40 et 30 requêtes par minute) et le texte à 220 caractères.

## Tester en local sans HTTPS

`http://localhost:8080` est considéré comme sûr par Chrome : tout marche en local, push compris (hors navigation privée).
