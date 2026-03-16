"""
Enrich auto-generated D2 schemas with column descriptions from known documentation.

Applies known column descriptions, fixes type misdetections, and adds
cross-reference targets based on the D2R Data Guide and Phrozen Keep docs.

Usage: python scripts/enrich-schemas.py <schema_dir>
"""

import json
import os
import sys
from glob import glob

# ── Known Column Descriptions ───────────────────────────────────────────────
# Shared across armor.txt, weapons.txt, misc.txt (and many other files)

COMMON_DESCRIPTIONS = {
    # Identity
    "name": "Internal name identifier",
    "code": "Unique 3-4 character item code",
    "namestr": "String key for display name (references .tbl files)",
    "version": "Game version (0=Classic D2, 1=New Classic, 100=Expansion)",
    "*id": "Row index (comment field, not used by game)",
    "id": "Unique numeric ID",
    "index": "Unique index identifier",

    # Item basics
    "rarity": "Spawn rarity ratio (1/N chance)",
    "spawnable": "Can randomly spawn in the game",
    "level": "Base item level",
    "levelreq": "Minimum character level required to equip",
    "reqstr": "Strength requirement to equip",
    "reqdex": "Dexterity requirement to equip",
    "cost": "Base NPC gold cost",
    "gamble cost": "Gambling cost override (rings/amulets)",
    "magic lvl": "Magic modifier level for affixes",
    "auto prefix": "AutoMagic group index",
    "compactsave": "Save item stats only (no durability/quantity)",
    "speed": "Speed reduction modifier (negative = faster)",

    # Durability
    "durability": "Base durability value (0-255)",
    "nodurability": "Item has no durability",
    "durwarning": "Low durability warning threshold",

    # Damage
    "mindam": "Minimum one-handed physical damage",
    "maxdam": "Maximum one-handed physical damage",
    "2handmindam": "Minimum two-handed physical damage",
    "2handmaxdam": "Maximum two-handed physical damage",
    "minmisdam": "Minimum throwing/missile damage",
    "maxmisdam": "Maximum throwing/missile damage",
    "strbonus": "Strength damage bonus (percentage per 100 str)",
    "dexbonus": "Dexterity damage bonus (percentage per 100 dex)",
    "rangeadder": "Melee range extension (grid spaces)",

    # Defense
    "minac": "Minimum defense value",
    "maxac": "Maximum defense value",
    "block": "Block chance percentage (0-75)",
    "absorbs": "Damage absorption percentage",

    # Visual
    "invwidth": "Inventory grid width",
    "invheight": "Inventory grid height",
    "invfile": "Inventory graphics DC6 file",
    "uniqueinvfile": "Unique quality inventory DC6 file",
    "setinvfile": "Set quality inventory DC6 file",
    "flippyfile": "Ground display DC6 file",
    "alternategfx": "Alternate character graphics code",
    "component": "Animation layer component index",
    "invtrans": "Inventory color transform palette index",
    "transform": "Character model color palette transform",
    "lightradius": "Light radius around item/character",
    "transparent": "Enable transparency rendering",
    "transtbl": "Transparency type code",

    # Item type/class
    "type": "Primary item type code (references ItemTypes.txt)",
    "type2": "Secondary item type code",
    "wclass": "One-handed weapon class code",
    "2handedwclass": "Two-handed weapon class code",
    "1or2handed": "Can be wielded in one or two hands (Barbarian)",
    "2handed": "Two-handed weapon flag",
    "hit class": "Impact sound effect class",

    # Socket/gem
    "hasinv": "Item is socketable",
    "gemsockets": "Maximum number of sockets",
    "gemapplytype": "Gem effect application (0=Weapon, 1=Armor, 2=Shield)",
    "gemoffset": "Gem/rune starting index in Gems.txt",

    # Stack
    "stackable": "Item uses quantity stacking",
    "minstack": "Minimum stack count",
    "maxstack": "Maximum stack count",
    "spawnstack": "Default spawn stack quantity",

    # Sound
    "dropsound": "Sound when item drops",
    "dropsfxframe": "Animation frame to play drop sound",
    "usesound": "Sound when item is used/moved",

    # Upgrade
    "normcode": "Normal quality item code",
    "ubercode": "Exceptional quality item code",
    "ultracode": "Elite quality item code",
    "nightmareupgrade": "Nightmare difficulty replacement code",
    "hellupgrade": "Hell difficulty replacement code",

    # Flags
    "unique": "Only appears as unique quality",
    "quest": "Quest item class identifier",
    "questdiffcheck": "Per-difficulty quest item flag",
    "skipname": "Skip base name display on uniques",
    "nameable": "Can be personalized by Anya",
    "permstoreitem": "Always appears in NPC store",
    "showlevel": "Display item level",
    "useable": "Item is right-clickable",
    "missiletype": "Throwing weapon missile type reference",
    "qntwarning": "Low quantity warning threshold",
    "diablocloneweight": "Diablo clone progress contribution weight",
    "belt": "Belt type index",
    "autobelt": "Auto-place in belt slots",
    "bettergem": "Upgraded gem/rune code",
    "multibuy": "Shift-click bulk purchase enabled",
    "noupgrade": "Cannot be upgraded to higher quality tier",

    # ItemStatCost.txt
    "stat": "Unique stat identifier",
    "send other": "Only send to other players (monster stats)",
    "signed": "Value is a signed integer",
    "send bits": "Network transmission bit width",
    "send param bits": "Parameter bit width for network",
    "updateanimrate": "Update animation rate when stat changes",
    "saved": "Include in character save file",
    "csvsigned": "Save as signed integer in character file",
    "csvbits": "Bit width in character save",
    "csvparam": "Parameter bits in character save",
    "fcallback": "Trigger callback function when stat changes",
    "fmin": "Enable minimum value cap",
    "minaccr": "Minimum accumulation value",
    "encode": "Cost modification function (0-4)",
    "add": "Flat cost modification value",
    "multiply": "Multiplicative cost modifier",
    "valshift": "Bit shift for value calculation",

    # Properties.txt
    "func1": "Property function 1 code",
    "func2": "Property function 2 code",
    "func3": "Property function 3 code",
    "func4": "Property function 4 code",
    "func5": "Property function 5 code",
    "func6": "Property function 6 code",
    "func7": "Property function 7 code",
    "stat1": "Stat 1 reference (from ItemStatCost.txt)",
    "stat2": "Stat 2 reference",
    "stat3": "Stat 3 reference",
    "stat4": "Stat 4 reference",
    "stat5": "Stat 5 reference",
    "stat6": "Stat 6 reference",
    "stat7": "Stat 7 reference",
    "set1": "Set parameter 1",
    "set2": "Set parameter 2",
    "set3": "Set parameter 3",
    "set4": "Set parameter 4",
    "set5": "Set parameter 5",
    "set6": "Set parameter 6",
    "set7": "Set parameter 7",
    "val1": "Value 1 parameter",
    "val2": "Value 2 parameter",

    # Levels.txt
    "levelname": "Display name string key",
    "levelwarp": "Warp destination reference",
    "act": "Act number (1-5)",
    "questflag": "Associated quest flag",
    "warpdist": "Waypoint travel distance",
    "monlvl1": "Normal difficulty monster level",
    "monlvl2": "Nightmare difficulty monster level",
    "monlvl3": "Hell difficulty monster level",
    "monlvl1ex": "Normal difficulty monster level (expansion)",
    "monlvl2ex": "Nightmare difficulty monster level (expansion)",
    "monlvl3ex": "Hell difficulty monster level (expansion)",
    "monden": "Monster density multiplier",
    "nummon": "Number of unique monster types",

    # CubeMain.txt
    "description": "Recipe description/identifier",
    "enabled": "Recipe is functional (1=active, 0=disabled)",
    "ladder": "Ladder-only restriction (1=ladder only)",
    "min diff": "Minimum difficulty (0=all, 1=Nightmare+, 2=Hell only)",
    "op": "Condition operation function code (0-28)",
    "param": "Condition operation parameter",
    "value": "Condition comparison value",
    "class": "Character class restriction",
    "numinputs": "Number of required input items",

    # Hireling.txt
    "hireling": "Hireling type identifier",
    "difficulty": "Difficulty level (1=Normal, 2=Nightmare, 3=Hell)",
    "seller": "NPC vendor reference",
    "gold": "Base hiring gold cost",
    "exp/lvl": "Experience scaling ratio per level",
    "hp": "Base hit points",
    "hp/lvl": "Hit points gained per level",
    "defense": "Base defense rating",
    "def/lvl": "Defense gained per level",
    "str": "Base strength",
    "str/lvl": "Strength gained per level (eighths)",
    "dex": "Base dexterity",
    "dex/lvl": "Dexterity gained per level (eighths)",
    "ar": "Base attack rating",
    "ar/lvl": "Attack rating gained per level",
    "dmg-min": "Base minimum damage",
    "dmg-max": "Base maximum damage",
    "dmg/lvl": "Damage gained per level (eighths)",
    "resistfire": "Base fire resistance",
    "resistcold": "Base cold resistance",
    "resistlightning": "Base lightning resistance",
    "resistpoison": "Base poison resistance",

    # Character stats
    "int": "Starting energy",
    "vit": "Starting vitality",
    "stamina": "Starting stamina",
    "hpadd": "Bonus starting hit points",
    "manaregen": "Mana regeneration time (seconds per full regen)",
    "tohitfactor": "Starting attack rating",
    "walkvelocity": "Walk movement speed",
    "runvelocity": "Run movement speed",
    "rundrain": "Stamina drain rate while running",
    "lifeperlevel": "HP gained per level (fourths)",
    "staminaperlevel": "Stamina gained per level (fourths)",
    "manaperlevel": "Mana gained per level (fourths)",
    "lifepervitality": "HP per vitality point (fourths)",
    "staminapervitality": "Stamina per vitality point (fourths)",
    "manapermagic": "Mana per energy point (fourths)",
    "statperlevel": "Attribute points per level",
    "skillsperlevel": "Skill points per level",
    "blockfactor": "Base block percentage",

    # Sounds
    "filename": "Audio file reference",
    "volume": "Playback volume (0-255)",
    "loop": "Enable looping playback",
    "fadein": "Fade-in duration (milliseconds)",
    "fadeout": "Fade-out duration (milliseconds)",

    # States
    "state": "State identifier",
    "group": "State group assignment",
    "curse": "Curse type classification",
    "aura": "Aura type flag",
    "color": "Visual effect color index",

    # Overlay
    "filename1": "Primary overlay graphic file",
    "filename2": "Secondary overlay graphic file",
    "filename3": "Tertiary overlay graphic file",

    # Gems.txt modifiers
    "letter": "Tooltip concatenation letter",

    # General patterns
    "eol": "End of line marker (always 0)",
    "expansion": "Expansion-only content flag",
    "beta": "Beta content flag (unused)",
    "end": "End marker",
    "*eol": "End of line marker (comment)",
}

# ── File-Specific Descriptions ──────────────────────────────────────────────

FILE_DESCRIPTIONS = {
    "armor.txt": "Armor item definitions — defense values, requirements, visual properties, and NPC pricing.",
    "weapons.txt": "Weapon item definitions — damage values, speed, range, requirements, and visual properties.",
    "misc.txt": "Miscellaneous item definitions — potions, scrolls, gems, quest items, keys, and other non-equipment items.",
    "itemstatcost.txt": "Stat definitions — controls how stats are stored, transmitted, displayed, and affect item costs.",
    "itemtypes.txt": "Item type hierarchy — defines equipment categories, socket rules, and class restrictions.",
    "properties.txt": "Property definitions — maps property codes to stat functions used by affixes and uniques.",
    "levels.txt": "Level/area definitions — monster levels, density, waypoints, and act assignments.",
    "cubemain.txt": "Horadric Cube recipes — input items, output items, conditions, and property modifications.",
    "uniqueitems.txt": "Unique item definitions — base types, level requirements, and up to 12 properties per item.",
    "setitems.txt": "Set item definitions — base types, individual properties, and set bonus properties.",
    "runes.txt": "Runeword definitions — rune combinations, item type restrictions, and granted properties.",
    "gems.txt": "Gem and rune modifier definitions — weapon, armor, and shield bonuses per quality level.",
    "hireling.txt": "Mercenary definitions — stats, skills, level progression, and hiring costs per act and difficulty.",
    "monstats.txt": "Monster definitions — stats, skills, AI, treasure classes, and visual properties.",
    "skills.txt": "Skill definitions — damage, mana cost, synergies, missiles, and visual effects.",
    "missiles.txt": "Missile/projectile definitions — movement, collision, damage, and visual effects.",
    "charstats.txt": "Character class base stats — starting attributes, growth rates, and default equipment.",
    "experience.txt": "Experience requirements per level for each character class.",
    "objects.txt": "Game object definitions — shrines, chests, doors, waypoints, and interactive objects.",
    "states.txt": "Character/monster state definitions — buffs, debuffs, auras, and visual effects.",
    "sounds.txt": "Sound effect definitions — file references, volume, looping, and fade settings.",
    "overlay.txt": "Visual overlay definitions — particle effects, auras, and status indicators.",
    "treasureclassex.txt": "Treasure class definitions — item drop tables with quality modifiers.",
    "treasureclass.txt": "Legacy treasure class definitions (pre-expansion).",
    "difficultylevels.txt": "Difficulty scaling — resistance penalties, experience modifiers per difficulty.",
    "magicprefix.txt": "Magic prefix affix definitions — stat modifiers, spawn conditions, and item type restrictions.",
    "magicsuffix.txt": "Magic suffix affix definitions — stat modifiers, spawn conditions, and item type restrictions.",
    "automagic.txt": "Automatic magic modifier definitions applied during item generation.",
    "qualityitems.txt": "Superior/inferior quality item modifier definitions.",
    "superuniques.txt": "Super unique monster definitions — named bosses with fixed spawn locations.",
    "shrines.txt": "Shrine effect definitions — duration, stat modifiers, and visual effects.",
    "montype.txt": "Monster type hierarchy — damage resistances and immunities by type.",
    "lvltypes.txt": "Level visual type definitions — tileset assignments and lighting.",
    "lvlprest.txt": "Level preset definitions — pre-built map sections.",
    "lvlmaze.txt": "Level maze generation parameters.",
    "lvlsub.txt": "Level substitution parameters for random map generation.",
    "lvlwarp.txt": "Level warp/transition definitions — visual offsets and target areas.",
    "belts.txt": "Belt inventory layout definitions — potion slot positions per belt type.",
    "inventory.txt": "Inventory panel layout definitions — grid positions for each inventory screen.",
    "gamble.txt": "Gambling item pool definitions — items available from gambling NPCs.",
    "npc.txt": "NPC trade inventory definitions — item types and quantities per NPC.",
    "setitems.txt": "Set item definitions — individual and set bonus properties.",
    "colors.txt": "Color transform definitions for character graphics.",
    "composit.txt": "Character composite layer mode definitions.",
    "bodylocs.txt": "Body location/equipment slot definitions.",
    "playerclass.txt": "Player character class code definitions.",
    "plrmode.txt": "Player animation mode definitions.",
    "plrtype.txt": "Player animation type definitions.",
    "monmode.txt": "Monster animation mode definitions.",
    "hitclass.txt": "Hit/impact sound class definitions.",
    "elemtypes.txt": "Elemental damage type definitions.",
    "weaponclass.txt": "Weapon animation class definitions.",
    "storepage.txt": "NPC store page layout definitions.",
    "cubetype.txt": "Cube recipe type code definitions.",
    "cubemod.txt": "Cube recipe modifier code definitions.",
    "hiredesc.txt": "Hireling description string key definitions.",
    "objmode.txt": "Object animation mode definitions.",
    "objtype.txt": "Object type classification definitions.",
    "objgroup.txt": "Object group definitions for random object placement.",
    "lowqualityitems.txt": "Low quality item prefix definitions (Crude, Cracked, etc.).",
    "itemratio.txt": "Item quality ratio definitions per monster level.",
    "arena.txt": "PvP arena configuration definitions.",
    "soundenviron.txt": "Environmental sound effect definitions per area type.",
    "monitempercent.txt": "Monster item equipment rate percentages.",
    "armtype.txt": "Arm animation type definitions.",
}

# ── Type Fixes ──────────────────────────────────────────────────────────────
# Known columns that are commonly misdetected

TYPE_FIXES = {
    # These are reference columns, not simple strings/enums
    ("armor.txt", "type"): {"type": "ref", "target": "itemtypes.txt", "targetColumn": "Code"},
    ("armor.txt", "type2"): {"type": "ref", "target": "itemtypes.txt", "targetColumn": "Code"},
    ("weapons.txt", "type"): {"type": "ref", "target": "itemtypes.txt", "targetColumn": "Code"},
    ("weapons.txt", "type2"): {"type": "ref", "target": "itemtypes.txt", "targetColumn": "Code"},
    ("misc.txt", "type"): {"type": "ref", "target": "itemtypes.txt", "targetColumn": "Code"},
    ("misc.txt", "type2"): {"type": "ref", "target": "itemtypes.txt", "targetColumn": "Code"},

    # version is an enum, not plain integer
    ("armor.txt", "version"): {"type": "enum", "values": ["0", "1", "100"]},
    ("weapons.txt", "version"): {"type": "enum", "values": ["0", "1", "100"]},
    ("misc.txt", "version"): {"type": "enum", "values": ["0", "1", "100"]},
    ("uniqueitems.txt", "version"): {"type": "enum", "values": ["0", "1", "100"]},
    ("setitems.txt", "version"): {"type": "enum", "values": ["0", "1", "100"]},
    ("cubemain.txt", "version"): {"type": "enum", "values": ["0", "100"]},

    # gemapplytype is an enum
    ("armor.txt", "gemapplytype"): {"type": "enum", "values": ["0", "1", "2"], "description": "Gem effect type (0=Weapon, 1=Armor, 2=Shield)"},
    ("weapons.txt", "gemapplytype"): {"type": "enum", "values": ["0", "1", "2"], "description": "Gem effect type (0=Weapon, 1=Armor, 2=Shield)"},
    ("misc.txt", "gemapplytype"): {"type": "enum", "values": ["0", "1", "2"], "description": "Gem effect type (0=Weapon, 1=Armor, 2=Shield)"},
}

# ── Main ────────────────────────────────────────────────────────────────────

def enrich_schema(schema_path):
    with open(schema_path, "r") as f:
        schema = json.load(f)

    file_name = schema.get("file", "")
    modified = False

    # Update file description
    file_lower = file_name.lower()
    if file_lower in FILE_DESCRIPTIONS and "Auto-generated" in schema.get("description", ""):
        schema["description"] = FILE_DESCRIPTIONS[file_lower]
        modified = True

    # Update column descriptions and fix types
    for col_name, col_schema in schema.get("columns", {}).items():
        col_lower = col_name.lower()

        # Add description if missing
        if "description" not in col_schema and col_lower in COMMON_DESCRIPTIONS:
            col_schema["description"] = COMMON_DESCRIPTIONS[col_lower]
            modified = True

        # Apply type fixes
        fix_key = (file_lower, col_lower)
        if fix_key in TYPE_FIXES:
            fix = TYPE_FIXES[fix_key]
            for k, v in fix.items():
                col_schema[k] = v
            modified = True

        # Fix common patterns: columns ending in "code" that reference other files
        if col_lower.endswith("code") and col_schema.get("type") == "string":
            # These might be item type codes
            pass  # Leave as string unless we have specific knowledge

    if modified:
        with open(schema_path, "w") as f:
            json.dump(schema, f, indent=2)

    return modified

def main():
    if len(sys.argv) < 2:
        print("Usage: python enrich-schemas.py <schema_dir>")
        sys.exit(1)

    schema_dir = sys.argv[1]
    schema_files = glob(os.path.join(schema_dir, "*.schema.json"))

    enriched = 0
    unchanged = 0

    for schema_path in sorted(schema_files):
        basename = os.path.basename(schema_path)
        if enrich_schema(schema_path):
            print(f"  ENRICHED {basename}")
            enriched += 1
        else:
            print(f"  unchanged {basename}")
            unchanged += 1

    print(f"\nDone: {enriched} enriched, {unchanged} unchanged")

if __name__ == "__main__":
    main()
