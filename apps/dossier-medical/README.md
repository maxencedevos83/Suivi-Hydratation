# Dossier médical

Application séparée qui reprend uniquement deux onglets de Suivi Hydrique Pro :

- **📅 Agenda** : rendez-vous médicaux synchronisés avec l'agenda Google « 🩺 RDV médicaux ».
- **📁 Dossier médical sécurisé** : documents chiffrés sur l'appareil (AES-256) puis rangés dans Google Drive, déverrouillés par empreinte et phrase secrète.

Elle utilise le **même script Google Apps Script** que Suivi Hydrique Pro (`apps-script/Code.gs` à la racine du dépôt) : même connexion Google, mêmes rendez-vous, même coffre et mêmes documents. Rien à redéployer.

Publiée avec GitHub Pages, elle est accessible à l'adresse :
https://maxencedevos83.github.io/Suivi-Hydratation/apps/dossier-medical/

Comme les deux applis sont sur le même site, la session, l'empreinte et la clé du dossier enregistrées sur un appareil sont partagées entre elles.

Pour l'héberger sur ton propre serveur (ex : VPS Oracle Cloud), suis [deploy/GUIDE-VPS-ORACLE.md](deploy/GUIDE-VPS-ORACLE.md).
