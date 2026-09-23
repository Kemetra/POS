export interface DemoProduct {
  readonly name: string;
  readonly englishName: string;
  readonly form: string;
  readonly barcode: string;
  readonly unitPrice: string;
}

export interface DemoCartLine extends DemoProduct {
  readonly quantity: number;
  readonly linePrice: string;
}

// Design-preview display values only. No transaction or fiscal calculation occurs here.
export const demoSale: {
  readonly products: readonly DemoProduct[];
  readonly cartLines: readonly DemoCartLine[];
  readonly subtotal: string;
  readonly total: string;
} = {
  products: [
    {
      name: 'بنادول أدفانس 500 مجم أقراص',
      englishName: 'Panadol Advance',
      form: 'عبوة 24 قرصًا',
      barcode: '6223004355218',
      unitPrice: '18.50',
    },
    {
      name: 'أموكسيسيلين 500 مجم كبسولات',
      englishName: 'Amoxicillin 500 mg',
      form: 'عبوة 16 كبسولة',
      barcode: '6223001251841',
      unitPrice: '62.00',
    },
    {
      name: 'فيتامين د 1000 وحدة دولية',
      englishName: 'Vitamin D3',
      form: 'عبوة 30 قرصًا',
      barcode: '6223004867916',
      unitPrice: '85.00',
    },
    {
      name: 'محلول ملحي معقم للأنف 0.9٪',
      englishName: 'Saline nasal drops',
      form: 'قطارة 20 مل',
      barcode: '6223002472108',
      unitPrice: '14.75',
    },
    {
      name: 'أكياس أملاح معالجة الجفاف للأطفال',
      englishName: 'Oral rehydration salts',
      form: 'كيس واحد',
      barcode: '6223003917468',
      unitPrice: '12.00',
    },
    {
      name: 'سيتريزين 10 مجم أقراص',
      englishName: 'Cetirizine 10 mg',
      form: 'عبوة 20 قرصًا',
      barcode: '6223001784059',
      unitPrice: '27.50',
    },
  ],
  cartLines: [
    {
      name: 'بنادول أدفانس 500 مجم أقراص',
      englishName: 'Panadol Advance',
      form: 'عبوة 24 قرصًا',
      barcode: '6223004355218',
      unitPrice: '18.50',
      quantity: 2,
      linePrice: '37.00',
    },
    {
      name: 'أموكسيسيلين 500 مجم كبسولات',
      englishName: 'Amoxicillin 500 mg',
      form: 'عبوة 16 كبسولة',
      barcode: '6223001251841',
      unitPrice: '62.00',
      quantity: 1,
      linePrice: '62.00',
    },
    {
      name: 'فيتامين د 1000 وحدة دولية',
      englishName: 'Vitamin D3',
      form: 'عبوة 30 قرصًا',
      barcode: '6223004867916',
      unitPrice: '85.00',
      quantity: 1,
      linePrice: '85.00',
    },
    {
      name: 'محلول ملحي معقم للأنف 0.9٪',
      englishName: 'Saline nasal drops',
      form: 'قطارة 20 مل',
      barcode: '6223002472108',
      unitPrice: '14.75',
      quantity: 2,
      linePrice: '29.50',
    },
    {
      name: 'أكياس أملاح معالجة الجفاف للأطفال',
      englishName: 'Oral rehydration salts',
      form: 'كيس واحد',
      barcode: '6223003917468',
      unitPrice: '12.00',
      quantity: 3,
      linePrice: '36.00',
    },
  ],
  subtotal: '249.50',
  total: '249.50',
};
