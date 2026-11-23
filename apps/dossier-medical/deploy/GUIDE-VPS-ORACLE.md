# Installer « Dossier médical » sur un VPS Oracle Cloud

L'appli est un simple site (une page web, sans base de données). Le serveur ne fait que l'afficher : tes documents restent chiffrés dans Google Drive et tes rendez-vous dans Google Agenda. Rien de médical n'est stocké sur le VPS.

Compte environ 30 minutes.

## Ce qu'il te faut

- Un compte **Oracle Cloud** (l'offre gratuite « Always Free » suffit).
- Un **nom de domaine**, par exemple `dossier.mon-domaine.fr`. Il est **obligatoire** : sans HTTPS, le navigateur bloque l'empreinte, le chiffrement et la connexion Google. Si tu n'en as pas, un sous-domaine gratuit sur [duckdns.org](https://www.duckdns.org) fonctionne très bien (ex : `mon-dossier.duckdns.org`).
- L'accès à ta **console Google Cloud**, où a été créé l'identifiant de connexion Google de l'appli (étape 6).

## 1. Créer le serveur

1. Dans la console Oracle Cloud : **Menu ☰ › Compute › Instances › Create instance**.
2. **Image** : clique sur *Change image* et choisis **Canonical Ubuntu 24.04**.
3. **Shape** : clique sur *Change shape* › **Ampere** › **VM.Standard.A1.Flex**, avec 1 OCPU et 6 Go de mémoire (gratuit).
   - L'image Ubuntu doit correspondre au processeur : avec A1.Flex (ARM), prends la version **aarch64** d'Ubuntu 24.04. Si Oracle affiche « Shape … is not valid for image … », c'est que les deux ne correspondent pas : change l'image ou la forme.
   - `VM.Standard.E2.1.Micro` (AMD) marche aussi, mais seulement avec l'image Ubuntu 24.04 **sans** « aarch64 », et elle est souvent indisponible.
   - Si Oracle répond « Out of capacity », réessaie plus tard ou change d'*Availability domain*.
4. **Add SSH keys** : choisis *Generate a key pair for me* puis **Save private key**. Garde ce fichier `.key` précieusement : c'est ta clé pour entrer sur le serveur.
5. Clique sur **Create**. Quand l'instance est « Running », note son **Public IP address**.

## 2. Ouvrir les ports web (80 et 443) côté Oracle

Par défaut, Oracle n'autorise que SSH.

1. Sur la page de l'instance, clique sur le **Subnet** (section *Primary VNIC*).
2. Ouvre la **Security List** par défaut (*Default Security List for …*).
3. **Add Ingress Rules**, deux fois :
   - Source CIDR `0.0.0.0/0` · IP Protocol **TCP** · Destination Port Range **80**
   - Source CIDR `0.0.0.0/0` · IP Protocol **TCP** · Destination Port Range **443**

(Le pare-feu interne du serveur est ouvert automatiquement par le script de l'étape 5.)

## 3. Faire pointer ton domaine vers le serveur

Chez ton fournisseur de domaine, crée un enregistrement **A** :

| Type | Nom | Valeur |
|---|---|---|
| A | `dossier` (ou `@` pour le domaine nu) | l'IP publique notée à l'étape 1 |

Avec DuckDNS : connecte-toi, crée ton sous-domaine et colle l'IP publique dans le champ *current ip*, puis **update ip**.

Attends quelques minutes que ça se propage.

## 4. Se connecter au serveur

Depuis un terminal (PowerShell sur Windows, Terminal sur Mac) :

```bash
ssh -i chemin/vers/ta-cle.key ubuntu@IP_PUBLIQUE
```

Sur Mac ou Linux, si SSH refuse la clé (« permissions too open ») : `chmod 600 chemin/vers/ta-cle.key`.

## 5. Installer l'appli (une seule commande)

Une fois connecté au serveur, remplace le domaine et l'e-mail, puis colle :

```bash
curl -fsSL https://raw.githubusercontent.com/maxencedevos83/Suivi-Hydratation/main/apps/dossier-medical/deploy/installer.sh -o installer.sh
sudo bash installer.sh dossier.mon-domaine.fr ton-email@exemple.fr
```

Le script installe nginx, ouvre les ports, récupère l'appli depuis GitHub et obtient un certificat HTTPS gratuit (Let's Encrypt, renouvelé tout seul). Il se termine par :

```
✅ L'appli est en ligne : https://dossier.mon-domaine.fr/
```

> Tant que la PR n'est pas fusionnée, l'appli n'est pas encore sur la branche `main`. Pour l'installer quand même, remplace `main` par `claude/app-dossier-medical` dans l'adresse du `curl`, et lance `sudo BRANCHE=claude/app-dossier-medical bash installer.sh …`.

## 6. Autoriser la nouvelle adresse pour la connexion Google

Sans cette étape, le bouton « Se connecter avec Google » refuse de fonctionner sur ton nouveau domaine.

1. Va sur [console.cloud.google.com](https://console.cloud.google.com) › **APIs & Services › Credentials** (Identifiants).
2. Ouvre l'identifiant OAuth du client Web qui commence par `473355473317-…`.
3. Dans **Authorized JavaScript origins** (Origines JavaScript autorisées), ajoute `https://dossier.mon-domaine.fr` (sans `/` à la fin).
4. **Save**. Ça peut prendre quelques minutes avant de marcher.

Côté script Google (Apps Script), il n'y a rien à changer.

## 7. Premier lancement sur ton téléphone

Ouvre `https://dossier.mon-domaine.fr/`. Le navigateur traite cette adresse comme un nouveau site, alors tu refais une seule fois :

1. La connexion avec ton compte Google.
2. L'activation de l'empreinte (onglet Dossier médical).
3. La saisie de ta phrase secrète. Tes documents et ton coffre restent les mêmes.

Pour l'avoir comme une appli : menu du navigateur › **Ajouter à l'écran d'accueil** (ou **Installer l'application**).

## Mettre à jour plus tard

Reconnecte-toi au serveur et relance la même commande :

```bash
sudo bash installer.sh dossier.mon-domaine.fr ton-email@exemple.fr
```

Le script récupère la dernière version et garde le certificat.

## En cas de problème

| Symptôme | Cause probable |
|---|---|
| Le script s'arrête sur « pointe vers … alors que ce serveur est … » | L'enregistrement DNS n'est pas encore à jour : vérifie l'étape 3, attends, relance. |
| Le site ne répond pas du tout | Les règles d'entrée de l'étape 2 manquent (ports 80 et 443). |
| Le bouton Google affiche une erreur ou ne s'affiche pas | L'origine de l'étape 6 n'est pas ajoutée, ou pas encore prise en compte. |
| « Empreinte non vérifiée » | Le site doit être ouvert en `https://`, jamais par son IP. |
