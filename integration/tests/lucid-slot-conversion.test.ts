import { SLOT_CONFIG_NETWORK, slotToUnixTime, unixTimeToSlot } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';

/**
 * Slot conversion, pinned against the library version this one replaced.
 *
 * WHY THIS FILE EXISTS
 *
 * Every submitter that spends a script names a validity range with
 * `.validFrom()` / `.validTo()` — 35 call sites across 14 files at the time of
 * writing — and several validators check that range on chain
 * (`validity_range_is_narrow`, `interval.contains`). The conversion from a
 * timestamp to a slot is therefore load-bearing: get it wrong and a
 * transaction that looks right locally is refused by the chain, or worse,
 * accepted with a range nobody intended.
 *
 * That conversion lives inside Lucid, and **the submitter tests all mock
 * Lucid**. So the suite passing says nothing at all about it. Lucid 0.6.0
 * rewrote exactly this area — "use validated per-Lucid-instance slot
 * configuration throughout time conversion, transaction building, evaluation,
 * signing, and script-context construction" — which is precisely the kind of
 * change a mocked suite cannot see.
 *
 * The figures below were computed under **0.5.6**, the version 0.6.2 replaced,
 * and asserted unchanged after the upgrade. They are values, not shapes: a
 * test that only checked "returns a number" or "round-trips" would pass under
 * any arithmetic at all, including wrong arithmetic. A round-trip check is
 * included as well, but it is the second assertion here, not the first.
 *
 * If one of these ever fails, the library changed what a timestamp means. That
 * is not a number to update — it is a reason to re-check every validity range
 * on Preprod before shipping.
 */

/** Computed under @lucid-evolution/lucid@0.5.6, before the 0.6.2 upgrade. */
const PINNED: ReadonlyArray<{ network: 'Preprod' | 'Mainnet' | 'Preview'; unixTime: number; slot: number }> = [
  { network: 'Preprod', unixTime: 1_760_000_000_000, slot: 104_316_800 },
  { network: 'Preprod', unixTime: 1_700_000_000_000, slot: 44_316_800 },
  { network: 'Mainnet', unixTime: 1_760_000_000_000, slot: 168_433_709 },
  { network: 'Mainnet', unixTime: 1_700_000_000_000, slot: 108_433_709 },
  { network: 'Preview', unixTime: 1_760_000_000_000, slot: 93_344_000 },
  { network: 'Preview', unixTime: 1_700_000_000_000, slot: 33_344_000 },
];

describe('Lucid slot conversion — pinned across the 0.5.6 → 0.6.2 upgrade', () => {
  for (const { network, unixTime, slot } of PINNED) {
    it(`${network}: ${unixTime} converts to slot ${slot}`, () => {
      expect(unixTimeToSlot(network, unixTime)).toBe(slot);
    });

    it(`${network}: slot ${slot} converts back to ${unixTime}`, () => {
      expect(slotToUnixTime(network, slot)).toBe(unixTime);
    });
  }

  /**
   * The era parameters the conversions above are derived from. Pinned
   * separately because a change here explains a change there — without it, a
   * failing conversion looks like a bug in the arithmetic rather than a
   * different genesis being used.
   */
  it('the network slot configs are unchanged', () => {
    expect(SLOT_CONFIG_NETWORK.Preprod).toEqual({ zeroTime: 1_655_769_600_000, zeroSlot: 86_400, slotLength: 1_000 });
    expect(SLOT_CONFIG_NETWORK.Mainnet).toEqual({
      zeroTime: 1_596_059_091_000,
      zeroSlot: 4_492_800,
      slotLength: 1_000,
    });
  });

  /**
   * A validity range is a WINDOW, and the submitters build it by adding and
   * subtracting milliseconds either side of a timestamp. What matters on chain
   * is that the window stays the width it was asked for once converted, since
   * `validity_range_is_narrow` refuses one that is too wide.
   */
  it('a 60-second window is still 60 slots wide after conversion', () => {
    const centre = 1_760_000_000_000;
    const from = unixTimeToSlot('Preprod', centre - 30_000);
    const to = unixTimeToSlot('Preprod', centre + 30_000);
    expect(to - from).toBe(60);
  });
});
