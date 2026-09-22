import { describe, expect, it } from 'vitest';
import {
  gateDeployFieldsFromLaunchRecord,
  PRODUCT_WINDOWS_SECONDS,
  recordTimestampToSeconds,
} from '../gate-deploy-fields.js';

const LAUNCH = '6d67c99f7d9f634885271923eef91fffec1d95649b02e77fe2ee62c5dd01a102';
const KEY = '0123456789abcdef'.repeat(4);

/** A record the wizard writes: buying opens at T, registration T-48h to T-2h, buying 24h. */
function wizardRecord(buyingOpensIso: string) {
  const t = Date.parse(buyingOpensIso);
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
  return {
    launch_id_hex: LAUNCH,
    dv_registration_opens_ts: iso(t - 48 * 3600_000),
    dv_registration_freezes_ts: iso(t - 2 * 3600_000),
    dv_buying_opens_ts: iso(t),
    dv_buying_closes_ts: iso(t + 24 * 3600_000),
  };
}

describe('gateDeployFieldsFromLaunchRecord', () => {
  it('maps a record the wizard made onto exactly the deploy defaults, with the freeze as the close', () => {
    const f = gateDeployFieldsFromLaunchRecord(wizardRecord('2026-10-01T12:00:00Z'));
    expect(f.registrationCloseTime).toBe(String(Date.parse('2026-10-01T10:00:00Z') / 1000));
    expect(f.registrationWindowSeconds).toBe(String(PRODUCT_WINDOWS_SECONDS.registration));
    expect(f.freezeWindowSeconds).toBe(String(PRODUCT_WINDOWS_SECONDS.freeze));
    expect(f.buyingWindowSeconds).toBe(String(PRODUCT_WINDOWS_SECONDS.buying));
    expect(f.notes).toEqual([]);
  });

  it('pins a real record: the rehearsal schedule is read back to the second, and noted as not the product schedule', () => {
    // The launch record served for `veil`, as the site answers it.
    const f = gateDeployFieldsFromLaunchRecord({
      launch_id_hex: LAUNCH,
      dv_registration_opens_ts: '2026-08-15T05:28:37Z',
      dv_registration_freezes_ts: '2026-08-15T07:33:37Z',
      dv_buying_opens_ts: '2026-08-15T07:43:37Z',
      dv_buying_closes_ts: '2026-08-15T08:33:37Z',
    });
    expect(f.launchIdHex).toBe(LAUNCH);
    expect(f.registrationCloseTime).toBe('1786779217');
    expect(f.registrationWindowSeconds).toBe('7500'); // 2h05
    expect(f.freezeWindowSeconds).toBe('600'); // 10 min
    expect(f.buyingWindowSeconds).toBe('3000'); // 50 min
    expect(f.notes).toHaveLength(1);
    expect(f.notes[0]).toMatch(/not the product's 46h \/ 2h \/ 24h/);
  });

  it('reads ISO, second and millisecond timestamps as the same instant', () => {
    const iso = '2026-10-01T10:00:00Z';
    const s = Date.parse(iso) / 1000;
    expect(recordTimestampToSeconds(iso, 'x')).toBe(s);
    expect(recordTimestampToSeconds(String(s), 'x')).toBe(s);
    expect(recordTimestampToSeconds(s * 1000, 'x')).toBe(s);
    expect(recordTimestampToSeconds(String(s * 1000), 'x')).toBe(s);
  });

  it('refuses a schedule whose steps are out of order and names the pair', () => {
    const r = wizardRecord('2026-10-01T12:00:00Z');
    expect(() =>
      gateDeployFieldsFromLaunchRecord({ ...r, dv_registration_freezes_ts: r.dv_registration_opens_ts }),
    ).toThrow(/dv_registration_freezes_ts .* must be later than dv_registration_opens_ts/);
    expect(() => gateDeployFieldsFromLaunchRecord({ ...r, dv_buying_closes_ts: '2026-09-30T00:00:00Z' })).toThrow(
      /dv_buying_closes_ts .* must be later than dv_buying_opens_ts/,
    );
  });

  it('refuses a record missing a timestamp, or holding an unreadable one', () => {
    const r = wizardRecord('2026-10-01T12:00:00Z');
    expect(() => gateDeployFieldsFromLaunchRecord({ ...r, dv_buying_opens_ts: '' })).toThrow(
      /dv_buying_opens_ts: the record has no value/,
    );
    expect(() => gateDeployFieldsFromLaunchRecord({ ...r, dv_buying_opens_ts: 'soon' })).toThrow(
      /dv_buying_opens_ts: cannot read "soon"/,
    );
  });

  it('refuses a launch id that is not 32 bytes', () => {
    const r = wizardRecord('2026-10-01T12:00:00Z');
    expect(() => gateDeployFieldsFromLaunchRecord({ ...r, launch_id_hex: LAUNCH.slice(0, 40) })).toThrow(
      /launch_id_hex: expected 64 hex characters/,
    );
    expect(() => gateDeployFieldsFromLaunchRecord({ ...r, launch_id_hex: undefined })).toThrow(/launch_id_hex/);
  });

  it('carries the creator identity when the record has one, and says so when it has none', () => {
    const r = wizardRecord('2026-10-01T12:00:00Z');
    const bound = gateDeployFieldsFromLaunchRecord(r, {
      launch_id_hex: LAUNCH,
      midnight_key: KEY.toUpperCase(),
      sealed: false,
    });
    expect(bound.creatorPubKeyHex).toBe(KEY);
    expect(bound.notes).toEqual([]);

    const unbound = gateDeployFieldsFromLaunchRecord(r, { launch_id_hex: LAUNCH, midnight_key: '', sealed: false });
    expect(unbound.creatorPubKeyHex).toBeUndefined();
    expect(unbound.notes).toEqual([expect.stringMatching(/no creator identity yet/)]);
  });

  it('refuses a creator identity answered for a different launch, or one that is not a key', () => {
    const r = wizardRecord('2026-10-01T12:00:00Z');
    expect(() => gateDeployFieldsFromLaunchRecord(r, { launch_id_hex: 'ab'.repeat(32), midnight_key: KEY })).toThrow(
      /answered for launch abababababab/,
    );
    expect(() => gateDeployFieldsFromLaunchRecord(r, { launch_id_hex: LAUNCH, midnight_key: '0'.repeat(64) })).toThrow(
      /not a 32-byte key/,
    );
  });

  it('notes a record that already names a contract, and a freeze that has already passed', () => {
    const r = wizardRecord('2026-10-01T12:00:00Z');
    const f = gateDeployFieldsFromLaunchRecord(
      r,
      { launch_id_hex: LAUNCH, midnight_key: KEY, sealed: true },
      Date.parse('2026-10-02T00:00:00Z') / 1000,
    );
    expect(f.notes).toEqual([
      expect.stringMatching(/already froze at 1790848800/),
      expect.stringMatching(/already names a deployed contract/),
    ]);
  });
});
