import type { JSX, ReactNode } from 'react';

interface WorkspaceProps {
  title?: string;
  banner?: ReactNode;
  children: ReactNode;
}

/**
 * T055 [S3] — Workspace layout primitive.
 *
 * max-inline-size 1280px, padded 32–40px, single scroll surface.
 * Optional page header (title) + optional banner slot + body slot.
 * Consumed by every signed-in route (S4 placeholder wrap in T070a).
 *
 * Layout implemented via .workspace CSS in tailwind.css.
 */
export function Workspace({ title, banner, children }: Readonly<WorkspaceProps>): JSX.Element {
  return (
    <div data-testid="workspace" className="workspace">
      {title && (
        <div className="workspace__header">
          <h1 className="workspace__title">{title}</h1>
        </div>
      )}
      {banner && <div className="workspace__banner">{banner}</div>}
      <div className="workspace__body">{children}</div>
    </div>
  );
}
