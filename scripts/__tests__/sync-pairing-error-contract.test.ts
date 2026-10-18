import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import {
  SNAPSHOT_PATH,
  loadPinnedPairingError,
  normalizeNullable,
  syncPairingError,
  type OpenApiDoc,
} from '../sync-pairing-error-contract.js';

const pinned = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', enum: ['INVALID_CODE'] },
        message: { type: 'string' },
        request_id: { type: 'string', format: 'uuid', nullable: true },
      },
    },
  },
};

const snapshot: OpenApiDoc = {
  openapi: '3.1.0',
  paths: { '/x': {} },
  components: {
    schemas: {
      TerminalPairErrorResponse: { type: 'object', required: ['code'] },
      Other: { type: 'object' },
    },
  },
};

describe('syncPairingError', () => {
  it('replaces only TerminalPairErrorResponse and leaves the input untouched', () => {
    const out = syncPairingError(snapshot, pinned);
    expect(out.components.schemas.Other).toEqual({ type: 'object' });
    expect(out.paths).toEqual(snapshot.paths);
    expect(out.components.schemas.TerminalPairErrorResponse).toEqual(normalizeNullable(pinned));
    expect(snapshot.components.schemas.TerminalPairErrorResponse).toEqual({
      type: 'object',
      required: ['code'],
    });
  });

  it('rewrites 3.0 nullable into a 3.1 type union', () => {
    const out = syncPairingError(snapshot, pinned);
    const schema = out.components.schemas.TerminalPairErrorResponse as typeof pinned;
    expect(schema.properties.error.properties.request_id).toEqual({
      type: ['string', 'null'],
      format: 'uuid',
    });
  });

  it('rejects a non-envelope pinned schema and a missing target', () => {
    expect(() =>
      syncPairingError(snapshot, { type: 'object', properties: { code: {} } }),
    ).toThrow();
    expect(() => syncPairingError({ ...snapshot, components: { schemas: {} } }, pinned)).toThrow();
  });
});

describe('committed snapshot vs pinned Backend-Core contract (RT-307)', () => {
  it('TerminalPairErrorResponse is the pinned canonical envelope', () => {
    const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as OpenApiDoc;
    expect(committed.components.schemas.TerminalPairErrorResponse).toEqual(
      normalizeNullable(loadPinnedPairingError()),
    );
  });
});
