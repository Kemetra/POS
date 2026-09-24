import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SaleScreen } from '../sale/SaleScreen';

const v5Root = resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.(css|ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('Sale proof clean-room boundary', () => {
  it('has its own implementation without importing legacy presentation or using legacy screen styles', () => {
    const saleScreen = join(v5Root, 'sale', 'SaleScreen.tsx');
    expect(existsSync(saleScreen)).toBe(true);

    const files = sourceFiles(v5Root);
    expect(files.some((file) => file.endsWith('.css'))).toBe(true);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/(?:ui\/(?:cart|catalogue)|\/shell)\//);
      expect(source, file).not.toMatch(
        /\b(?:CartPane|CatalogueSalePane|ProductSearchInput|ScanCaptureField|SearchResultRow|SearchResultList|ProductConfirmPanel|LineItemRow|QuantityStepper|Workspace)\b/,
      );
      expect(source, file).not.toMatch(
        /\b(?:sale-layout|catalogue-[\w-]*|cart-pane[\w-]*|payment-surface[\w-]*|tender-row[\w-]*|sign-in-route[\w-]*|placeholder-pane[\w-]*)\b/,
      );
    }
  });

  it('renders Arabic-first discovery, an active cart, and truthful illustrative totals', () => {
    render(<SaleScreen />);

    expect(screen.getByRole('main', { name: 'معاينة شاشة البيع' })).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('heading', { name: 'الأصناف والمنتجات' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'سلة المشتريات' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'البحث بالاسم أو الباركود' })).toHaveAttribute(
      'readonly',
    );
    expect(screen.getByText('قيد الإضافة · لا تُحسب هنا')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'المتابعة إلى الدفع' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByText(/SAR|ZATCA|15%|mada|Apple Pay|STC Pay/i)).not.toBeInTheDocument();
  });
});
