import type { JSX, ReactNode, AriaAttributes } from 'react';

type CardVariant = 'default' | 'muted' | 'elevated';

interface CardProps extends AriaAttributes {
  variant?: CardVariant;
  children: ReactNode;
  'aria-labelledby'?: string;
}

export function Card({
  variant = 'default',
  children,
  'aria-labelledby': ariaLabelledBy,
  ...aria
}: Readonly<CardProps>): JSX.Element {
  if (ariaLabelledBy) {
    return (
      <section className={`card card--${variant}`} aria-labelledby={ariaLabelledBy} {...aria}>
        {children}
      </section>
    );
  }
  return (
    <div className={`card card--${variant}`} {...aria}>
      {children}
    </div>
  );
}
