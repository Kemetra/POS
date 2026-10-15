import type { JSX, ReactNode } from 'react';

interface CenterStageProps {
  children: ReactNode;
}

/**
 * T054 [S3] — CenterStage layout primitive.
 *
 * Full-bleed 100vh workspace with no top bar, no rail. One floating
 * pane child centred. Used by pairing (S4) and sign-in surfaces (S5).
 *
 * Layout implemented via .center-stage CSS in tailwind.css.
 */
export function CenterStage({ children }: Readonly<CenterStageProps>): JSX.Element {
  return (
    <div data-testid="center-stage" className="center-stage">
      {children}
    </div>
  );
}
