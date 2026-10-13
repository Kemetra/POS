import type { IpcMain } from 'electron';

import { CART_PARK_IPC_CHANNELS } from '../../shared/cart/channels.js';
import {
  PARK_LABEL_MAX_LENGTH,
  type CartParkRefusal,
  type CartParkRequest,
  type CartPreviewResumeRequest,
  type CartResumeRequest,
} from '../../shared/cart/park-types.js';
import type { ParkResume } from '../cart/park/park-resume.js';

/**
 * RT-440 (PK-2, spec 024 §3) — `cart:park`, `cart:listParked`,
 * `cart:previewResume`, `cart:resume`.
 *
 * Thin wire-up: each request is rebuilt as a FRESH object holding only the
 * contract fields, each a bounded id or a closed value, so no renderer-supplied
 * identity, owner, price or total reaches main. A malformed request refuses
 * generically (`no_session`), never naming the field. The `cart:` prefix puts
 * all four behind the central lock, recovery-mode and sale-boundary guards.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** A diff token is the hex digest `cart.previewResume` returned. */
const TOKEN_PATTERN = /^[0-9a-f]{1,64}$/;
/** Generous raw cap: main trims and enforces the 40-character rule itself. */
const RAW_LABEL_MAX = PARK_LABEL_MAX_LENGTH * 4;

const invalid = (): CartParkRefusal => ({ kind: 'refused', reason: 'no_session' });

function fieldsOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function isRawLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= RAW_LABEL_MAX;
}

function isCurrentCartChoice(value: unknown): value is CartResumeRequest['current_cart'] {
  return value === 'park' || value === 'keep';
}

/** The cart id and idempotency key every mutating park call carries, or null. */
function keyedCart(value: unknown): { cart_id: string; idempotency_key: string } | null {
  const v = fieldsOf(value);
  if (v === null) return null;
  const { cart_id, idempotency_key } = v;
  return isId(cart_id) && isId(idempotency_key) ? { cart_id, idempotency_key } : null;
}

export function asParkReq(value: unknown): CartParkRequest | null {
  const req = keyedCart(value);
  if (req === null) return null;
  const label = (value as Record<string, unknown>)['label'];
  if (label === undefined) return req;
  return isRawLabel(label) ? { ...req, label } : null;
}

export function asPreviewReq(value: unknown): CartPreviewResumeRequest | null {
  const cart_id = fieldsOf(value)?.['cart_id'];
  return isId(cart_id) ? { cart_id } : null;
}

/** The resume choice: the diff token seen, the acceptance and the current sale. */
function resumeChoice(
  v: Record<string, unknown>,
): Pick<CartResumeRequest, 'accept_changes' | 'diff_token' | 'current_cart'> | null {
  const { accept_changes, diff_token, current_cart } = v;
  if (!isToken(diff_token)) return null;
  if (typeof accept_changes !== 'boolean') return null;
  return isCurrentCartChoice(current_cart) ? { accept_changes, diff_token, current_cart } : null;
}

export function asResumeReq(value: unknown): CartResumeRequest | null {
  const keys = keyedCart(value);
  if (keys === null) return null;
  const choice = resumeChoice(value as Record<string, unknown>);
  return choice === null ? null : { ...keys, ...choice };
}

export function registerCartParkHandlers(ipcMain: IpcMain, deps: { parkResume: ParkResume }): void {
  const { parkResume } = deps;
  ipcMain.handle(CART_PARK_IPC_CHANNELS.PARK, (_event, request: unknown) => {
    const req = asParkReq(request);
    return req === null ? invalid() : parkResume.park(req);
  });
  ipcMain.handle(CART_PARK_IPC_CHANNELS.LIST_PARKED, () => parkResume.listParked());
  ipcMain.handle(CART_PARK_IPC_CHANNELS.PREVIEW_RESUME, (_event, request: unknown) => {
    const req = asPreviewReq(request);
    return req === null ? invalid() : parkResume.previewResume(req);
  });
  ipcMain.handle(CART_PARK_IPC_CHANNELS.RESUME, (_event, request: unknown) => {
    const req = asResumeReq(request);
    return req === null ? invalid() : parkResume.resume(req);
  });
}
