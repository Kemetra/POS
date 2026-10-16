import type { JSX, ReactNode, MouseEvent, AriaAttributes } from 'react';

type ButtonIntent = 'primary' | 'secondary' | 'ghost' | 'destructive';
type ButtonSize = 'md' | 'lg';

interface ButtonProps extends AriaAttributes {
  intent: ButtonIntent;
  size?: ButtonSize;
  children: ReactNode;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  type?: 'button' | 'submit' | 'reset';
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}

function Spinner(): JSX.Element {
  return <output aria-label="Loading" className="btn__spinner" aria-hidden="false" />;
}

export function Button({
  intent,
  size = 'md',
  children,
  iconStart,
  iconEnd,
  disabled = false,
  loading = false,
  type = 'button',
  onClick,
  ...aria
}: Readonly<ButtonProps>): JSX.Element {
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      className={`btn btn--${intent} btn--${size}`}
      disabled={isDisabled}
      aria-busy={loading ? 'true' : undefined}
      aria-disabled={isDisabled ? 'true' : undefined}
      tabIndex={isDisabled ? -1 : undefined}
      onClick={isDisabled ? undefined : onClick}
      data-touch-target="44"
      {...aria}
    >
      {loading && <Spinner />}
      {!loading && iconStart}
      {children}
      {!loading && iconEnd}
    </button>
  );
}
