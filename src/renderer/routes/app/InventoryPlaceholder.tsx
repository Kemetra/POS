/**
 * RT-503 (VN-S10 S10-6) — Inventory: an honest Arabic notice (inventory
 * management is not available on this terminal) and the way to the read-only
 * catalogue check (G-6 state 11). It implies no inventory management; the dev
 * `?state=` gallery is gone.
 *
 * Navigation-only: no fetch, no IPC, no persistence.
 */
import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import { ScreenSection } from '../../v5/foundation/ScreenSection';
import { SearchGlyph } from '../../v5/manager/honest/SearchGlyph';
import { HonestNotice } from '../../v5/manager/honest/HonestNotice';
import { HONEST_COPY, MANAGER_PATHS } from '../../v5/manager/honest/honest-copy';

export function InventoryPlaceholder(): JSX.Element {
  const copy = HONEST_COPY.inventory;
  return (
    <ScreenSection title={copy.title}>
      <div className="v5-honest-state">
        <HonestNotice notice={copy.notice} />
        <ul className="v5-manager-tiles">
          <li>
            <Link
              className="v5-manager-tile"
              to={MANAGER_PATHS.diagnostics}
              data-testid="inventory-diagnostics-link"
            >
              <span className="v5-manager-tile__glyph" aria-hidden="true">
                <SearchGlyph />
              </span>
              <span className="v5-manager-tile__title">{copy.diagnosticsTitle}</span>
              <span className="v5-manager-tile__hint">{copy.diagnosticsHint}</span>
            </Link>
          </li>
        </ul>
      </div>
    </ScreenSection>
  );
}
