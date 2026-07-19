/**
 * Real Chests
 * Interactive, DM-authorized loot chests for Foundry VTT (dnd5e).
 *
 * Flow: player double-clicks a chest -> our sheet shows a "locked" view ->
 * player requests to open -> the active GM gets an approval dialog (contents
 * reminder + force-unlock checkbox) -> on approval the player's character
 * auto-rolls a configurable skill check vs a DC -> success opens the loot view,
 * failure triggers the chest's trap (damage). Players loot items straight into
 * their character; the GM can drag items in to stock the chest.
 */

const MODULE_ID = "real-chests";
const SOCKET = `module.${MODULE_ID}`;

/** Chest ids the current client has unlocked this session (per user, non-persistent). */
const unlockedChests = new Set();

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/** Read (and default) a chest's configuration from its flags. */
function getConfig(actor) {
  const f = actor?.getFlag(MODULE_ID, "config") ?? {};
  return {
    isChest: actor?.getFlag(MODULE_ID, "isChest") === true,
    locked: f.locked ?? true,
    skill: f.skill ?? "",
    dc: Number(f.dc ?? 10),
    trapFormula: f.trapFormula ?? "",
    trapType: f.trapType ?? "none",
    note: f.note ?? ""
  };
}

function isChest(actor) {
  return actor?.getFlag(MODULE_ID, "isChest") === true;
}

/** The character a user is playing, or their first owned character. */
function userCharacter(user = game.user) {
  if (user.character) return user.character;
  return game.actors.find(a => a.type === "character" && a.testUserPermission(user, "OWNER")) ?? null;
}

/** Re-render any open sheets for the given chest on this client. */
function rerenderChest(chestId) {
  const actor = game.actors.get(chestId);
  if (!actor) return;
  for (const app of Object.values(actor.apps ?? {})) app.render(false);
}

/** Build a plain-text contents list for a chest. */
function contentsList(actor) {
  if (!actor.items.size) return "<em>(empty)</em>";
  return "<ul>" + actor.items.map(i => {
    const qty = i.system?.quantity ?? 1;
    return `<li>${foundry.utils.escapeHTML?.(i.name) ?? i.name}${qty > 1 ? ` &times;${qty}` : ""}</li>`;
  }).join("") + "</ul>";
}

/** Apply trap damage to an actor across dnd5e version signatures. */
async function applyTrapDamage(actor, amount, type) {
  if (!actor || !amount) return;
  try {
    // dnd5e v3+ preferred signature
    return await actor.applyDamage([{ value: amount, type: type && type !== "none" ? type : "" }]);
  } catch (e) {
    try {
      // Older signature
      return await actor.applyDamage(amount, 1);
    } catch (e2) {
      // Last resort: adjust HP directly
      const hp = actor.system?.attributes?.hp;
      if (hp) await actor.update({ "system.attributes.hp.value": Math.max(0, (hp.value ?? 0) - amount) });
    }
  }
}

/* -------------------------------------------- */
/*  Socket handling                             */
/* -------------------------------------------- */

function emit(payload) {
  game.socket.emit(SOCKET, payload);
}

async function onSocket(data) {
  switch (data?.type) {
    case "attempt": return handleAttemptAsGM(data);
    case "decision": return handleDecisionAsPlayer(data);
    case "take": return handleTakeAsGM(data);
    case "refresh": return rerenderChest(data.chestId);
  }
}

/** GM side: a player requested to open a chest -> show approval dialog. */
async function handleAttemptAsGM(data) {
  if (game.users.activeGM?.id !== game.user.id) return; // only the primary GM adjudicates
  const chest = game.actors.get(data.chestId);
  const requester = game.users.get(data.userId);
  const pc = game.actors.get(data.actorId);
  if (!chest || !requester) return;

  const cfg = getConfig(chest);
  const skillLabel = cfg.skill ? (CONFIG.DND5E?.skills?.[cfg.skill]?.label ?? cfg.skill) : null;
  const checkLine = (cfg.locked && cfg.skill)
    ? `<p><strong>Requires:</strong> ${skillLabel} check vs DC ${cfg.dc}${cfg.trapFormula ? ` &mdash; trapped (${cfg.trapFormula} ${cfg.trapType})` : ""}</p>`
    : `<p><em>No skill check configured (will open on approval).</em></p>`;

  const content = `
    <div class="rc-approval">
      <p><strong>${requester.name}</strong>${pc ? ` (${pc.name})` : ""} wants to open <strong>${chest.name}</strong>.</p>
      ${checkLine}
      <fieldset><legend>Contents</legend>${contentsList(chest)}</fieldset>
      <label class="rc-force"><input type="checkbox" name="forceUnlock" /> Force unlock (skip the check &mdash; opens immediately)</label>
    </div>`;

  const { DialogV2 } = foundry.applications.api;
  const approved = await DialogV2.wait({
    window: { title: `Chest Access Request: ${chest.name}` },
    content,
    buttons: [
      {
        action: "approve",
        label: "Approve",
        icon: "fas fa-check",
        default: true,
        callback: (event, button) => button.form.elements.forceUnlock.checked ? "force" : "approve"
      },
      { action: "deny", label: "Deny", icon: "fas fa-ban", callback: () => "deny" }
    ],
    rejectClose: false
  }).catch(() => "deny");

  const decision = approved ?? "deny";
  emit({
    type: "decision",
    chestId: data.chestId,
    userId: data.userId,
    actorId: data.actorId,
    approved: decision !== "deny",
    forceUnlock: decision === "force"
  });
}

/** Player side: the GM responded to our request. */
async function handleDecisionAsPlayer(data) {
  if (data.userId !== game.user.id) return;
  const chest = game.actors.get(data.chestId);
  if (!chest) return;

  if (!data.approved) {
    ui.notifications.warn(`The DM denied your attempt to open ${chest.name}.`);
    return;
  }

  const cfg = getConfig(chest);
  const pc = game.actors.get(data.actorId);

  // No check needed -> open immediately.
  if (data.forceUnlock || !cfg.locked || !cfg.skill) {
    return unlockAndOpen(chest);
  }

  if (!pc) {
    ui.notifications.error("You have no assigned character to make the check.");
    return;
  }

  // Auto-roll the configured skill check for the player's character.
  const mod = pc.system?.skills?.[cfg.skill]?.total ?? 0;
  const roll = await new Roll("1d20 + @mod", { mod }).evaluate();
  const skillLabel = CONFIG.DND5E?.skills?.[cfg.skill]?.label ?? cfg.skill;
  const success = roll.total >= cfg.dc;
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor: pc }),
    flavor: `${skillLabel} check to open ${chest.name} (DC ${cfg.dc}) &mdash; ${success ? "<strong>Success!</strong>" : "<strong>Failed</strong>"}`
  });

  if (success) return unlockAndOpen(chest);

  // Failure -> spring the trap, if any.
  if (cfg.trapFormula) {
    const trap = await new Roll(cfg.trapFormula).evaluate();
    await trap.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: pc }),
      flavor: `${chest.name} was trapped! ${cfg.trapType !== "none" ? cfg.trapType + " " : ""}damage`
    });
    await applyTrapDamage(pc, trap.total, cfg.trapType);
  } else {
    ui.notifications.info(`${chest.name} stays firmly shut.`);
  }
}

/** Mark a chest unlocked for this client and open its loot view. */
function unlockAndOpen(chest) {
  unlockedChests.add(chest.id);
  chest.sheet.render(true);
  rerenderChest(chest.id);
}

/** GM side: move an item from a chest into a player's character. */
async function handleTakeAsGM(data) {
  if (game.users.activeGM?.id !== game.user.id) return;
  await doTake(data.chestId, data.itemId, data.actorId);
}

async function doTake(chestId, itemId, actorId) {
  const chest = game.actors.get(chestId);
  const pc = game.actors.get(actorId);
  const item = chest?.items.get(itemId);
  if (!chest || !pc || !item) return;
  await pc.createEmbeddedDocuments("Item", [item.toObject()]);
  await item.delete();
  emit({ type: "refresh", chestId });
  rerenderChest(chestId);
}

/* -------------------------------------------- */
/*  Custom chest sheet                          */
/* -------------------------------------------- */

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

class RealChestSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["real-chests", "rc-sheet"],
    position: { width: 480, height: "auto" },
    window: { icon: "fa-solid fa-box-open", resizable: true },
    actions: {
      rcAttempt: RealChestSheet.#onAttempt,
      rcTake: RealChestSheet.#onTake,
      rcDelete: RealChestSheet.#onDelete,
      rcToggleLock: RealChestSheet.#onToggleLock
    },
    form: { handler: RealChestSheet.#onSubmitConfig, submitOnChange: false, closeOnSubmit: false }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/chest-sheet.hbs` }
  };

  get title() {
    return this.actor?.name ?? "Chest";
  }

  async _prepareContext(options) {
    const actor = this.actor;
    const cfg = getConfig(actor);
    const isGM = game.user.isGM;
    const unlocked = isGM || unlockedChests.has(actor.id);

    const items = actor.items.map(i => {
      const qty = i.system?.quantity ?? 1;
      return { id: i.id, name: i.name, img: i.img, qty, showQty: qty > 1 };
    });

    const skills = [{ key: "", label: "— None —", selected: !cfg.skill }].concat(
      Object.entries(CONFIG.DND5E?.skills ?? {})
        .map(([key, v]) => ({ key, label: v.label, selected: key === cfg.skill }))
        .sort((a, b) => a.label.localeCompare(b.label))
    );

    const damageTypes = [{ key: "none", label: "— None —" }].concat(
      Object.entries(CONFIG.DND5E?.damageTypes ?? {}).map(([key, v]) => ({
        key, label: (v?.label ?? key)
      }))
    ).map(d => ({ ...d, selected: d.key === cfg.trapType }));

    return { actor, cfg, isGM, unlocked, items, skills, damageTypes };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    // Enable the GM to drag items onto the chest to stock it.
    if (game.user.isGM) {
      el.addEventListener("dragover", ev => ev.preventDefault());
      el.addEventListener("drop", this.#onDrop.bind(this));
    } else {
      // Players only have LIMITED ownership, so ActorSheetV2 disables every
      // control on render. Re-enable the interactive action buttons players
      // are meant to use (Attempt to Open / Take).
      for (const btn of el.querySelectorAll('button[data-action="rcAttempt"], button[data-action="rcTake"]')) {
        btn.disabled = false;
        btn.removeAttribute("disabled");
      }
    }
  }

  async #onDrop(event) {
    event.preventDefault();
    let data;
    try {
      data = JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch (e) {
      return;
    }
    if (data?.type !== "Item") return;
    const item = await Item.implementation.fromDropData(data);
    if (!item) return;
    await this.actor.createEmbeddedDocuments("Item", [item.toObject()]);
    emit({ type: "refresh", chestId: this.actor.id });
    this.render(false);
  }

  /* --- Action handlers (this === sheet instance) --- */

  static async #onAttempt(event, target) {
    const pc = userCharacter();
    if (!pc) {
      ui.notifications.error("You have no assigned character. Ask your DM to assign one.");
      return;
    }
    emit({ type: "attempt", chestId: this.actor.id, userId: game.user.id, actorId: pc.id });
    ui.notifications.info(`Requested to open ${this.actor.name}. Waiting for the DM...`);
  }

  static async #onTake(event, target) {
    const itemId = target.dataset.itemId;
    const pc = userCharacter();
    if (!pc) {
      ui.notifications.error("You have no assigned character to receive the item.");
      return;
    }
    if (game.user.isGM) {
      await doTake(this.actor.id, itemId, pc.id);
    } else {
      emit({ type: "take", chestId: this.actor.id, itemId, actorId: pc.id, userId: game.user.id });
    }
  }

  static async #onDelete(event, target) {
    const itemId = target.dataset.itemId;
    const item = this.actor.items.get(itemId);
    if (item) await item.delete();
    this.render(false);
  }

  static async #onToggleLock(event, target) {
    const cfg = getConfig(this.actor);
    await this.actor.setFlag(MODULE_ID, "config", { ...cfg, locked: !cfg.locked });
    this.render(false);
  }

  static async #onSubmitConfig(event, form, formData) {
    const d = formData.object;
    const cfg = getConfig(this.actor);
    await this.actor.setFlag(MODULE_ID, "config", {
      ...cfg,
      locked: !!d.locked,
      skill: d.skill ?? "",
      dc: Number(d.dc ?? 10),
      trapFormula: (d.trapFormula ?? "").trim(),
      trapType: d.trapType ?? "none",
      note: d.note ?? ""
    });
    ui.notifications.info(`${this.actor.name} configuration saved.`);
    this.render(false);
  }
}

/* -------------------------------------------- */
/*  Chest creation                              */
/* -------------------------------------------- */

async function createChest({ name = "Chest", img = "icons/svg/chest.svg", drop = true } = {}) {
  const LIMITED = CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
  const actor = await Actor.create({
    name,
    type: "npc",
    img,
    ownership: { default: LIMITED },
    prototypeToken: {
      name,
      texture: { src: img },
      actorLink: false,
      disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
      sight: { enabled: false }
    },
    flags: {
      [MODULE_ID]: {
        isChest: true,
        config: { locked: true, skill: "", dc: 10, trapFormula: "", trapType: "none", note: "" }
      },
      core: { sheetClass: `${MODULE_ID}.RealChestSheet` }
    }
  });

  if (drop && canvas?.ready && canvas.scene) {
    const d = canvas.dimensions;
    const x = Math.round((d?.sceneX ?? 0) + (d?.sceneWidth ?? 2000) / 2);
    const y = Math.round((d?.sceneY ?? 0) + (d?.sceneHeight ?? 2000) / 2);
    const tokenData = (await actor.getTokenDocument({ x, y })).toObject();
    await canvas.scene.createEmbeddedDocuments("Token", [tokenData]);
  }

  actor.sheet.render(true);
  return actor;
}

/* -------------------------------------------- */
/*  Hooks                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const DSC = foundry.applications.apps?.DocumentSheetConfig ?? globalThis.DocumentSheetConfig;
  DSC.registerSheet(Actor, MODULE_ID, RealChestSheet, {
    types: ["npc"],
    makeDefault: false,
    label: "Real Chest"
  });
  console.log(`${MODULE_ID} | initialised`);
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
  const mod = game.modules.get(MODULE_ID);
  mod.api = { createChest, getConfig, isChest, doTake, unlockedChests, RealChestSheet };
  console.log(`${MODULE_ID} | ready. Create a chest with: game.modules.get('${MODULE_ID}').api.createChest()`);
});

// GM tool to create a chest from the Token scene controls.
Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;
  const tool = {
    name: "create-chest",
    title: "Create Real Chest",
    icon: "fa-solid fa-box-open",
    button: true,
    order: 99,
    onChange: () => createChest(),
    onClick: () => createChest()
  };
  // v13+ controls is an object keyed by control name; v12 is an array.
  if (Array.isArray(controls)) {
    const tokens = controls.find(c => c.name === "token" || c.name === "tokens");
    tokens?.tools?.push(tool);
  } else {
    const tokens = controls.tokens ?? controls.token;
    if (tokens?.tools) tokens.tools["create-chest"] = tool;
  }
});
