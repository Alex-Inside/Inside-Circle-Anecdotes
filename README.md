# Battle d'anecdotes — INSIDE CIRCLE

Sondage live pour un public ouvert : les participants scannent un QR code, ouvrent
la page sur leur téléphone, **choisissent une seule anecdote**, et le **Top 3** est
révélé quand l'animateur le décide.

Aucun compte, aucune connexion pour les participants : l'adresse est publique.

- **Page publique** : servie par un Worker Cloudflare (HTML/CSS/JS statiques).
- **État de la session** : un unique Durable Object (anecdotes, votes, phase).
  Un seul écrivain, donc un décompte cohérent même avec 200 téléphones.
- **Temps réel** : WebSocket vers tous les téléphones, avec repli en interrogation
  toutes les 5 s si le WebSocket est bloqué par le réseau du lieu.

## Mise en ligne, sans rien installer (le plus rapide)

Depuis le navigateur, avec un compte Cloudflare gratuit :

1. **dash.cloudflare.com** → **Compute (Workers)** → **Create** → **Import a repository**.
2. Autorise GitHub, choisis `Inside-Circle-Anecdotes`, branche `main`.
3. **Root directory** : `/` (la racine). Laisse la commande de build vide ;
   commande de déploiement : `npx wrangler deploy`. Lance le déploiement.
4. Une fois en ligne : **Settings** → **Variables and Secrets** → **Add** →
   type **Secret**, nom `ADMIN_TOKEN`, valeur = ton code régie (choisis-le long).
   **Deploy** pour l'appliquer.
5. Ouvre l'adresse `https://…workers.dev` : c'est le lien à mettre derrière le QR.

Tant qu'aucun `ADMIN_TOKEN` n'est défini, la régie est inaccessible pour tout le
monde — y compris toi. Les participants, eux, peuvent déjà voir la page.

## Mise en ligne en ligne de commande

Prérequis : Node.js 18+ et un compte Cloudflare (l'offre gratuite suffit).

```bash
npm install
npm run vendor          # auto-héberge la librairie QR (évite de dépendre d'un CDN le jour J)
npx wrangler login
npm run deploy
```

Le déploiement affiche l'adresse publique, du type :
`https://inside-circle-anecdotes.<ton-sous-domaine>.workers.dev`

Puis définis le **code régie** (il protège le pilotage : phases, anecdotes, remise à zéro) :

```bash
npx wrangler secret put ADMIN_TOKEN
# saisis un code long, par exemple : circle-2026-regie-8412
```

### Nom de domaine personnalisé (facultatif)

Dans le tableau de bord Cloudflare : **Workers & Pages → ton Worker → Settings →
Domains & Routes → Add custom domain**. Une adresse courte type
`vote.inside-company.fr` est plus lisible sur un écran de projection, et le QR
code s'adapte automatiquement.

## Le jour de l'événement

1. Ouvre l'adresse publique, clique sur **Accès régie**, saisis le code.
   (Raccourci : `https://…workers.dev/?admin=TON_CODE` — le code est retiré de
   l'adresse dès qu'il est validé.)
2. Dans **Les anecdotes**, colle ta liste (ou pré-charge-la avant le déploiement
   via `SEED_ANECDOTES` dans `wrangler.toml`) : **une anecdote par ligne**. Pour
   attribuer une anecdote, termine la ligne par `| Prénom`.
   Clique sur **Enregistrer la liste**.
3. **Projeter le QR code** affiche un écran plein format aux couleurs INSIDE
   CIRCLE, avec le QR, l'adresse et le compteur de votes qui monte en direct.
   (Échap pour sortir.)
4. Phase **1 · Salle d'attente** pendant que le public scanne, puis
   **2 · Ouvrir le vote** quand tu as fini de raconter les anecdotes.
   Le panneau **Décompte en direct** te montre les scores — réservé à la régie,
   personne d'autre ne les voit.
5. **3 · Révéler le Top 3** : tous les téléphones basculent en même temps sur le
   podium, et l'écran de projection affiche le classement.

**Répétition générale** : fais un tour complet à blanc, puis
**Effacer les votes** avant l'ouverture au public.

## Détails utiles

- **Un vote par téléphone.** L'identifiant du votant est stocké dans le
  navigateur. C'est adapté à un événement — ce n'est pas un scrutin certifié :
  quelqu'un qui ouvre une navigation privée peut voter une seconde fois.
- **Changer d'avis** est permis tant que le vote est ouvert ; la révélation ferme
  le scrutin côté serveur.
- **Les scores sont cachés** côté serveur tant que la phase n'est pas
  `results` : l'API ne les renvoie pas, même en les demandant directement.
- **Repartir de zéro pour un autre événement** sans rien perdre de l'ancien :
  change `SESSION_NAME` dans `wrangler.toml` puis redéploie. Chaque nom
  correspond à une session indépendante.
- **Limites** : 60 anecdotes, 400 caractères par anecdote.

## Développement local

```bash
echo 'ADMIN_TOKEN=dev' > .dev.vars
npm run dev        # http://localhost:8787
```

`npm run logs` (`wrangler tail`) affiche les requêtes en direct sur le
déploiement de production.

## L'API, en bref

| Méthode | Route | Qui |
|---|---|---|
| `GET` | `/api/state?voter=<id>` | tout le monde |
| `GET` | `/api/ws` | tout le monde (WebSocket, diffusion de l'état) |
| `POST` | `/api/vote` | tout le monde — `{voter, choice}` |
| `GET` | `/api/admin/check` | régie — état + décompte |
| `POST` | `/api/admin/phase` | régie — `{phase: "lobby"\|"vote"\|"results"}` |
| `POST` | `/api/admin/anecdotes` | régie — `{items: [{text, author}]}` |
| `POST` | `/api/admin/meta` | régie — `{title, subtitle}` |
| `POST` | `/api/admin/reset` | régie — `{scope: "votes"\|"all"}` |

Les routes régie attendent l'en-tête `x-admin-token`.

## Charte

Les couleurs et les typographies sont regroupées en tête de
`public/styles.css` (bloc `:root`) : navy `#0A1350`, bleu roi `#142397`, azur
`#0F7ED8`, cyan `#2FD8E8`, violet `#4A21D0`, relevés sur le support de
l'événement de lancement. Montserrat pour les titres, Lato pour le texte et les
italiques de la signature.

Le logo de l'en-tête est une **reconstitution** de l'anneau INSIDE CIRCLE en SVG
(`public/index.html` et `public/favicon.svg`). Dépose le fichier officiel dans
`public/` et remplace le `<svg class="ring">` par une `<img>` pour un rendu
exact.
