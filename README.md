# Real Chests

**Interactive, DM-authorized loot chests for Foundry VTT.**

Real Chests turns any chest into a living, interactive object at the table. Players click a chest on their turn; the DM decides whether they may open it; the character auto-rolls a skill check; trapped chests bite back; and successful players loot items straight into their inventory.

> System support: **dnd5e** (D&D 5e, including 2024 rules). Foundry VTT **v13+**.

## Features

- **Click-to-open chests.** Place a chest token; players double-click it to interact.
- **DM authorization on every attempt.** When a player requests to open a chest, the active GM gets an approval dialog — so the DM controls whether a player is close enough, using a spell at range, etc.
- **Contents reminder for the DM.** The approval dialog lists exactly what's inside, so the DM always knows what they're handing out.
- **Automatic skill checks.** Configure a skill (e.g. Sleight of Hand, Investigation) and a DC. On approval, the player's character auto-rolls against the DC.
- **Trapped chests.** Configure a damage formula and type (e.g. `2d6` poison). A failed check springs the trap and applies damage to the character.
- **Force unlock.** The DM's approval dialog has a *Force unlock* checkbox to bypass the check entirely — perfect when a player has disabled the trap or picked the lock in the fiction.
- **Real loot.** Stock a chest by dragging items onto it. Players take items from the chest UI directly into their character.

## Installation

**Manifest URL** (Foundry → Add-on Modules → Install Module):

```
https://github.com/cjennison/real-chests/releases/latest/download/module.json
```

Enable the module in your world (Game Settings → Manage Modules).

## Usage

### Create a chest (DM)

- Open the **Token controls** on the left toolbar and click **Create Real Chest**, or
- Run in the console: `game.modules.get('real-chests').api.createChest()`

A chest actor and token are created and its configuration sheet opens.

### Configure a chest (DM)

Open the chest (double-click its token) to set:

- **Locked** — whether a skill check is required.
- **Skill Check** + **DC** — which skill the character rolls and the target number.
- **Trap Damage** — a formula (e.g. `2d6`) and damage type applied on a failed check.
- **Contents** — drag items from any compendium, actor, or the items sidebar onto the chest to stock it.

### Open a chest (Player)

1. Double-click the chest token.
2. Click **Attempt to Open** — a request goes to the DM.
3. The DM approves or denies (and may force-unlock).
4. Your character auto-rolls the check. On success the loot opens; on failure the trap (if any) triggers.
5. Click **Take** on any item to move it into your character.

## License

[MIT](LICENSE) — free and open source. Contributions welcome.
