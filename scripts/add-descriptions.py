"""
Add pattern-based descriptions to schema columns that are still undescribed.
Uses column name patterns (exact match and regex) to infer descriptions.
"""

import json
import os
import re
from glob import glob

PATTERN_DESCRIPTIONS = {
    "token": "Animation token identifier",
    "completed": "Item completion flag",
    "transformcolor": "Color transform palette index",
    "nummods": "Number of active modifiers",
    "divide": "Division factor for calculations",
    "eol": "End of line marker (always 0)",
    "*eol": "End of line marker (comment)",
    "expansion": "Expansion-only content",
    "end": "End marker",
    "rare": "Can spawn as rare quality",
    "throwable": "Item can be thrown",
    "sizex": "Width in grid cells",
    "sizey": "Height in grid cells",
    "spelloffset": "Spell effect offset index",
    "bodyloc1": "Primary equipment slot location",
    "bodyloc2": "Secondary equipment slot location",
    "shield": "Applies to shields",
    "armor": "Applies to armor",
    "weapon": "Applies to weapons",
    "scepter": "Applies to scepters",
    "wand": "Applies to wands",
    "staff": "Applies to staves",
    "bow": "Applies to bows",
    "boots": "Applies to boots",
    "gloves": "Applies to gloves",
    "helm": "Applies to helms",
    "ring": "Applies to rings",
    "amulet": "Applies to amulets",
    "crossbow": "Applies to crossbows",
    "polearm": "Applies to polearms",
    "mace": "Applies to maces",
    "sword": "Applies to swords",
    "axe": "Applies to axes",
    "spear": "Applies to spears",
    "dagger": "Applies to daggers",
    "javelin": "Applies to javelins",
    "hammer": "Applies to hammers",
    "club": "Applies to clubs",
    "thrown": "Applies to throwing weapons",
    "orb": "Applies to orbs",
    "claw": "Applies to claws",
    "circlet": "Applies to circlets",
    "amazon": "Amazon class specific",
    "paladin": "Paladin class specific",
    "barbarian": "Barbarian class specific",
    "necromancer": "Necromancer class specific",
    "sorceress": "Sorceress class specific",
    "druid": "Druid class specific",
    "assassin": "Assassin class specific",
    "picks": "Number of items picked from this class",
    "nodrop": "Weight for no item drop",
    "group": "Treasure class group assignment",
    "mingrp": "Minimum group spawn count",
    "maxgrp": "Maximum group spawn count",
    "resistpenalty": "Resistance penalty percentage",
    "deathexppenalty": "Experience penalty on death",
    "monsterskillbonus": "Monster skill level bonus",
    "staticfieldmin": "Minimum HP from Static Field (percentage)",
    "intensity": "Light intensity value",
    "red": "Red color channel (0-255)",
    "green": "Green color channel (0-255)",
    "blue": "Blue color channel (0-255)",
    "effectclass": "Visual effect class",
    "levelmin": "Minimum area level to appear",
    "teleport": "Teleport enabled flag",
    "isroom": "Area is an enclosed room",
    "rainfall": "Rain intensity",
    "mud": "Mud visual effect",
    "noper": "No periodic spawn",
    "nomap": "Hidden from automap",
    "drawfloors": "Render floor tiles",
    "drawwalls": "Render wall tiles",
    "isbarrier": "Acts as movement barrier",
    "automap": "Automap display flag",
    "scan": "Scannable by abilities",
    "pops": "Population density",
    "killable": "Can be killed/destroyed",
    "operatable": "Can be operated/clicked",
    "selectable": "Can be selected/targeted",
    "trap": "Is a trap object",
    "isattackable": "Can be attacked",
    "revive": "Can be revived/resurrected",
    "hc": "Hardcore mode flag",
    "questid": "Associated quest identifier",
    "questflag": "Quest completion flag",
    "setname": "Set name string key",
    "setitems": "Number of items in the set",
    "pcode2a": "Partial set bonus 2 property code",
    "pcode2b": "Partial set bonus 2b property code",
    "pcode3a": "Partial set bonus 3 property code",
    "pcode3b": "Partial set bonus 3b property code",
    "pcode4a": "Partial set bonus 4 property code",
    "pcode4b": "Partial set bonus 4b property code",
    "pcode5a": "Partial set bonus 5 property code",
    "pcode5b": "Partial set bonus 5b property code",
    "fcode1": "Full set bonus 1 property code",
    "fcode2": "Full set bonus 2 property code",
    "fcode3": "Full set bonus 3 property code",
    "fcode4": "Full set bonus 4 property code",
    "fcode5": "Full set bonus 5 property code",
    "fcode6": "Full set bonus 6 property code",
    "fcode7": "Full set bonus 7 property code",
    "fcode8": "Full set bonus 8 property code",
    "rune name": "Runeword display name string key",
    "complete": "Runeword activation flag",
    "server": "Server-side only flag",
    "itype1": "Required item type 1",
    "itype2": "Required item type 2",
    "itype3": "Required item type 3",
    "itype4": "Required item type 4",
    "itype5": "Required item type 5",
    "itype6": "Required item type 6",
    "etype1": "Excluded item type 1",
    "etype2": "Excluded item type 2",
    "etype3": "Excluded item type 3",
    "classspecific": "Class restriction for item type",
    "storepage": "NPC store tab page",
    "equivalent1": "Equivalent item type 1",
    "equivalent2": "Equivalent item type 2",
    "repair": "Item can be repaired",
    "body": "Equippable on body slot",
    "beltable": "Can be placed in belt",
    "maxsockets1": "Max sockets for normal quality",
    "maxsockets2": "Max sockets for nightmare quality",
    "maxsockets3": "Max sockets for hell quality",
    "treasureclass": "Item drop classification reference",
    "staffmods": "Staff auto-mod skill group",
    "class": "Character class restriction",
    "varinvgfx": "Number of inventory graphic variations",
    "invgfx1": "Inventory graphic variation 1",
    "invgfx2": "Inventory graphic variation 2",
    "invgfx3": "Inventory graphic variation 3",
    "invgfx4": "Inventory graphic variation 4",
    "invgfx5": "Inventory graphic variation 5",
    "invgfx6": "Inventory graphic variation 6",
    "maxlevel": "Maximum level this can appear",
    "classlevelreq": "Class-specific level requirement",
    "frequency": "Spawn frequency weight",
    "charsimagicmin": "Charsi magic stock minimum",
    "charsimagicmax": "Charsi magic stock maximum",
    "charsimagiclvl": "Charsi magic stock level",
    "lydiamagicmin": "Lydia magic stock minimum",
    "lydiamagicmax": "Lydia magic stock maximum",
    "lydiamagiclvl": "Lydia magic stock level",
    "tc": "Treasure class reference",
    "tc(n)": "Nightmare treasure class",
    "tc(h)": "Hell treasure class",
}

NUMBERED_PATTERNS = [
    (r"^mod(\d+)code$", "Modifier {} property code"),
    (r"^mod(\d+)param$", "Modifier {} parameter value"),
    (r"^mod(\d+)min$", "Modifier {} minimum value"),
    (r"^mod(\d+)max$", "Modifier {} maximum value"),
    (r"^mod(\d+)offset$", "Modifier {} value offset"),
    (r"^mod(\d+) chance$", "Modifier {} application chance"),
    (r"^prop(\d+)$", "Property {} code"),
    (r"^par(\d+)$", "Property {} parameter"),
    (r"^min(\d+)$", "Property {} minimum value"),
    (r"^max(\d+)$", "Property {} maximum value"),
    (r"^aprop(\d+[ab]?)$", "Set bonus {} property code"),
    (r"^apar(\d+[ab]?)$", "Set bonus {} parameter"),
    (r"^amin(\d+[ab]?)$", "Set bonus {} minimum"),
    (r"^amax(\d+[ab]?)$", "Set bonus {} maximum"),
    (r"^item(\d+)$", "Starting item {} code"),
    (r"^item(\d+)loc$", "Item {} equipment slot"),
    (r"^item(\d+)count$", "Item {} stack quantity"),
    (r"^item(\d+)quality$", "Item {} quality tier"),
    (r"^montype(\d+)$", "Monster type {} reference"),
    (r"^mon(\d+)$", "Monster {} type reference"),
    (r"^umon(\d+)$", "Unique monster {} reference"),
    (r"^nmon(\d+)$", "Normal monster {} reference"),
    (r"^cmon(\d+)$", "Champion monster {} reference"),
    (r"^skill(\d+)$", "Skill {} reference"),
    (r"^sk(\d+)$", "Skill {} reference"),
    (r"^mode(\d+)$", "Skill {} usage mode"),
    (r"^chance(\d+)$", "Skill {} usage probability (%)"),
    (r"^chanceperlvl(\d+)$", "Skill {} probability per level"),
    (r"^lvlperlvl(\d+)$", "Skill {} level per character level"),
    (r"^weaponmod(\d+)code$", "Weapon modifier {} property code"),
    (r"^weaponmod(\d+)param$", "Weapon modifier {} parameter"),
    (r"^weaponmod(\d+)min$", "Weapon modifier {} minimum"),
    (r"^weaponmod(\d+)max$", "Weapon modifier {} maximum"),
    (r"^helmmod(\d+)code$", "Helm modifier {} property code"),
    (r"^helmmod(\d+)param$", "Helm modifier {} parameter"),
    (r"^helmmod(\d+)min$", "Helm modifier {} minimum"),
    (r"^helmmod(\d+)max$", "Helm modifier {} maximum"),
    (r"^shieldmod(\d+)code$", "Shield modifier {} property code"),
    (r"^shieldmod(\d+)param$", "Shield modifier {} parameter"),
    (r"^shieldmod(\d+)min$", "Shield modifier {} minimum"),
    (r"^shieldmod(\d+)max$", "Shield modifier {} maximum"),
    (r"^t(\d+)code(\d+)$", "Property {} code for tier {}"),
    (r"^t(\d+)param(\d+)$", "Property {} param for tier {}"),
    (r"^t(\d+)min(\d+)$", "Property {} min for tier {}"),
    (r"^t(\d+)max(\d+)$", "Property {} max for tier {}"),
    (r"^input (\d+)$", "Input {} item code or condition"),
    (r"^output (.+)$", "Output {} specification"),
    (r"^(.+)min$", "{} minimum value"),
    (r"^(.+)max$", "{} maximum value"),
]

def main():
    schema_dir = "schemas/txt"
    enriched = 0
    total_added = 0

    for f in sorted(glob(os.path.join(schema_dir, "*.schema.json"))):
        with open(f) as fh:
            s = json.load(fh)

        modified = False
        for col_name, col_schema in s.get("columns", {}).items():
            if "description" in col_schema:
                continue

            col_lower = col_name.lower().strip()

            # Exact match
            if col_lower in PATTERN_DESCRIPTIONS:
                col_schema["description"] = PATTERN_DESCRIPTIONS[col_lower]
                modified = True
                total_added += 1
                continue

            # Regex patterns
            for pattern, template in NUMBERED_PATTERNS:
                m = re.match(pattern, col_lower)
                if m:
                    try:
                        groups = m.groups()
                        col_schema["description"] = template.format(*groups) if groups else template
                    except (IndexError, KeyError):
                        col_schema["description"] = template.replace("{}", m.group(0))
                    modified = True
                    total_added += 1
                    break

        if modified:
            with open(f, "w") as fh:
                json.dump(s, fh, indent=2)
            enriched += 1

    print(f"Enriched {enriched} files, added {total_added} descriptions")

if __name__ == "__main__":
    main()
