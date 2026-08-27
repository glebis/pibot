#!/usr/bin/env python3
"""Create a managed sub-bot for a pibot agent via the owner's Telethon session.

Usage: create-sub-bot.py <name> <username> [manager_username]
- name: display name (1-64 chars)
- username: must end in 'bot' (5-32 chars)
- manager: bot username that controls the sub-bot (must have bot_can_manage_bots)

After creation, the manager bot receives Update.managed_bot and fetches the
token itself (getManagedBotToken) — this script only triggers the creation.
"""
import asyncio
import json
import os
import sys

import yaml
from telethon import TelegramClient, functions

CONFIG = os.path.expanduser("~/.config/telegram-telethon/config.yaml")
SESSION = os.path.expanduser("~/.config/telegram-telethon/session.session")


async def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "--export":
        if len(sys.argv) < 3:
            print(json.dumps({"ok": False, "error": "usage: create-sub-bot.py --export <username>"}))
            return
        username = sys.argv[2]
        cfg = yaml.safe_load(open(CONFIG))
        client = TelegramClient(SESSION.replace(".session", "") or SESSION, int(cfg["api_id"]), cfg["api_hash"])
        await client.start(phone=cfg.get("phone"))
        result = await client(functions.bots.ExportBotTokenRequest(bot=username, revoke=False))
        print(json.dumps({"ok": True, "username": username, "token": result.token}))
        await client.disconnect()
        return

    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: create-sub-bot.py <name> <username> [manager]  |  --export <username>"}))
        return
    name, username = sys.argv[1], sys.argv[2]
    manager = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("PIBOT_MANAGER_BOT", "pimother_bot")

    cfg = yaml.safe_load(open(CONFIG))
    client = TelegramClient(SESSION.replace(".session", "") or SESSION, int(cfg["api_id"]), cfg["api_hash"])
    await client.start(phone=cfg.get("phone"))

    check = await client(functions.bots.CheckUsernameRequest(username=username))
    if not check:
        print(json.dumps({"ok": False, "error": f"username '{username}' is not available"}))
        return

    result = await client(functions.bots.CreateBotRequest(name=name, username=username, manager_id=manager))
    print(json.dumps({"ok": True, "bot_id": result.id, "username": result.username, "name": result.first_name}))
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
