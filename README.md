# Mode Étude — extension Firefox

Remplace la page « Nouvel onglet » par un tableau de bord étudiant :

- **Recherche unique** : Entrée lance la recherche sur le web avec le moteur de Firefox. Pendant la frappe, les résultats trouvés dans tes cours s'affichent en dessous.
- **Raccourcis** : tes sites les plus visités, comme sur la page de Firefox. Le bouton « + » ajoute un site (Moodle, ENT…), le bouton ⋯ d'une tuile la retire.
- **Fond d'écran** : une image au choix, à régler dans Réglages → Accueil.
- **Thème de Firefox** : option « Suivre le thème de Firefox » (Réglages → Accueil). Les couleurs de la page reprennent celles de ton thème et changent avec lui ; l'image du thème peut servir de fond. Les fonds d'écran de la page Nouvel onglet de Firefox, eux, ne sont pas accessibles aux extensions : enregistre l'image et choisis-la comme fond d'écran.
- **Mes cours** : les cours d'aujourd'hui et de demain, avec un badge « En cours ».
- **À rendre** : les devoirs, interros et projets, avec leur échéance.
- **Projets & compétitions** : tes projets, hackathons, concours et stages en cours, avec leur type, la date limite, la prochaine étape, un lien (dépôt, plateforme) et une barre d'avancement réglable. « Terminé » les range à part.
- **Ne pas oublier, depuis n'importe quel site** : sur la page d'une compétition, clique sur l'icône Mode Étude de la barre d'outils (ou **Alt+Maj+E**, ou clic droit → « Ajouter à Mode Étude »). Le nom et le lien sont repris de la page, et les dates trouvées sont proposées (celle qui suit « date limite », « deadline »… est choisie d'office ; sélectionne une date avant le clic droit pour l'imposer). Firefox te prévient ensuite par une notification le jour choisi (veille par défaut) puis le jour J, et l'icône affiche le nombre de dates limites dans les 3 jours.
- **Mon semestre** : la liste des matières à gauche ; à droite, les PDF de la matière choisie (rangés par sous-dossier), son prochain cours et ses devoirs à venir.
- **Dossiers créés depuis l'emploi du temps** : après un import (ou Emploi du temps → « Créer les dossiers de cours »), un script Windows `.bat` est proposé. Placé dans ton dossier de cours, il crée `Semestre N/Partie P/<matière>/Cours, TD, TP` (d'après les types de séances), avec les noms exacts de l'emploi du temps, plus « Annales » ou « Projets » au choix. Il ne crée que ce qui manque.
- **Dossier de cours par semestre et partie** : `Cours/Semestre 1/Partie 2/ETL/TD/td1.pdf`. Les dossiers de période (« Semestre 1 », « S1 », « Partie 2 », « P2 », « S1P2 », « 2e partie »…) sont reconnus : la matière est le premier dossier qui suit, et les sous-dossiers (Cours, TD…) regroupent ses fichiers. Dans « Mon semestre », les matières de la partie choisie passent en tête (d'après le semestre et la partie de l'emploi du temps), les autres sont rangées par période.
- **Recherche** dans le texte de tous tes PDF. Un clic ouvre le PDF à la bonne page.
- **Semaine** : le planning de la semaine, avec les devoirs placés au bon jour.
- **Imports regroupés dans Réglages → Imports** : emploi du temps, calendrier des examens, dossier de cours (et script de création des dossiers), sauvegarde. Les pages Emploi du temps et Mon semestre ne gardent que l'affichage et les corrections.
- **Emploi du temps** : tu déposes le PDF de l'école, Gemini (gratuit) en extrait les créneaux, tu vérifies et tu valides. La saisie à la main marche aussi, sans IA. La grille reprend la forme du PDF de l'école (semaines en colonnes, jours et créneaux en lignes).
- **Semestre et partie** : un emploi du temps couvre une partie d'un semestre (chaque semestre a deux parties). À l'import, l'IA lit dans l'en-tête du PDF le numéro du semestre, la partie, la classe et les dates. Tu peux les corriger à la vérification (« Période couverte ») et plus tard dans Emploi du temps → Paramètres. Si une partie identique existe déjà, le nouveau PDF la remplace par défaut. Tu peux aussi l'ajouter en nouvelle partie ou compléter l'existante. La liste des emplois du temps est groupée par semestre. Le calendrier des examens est rattaché à la bonne partie, et le script de dossiers reprend le semestre et la partie.
- **Nouvelle version d'un emploi du temps** : quand tu importes un PDF « à la place » d'une partie existante, Mode Étude compare les deux versions. Il liste les cours à venir déplacés, ajoutés, annulés, ou qui changent d'horaire ou de salle. La carte « Ce qui a changé » s'affiche sur la page Emploi du temps, et l'accueil signale les changements des 7 prochains jours jusqu'à ce que tu cliques sur « Vu ». Le calendrier des examens importé à part est conservé.
- **Révisions** : dès que le calendrier des examens est importé, chaque épreuve reçoit une séance de révision à J-14, J-7, J-3 et la veille. Les séances sont placées sur les jours les moins chargés (jamais plus de deux par jour), avec l'heure de fin des cours. La page Révisions montre l'avancement de chaque épreuve, ses séances et les documents à revoir, rangés en Cours, TD, TP et Annales et à cocher. Le widget « À réviser » de l'accueil affiche les séances du jour et celles en retard.
- **PDF à classer** : les fichiers dont la matière n'a pas été devinée se rangent en deux clics.

Tout reste dans le navigateur (IndexedDB). Seul le PDF de l'emploi du temps est envoyé à Google, et seulement quand tu cliques sur « Importer un PDF ».

## Installer (mode test)

1. Ouvre Firefox et va sur `about:debugging#/runtime/this-firefox`.
2. Clique sur **Charger un module complémentaire temporaire…**.
3. Choisis le fichier `manifest.json` de ce dossier.
4. Ouvre un nouvel onglet. Firefox demande si tu gardes la nouvelle page d'accueil : réponds **Conserver les modifications**.

> Un module temporaire disparaît quand Firefox se ferme, mais **tes données restent** tant que l'identifiant de l'extension (`mode-etude@local`) ne change pas.

## Installer pour de bon (signature « non listée »)

Firefox (version normale) n'installe que les extensions signées par Mozilla. La signature « non listée » est gratuite et ne publie rien sur le store : tu obtiens un fichier `.xpi` à installer toi-même.

1. Crée un compte sur [addons.mozilla.org](https://addons.mozilla.org), puis génère tes clés sur la page [Gérer les clés API](https://addons.mozilla.org/developers/addon/api/key/) (un « émetteur JWT » et un « secret JWT »).
2. Dans ce dossier, lance (Node.js requis) :
   ```bash
   npx web-ext lint
   ```
   ```bash
   npx web-ext sign --channel=unlisted --api-key=TON_EMETTEUR --api-secret=TON_SECRET
   ```
   Ne mets jamais ces clés dans un fichier du projet.
3. Le fichier signé arrive dans `web-ext-artifacts/`. Glisse-le dans Firefox (ou `about:addons` → ⚙ → Installer un module depuis un fichier).
4. Pour une nouvelle version : augmente `version` dans `manifest.json`, puis relance la signature. Firefox garde tes données puisque l'identifiant ne change pas.

## Premiers pas

1. **Réglages → Clé API Gemini** : crée une clé gratuite sur https://aistudio.google.com/apikey et colle-la. Le modèle est choisi tout seul : l'extension demande à Google la liste des modèles et prend le « Flash » le plus récent. Si ce modèle est retiré plus tard, elle en change automatiquement.
2. **Emploi du temps → Importer un PDF**, vérifie le tableau, puis **Valider**.
3. **Accueil → Choisir le dossier** : sélectionne ton dossier de cours. Firefox affiche « Envoyer N fichiers ? » : c'est seulement l'extension qui les lit, rien ne part sur Internet.
4. Quand tu ajoutes des cours, va dans **Réglages → Resynchroniser** et choisis à nouveau le même dossier. Seuls les fichiers nouveaux ou modifiés sont relus.

### Comment la matière d'un PDF est devinée

1. Par le nom de ses dossiers : `Cloud/`, `BDD/` (sigle de « Bases de données »), `Réseaux/`…
2. Sinon, par son nom de fichier.
3. Sinon, par le texte de ses deux premières pages.

Ajoute des « autres noms » à une matière dans les Réglages (ex. `SQL, BD` pour Bases de données). Un choix fait à la main est toujours prioritaire.

## Limites connues (V1)

- Firefox ne permet pas de surveiller un dossier : la resynchronisation est manuelle.
- Les PDF sont **copiés** dans le stockage de l'extension, ce qui double la place qu'ils occupent sur le disque.
- Les PDF scannés (images) ne sont pas cherchables, sauf par leur nom de fichier.
- Pas encore de panneau IA dans le lecteur de cours : c'est l'objet de la V3.

## Structure

```
manifest.json      déclaration de l'extension (nouvel onglet, bouton, clic droit)
newtab.html        la page
popup.html         petite fenêtre « Ne pas oublier » (bouton de la barre d'outils)
css/app.css        styles (clair / sombre automatique)
js/app.js          vues, routeur, actions
js/db.js           IndexedDB (réglages, fichiers, texte des pages)
js/pdftext.js      extraction du texte avec pdf.js
js/gemini.js       lecture de l'emploi du temps par Gemini
js/browser.js      sites les plus visités, recherche web
js/subjects.js     rattachement PDF → matière
js/util.js         dates, texte, échappement
js/projects.js     projets et compétitions : stockage, rappels, dates trouvées dans une page
js/popup.js        ajout de la page en cours
js/background.js   clic droit, rappels (notifications), badge de l'icône
js/theme.js        couleurs et image du thème de Firefox
vendor/            pdf.js 4.10.38 (Mozilla, Apache-2.0)
```

## Développer sans recharger l'extension

Sers le dossier en local (`npx http-server . -p 5517`) puis ouvre `http://localhost:5517/newtab.html`. Tout fonctionne sauf l'ouverture en nouvel onglet.
