"""
Fix known issues in auto-generated D2 schemas based on audit findings.

Fixes:
1. Boolean misdetection - columns typed as boolean that should be integer
2. Missing/wrong cross-references
3. Wrong descriptions (copy-paste errors)
4. Missing enum values
"""

import json
import os
import re
from glob import glob

# ── Boolean → Integer Fixes ─────────────────────────────────────────────────
# Columns that are typed as "boolean" but should be "integer"
# Pattern: if a column name matches and is boolean, fix it

BOOLEAN_TO_INTEGER_PATTERNS = [
    # Numbered patterns that are clearly integers, not booleans
    r"^m\d+$",         # M1-M25 monster IDs
    r"^s\d+$",         # S1-S25 super unique IDs
    r"^u\d+$",         # U1-U25 unique monster IDs
    r"^c\d+$",         # C1-C5 champion monster IDs
    r"^ca\d+$",        # CA1-CA5
    r"^objgrp\d+$",    # ObjGrp object group IDs
    r"^objprb\d+$",    # ObjPrb object probabilities
    r"^monumin\d*$",   # Monster unique min
    r"^monumax\d*$",   # Monster unique max
    # Item/equipment columns
    r"^item\d+count$",
    r"^item\d+loc$",
    r"^item\d+quality$",
    # Skill/chance columns
    r"^chanceperlevel\d+$",
    r"^chanceperlvl\d+$",
    r"^lvlperlvl\d+$",
    r"^level\d+$",
    r"^mode\d+$",
    r"^chance\d+$",
    # Modifier columns
    r"^.*mod\d+offset$",
    r"^.*mod\d+min$",
    r"^.*mod\d+max$",
    r"^.*mod\d+param$",
    r"^.*mod\d+bmin$",
    r"^.*mod\d+bmax$",
    r"^.*mod\d+bparam$",
    r"^.*mod\d+bchance$",
    # Property columns
    r"^propertymod\d+min$",
    r"^propertymod\d+max$",
    r"^propertymod\d+offset$",
    # Cube recipe columns
    r"^sockets [a-g]$",
    r"^number of [a-g]$",
    r"^function$",
    r"^product [a-g]$",
    r"^mods [a-g]$",
    r"^uses [a-g]$",
    r"^param\d+ [a-g]$",
    r"^fixedlevel [a-g]$",
    r"^playerlevel pct [a-g]$",
    r"^itemlevel pct [a-g]$",
    # Specific misdetected columns
    r"^height\d+$",    # overlay heights
    r"^ntgtb[xy]$",    # object target coordinates
]

# Exact column names that should be integer, not boolean
BOOLEAN_TO_INTEGER_EXACT = {
    "shield", "transform", "invtransform", "shrinefunction", "overlay",
    "startskill", "day of week", "min difficulty",
    "modfuncoffset", "damage",
}

# ── Specific File Fixes ─────────────────────────────────────────────────────

SPECIFIC_FIXES = {
    "experience.schema.json": {
        "Level": {"type": "integer", "description": "Character level (1-99)", "required": True, "min": 0, "max": 99},
    },
    "charstats.schema.json": {
        "class": {"type": "string", "description": "Character class identifier", "required": True, "unique": True},
        "StartSkill": {"type": "ref", "target": "skills.txt", "targetColumn": "skill", "description": "Default right-hand skill"},
    },
    "overlay.schema.json": {
        "Filename": {"description": "DCC/DC6 animation file reference"},
    },
    "objects.schema.json": {
        "Act": {"description": "Act bitmask (bitfield, not 1-5)"},
    },
    "levels.schema.json": {
        "Act": {"type": "integer", "min": 0, "max": 4, "description": "Act number (0-indexed: 0=Act1, 4=Act5)"},
    },
    "hireling.schema.json": {
        "Level": {"description": "Hireling base level"},
        "Class": {"description": "Monster class animation index"},
    },
    "uniqueitems.schema.json": {
        "code": {"type": "ref", "target": "armor.txt", "targetColumn": "code", "description": "Base item code (references Armor/Weapons/Misc code)"},
    },
    "gems.schema.json": {
        "transform": {"description": "Inventory color transform index"},
        "code": {"type": "ref", "target": "misc.txt", "targetColumn": "code", "description": "Item code (references Misc.txt)"},
    },
    "properties.schema.json": {
        "Code": {"description": "Unique property code identifier"},
    },
}

# ── Description Fixes ───────────────────────────────────────────────────────

DESCRIPTION_FIXES = {
    # Wrong descriptions from copy-paste
    ("properties.schema.json", "description"): "Human-readable description of the property",
    ("properties.schema.json", "code"): "Unique property code identifier",
}

def fix_schema(schema_path):
    basename = os.path.basename(schema_path)
    with open(schema_path, "r") as f:
        schema = json.load(f)

    modified = False
    fixes_applied = []

    for col_name, col_schema in schema.get("columns", {}).items():
        col_lower = col_name.lower().strip()

        # Fix 1: Boolean → Integer misdetection
        if col_schema.get("type") == "boolean":
            should_fix = False

            # Check exact matches
            if col_lower in BOOLEAN_TO_INTEGER_EXACT:
                should_fix = True

            # Check patterns
            if not should_fix:
                for pattern in BOOLEAN_TO_INTEGER_PATTERNS:
                    if re.match(pattern, col_lower):
                        should_fix = True
                        break

            if should_fix:
                col_schema["type"] = "integer"
                col_schema["min"] = 0
                col_schema["max"] = 1  # Preserve the known range
                fixes_applied.append(f"  {col_name}: boolean -> integer")
                modified = True

        # Fix 2: Specific file fixes
        if basename in SPECIFIC_FIXES and col_name in SPECIFIC_FIXES[basename]:
            fix = SPECIFIC_FIXES[basename][col_name]
            for k, v in fix.items():
                if col_schema.get(k) != v:
                    col_schema[k] = v
                    modified = True
            fixes_applied.append(f"  {col_name}: specific fix applied")

        # Fix 3: Description fixes
        fix_key = (basename, col_lower)
        if fix_key in DESCRIPTION_FIXES:
            col_schema["description"] = DESCRIPTION_FIXES[fix_key]
            modified = True
            fixes_applied.append(f"  {col_name}: description fixed")

        # Fix 4: String columns that should be refs (skill references)
        if col_lower.startswith("skill") and col_schema.get("type") in ("string", "enum"):
            if "ref" not in col_schema.get("type", ""):
                # Check if it's a skill name reference
                values = col_schema.get("values", [])
                if values and any(v in ("Fire Bolt", "Ice Bolt", "Attack", "Jab", "Bash") for v in values):
                    col_schema["type"] = "ref"
                    col_schema["target"] = "skills.txt"
                    col_schema["targetColumn"] = "skill"
                    if "values" in col_schema:
                        del col_schema["values"]
                    fixes_applied.append(f"  {col_name}: enum -> ref(skills.txt)")
                    modified = True

    if modified:
        with open(schema_path, "w") as f:
            json.dump(schema, f, indent=2)

    return fixes_applied

def main():
    schema_dir = "schemas/txt"
    total_fixes = 0

    for f in sorted(glob(os.path.join(schema_dir, "*.schema.json"))):
        fixes = fix_schema(f)
        if fixes:
            basename = os.path.basename(f)
            print(f"{basename}: {len(fixes)} fixes")
            for fix in fixes:
                print(fix)
            total_fixes += len(fixes)

    print(f"\nTotal fixes applied: {total_fixes}")

if __name__ == "__main__":
    main()
