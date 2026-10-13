/**
 * RT-440 (PK-2, spec 024) — Park v1, main side: the four calls behind
 * `cart:park`, `cart:listParked`, `cart:previewResume` and `cart:resume`.
 *
 * A parked sale is an `editing` cart with `parked_at` set (K5): no new state,
 * no new outbox kind. Everything is local and works offline (§4.2). The park
 * label never leaves the `carts` row (§7).
 */
import type {
  CartListParkedResponse,
  CartParkRequest,
  CartParkResponse,
  CartPreviewResumeRequest,
  CartPreviewResumeResponse,
  CartResumeRequest,
  CartResumeResponse,
} from '../../../shared/cart/park-types.js';
import type { ParkResumeDeps } from './park-context.js';
import { listParked, park, previewResume } from './park-service.js';
import { resume } from './resume-flow.js';

export type { ParkResumeDeps } from './park-context.js';

export interface ParkResume {
  park(req: CartParkRequest): CartParkResponse;
  listParked(): CartListParkedResponse;
  previewResume(req: CartPreviewResumeRequest): CartPreviewResumeResponse;
  resume(req: CartResumeRequest): CartResumeResponse;
}

export function createParkResume(deps: ParkResumeDeps): ParkResume {
  return {
    park: (req) => park(deps, req),
    listParked: () => listParked(deps),
    previewResume: (req) => previewResume(deps, req),
    resume: (req) => resume(deps, req),
  };
}
