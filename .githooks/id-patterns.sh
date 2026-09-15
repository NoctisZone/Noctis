# Shared definitions for the repository-hygiene hooks. Sourced by BOTH
# pre-commit and pre-push, because two copies of a pattern is precisely how the
# last gap opened: one hook was taught about a new ID scheme and the other was
# not, and nothing said so. There is one definition now, and editing it changes
# both gates at once.
#
# This file is not executable and defines no behaviour of its own.

# Internal ID shapes, matched for EVERY letter.
#
# The old pattern named the prefixes in use: T/D/MN/C for the issue tracker,
# then M/F/H/L/I/RC/CRIT once the security audits grew their own numbering.
# Naming them is the flaw. A pattern extended one scheme at a time is always
# one scheme behind whoever invents the next, and the schemes above were not
# planned in advance either. So every letter matches now, in the three shapes
# every scheme so far has used:
#     letter + digits    T24   D5   A7
#     PREFIX-digits      MN-6  C-1  M-2  RC-3  CRIT-1
#     letter-WORD        T-AUDIT
ID_SHAPES='\b([A-Z][0-9]{1,3}|[A-Z]{1,4}-[0-9]{1,4}|[A-Z]-[A-Z][A-Z-]+)\b'

# Matching every letter also matches real technical identifiers, so those are
# subtracted BY NAME. That is the whole trade, and it is the right way round:
# an unlisted token blocks by default, so a numbering scheme invented next
# month is caught on its first push rather than discovered afterwards. Add an
# entry only for a token whose meaning is public and obvious from the token.
#   L1/L2  Cardano layers          P0     bonding-curve base price
#   R2/S3  object-storage APIs     V1-V3  Plutus and Minswap versions
#   E1/E2  ROADMAP.md track items, cited elsewhere only alongside their source
#   CIP/MIP/CAIP/BIP  published improvement proposals
#   SHA/AES/UTF       algorithms and encodings
#   BSD/GPL/MPL/BY    SPDX licence identifiers
# A calendar quarter is allowed only in its date form ("Q1 2024"), so a bare
# Q1 -- which a numbering scheme could plausibly use -- still blocks.
# "Stream A1" is a phrase rather than a token: the two creator-fee streams are
# public product vocabulary, and only that phrase may carry the shape.
ID_ALLOW='\b(L1|L2|P0|R2|S3|V1|V2|V3|E1|E2|Stream A[0-9](/A[0-9])?|CIP-[0-9]+|MIP-[0-9]+|CAIP-[0-9]+|BIP-[0-9]+|SHA-[0-9]+|AES-[0-9]+|UTF-[0-9]+|BSD-[0-9]+|L?GPL-[0-9]+|MPL-[0-9]+|BY-[0-9]+|Q[1-4] 20[0-9]{2})\b'

# CLAUDE.md states the hygiene rule and has to quote the shapes it forbids;
# ROADMAP.md numbers its own public deliverables per track (A1, B7, D1...) --
# a scheme that collides in shape with the private tracker's, but is defined
# in that same public file, so it reveals nothing. Lockfiles are machine-
# written base64 that hits these shapes by coincidence: package-lock.json
# alone carries five such collisions today.
ID_EXCLUDE="':(exclude).githooks/' ':(exclude)CLAUDE.md' ':(exclude)ROADMAP.md' ':(exclude)package-lock.json' ':(exclude)*.lock'"

# Those two docs are exempt from the SHAPE scan, not from scanning. They are
# still swept for the dash forms below, where every security-audit finding ID
# lives, minus only the three literals CLAUDE.md quotes as examples. So a
# finding ID pasted into the policy document itself is still refused -- the
# exemption must not become the blind spot that hid the last one.
ID_DASH='\b([A-Z]{1,4}-[0-9]{1,4}|[A-Z]-[A-Z][A-Z-]+)\b'
DOC_ALLOW='\b(T-AUDIT|MN-6|C-1)\b'
