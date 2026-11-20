"""Compte Telegram personnel de NLR (Telethon). Mandat du 16 nov. 2026.

Configuration : <dataDir>/telegram-user.json  {"api_id": 123, "api_hash": "...", "phone": "+33..."}
Session       : <dataDir>/telegram-user.session

Sous-commandes (sortie JSON sur stdout, une ligne) :
  login                    interactif : code reçu, puis mot de passe 2FA s'il existe
  login --phone X|-        non interactif (réglages desktop) : demande le code ; étape suivante
  login --code Y|-         envoie le code reçu ; peut répondre {"step": "password"}
  login --password Z|-     mot de passe 2FA ; « - » lit la valeur sur stdin (jamais en argument)
  status                   connecté ou non, nom du compte ; aucun secret
  resolve <cible>          @username, id numérique ou nom exact d'une conversation privée
  send <cible> [texte|-]   texte en argument, ou lu sur stdin si absent ou « - »
  recent <cible> [n]       n derniers messages (auteur moi/lui, date, texte)
  dialogs [n]              n dialogues recents : id, nom, type, date du dernier message, media, sens
  media --dest DIR [--to C] [--message-id N] [--scan N] [--max-bytes B]
                           telecharge (lecture seule) le document d'un message, ou le dernier
                           document ENTRANT (de --to, ou des N dialogues recents) ; jamais execute
                           ni decompresse ; refus au-dela de --max-bytes

Le dossier de données vient de --data-dir ou de MIND_WAKE_DATA_DIR. Aucun secret
(api_hash, téléphone, code, mot de passe, session) n'est écrit sur stdout ni stderr.
Erreurs : {"ok": false, "error": <code>, "message": ..., "definite": true|false}.
Session verrouillee par un autre processus (relais inbound) : erreur « session_locked » ; l'appelant
reessaie apres un court delai.
« definite » vaut true quand rien n'a pu partir (refus net), false quand l'issue est incertaine.
"""
import argparse
import asyncio
import json
import os
import re
import sqlite3
import sys

TEXT_MAX = 4000


def emit(payload, code=0):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def fail(error, message, definite=True, code=1, **extra):
    emit({"ok": False, "error": error, "message": message, "definite": definite, **extra}, code)


try:
    from telethon import TelegramClient, errors, utils  # type: ignore
    from telethon.tl.types import InputMessagesFilterDocument, User  # type: ignore
except ImportError:
    fail(
        "telethon_missing",
        "Telethon n'est pas installe pour ce Python. Installer avec : "
        + '"' + sys.executable + '" -m pip install telethon',
    )


def load_config(data_dir):
    file = os.path.join(data_dir, "telegram-user.json")
    if not os.path.isfile(file):
        fail("not_configured", "telegram-user.json absent du dossier de donnees (api_id, api_hash, phone).")
    try:
        with open(file, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        api_id = int(raw["api_id"])
        api_hash = str(raw["api_hash"]).strip()
        phone = str(raw.get("phone", "")).strip()
    except Exception:  # aucun détail : le contenu peut être secret
        fail("not_configured", "telegram-user.json illisible : il faut api_id (nombre), api_hash et phone.")
    if not api_hash:
        fail("not_configured", "telegram-user.json : api_hash vide.")
    return api_id, api_hash, phone


def make_client(data_dir):
    api_id, api_hash, phone = load_config(data_dir)
    session = os.path.join(data_dir, "telegram-user")  # Telethon ajoute « .session »
    client = TelegramClient(session, api_id, api_hash, device_model="MIND Wake", app_version="1.0")
    return client, phone


def display_name(entity):
    name = utils.get_display_name(entity) or ""
    return name


def describe(entity):
    username = getattr(entity, "username", None)
    return {
        "id": int(utils.get_peer_id(entity)),
        "name": display_name(entity),
        "username": ("@" + username) if username else None,
        "kind": "user" if isinstance(entity, User) else "chat",
    }


async def resolve(client, target):
    target = target.strip()
    if not target:
        fail("invalid_target", "Cible vide.")
    if target.startswith("@"):
        try:
            return await client.get_entity(target)
        except (ValueError, errors.RPCError):
            fail("not_found", "Aucun compte ou canal pour " + target[:64] + ".")
    if target.lstrip("-").isdigit():
        wanted = int(target)
        try:
            return await client.get_entity(wanted)
        except (ValueError, errors.RPCError):
            pass
        async for dialog in client.iter_dialogs():
            if int(dialog.id) == wanted or int(getattr(dialog.entity, "id", 0)) == wanted:
                return dialog.entity
        fail("not_found", "Aucun dialogue avec l'id " + target[:32] + ".")
    matches = []
    async for dialog in client.iter_dialogs():
        if dialog.is_user and display_name(dialog.entity) == target:
            matches.append(dialog.entity)
    if not matches:
        fail("not_found", "Aucune conversation privee nommee exactement « " + target[:64] + " ».")
    if len(matches) > 1:
        fail("ambiguous", "Plusieurs conversations privees portent ce nom ; utiliser l'id ou le @username.")
    return matches[0]


async def require_login(client):
    try:
        await client.connect()
    except Exception:
        fail("network", "Connexion a Telegram impossible.")
    if not await client.is_user_authorized():
        fail("not_logged_in", "Compte non connecte : lancer la sous-commande login une fois.")


async def cmd_login(client, phone):
    import getpass

    if not phone:
        fail("not_configured", "telegram-user.json : phone manquant pour la connexion.")
    await client.start(
        phone=lambda: phone,
        code_callback=lambda: input("Code recu dans Telegram : ").strip(),
        password=lambda: getpass.getpass("Mot de passe 2FA (vide si aucun) : "),
    )
    me = await client.get_me()
    return {"ok": True, "logged_in": True, "account": describe(me)}


LOGIN_STATE = "telegram-user.login.json"


def login_state_path(data_dir):
    return os.path.join(data_dir, LOGIN_STATE)


def read_login_state(data_dir):
    try:
        with open(login_state_path(data_dir), "r", encoding="utf-8") as handle:
            state = json.load(handle)
        return str(state["phone"]), str(state["phone_code_hash"])
    except Exception:
        fail("no_pending_login", "Aucune connexion en cours : saisir d'abord le numero de telephone.")


def clear_login_state(data_dir):
    try:
        os.remove(login_state_path(data_dir))
    except OSError:
        pass


async def connect_for_login(client):
    try:
        await client.connect()
    except Exception:
        fail("network", "Connexion a Telegram impossible.")


async def logged_in_result(client, data_dir):
    clear_login_state(data_dir)
    me = await client.get_me()
    return {"ok": True, "logged_in": True, "step": "done", "account": describe(me)}


async def cmd_login_phone(client, data_dir, phone):
    """Étape 1 non interactive : Telegram envoie un code ; le hash est gardé pour l'étape 2."""
    await connect_for_login(client)
    if await client.is_user_authorized():
        return await logged_in_result(client, data_dir)
    try:
        sent = await client.send_code_request(phone)
    except errors.PhoneNumberInvalidError:
        fail("phone_invalid", "Numero de telephone refuse par Telegram.")
    except errors.FloodWaitError as error:
        fail("flood_wait", "Telegram impose une attente de " + str(error.seconds) + " s.", seconds=int(error.seconds))
    file = login_state_path(data_dir)
    with open(file, "w", encoding="utf-8") as handle:
        json.dump({"phone": phone, "phone_code_hash": sent.phone_code_hash}, handle)
    try:
        os.chmod(file, 0o600)
    except OSError:
        pass
    return {"ok": True, "logged_in": False, "step": "code"}


async def cmd_login_code(client, data_dir, code):
    phone, phone_code_hash = read_login_state(data_dir)
    await connect_for_login(client)
    try:
        await client.sign_in(phone=phone, code=code, phone_code_hash=phone_code_hash)
    except errors.SessionPasswordNeededError:
        return {"ok": True, "logged_in": False, "step": "password"}
    except errors.PhoneCodeInvalidError:
        fail("code_invalid", "Code incorrect.")
    except errors.PhoneCodeExpiredError:
        clear_login_state(data_dir)
        fail("code_expired", "Code expire : recommencer avec le numero de telephone.")
    return await logged_in_result(client, data_dir)


async def cmd_login_password(client, data_dir, password):
    await connect_for_login(client)
    try:
        await client.sign_in(password=password)
    except errors.PasswordHashInvalidError:
        fail("password_invalid", "Mot de passe 2FA incorrect.")
    return await logged_in_result(client, data_dir)


async def cmd_status(client):
    try:
        await client.connect()
    except Exception:
        fail("network", "Connexion a Telegram impossible.")
    if not await client.is_user_authorized():
        return {"ok": True, "logged_in": False, "account": None}
    me = await client.get_me()
    return {"ok": True, "logged_in": True, "account": describe(me)}


async def cmd_resolve(client, target):
    await require_login(client)
    return {"ok": True, "peer": describe(await resolve(client, target))}


CAPTION_MAX = 1024


async def cmd_send(client, target, text, file=None):
    if not text.strip():
        fail("invalid_text", "Texte vide.")
    if len(text) > TEXT_MAX:
        fail("invalid_text", "Texte trop long (" + str(TEXT_MAX) + " caracteres au plus).")
    if file is not None and not os.path.isfile(file):
        fail("not_found", "Fichier joint introuvable.")
    await require_login(client)
    peer = await resolve(client, target)
    try:
        if file is None:
            message = await client.send_message(peer, text, parse_mode=None, link_preview=False)
        else:
            # Fichier joint avec le texte en legende ; legende trop longue : le texte suit a part.
            long = len(text) > CAPTION_MAX
            message = await client.send_file(peer, file, caption=None if long else text, parse_mode=None)
            if long:
                await client.send_message(peer, text, parse_mode=None, link_preview=False)
    except errors.FloodWaitError as error:
        fail("flood_wait", "Telegram impose une attente de " + str(error.seconds) + " s avant un nouvel envoi.", seconds=int(error.seconds))
    except errors.RPCError as error:
        # Refus explicite de Telegram : le message n'est pas parti.
        fail("telegram_refused", "Telegram a refuse l'envoi : " + type(error).__name__ + ".")
    except Exception:
        fail("uncertain", "Envoi interrompu ; issue incertaine.", definite=False)
    return {"ok": True, "message_id": int(message.id), "peer": describe(peer), "date": message.date.isoformat()}


async def cmd_recent(client, target, limit):
    limit = max(1, min(int(limit), 50))
    await require_login(client)
    peer = await resolve(client, target)
    messages = await client.get_messages(peer, limit=limit)
    items = []
    for message in reversed(list(messages)):
        items.append(
            {
                "id": int(message.id),
                "author": "moi" if message.out else "lui",
                "date": message.date.isoformat() if message.date else None,
                "text": message.message or "",
                "media": bool(message.media),
            }
        )
    return {"ok": True, "peer": describe(peer), "messages": items}


async def resolve_quiet(client, target):
    """Comme resolve, sans quitter le processus : None si la cible est introuvable ou ambigue."""
    target = (target or "").strip()
    if not target:
        return None
    try:
        if target.startswith("@"):
            return await client.get_entity(target)
        if target.lstrip("-").isdigit():
            wanted = int(target)
            try:
                return await client.get_entity(wanted)
            except (ValueError, errors.RPCError):
                pass
            async for dialog in client.iter_dialogs():
                if int(dialog.id) == wanted or int(getattr(dialog.entity, "id", 0)) == wanted:
                    return dialog.entity
            return None
        matches = []
        async for dialog in client.iter_dialogs():
            if dialog.is_user and display_name(dialog.entity) == target:
                matches.append(dialog.entity)
        return matches[0] if len(matches) == 1 else None
    except errors.FloodWaitError:
        raise
    except (ValueError, errors.RPCError):
        return None


async def cmd_inbound(client, request):
    """
    Messages recus depuis un id, pour plusieurs dialogues en une connexion (routage vers les
    coachs Telegram). Entree : {"peers": [{"key", "target", "after": id|null}]}. after null : point
    de depart seulement (dernier id, aucun message rendu). Sortie par pair : last_id (plus grand
    id vu) et messages depuis after, envoyes compris (author moi = NLR, lui = l'autre), du plus
    ancien au plus recent.
    """
    await require_login(client)
    out = []
    peers = request.get("peers") if isinstance(request, dict) else None
    for item in peers if isinstance(peers, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("key"), str):
            continue
        key = item["key"]
        after = item.get("after")
        try:
            peer = await resolve_quiet(client, str(item.get("target") or ""))
            if peer is None:
                out.append({"key": key, "ok": False, "error": "not_found"})
                continue
            if not isinstance(after, int):
                latest = await client.get_messages(peer, limit=1)
                last_id = int(latest[0].id) if len(latest) > 0 else 0
                out.append({"key": key, "ok": True, "peer": describe(peer), "last_id": last_id, "messages": []})
                continue
            found = await client.get_messages(peer, min_id=after, limit=50)
            items = []
            last_id = after
            for message in reversed(list(found)):
                last_id = max(last_id, int(message.id))
                items.append(
                    {
                        "id": int(message.id),
                        "author": "moi" if message.out else "lui",
                        "date": message.date.isoformat() if message.date else None,
                        "text": message.message or "",
                        "media": bool(message.media),
                    }
                )
            out.append({"key": key, "ok": True, "peer": describe(peer), "last_id": last_id, "messages": items})
        except errors.FloodWaitError as error:
            out.append({"key": key, "ok": False, "error": "flood_wait", "seconds": int(error.seconds)})
            break
    return {"ok": True, "peers": out}


async def cmd_search(client, query, target, limit):
    """
    Recherche de messages : dans tous les dialogues (target vide, recherche globale de Telegram)
    ou dans un dialogue. Rend dialogue, auteur, date, texte, du plus recent au plus ancien.
    """
    query = (query or "").strip()
    if not query:
        fail("invalid_query", "Recherche vide.")
    limit = max(1, min(int(limit), 100))
    await require_login(client)
    peer = await resolve(client, target) if target else None
    items = []
    async for message in client.iter_messages(peer, search=query, limit=limit):
        chat = None
        try:
            chat = await message.get_chat()
        except Exception:
            chat = None
        sender = None
        try:
            sender = await message.get_sender()
        except Exception:
            sender = None
        items.append(
            {
                "id": int(message.id),
                "dialog": describe(chat) if chat is not None else None,
                "author": "moi" if message.out else (display_name(sender) if sender is not None else None),
                "date": message.date.isoformat() if message.date else None,
                "text": message.message or "",
                "media": bool(message.media),
            }
        )
    return {"ok": True, "query": query, "dialog": describe(peer) if peer is not None else None, "messages": items}


def dialog_type(dialog):
    if dialog.is_user:
        return "private"
    if dialog.is_channel and not dialog.is_group:
        return "channel"
    return "group"


async def cmd_dialogs(client, limit):
    """Dialogues recents dans l'ordre de Telegram (epingles d'abord) ; aucun texte de message rendu."""
    limit = max(1, min(int(limit), 100))
    await require_login(client)
    items = []
    async for dialog in client.iter_dialogs(limit=limit):
        last = dialog.message
        items.append(
            {
                "id": int(dialog.id),
                "name": dialog.name or "",
                "type": dialog_type(dialog),
                "date": dialog.date.isoformat() if dialog.date else None,
                "last_media": bool(last is not None and last.media),
                "last_direction": None if last is None else ("out" if last.out else "in"),
                "unread": int(getattr(dialog, "unread_count", 0) or 0),
            }
        )
    return {"ok": True, "dialogs": items}


SAFE_NAME = re.compile(r"[^\w.\- ()\[\]+,=@]+", re.UNICODE)


def safe_file_name(name, message_id, ext):
    """Nom de fichier sans chemin ni caractere reserve, prefixe par l'id du message."""
    base = os.path.basename((name or "").replace("\\", "/")).strip().strip(".")
    base = SAFE_NAME.sub("_", base)[:120].strip()
    if not base:
        base = "document" + (ext or "")
    return str(int(message_id)) + "-" + base


def is_document(message):
    return message is not None and message.file is not None and (message.document is not None or message.photo is not None)


async def latest_incoming_document(client, peer):
    found = await client.get_messages(peer, limit=20, filter=InputMessagesFilterDocument)
    for message in found:
        if not message.out and message.document is not None:
            return message
    return None


async def cmd_media(client, dest, target, message_id, scan, max_bytes):
    """
    Telecharge un document recu (lecture seule). Avec message_id : ce message de `target`.
    Sinon : dernier document ENTRANT de `target`, ou des `scan` dialogues les plus recents.
    Le fichier est ecrit dans `dest` (cree au besoin), jamais ouvert, execute ni decompresse.
    """
    if not dest or not os.path.isabs(dest):
        fail("invalid_dest", "Dossier de destination absolu attendu.")
    scan = max(1, min(int(scan), 100))
    await require_login(client)
    message = None
    peer = None
    if message_id is not None:
        if not target:
            fail("invalid_target", "message_id demande aussi le dialogue (to).")
        peer = await resolve(client, target)
        message = await client.get_messages(peer, ids=int(message_id))
        if not is_document(message):
            fail("no_document", "Ce message ne porte aucun document.")
    elif target:
        peer = await resolve(client, target)
        message = await latest_incoming_document(client, peer)
    else:
        async for dialog in client.iter_dialogs(limit=scan):
            # Dernier message du dialogue plus ancien que le meilleur document : rien de plus recent ici.
            # (Pas d'arret : les dialogues epingles viennent en tete, quelle que soit leur date.)
            if message is not None and dialog.date is not None and dialog.date <= message.date:
                continue
            candidate = await latest_incoming_document(client, dialog.entity)
            if candidate is not None and (message is None or candidate.date > message.date):
                message = candidate
                peer = dialog.entity
    if message is None:
        fail("no_document", "Aucun document recu dans les dialogues parcourus.", scanned=1 if target else scan)
    size = message.file.size
    if size is not None and int(size) > int(max_bytes):
        fail(
            "too_large",
            "Document trop gros (" + str(int(size)) + " octets ; plafond " + str(int(max_bytes)) + ") : non telecharge.",
            size=int(size),
        )
    os.makedirs(dest, exist_ok=True)
    name = safe_file_name(message.file.name, message.id, message.file.ext)
    final = os.path.join(dest, name)
    partial = final + ".part"
    try:
        written = await client.download_media(message, file=partial)
    except Exception:
        try:
            os.remove(partial)
        except OSError:
            pass
        raise
    if not written or not os.path.isfile(partial):
        fail("download_failed", "Telechargement sans fichier.")
    if os.path.getsize(partial) > int(max_bytes):
        os.remove(partial)
        fail("too_large", "Document plus gros que le plafond une fois telecharge : supprime.")
    os.replace(partial, final)
    return {
        "ok": True,
        "path": final,
        "name": message.file.name or name,
        "size": os.path.getsize(final),
        "mime": message.file.mime_type,
        "date": message.date.isoformat() if message.date else None,
        "message_id": int(message.id),
        "direction": "out" if message.out else "in",
        "dialog": {"id": int(utils.get_peer_id(peer)), "name": display_name(peer)},
    }


def is_locked(error):
    return isinstance(error, sqlite3.OperationalError) and "locked" in str(error).lower()


def main():
    parser = argparse.ArgumentParser(description="Compte Telegram personnel (Telethon)")
    parser.add_argument("--data-dir", default=os.environ.get("MIND_WAKE_DATA_DIR"))
    sub = parser.add_subparsers(dest="command", required=True)
    p_login = sub.add_parser("login")
    steps = p_login.add_mutually_exclusive_group()
    steps.add_argument("--phone")
    steps.add_argument("--code")
    steps.add_argument("--password")
    sub.add_parser("status")
    p_resolve = sub.add_parser("resolve")
    p_resolve.add_argument("target")
    p_send = sub.add_parser("send")
    p_send.add_argument("target")
    p_send.add_argument("text", nargs="?", default="-")
    p_send.add_argument("--file", default=None)
    sub.add_parser("inbound")
    p_search = sub.add_parser("search")
    p_search.add_argument("query")
    p_search.add_argument("target", nargs="?", default="")
    p_search.add_argument("limit", nargs="?", type=int, default=20)
    p_dialogs = sub.add_parser("dialogs")
    p_dialogs.add_argument("limit", nargs="?", type=int, default=20)
    p_media = sub.add_parser("media")
    p_media.add_argument("--dest", required=True)
    p_media.add_argument("--to", default="")
    p_media.add_argument("--message-id", type=int, default=None)
    p_media.add_argument("--scan", type=int, default=20)
    p_media.add_argument("--max-bytes", type=int, default=50 * 1024 * 1024)
    p_recent = sub.add_parser("recent")
    p_recent.add_argument("target")
    p_recent.add_argument("limit", nargs="?", type=int, default=10)
    args = parser.parse_args()
    if not args.data_dir or not os.path.isdir(args.data_dir):
        fail("not_configured", "Dossier de donnees introuvable : --data-dir ou MIND_WAKE_DATA_DIR.")
    inbound_request = None
    if args.command == "inbound":
        try:
            inbound_request = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
        except ValueError:
            fail("invalid_request", "Requete inbound : JSON attendu sur stdin.")
    if args.command == "send" and args.text == "-":
        args.text = sys.stdin.buffer.read().decode("utf-8")
    if args.command == "login":
        for name in ("phone", "code", "password"):
            if getattr(args, name) == "-":
                setattr(args, name, sys.stdin.buffer.read().decode("utf-8").strip())
            if getattr(args, name) is not None and not getattr(args, name):
                fail("invalid_" + name, "Valeur vide.")

    try:
        client, phone = make_client(args.data_dir)
    except sqlite3.OperationalError as error:
        if is_locked(error):
            fail("session_locked", "Session Telegram tenue par un autre processus ; reessayer.", definite=True)
        raise

    async def run():
        try:
            if args.command == "login":
                if args.phone is not None:
                    return await cmd_login_phone(client, args.data_dir, args.phone)
                if args.code is not None:
                    return await cmd_login_code(client, args.data_dir, args.code)
                if args.password is not None:
                    return await cmd_login_password(client, args.data_dir, args.password)
                return await cmd_login(client, phone)
            if args.command == "status":
                return await cmd_status(client)
            if args.command == "resolve":
                return await cmd_resolve(client, args.target)
            if args.command == "send":
                return await cmd_send(client, args.target, args.text, args.file)
            if args.command == "inbound":
                return await cmd_inbound(client, inbound_request)
            if args.command == "search":
                return await cmd_search(client, args.query, args.target, args.limit)
            if args.command == "dialogs":
                return await cmd_dialogs(client, args.limit)
            if args.command == "media":
                return await cmd_media(client, args.dest, args.to.strip(), args.message_id, args.scan, args.max_bytes)
            return await cmd_recent(client, args.target, args.limit)
        finally:
            try:
                await client.disconnect()
            except Exception:
                pass

    try:
        result = asyncio.run(run())
    except SystemExit:
        raise
    except KeyboardInterrupt:
        fail("interrupted", "Interrompu.")
    except errors.FloodWaitError as error:
        # Hors de l'envoi lui-même (résolution, lecture) : rien n'est parti.
        fail("flood_wait", "Telegram impose une attente de " + str(error.seconds) + " s.", seconds=int(error.seconds))
    except Exception as error:
        if is_locked(error):
            # Lecture : rien n'est parti. Envoi : issue incertaine.
            fail("session_locked", "Session Telegram tenue par un autre processus ; reessayer.", definite=args.command != "send")
        fail("telegram_error", "Erreur Telegram : " + type(error).__name__ + ".", definite=args.command != "send")
    emit(result)


if __name__ == "__main__":
    main()
